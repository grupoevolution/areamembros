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
const { processSale } = require('../lib/sales-processor');

const kirvanoAdapter = require('../lib/gateways/kirvano');
const perfectpayAdapter = require('../lib/gateways/perfectpay');


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
    
    // 3. Se assinatura inválida, rejeita
    if (!signatureValid) {
        logger.warn(`Webhook Kirvano rejeitado — assinatura inválida (IP: ${getIp(req)})`);
        await logWebhookProcessed(logId, {
            processed: false,
            error: 'Assinatura inválida',
        });
        // Retornamos 401 pra mostrar que rejeitamos, mas mesmo assim a Kirvano
        // pode reenviar. Se estiver recebendo várias rejeições é sinal de
        // token mal configurado.
        return res.status(401).json({ success: false, error: 'Unauthorized' });
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
    
    // 5. Processa venda
    try {
        const summary = await processSale(normalized.data);
        
        await logWebhookProcessed(logId, {
            processed: true,
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
    
    if (!signatureValid) {
        logger.warn(`Webhook PerfectPay rejeitado — token inválido (IP: ${getIp(req)})`);
        await logWebhookProcessed(logId, {
            processed: false,
            error: 'Token inválido',
        });
        return res.status(401).json({ success: false, error: 'Unauthorized' });
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
    
    try {
        const summary = await processSale(normalized.data);
        
        await logWebhookProcessed(logId, {
            processed: true,
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
