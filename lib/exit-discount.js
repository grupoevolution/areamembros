/**
 * =============================================================================
 * lib/exit-discount.js — DESCONTO AO DESISTIR (out/2026)
 * =============================================================================
 *
 * O lead recusou a oferta (fechou o popup de planos 2x, ou foi pro checkout e
 * voltou sem pagar) → depois de X segundos aparece UM desconto, UMA vez na vida,
 * no produto onde ele desistiu: ACESSO (VIP/Premium) ou GRUPO. Nunca nos dois.
 *
 * Config no painel (gamification_config → key 'exit_discount'):
 *   { delay_sec, min_dismissals, headline, sub,
 *     access: { enabled, vip_url, vip_offer_id, vip_price, vip_orig,
 *               premium_url, premium_offer_id, premium_price, premium_orig },
 *     group:  { enabled, url, offer_id, price, orig } }
 *
 * O GRUPO usa UM link universal (9,90): a venda chega com o carimbo
 * utm_content = 'group_<id>' e é ESSE grupo que o sistema libera.
 * =============================================================================
 */

const db = require('../db');
const { logger } = require('./logger');

const DEFAULTS = {
    delay_sec: 25,
    min_dismissals: 2,
    headline: 'As meninas da sua região liberaram um desconto pra você entrar agora',
    sub: 'Só uma vez, só agora. Fechou, voltou pro preço normal.',
    minutes_valid: 10,
    access: { enabled: false, vip_url: '', vip_offer_id: '', vip_price: '14,90', vip_orig: '24,90',
              premium_url: '', premium_offer_id: '', premium_price: '29,90', premium_orig: '49,90' },
    group: { enabled: false, url: '', offer_id: '', price: '9,90', orig: '19,90' },
};

let _cache = { at: 0, cfg: null };

function str(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 300); }

async function loadConfig() {
    if (_cache.cfg && Date.now() - _cache.at < 30000) return _cache.cfg;
    let v = {};
    try {
        const { rows } = await db.query(`SELECT value FROM gamification_config WHERE key = 'exit_discount'`);
        v = (rows[0] && rows[0].value) || {};
    } catch (_) {}
    const a = v.access || {}, g = v.group || {};
    const cfg = {
        delay_sec: Math.max(0, Math.min(300, parseInt(v.delay_sec, 10) || DEFAULTS.delay_sec)),
        min_dismissals: Math.max(1, Math.min(10, parseInt(v.min_dismissals, 10) || DEFAULTS.min_dismissals)),
        minutes_valid: Math.max(1, Math.min(120, parseInt(v.minutes_valid, 10) || DEFAULTS.minutes_valid)),
        headline: str(v.headline) || DEFAULTS.headline,
        sub: str(v.sub) || DEFAULTS.sub,
        access: {
            enabled: a.enabled === true,
            vip_url: str(a.vip_url, 500), vip_offer_id: str(a.vip_offer_id, 120),
            vip_price: str(a.vip_price, 20) || DEFAULTS.access.vip_price, vip_orig: str(a.vip_orig, 20) || DEFAULTS.access.vip_orig,
            premium_url: str(a.premium_url, 500), premium_offer_id: str(a.premium_offer_id, 120),
            premium_price: str(a.premium_price, 20) || DEFAULTS.access.premium_price, premium_orig: str(a.premium_orig, 20) || DEFAULTS.access.premium_orig,
        },
        group: {
            enabled: g.enabled === true,
            url: str(g.url, 500), offer_id: str(g.offer_id, 120),
            price: str(g.price, 20) || DEFAULTS.group.price, orig: str(g.orig, 20) || DEFAULTS.group.orig,
        },
    };
    _cache = { at: Date.now(), cfg };
    return cfg;
}
function clearCache() { _cache = { at: 0, cfg: null }; }

// Um desconto por pessoa NA VIDA (identidade = e-mail, senão visitor_id).
async function alreadyGot(ident) {
    if (!ident) return false;
    const { rows } = await db.query(`SELECT 1 FROM exit_discounts WHERE identity = $1 LIMIT 1`, [ident]);
    return rows.length > 0;
}

/**
 * Venda chegou com o offer_id de um dos links de DESCONTO? Devolve o produto
 * que deve ser liberado (ou null se não é desconto). Para grupo, o grupo vem
 * do carimbo utm_content = 'group_<id>'.
 */
async function resolveDiscountOffer(gateway, offerId, utmContent) {
    const cfg = await loadConfig();
    const oid = String(offerId || '').trim();
    if (!oid) return null;

    if (cfg.group.offer_id && oid === cfg.group.offer_id) {
        const m = /^group_(\d+)$/.exec(String(utmContent || ''));
        if (!m) {
            logger.warn(`[desconto] venda ${gateway}/${oid} do grupo universal SEM carimbo de grupo (utm='${utmContent}') — liberar manualmente`);
            return { kind: 'group', product_id: null, offer_row_id: null, is_premium: false, missing_group: true };
        }
        const { rows } = await db.query(`SELECT product_id, name FROM groups WHERE id = $1`, [parseInt(m[1], 10)]);
        if (!rows[0] || !rows[0].product_id) {
            logger.warn(`[desconto] grupo ${m[1]} sem produto vinculado — liberar manualmente`);
            return { kind: 'group', product_id: null, offer_row_id: null, is_premium: false, missing_group: true };
        }
        return { kind: 'group', product_id: rows[0].product_id, offer_row_id: null, is_premium: false, label: rows[0].name };
    }

    const isVip = cfg.access.vip_offer_id && oid === cfg.access.vip_offer_id;
    const isPrem = cfg.access.premium_offer_id && oid === cfg.access.premium_offer_id;
    if (!isVip && !isPrem) return null;

    // produto do plano de chat (VIP/Premium moram no mesmo produto; Premium =
    // selo + extras, que precisam da oferta Premium cadastrada pra saber a duração)
    const { rows: pr } = await db.query(`SELECT id, name FROM products WHERE is_chat_plan = true AND is_active = true ORDER BY id LIMIT 1`);
    if (!pr[0]) { logger.warn('[desconto] nenhum produto is_chat_plan ativo'); return null; }
    let offerRowId = null;
    if (isPrem) {
        const { rows: po } = await db.query(
            `SELECT id FROM product_offers WHERE product_id = $1 AND is_active = true AND COALESCE(is_premium, false) = true
             ORDER BY priority DESC, id LIMIT 1`, [pr[0].id]);
        offerRowId = po[0] ? po[0].id : null;
    } else {
        const { rows: po } = await db.query(
            `SELECT id FROM product_offers WHERE product_id = $1 AND is_active = true AND COALESCE(is_premium, false) = false
             ORDER BY priority DESC, id LIMIT 1`, [pr[0].id]);
        offerRowId = po[0] ? po[0].id : null;
    }
    return { kind: isPrem ? 'premium' : 'vip', product_id: pr[0].id, offer_row_id: offerRowId, is_premium: !!isPrem, label: pr[0].name };
}

module.exports = { loadConfig, clearCache, alreadyGot, resolveDiscountOffer, DEFAULTS };
