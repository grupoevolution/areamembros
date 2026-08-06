/**
 * =============================================================================
 * routes/webhooks.js — Endpoints dos webhooks
 * =============================================================================
 *
 * Recebe notificações das plataformas de pagamento.
 *
 * Endpoints:
 *   POST /webhook/kirvano       - recebe vendas da Kirvano
 *   POST /webhook/perfectpay    - recebe vendas da PerfectPay
 *
 * Fluxo geral:
 *   1. Loga o webhook bruto no banco (sempre, mesmo antes de validar)
 *   2. Valida assinatura
 *   3. Normaliza payload
 *   4. Processa via sales-processor
 *   5. Atualiza log com resultado
 *   6. Retorna 200 (sempre, pra plataforma não reenviar)
 *
 * IMPORTANTE: Sempre respondemos 200, mesmo em erro interno, pra evitar
 * que o gateway fique reenviando infinitamente. Erros ficam no log pra
 * você debugar.
 *
 * =============================================================================
 */

const express = require('express');
const router = express.Router();

const db = require('../db');
const { logger } = require('../lib/logger');
const { getIp } = require('../lib/device-check');
const { webhookLimiter } = require('../lib/rate-limit');
const { processSale, saleItemFailures } = require('../lib/sales-processor');

const kirvanoAdapter = require('../lib/gateways/kirvano');
const perfectpayAdapter = require('../lib/gateways/perfectpay');

// Eventos que DERRUBAM acesso de cliente — só processam com assinatura válida.
const DESTRUCTIVE_EVENTS = ['refunded', 'chargeback', 'canceled'];

// INCIDENTE (ago/2026): lead com Pix PENDENTE ganhou acesso sem pagar — um
// SALE_APPROVED que a Kirvano não reconhece (forjado/replay). A porta era:
// "aprovada entra mesmo com assinatura inválida". REGRA NOVA:
//   - Token CONFIGURADO no painel + assinatura inválida → bloqueia TUDO
//     (inclusive aprovada). A Kirvano sempre manda o token certo, então
//     venda legítima nunca é perdida; o bloqueio fica vermelho no painel
//     de Webhooks pra reprocessar se for o caso.
//   - Token NÃO configurado → aprovada continua entrando com aviso (não
//     quebra quem nunca configurou o token), mas destrutivo segue bloqueado.
async function invalidSignatureAction(gateway, event) {
    let secretConfigured = false;
    try {
        const { getSecret } = require('../lib/gateway-secrets');
        const s = await getSecret(gateway);
        secretConfigured = !!(s && String(s).trim());
    } catch (_) {}
    if (secretConfigured) return 'block';
    return DESTRUCTIVE_EVENTS.includes(event) ? 'block' : 'warn';
}


/**
 * Salva webhook no banco (antes de processar).
 * Retorna o ID do log criado pra atualizarmos depois.
 */
async function logWebhookReceived({ gateway, req, signatureValid }) {
    const sourceIp = getIp(req);
    const eventType = req.body?.event || req.body?.sale_status_enum_key || null;
    const saleId = req.body?.sale_id || req.body?.code || null;
    const customerEmail = req.body?.customer?.email || null;
    
    try {
        const { rows: [log] } = await db.query(
            `INSERT INTO webhook_logs (
                gateway, event_type, sale_id, customer_email,
                signature_valid, raw_payload, source_ip
            ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
            RETURNING id`,
            [gateway, eventType, saleId, customerEmail, signatureValid, JSON.stringify(req.body || {}), sourceIp]
        );
        return log.id;
    } catch (err) {
        logger.error('Erro ao logar webhook:', err);
        return null;
    }
}


/**
 * Atualiza log do webhook com resultado do processamento.
 */
async function logWebhookProcessed(logId, { processed, error, summary }) {
    if (!logId) return;
    
    try {
        const metadata = {
            processing_summary: summary || null,
        };
        
        await db.query(
            `UPDATE webhook_logs
             SET processed = $1,
                 processing_error = $2,
                 processed_at = NOW(),
                 raw_payload = raw_payload || $3::jsonb
             WHERE id = $4`,
            [processed, error || null, JSON.stringify({ _processing: metadata }), logId]
        );
    } catch (err) {
        logger.error('Erro ao atualizar log do webhook:', err);
    }
}


