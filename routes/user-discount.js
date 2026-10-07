/**
 * =============================================================================
 * routes/user-discount.js — Desconto ao desistir (lado do app)
 * =============================================================================
 *   GET  /api/user/discount/state?kind=access|group&ref=<group_id>
 *        → { eligible, delay_sec, headline, sub, city, offer: {...} }
 *   POST /api/user/discount/shown  { kind, ref }   → marca que ELE JÁ GANHOU
 *        o desconto (1 na vida). Chamado quando o popup abre.
 *   POST /api/user/discount/click  { kind, ref, plan }  → só métrica.
 * =============================================================================
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const { logger } = require('../lib/logger');
const { optionalUser } = require('../lib/user-auth');
const discount = require('../lib/exit-discount');
const { resolveCity, cleanIp } = require('../lib/geo');

function identity(req) {
    const email = (req.user && req.user.email && !req.user.anonymous) ? String(req.user.email).toLowerCase() : null;
    const raw = (req.body && req.body.visitor_id) || (req.query && req.query.visitor_id) || '';
    const vid = String(raw).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || null;
    return { email, vid, key: email || (vid ? 'v:' + vid : null) };
}

router.get('/discount/state', optionalUser, async (req, res) => {
    try {
        const cfg = await discount.loadConfig();
        const kind = req.query.kind === 'group' ? 'group' : 'access';
        const ref = parseInt(req.query.ref, 10) || null;
        const id = identity(req);
        const none = { success: true, eligible: false };
        if (!id.key) return res.json(none);

        let offer = null;
        if (kind === 'group') {
            if (!cfg.group.enabled || !cfg.group.url || !ref) return res.json(none);
            const { rows } = await db.query(`SELECT id, name, product_id FROM groups WHERE id = $1 AND active = true`, [ref]);
            if (!rows[0] || !rows[0].product_id) return res.json(none);
            offer = { url: cfg.group.url, price: cfg.group.price, orig: cfg.group.orig, name: rows[0].name, src: 'group_' + rows[0].id };
        } else {
            if (!cfg.access.enabled) return res.json(none);
            const plans = [];
            if (cfg.access.premium_url) plans.push({ key: 'premium', name: 'PREMIUM', desc: 'Todas as conversas · vídeos e lives · grupo VIP', price: cfg.access.premium_price, orig: cfg.access.premium_orig, url: cfg.access.premium_url, src: 'desc_premium', recommended: true });
            if (cfg.access.vip_url) plans.push({ key: 'vip', name: 'VIP', desc: 'Conversa liberada com as modelos', price: cfg.access.vip_price, orig: cfg.access.vip_orig, url: cfg.access.vip_url, src: 'desc_vip' });
            if (!plans.length) return res.json(none);
            offer = { plans };
        }

        // já ganhou desconto alguma vez (por e-mail OU pelo aparelho) → nunca mais
        if (await discount.alreadyGot(id.key)) return res.json(none);
        if (id.email && id.vid && await discount.alreadyGot('v:' + id.vid)) return res.json(none);

        let city = null;
        try { city = resolveCity(cleanIp(req.headers['x-forwarded-for'] || req.ip)); } catch (_) {}

        return res.json({
            success: true, eligible: true, kind,
            delay_sec: cfg.delay_sec, min_dismissals: cfg.min_dismissals, minutes_valid: cfg.minutes_valid,
            headline: cfg.headline, sub: cfg.sub, city, offer,
        });
    } catch (err) {
        logger.error('[desconto] state:', err);
        return res.json({ success: true, eligible: false });
    }
});

router.post('/discount/shown', optionalUser, async (req, res) => {
    try {
        const id = identity(req);
        if (!id.key) return res.json({ success: true });
        const kind = req.body && req.body.kind === 'group' ? 'group' : 'access';
        const ref = parseInt(req.body && req.body.ref, 10) || null;
        await db.query(
            `INSERT INTO exit_discounts (identity, email, visitor_id, kind, ref) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (identity) DO NOTHING`,
            [id.key, id.email, id.vid, kind, ref]);
        return res.json({ success: true });
    } catch (err) {
        logger.warn('[desconto] shown: ' + err.message);
        return res.json({ success: true });
    }
});

router.post('/discount/click', optionalUser, async (req, res) => {
    try {
        const id = identity(req);
        if (id.key) {
            await db.query(`UPDATE exit_discounts SET clicked_at = NOW(), plan = $2 WHERE identity = $1`,
                [id.key, String((req.body && req.body.plan) || '').slice(0, 20) || null]);
        }
    } catch (_) {}
    return res.json({ success: true });
});

module.exports = router;
