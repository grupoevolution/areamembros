/**
 * lib/refund-guard.js — Trava de reembolso (decisão do dono, 12/11/2026)
 *
 * 1º reembolso/contestação de compra PAGA: tira só aquele produto (o processor já faz)
 *   e o cliente entra na lista "Em observação".
 * 2º reembolso do mesmo cliente (mesmo e-mail OU mesmo CPF): bloqueio total — perde
 *   todos os acessos e o app mostra "Acesso suspenso".
 * Reembolso de chamada até N min depois da compra = etiqueta "rápido" (não bloqueia sozinho).
 * Começa DESLIGADA: desligada, só registra (a lista "Em observação" enche igual).
 *
 * Config em system_settings.refund_guard: { enabled, threshold, quick_minutes }
 */
const db = require('../db');
const { logger } = require('./logger');

const DEFAULT = { enabled: false, threshold: 2, quick_minutes: 60 };
const BLOCK_REASON = 'Bloqueio por reembolso';
let cache = { val: null, at: 0 };

function cleanDoc(d) {
    const s = String(d || '').replace(/\D/g, '');
    return s.length >= 11 ? s : null;
}

async function getConfig() {
    if (cache.val && Date.now() - cache.at < 30000) return cache.val;
    try {
        const { rows: [r] } = await db.query(`SELECT value FROM system_settings WHERE key = 'refund_guard'`);
        const v = (r && r.value) || {};
        cache = {
            val: {
                enabled: v.enabled === true,
                threshold: Math.max(2, Math.min(10, parseInt(v.threshold, 10) || DEFAULT.threshold)),
                quick_minutes: Math.max(5, Math.min(1440, parseInt(v.quick_minutes, 10) || DEFAULT.quick_minutes)),
            },
            at: Date.now(),
        };
    } catch (err) {
        logger.warn('refund_guard config: ' + err.message);
        return cache.val || DEFAULT;
    }
    return cache.val;
}

