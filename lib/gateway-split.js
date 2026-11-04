/**
 * lib/gateway-split.js — Segunda plataforma de pagamento (Stripe) por cima dos links da Kirvano
 *
 * Config em system_settings.gateway_split:
 *   { mode: 'kirvano' | 'split' | 'stripe',
 *     links: [{ name, kirvano_id, stripe_url, payment_link_id, pct, active }] }
 * mode 'kirvano' (padrão) = o app recebe lista vazia e nada muda.
 * A venda da Stripe libera o MESMO produto da oferta Kirvano do par.
 */
const db = require('../db');
const { logger } = require('./logger');

const TTL_MS = 30 * 1000;
const PCT = [10, 30, 50, 70, 80, 100];
const DEFAULT = { mode: 'kirvano', links: [] };
let cache = { val: null, at: 0 };

function sanitize(raw) {
    const c = raw && typeof raw === 'object' ? raw : {};
    const mode = ['kirvano', 'split', 'stripe'].includes(c.mode) ? c.mode : 'kirvano';
    const links = (Array.isArray(c.links) ? c.links : []).map(l => {
        const m = String(l.kirvano_id || '').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        const url = String(l.stripe_url || '').trim();
        const plink = String(l.payment_link_id || '').trim();
        if (!m || !/^https:\/\/(buy\.stripe\.com|checkout\.stripe\.com)\//i.test(url) || !/^plink_[A-Za-z0-9]+$/.test(plink)) return null;
        const pct = parseInt(l.pct, 10);
        return {
            name: String(l.name || '').slice(0, 80),
            kirvano_id: m[0].toLowerCase(),
            stripe_url: url,
            payment_link_id: plink,
            pct: PCT.includes(pct) ? pct : 10,
            active: l.active !== false,
        };
    }).filter(Boolean);
    return { mode, links };
}

async function getConfig() {
    if (cache.val && Date.now() - cache.at < TTL_MS) return cache.val;
    try {
        const { rows: [r] } = await db.query(`SELECT value FROM system_settings WHERE key = 'gateway_split'`);
        cache = { val: sanitize(r ? r.value : DEFAULT), at: Date.now() };
    } catch (err) {
        logger.warn('gateway_split: ' + err.message);
        if (!cache.val) return DEFAULT; // sem cache e sem banco: tudo na Kirvano
    }
    return cache.val;
}

async function saveConfig(raw, by) {
    const clean = sanitize(raw);
    await db.query(
        `INSERT INTO system_settings (key, value, description, updated_by, updated_at)
         VALUES ('gateway_split', $1::jsonb, 'Divisão de vendas Kirvano x Stripe', $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        [JSON.stringify(clean), by || 'admin']
    );
    cache = { val: clean, at: Date.now() };
    return clean;
}

// O que o app recebe: só os pares que podem receber venda agora.
async function publicLinks() {
    const c = await getConfig();
    if (c.mode === 'kirvano') return [];
    return c.links.filter(l => l.active).map(l => ({
        k: l.kirvano_id,
        s: l.stripe_url,
        p: c.mode === 'stripe' ? 100 : l.pct,
    }));
}

async function kirvanoOfferFor(paymentLinkId) {
    const c = await getConfig();
    const l = c.links.find(x => x.payment_link_id === paymentLinkId);
    return l ? l.kirvano_id : null;
}

module.exports = { getConfig, saveConfig, publicLinks, kirvanoOfferFor, PCT };