/**
 * Venda ÓRFÃ: chegou item com offer_id que não está cadastrado em nenhum
 * produto do painel. Antes isso passava em silêncio (processed=true) e o
 * cliente ficava SEM o acesso que pagou. Agora o log fica processed=false
 * com o erro na cara — aparece em vermelho na tela de Webhooks e entra no
 * "Reprocessar falhas": cadastre o código na aba Ofertas e reprocesse.
 */
function orphanSaleError(summary) {
    if (!summary || !summary.items_without_product) return null;
    const missing = (summary.errors || []).filter(e => String(e).startsWith('Produto não configurado'));
    const first = missing[0] || 'venda com oferta não cadastrada no painel';
    const extra = missing.length > 1 ? ` (+${missing.length - 1} item(ns))` : '';
    return `⚠️ ${first}${extra} — cadastre o código da oferta no produto e clique em Reprocessar.`;
}

// Item que FALHOU por erro transitório (banco piscou etc.): antes a venda era
// marcada processed=true mesmo assim — o gateway não reenviava, o "Reprocessar
// falhas" não via, e o cliente pagava sem receber, tudo verde no painel.
// Agora: processed=false + resposta 500 (gateway reenvia; a reentrega é
// idempotente — grantAccess deduplica por gateway+sale_id+produto).
function itemFailureError(summary) {
    const failures = saleItemFailures(summary);
    if (!failures.length) return null;
    const extra = failures.length > 1 ? ` (+${failures.length - 1} item(ns))` : '';
    return `❌ Falha entregando a venda: ${failures[0]}${extra} — será retentada pelo gateway; se persistir, use Reprocessar.`;
}


// =============================================================================
// WEBHOOK KIRVANO
// =============================================================================