async function saveConfig(v, by) {
    const cur = await getConfig();
    const next = {
        enabled: v.enabled === undefined ? cur.enabled : v.enabled === true,
        threshold: Math.max(2, Math.min(10, parseInt(v.threshold, 10) || cur.threshold)),
        quick_minutes: Math.max(5, Math.min(1440, parseInt(v.quick_minutes, 10) || cur.quick_minutes)),
    };
    await db.query(
        `INSERT INTO system_settings (key, value, description, updated_by, updated_at)
         VALUES ('refund_guard', $1::jsonb, 'Trava de reembolso', $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        [JSON.stringify(next), by || 'admin']);
    cache = { val: next, at: Date.now() };
    return next;
}

// CPF do cliente: o do evento ou o que já está no cadastro.
async function docFor(email, doc) {
    const d = cleanDoc(doc);
    if (d) return d;
    const { rows: [c] } = await db.query(`SELECT document FROM customers WHERE LOWER(email) = $1`, [email]);
    return cleanDoc(c && c.document);
}

/** E-mail (ou CPF) bloqueado? */
async function isBlocked(email, doc) {
    const d = cleanDoc(doc);
    const { rows } = await db.query(
        `SELECT 1 FROM blocked_customers
          WHERE unblocked_at IS NULL AND (email = $1 OR ($2::text IS NOT NULL AND document = $2))
          LIMIT 1`, [String(email || '').toLowerCase().trim(), d]);
    return rows.length > 0;
}

/**
 * Chamado pelo processor DEPOIS de revogar um reembolso/contestação que tirou
 * pelo menos 1 acesso pago. Registra e, se passar do limite, bloqueia.
 */
async function onRefund(sale, email, revokedProductIds) {
    try {
        const doc = await docFor(email, sale.customer && sale.customer.document);
        const cfg = await getConfig();
        // "Rápido": alguma CHAMADA reembolsada até N min depois da compra.
        const { rows: [q] } = await db.query(
            `SELECT EXISTS (
                SELECT 1 FROM user_access ua JOIN products p ON p.id = ua.product_id
                 WHERE ua.gateway = $1 AND ua.sale_id = $2 AND p.product_type = 'video_call'
                   AND ua.granted_at > NOW() - make_interval(mins => $3)
             ) AS quick`, [sale.gateway, sale.sale_id, cfg.quick_minutes]);
        await db.query(
            `INSERT INTO refund_events (gateway, sale_id, email, document, kind, quick, product_ids)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (gateway, sale_id) DO NOTHING`,
            [sale.gateway, sale.sale_id, email, doc, sale.event, !!(q && q.quick), revokedProductIds]);
        const { rows: [c] } = await db.query(
            `SELECT COUNT(*)::int AS n FROM refund_events
              WHERE email = $1 OR ($2::text IS NOT NULL AND document = $2)`, [email, doc]);
        if (!cfg.enabled || c.n < cfg.threshold) return { blocked: false, count: c.n };
        await block(email, doc, `${c.n} reembolsos`, 'auto');
        return { blocked: true, count: c.n };
    } catch (err) {
        logger.error('refund_guard onRefund: ' + err.message);
        return { blocked: false, error: err.message };
    }
}

/** Bloqueia o e-mail (e todo e-mail com o mesmo CPF) e tira todos os acessos ativos. */
async function block(email, doc, reason, by) {
    const d = cleanDoc(doc);
    const emails = new Set([email]);
    if (d) {
        const { rows } = await db.query(`SELECT LOWER(email) AS email FROM customers WHERE document = $1`, [d]);
        rows.forEach(r => emails.add(r.email));
    }
    for (const e of emails) {
        await db.query(
            `INSERT INTO blocked_customers (email, document, reason, blocked_by)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (email) DO UPDATE SET document = COALESCE(EXCLUDED.document, blocked_customers.document),
                 reason = EXCLUDED.reason, blocked_by = EXCLUDED.blocked_by, blocked_at = NOW(), unblocked_at = NULL`,
            [e, d, reason, by || 'auto']);
        const { rowCount } = await db.query(
            `UPDATE user_access SET status = 'manually_revoked', revoked_at = NOW(), revoke_reason = $2
              WHERE LOWER(email) = $1 AND status = 'active'`, [e, BLOCK_REASON]);
        logger.warn(`refund_guard: ${e} bloqueado (${reason}); ${rowCount} acesso(s) retirado(s)`);
    }
}

/** Desbloqueia e devolve os acessos que a trava tirou. */
async function unblock(email, by) {
    const e = String(email || '').toLowerCase().trim();
    const { rows: [b] } = await db.query(
        `UPDATE blocked_customers SET unblocked_at = NOW(), unblocked_by = $2
          WHERE email = $1 AND unblocked_at IS NULL RETURNING document`, [e, by || 'admin']);
    if (!b) return { unblocked: false };
    const { rowCount } = await db.query(
        `UPDATE user_access SET status = 'active', revoked_at = NULL, revoke_reason = NULL
          WHERE LOWER(email) = $1 AND status = 'manually_revoked' AND revoke_reason = $2`, [e, BLOCK_REASON]);
    return { unblocked: true, restored: rowCount };
}

/** Compra nova de cliente bloqueado: não libera, só registra pro dono devolver o dinheiro. */
async function logBlockedPurchase(sale, email) {
    try {
        await db.query(
            `INSERT INTO blocked_purchases (gateway, sale_id, email, amount) VALUES ($1, $2, $3, $4)
             ON CONFLICT (gateway, sale_id) DO NOTHING`,
            [sale.gateway, sale.sale_id, email, sale.sale_amount || null]);
    } catch (err) { logger.warn('refund_guard blocked purchase: ' + err.message); }
}

async function overview() {
    const cfg = await getConfig();
    const { rows: watch } = await db.query(
        `SELECT email, MAX(document) AS document, COUNT(*)::int AS refunds,
                COUNT(*) FILTER (WHERE quick)::int AS quick, MAX(created_at) AS last_at
           FROM refund_events GROUP BY email ORDER BY MAX(created_at) DESC LIMIT 200`);
    const { rows: blocked } = await db.query(
        `SELECT email, document, reason, blocked_by, blocked_at FROM blocked_customers
          WHERE unblocked_at IS NULL ORDER BY blocked_at DESC LIMIT 200`);
    const { rows: purchases } = await db.query(
        `SELECT gateway, sale_id, email, amount, created_at FROM blocked_purchases
          ORDER BY created_at DESC LIMIT 50`);
    return { config: cfg, watch, blocked, purchases };
}

module.exports = { getConfig, saveConfig, isBlocked, onRefund, block, unblock, logBlockedPurchase, overview };
