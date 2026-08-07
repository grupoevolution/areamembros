/**
 * =============================================================================
 * routes/admin-access.js — Gestão de acessos e webhooks no admin
 * =============================================================================
 *
 * Endpoints pra:
 *   - Listar acessos liberados
 *   - Revogar acesso manual
 *   - Liberar acesso manual
 *   - Listar logs de webhook
 *   - Reprocessar webhook
 *   - Simular webhook (pra testar)
 *
 * =============================================================================
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAdmin } = require('../lib/auth');
const { logger } = require('../lib/logger');
const { processSale, saleItemFailures } = require('../lib/sales-processor');
const kirvanoAdapter = require('../lib/gateways/kirvano');
const perfectpayAdapter = require('../lib/gateways/perfectpay');

// O reprocesso só pode marcar processed=true se a venda foi ENTREGUE de fato.
// Antes marcava incondicionalmente: reprocessar antes de cadastrar a oferta
// (ou com o banco piscando) fazia a falha SUMIR da lista sem entregar nada.
function saleStillFailing(summary) {
    const failures = saleItemFailures(summary);
    if (failures.length) {
        const extra = failures.length > 1 ? ` (+${failures.length - 1} item(ns))` : '';
        return `❌ Falha entregando a venda: ${failures[0]}${extra} — tente de novo; se persistir, veja o log.`;
    }
    if (summary && summary.items_without_product) {
        const missing = ((summary.errors) || []).filter(e => String(e).startsWith('Produto não configurado'));
        return `⚠️ ${missing[0] || 'venda com oferta não cadastrada no painel'} — cadastre o código da oferta no produto e reprocesse.`;
    }
    return null;
}


// =============================================================================
// LISTAR ACESSOS
// =============================================================================

router.get('/access', requireAdmin, async (req, res) => {
    const { email, product_id, status, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    try {
        const conditions = [];
        const params = [];
        
        if (email) {
            params.push(`%${email.toLowerCase()}%`);
            conditions.push(`LOWER(ua.email) LIKE $${params.length}`);
        }
        if (product_id) {
            params.push(parseInt(product_id));
            conditions.push(`ua.product_id = $${params.length}`);
        }
        if (status) {
            params.push(status);
            conditions.push(`ua.status = $${params.length}`);
        }
        
        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        
        params.push(parseInt(limit), offset);
        
        const { rows } = await db.query(`
            SELECT ua.*, p.name as product_name, p.banner_url as product_banner
            FROM user_access ua
            LEFT JOIN products p ON p.id = ua.product_id
            ${where}
            ORDER BY ua.granted_at DESC
            LIMIT $${params.length - 1} OFFSET $${params.length}
        `, params);
        
        // Conta total (sem LIMIT)
        const countParams = params.slice(0, -2);
        const { rows: [{ total }] } = await db.query(`
            SELECT COUNT(*)::int as total FROM user_access ua ${where}
        `, countParams);
        
        return res.json({
            success: true,
            access: rows,
            pagination: { page: parseInt(page), limit: parseInt(limit), total },
        });
    } catch (err) {
        logger.error('Erro listando acessos:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// =============================================================================
// REVOGAR ACESSO MANUAL
// =============================================================================

router.post('/access/:id/revoke', requireAdmin, async (req, res) => {
    const accessId = parseInt(req.params.id);
    const { reason } = req.body || {};
    
    try {
        const { rowCount } = await db.query(`
            UPDATE user_access
            SET status = 'manually_revoked',
                revoked_at = NOW(),
                revoke_reason = $1
            WHERE id = $2 AND status = 'active'
        `, [reason || `Revogado por ${req.admin.username}`, accessId]);
        
        if (rowCount === 0) {
            return res.status(404).json({ 
                success: false, 
                error: 'Acesso não encontrado ou já inativo' 
            });
        }
        
        logger.info(`Acesso ${accessId} revogado manualmente por ${req.admin.username}`);
        return res.json({ success: true });
    } catch (err) {
        logger.error('Erro revogando acesso:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// =============================================================================
// LIBERAR ACESSO MANUAL
// =============================================================================

router.post('/access/grant', requireAdmin, async (req, res) => {
    const { email, product_id, note } = req.body || {};
    
    if (!email || !product_id) {
        return res.status(400).json({ 
            success: false, 
            error: 'Email e product_id são obrigatórios' 
        });
    }
    
    try {
        const { rows: [product] } = await db.query(
            'SELECT id, is_chat_plan FROM products WHERE id = $1',
            [product_id]
        );
        if (!product) {
            return res.status(404).json({ success: false, error: 'Produto não encontrado' });
        }
        
        // Verifica se já tem acesso
        const { rows: [existing] } = await db.query(`
            SELECT id FROM user_access
            WHERE LOWER(email) = $1 AND product_id = $2 AND status = 'active'
        `, [email.toLowerCase().trim(), product_id]);
        
        if (existing) {
            return res.status(409).json({ 
                success: false, 
                error: 'Cliente já tem acesso ativo a esse produto' 
            });
        }
        
        const { rows: [created] } = await db.query(`
            INSERT INTO user_access (
                email, product_id, status, granted_by, metadata
            ) VALUES ($1, $2, 'active', $3, $4::jsonb)
            RETURNING id
        `, [
            email.toLowerCase().trim(),
            product_id,
            req.admin.username,
            JSON.stringify({ note: note || null, granted_manually: true }),
        ]);
        
        logger.info(`Acesso manual liberado por ${req.admin.username}: ${email} → produto ${product_id}`);

        // RECEPÇÃO VIP também no acesso dado NA MÃO: o gatilho de compra só
        // roda no webhook — sem isto, liberar a assinatura de chat pelo painel
        // (teste do dono, cortesia, suporte) não fazia as modelas "chegarem".
        // Manual não tem oferta → conta como VIP (recebe todas as marcadas).
        if (product.is_chat_plan === true) {
            try {
                const chatsApi = require('./user-chats');
                if (typeof chatsApi.scheduleVipReception === 'function') {
                    await chatsApi.scheduleVipReception(email.toLowerCase().trim(), 'vip');
                }
            } catch (e) { logger.warn('recepção VIP (manual) falhou: ' + e.message); }
        }

        return res.status(201).json({ success: true, access_id: created.id });
    } catch (err) {
        logger.error('Erro liberando acesso manual:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// =============================================================================
// LIBERAR ACESSO EM MASSA (cola uma lista de e-mails + escolhe o produto)
// =============================================================================

router.post('/access/grant-bulk', requireAdmin, async (req, res) => {
    const { emails, product_id, note } = req.body || {};
    if (!emails || !product_id) {
        return res.status(400).json({ success: false, error: 'Lista de e-mails e produto são obrigatórios' });
    }
    try {
        const { rows: [product] } = await db.query('SELECT id, name, is_chat_plan FROM products WHERE id = $1', [product_id]);
        if (!product) return res.status(404).json({ success: false, error: 'Produto não encontrado' });

        const re = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
        // aceita separados por linha, vírgula, ponto-e-vírgula ou espaço
        const raw = String(emails).split(/[\s,;]+/).map(e => e.toLowerCase().trim()).filter(Boolean);
        const valid = [...new Set(raw.filter(e => re.test(e)))];
        const invalid = [...new Set(raw.filter(e => !re.test(e)))];

        let granted = 0, already = 0, errors = 0;
        for (const email of valid) {
            try {
                await db.query(`INSERT INTO customers (email) VALUES ($1) ON CONFLICT (email) DO NOTHING`, [email]);
                const { rows: [exists] } = await db.query(
                    `SELECT id FROM user_access WHERE LOWER(email) = $1 AND product_id = $2 AND status = 'active' LIMIT 1`,
                    [email, product_id]
                );
                if (exists) { already++; continue; }
                await db.query(
                    `INSERT INTO user_access (email, product_id, status, granted_by, metadata)
                     VALUES ($1, $2, 'active', $3, $4::jsonb)`,
                    [email, product_id, req.admin.username, JSON.stringify({ note: note || 'importação em massa', granted_manually: true, bulk: true })]
                );
                granted++;
                // Recepção VIP também na importação em massa da assinatura de chat
                if (product.is_chat_plan === true) {
                    try {
                        const chatsApi = require('./user-chats');
                        if (typeof chatsApi.scheduleVipReception === 'function') {
                            await chatsApi.scheduleVipReception(email, 'vip');
                        }
                    } catch (_) {}
                }
            } catch (e) { errors++; }
        }
        logger.info(`Importação em massa por ${req.admin.username}: produto ${product_id} (${product.name}) — ${granted} liberados, ${already} já tinham, ${invalid.length} inválidos, ${errors} erros`);
        return res.json({
            success: true, product_name: product.name,
            total_lidos: raw.length, liberados: granted, ja_tinham: already,
            invalidos: invalid.length, invalidos_lista: invalid.slice(0, 20), erros: errors,
        });
    } catch (err) {
        logger.error('Erro na importação em massa:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// =============================================================================
// LISTAR WEBHOOKS (LOGS)
// =============================================================================

router.get('/webhooks', requireAdmin, async (req, res) => {
    const { gateway, sale_id, email, processed, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    try {
        const conditions = [];
        const params = [];
        
        if (gateway) {
            params.push(gateway);
            conditions.push(`gateway = $${params.length}`);
        }
        if (sale_id) {
            params.push(`%${sale_id}%`);
            conditions.push(`sale_id ILIKE $${params.length}`);
        }
        if (email) {
            params.push(`%${email.toLowerCase()}%`);
            conditions.push(`LOWER(customer_email) LIKE $${params.length}`);
        }
        if (processed === 'true') {
            conditions.push('processed = true');
        } else if (processed === 'false') {
            conditions.push('processed = false');
        }
        
        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        
        params.push(parseInt(limit), offset);
        
        const { rows } = await db.query(`
            SELECT id, gateway, event_type, sale_id, customer_email,
                   signature_valid, processed, processing_error,
                   source_ip, received_at, processed_at
            FROM webhook_logs
            ${where}
            ORDER BY received_at DESC
            LIMIT $${params.length - 1} OFFSET $${params.length}
        `, params);
        
        const countParams = params.slice(0, -2);
        const { rows: [{ total }] } = await db.query(`
            SELECT COUNT(*)::int as total FROM webhook_logs ${where}
        `, countParams);
        
        return res.json({
            success: true,
            webhooks: rows,
            pagination: { page: parseInt(page), limit: parseInt(limit), total },
        });
    } catch (err) {
        logger.error('Erro listando webhooks:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// =============================================================================
// VER DETALHES DE UM WEBHOOK
// =============================================================================

router.get('/webhooks/:id', requireAdmin, async (req, res) => {
    try {
        const { rows: [webhook] } = await db.query(
            'SELECT * FROM webhook_logs WHERE id = $1',
            [req.params.id]
        );
        
        if (!webhook) {
            return res.status(404).json({ success: false, error: 'Webhook não encontrado' });
        }
        
        return res.json({ success: true, webhook });
    } catch (err) {
        logger.error('Erro buscando webhook:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// =============================================================================
// REPROCESSAR WEBHOOK
// =============================================================================

router.post('/webhooks/:id/reprocess', requireAdmin, async (req, res) => {
    try {
        const { rows: [webhook] } = await db.query(
            'SELECT * FROM webhook_logs WHERE id = $1',
            [req.params.id]
        );
        
        if (!webhook) {
            return res.status(404).json({ success: false, error: 'Webhook não encontrado' });
        }
        
        const adapter = webhook.gateway === 'kirvano' ? kirvanoAdapter : perfectpayAdapter;
        const normalizeFn = webhook.gateway === 'kirvano' 
            ? 'normalizeKirvanoPayload' 
            : 'normalizePerfectPayPayload';
        
        const normalized = adapter[normalizeFn](webhook.raw_payload);
        
        if (!normalized.valid) {
            return res.status(400).json({ 
                success: false, 
                error: `Payload inválido: ${normalized.reason}` 
            });
        }
        
        const summary = await processSale(normalized.data);

        const failing = saleStillFailing(summary);
        await db.query(`
            UPDATE webhook_logs
            SET processed = $1, processing_error = $2, processed_at = NOW(),
                raw_payload = raw_payload || $3::jsonb
            WHERE id = $4
        `, [!failing, failing, JSON.stringify({ _reprocessed: { at: new Date().toISOString(), by: req.admin.username, summary } }), webhook.id]);

        logger.info(`Webhook ${webhook.id} reprocessado por ${req.admin.username}${failing ? ' (ainda com falha)' : ''}`);
        return res.json({ success: true, summary, still_failing: failing });
    } catch (err) {
        logger.error('Erro reprocessando webhook:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// =============================================================================
// REPROCESSAR TODAS AS FALHAS (recupera vendas que não foram entregues)
// =============================================================================

router.post('/webhooks/reprocess-failed', requireAdmin, async (req, res) => {
    try {
        const { rows } = await db.query(
            `SELECT * FROM webhook_logs WHERE processed = false ORDER BY received_at ASC LIMIT 1000`
        );
        let ok = 0, fail = 0, granted = 0;
        const errors = [];
        for (const webhook of rows) {
            try {
                const adapter = webhook.gateway === 'kirvano' ? kirvanoAdapter : perfectpayAdapter;
                const fn = webhook.gateway === 'kirvano' ? 'normalizeKirvanoPayload' : 'normalizePerfectPayPayload';
                const normalized = adapter[fn](webhook.raw_payload);
                if (!normalized.valid) { fail++; errors.push(`#${webhook.id}: ${normalized.reason}`); continue; }
                const summary = await processSale(normalized.data);
                granted += (summary.accesses_granted || 0);
                const failing = saleStillFailing(summary);
                await db.query(
                    `UPDATE webhook_logs SET processed = $1, processing_error = $2, processed_at = NOW(),
                            raw_payload = raw_payload || $3::jsonb WHERE id = $4`,
                    [!failing, failing, JSON.stringify({ _reprocessed_bulk: { at: new Date().toISOString(), by: req.admin.username, summary } }), webhook.id]
                );
                if (failing) { fail++; errors.push(`#${webhook.id}: ${failing}`); }
                else ok++;
            } catch (e) { fail++; errors.push(`#${webhook.id}: ${e.message}`); }
        }
        logger.info(`Reprocesso em massa por ${req.admin.username}: ${ok} ok, ${fail} falhas, ${granted} acessos liberados`);
        return res.json({ success: true, total: rows.length, reprocessed: ok, failed: fail, accesses_granted: granted, errors: errors.slice(0, 15) });
    } catch (err) {
        logger.error('Erro no reprocesso em massa:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// =============================================================================
// SIMULAR WEBHOOK (pra testar)
// =============================================================================

router.post('/webhooks/simulate', requireAdmin, async (req, res) => {
    const { gateway, event, email, offer_id, sale_amount, customer_name } = req.body || {};
    
    if (!gateway || !event || !email || !offer_id) {
        return res.status(400).json({ 
            success: false, 
            error: 'Informe gateway, event, email e offer_id' 
        });
    }
    
    if (!['kirvano', 'perfectpay'].includes(gateway)) {
        return res.status(400).json({ 
            success: false, 
            error: 'Gateway inválido. Use kirvano ou perfectpay' 
        });
    }
    
    if (!['approved', 'refunded', 'chargeback', 'canceled'].includes(event)) {
        return res.status(400).json({ 
            success: false, 
            error: 'Evento inválido' 
        });
    }
    
    try {
        // Cria venda simulada já no formato normalizado
        const fakeSaleId = `SIM_${Date.now()}_${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
        
        const simulatedSale = {
            gateway,
            event,
            sale_id: fakeSaleId,
            sale_amount: parseFloat(sale_amount) || 0,
            customer: {
                email: email.toLowerCase().trim(),
                name: customer_name || 'Cliente Simulado',
                phone: null,
                document: null,
            },
            items: [{
                offer_id,
                offer_name: 'Oferta simulada',
                product_name: null,
                is_order_bump: false,
            }],
            raw: { simulated: true, simulated_by: req.admin.username },
        };
        
        // Loga como webhook real
        const { rows: [log] } = await db.query(`
            INSERT INTO webhook_logs (
                gateway, event_type, sale_id, customer_email,
                signature_valid, raw_payload, source_ip
            ) VALUES ($1, $2, $3, $4, true, $5::jsonb, 'simulated')
            RETURNING id
        `, [gateway, event, fakeSaleId, email, JSON.stringify(simulatedSale)]);
        
        const summary = await processSale(simulatedSale);
        
        await db.query(`
            UPDATE webhook_logs
            SET processed = true, processed_at = NOW()
            WHERE id = $1
        `, [log.id]);
        
        logger.info(`Webhook simulado por ${req.admin.username}: ${gateway}/${event} → ${email}`);
        return res.json({ success: true, summary, sale_id: fakeSaleId });
    } catch (err) {
        logger.error('Erro simulando webhook:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


module.exports = router;