router.post('/kirvano', webhookLimiter, async (req, res) => {
    logger.info(`Webhook Kirvano recebido (IP: ${getIp(req)})`);
    
    // 1. Valida assinatura
    const signatureValid = await kirvanoAdapter.validateKirvanoSignature(req);
    
    // 2. Loga (mesmo que assinatura seja inválida - pra auditoria)
    const logId = await logWebhookReceived({
        gateway: 'kirvano',
        req,
        signatureValid,
    });
    
    // 3. Assinatura inválida NÃO bloqueia a entrega da venda. Antes rejeitávamos
    //    com 401 e o cliente que PAGOU não recebia o acesso. Agora só logamos um
    //    aviso (signature_valid fica false no log pra você ver) e seguimos
    //    processando — a venda precisa ser entregue. Pra validação 100% limpa,
    //    configure o mesmo Token na Kirvano e no painel/KIRVANO_WEBHOOK_SECRET.
    if (!signatureValid) {
        logger.warn(`Webhook Kirvano com assinatura inválida — processando mesmo assim (token não confere). IP: ${getIp(req)}`);
    }

    // 4. Normaliza payload
    const normalized = kirvanoAdapter.normalizeKirvanoPayload(req.body);
    
    if (!normalized.valid) {
        logger.warn(`Webhook Kirvano inválido: ${normalized.reason}`);
        await logWebhookProcessed(logId, {
            processed: false,
            error: normalized.reason,
        });
        // Retornamos 200 pra Kirvano não reenviar. O erro fica no log pra análise.
        return res.status(200).json({ success: true, message: 'Ignorado', reason: normalized.reason });
    }

    // 4b. Assinatura inválida: ver regra em invalidSignatureAction — com o
    //     token configurado no painel, NADA entra sem assinatura válida
    //     (fecha o forjamento de compra aprovada E de reembolso).
    if (!signatureValid && (await invalidSignatureAction('kirvano', normalized.data.event)) === 'block') {
        const msg = `Evento '${normalized.data.event}' com ASSINATURA INVÁLIDA — bloqueado por segurança (ninguém ganha nem perde acesso). Se for legítimo: confira o token no painel = Kirvano e use Reprocessar.`;
        logger.warn(`Webhook Kirvano: ${msg} IP: ${getIp(req)}`);
        await logWebhookProcessed(logId, { processed: false, error: msg });
        return res.status(200).json({ success: false, error: 'invalid_signature' });
    }

    // 5. Processa venda
    try {
        const summary = await processSale(normalized.data);

        const failure = itemFailureError(summary);
        if (failure) {
            logger.error(`Webhook Kirvano com falha de entrega: ${failure}`);
            await logWebhookProcessed(logId, { processed: false, error: failure, summary });
            return res.status(500).json({ success: false, error: 'Falha entregando a venda — reenviar' });
        }

        const orphan = orphanSaleError(summary);
        if (orphan) logger.warn(`Webhook Kirvano com venda órfã: ${orphan}`);
        await logWebhookProcessed(logId, {
            processed: !orphan,
            error: orphan,
            summary,
        });

        return res.status(200).json({ success: true, summary });
    } catch (err) {
        logger.error('Erro processando webhook Kirvano:', err);
        await logWebhookProcessed(logId, {
            processed: false,
            error: err.message,
        });
        // 500 faz a Kirvano reenviar (ela tenta de novo). Isso é bom pra erros
        // transitórios (banco fora, por ex). Se fosse 200 perderíamos a venda.
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// =============================================================================
// WEBHOOK PERFECTPAY
// =============================================================================

router.post('/perfectpay', webhookLimiter, async (req, res) => {
    logger.info(`Webhook PerfectPay recebido (IP: ${getIp(req)})`);
    
    const signatureValid = await perfectpayAdapter.validatePerfectPaySignature(req);
    
    const logId = await logWebhookReceived({
        gateway: 'perfectpay',
        req,
        signatureValid,
    });
    
    // Igual à Kirvano: token inválido não bloqueia a entrega — só loga e segue.
    if (!signatureValid) {
        logger.warn(`Webhook PerfectPay com token inválido — processando mesmo assim. IP: ${getIp(req)}`);
    }

    const normalized = perfectpayAdapter.normalizePerfectPayPayload(req.body);
    
    if (!normalized.valid) {
        logger.warn(`Webhook PerfectPay inválido: ${normalized.reason}`);
        await logWebhookProcessed(logId, {
            processed: false,
            error: normalized.reason,
        });
        return res.status(200).json({ success: true, message: 'Ignorado', reason: normalized.reason });
    }

    // Igual à Kirvano: com token configurado, nada entra sem assinatura válida.
    if (!signatureValid && (await invalidSignatureAction('perfectpay', normalized.data.event)) === 'block') {
        const msg = `Evento '${normalized.data.event}' com ASSINATURA INVÁLIDA — bloqueado por segurança (ninguém ganha nem perde acesso). Se for legítimo: confira o token no painel = PerfectPay e use Reprocessar.`;
        logger.warn(`Webhook PerfectPay: ${msg} IP: ${getIp(req)}`);
        await logWebhookProcessed(logId, { processed: false, error: msg });
        return res.status(200).json({ success: false, error: 'invalid_signature' });
    }

    try {
        const summary = await processSale(normalized.data);

        const failure = itemFailureError(summary);
        if (failure) {
            logger.error(`Webhook PerfectPay com falha de entrega: ${failure}`);
            await logWebhookProcessed(logId, { processed: false, error: failure, summary });
            return res.status(500).json({ success: false, error: 'Falha entregando a venda — reenviar' });
        }

        const orphan = orphanSaleError(summary);
        if (orphan) logger.warn(`Webhook PerfectPay com venda órfã: ${orphan}`);
        await logWebhookProcessed(logId, {
            processed: !orphan,
            error: orphan,
            summary,
        });

        return res.status(200).json({ success: true, summary });
    } catch (err) {
        logger.error('Erro processando webhook PerfectPay:', err);
        await logWebhookProcessed(logId, {
            processed: false,
            error: err.message,
        });
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


module.exports = router;
