/**
 * =============================================================================
 * routes/user-encounters.js — ENCONTROS (lado do app) — out/2026
 * =============================================================================
 *   GET  /api/user/encounters/state      → config pública, perfil, curtidas,
 *                                           trava, plano, deck (cards)
 *   POST /api/user/encounters/swipe      { chat_id, action: 'like'|'pass' }
 *   POST /api/user/encounters/undo       (Premium) desfaz o último
 *   POST /api/user/encounters/profile    { name, age, age_min, age_max, email? }
 *   POST /api/user/encounters/seen       marca curtidas recebidas como vistas
 *   POST /api/user/encounters/open       { chat_id, src } → prepara a conversa
 *                                           (match: N msgs grátis num chat VIP)
 *   POST /api/user/encounters/event      { type, meta } → métrica (tracking_events)
 * =============================================================================
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const { logger } = require('../lib/logger');
const { optionalUser, loginClient, USER_COOKIE_NAME, USER_COOKIE_OPTIONS } = require('../lib/user-auth');
const E = require('../lib/encounters');

async function planOf(email) {
    if (!email) return { vip: false, premium: false };
    let premium = false, vip = false;
    try { premium = await require('./user').isPremiumCustomer(email); } catch (_) {}
    if (!premium) {
        try {
            const { rows } = await db.query(
                `SELECT 1 FROM user_access ua JOIN products p ON p.id = ua.product_id
                  WHERE LOWER(ua.email) = $1 AND p.is_chat_plan = true AND ua.status = 'active'
                    AND (ua.expires_at IS NULL OR ua.expires_at > NOW()) LIMIT 1`, [email]);
            vip = rows.length > 0;
        } catch (_) {}
    }
    return { vip: vip || premium, premium };
}

function cardOf(c, identity, cfg) {
    return {
        chat_id: c.id, name: c.name, avatar_url: c.avatar_url,
        age: c.enc_age || null, tag: E.tagFor(c),
        dist_km: E.distanceKm(identity, c.id, cfg),
        online: c.show_online !== false,
    };
}

async function track(type, id, meta) {
    try {
        await db.query(`INSERT INTO tracking_events (event_type, customer_email, metadata) VALUES ($1, $2, $3::jsonb)`,
            [type, id.email, JSON.stringify(Object.assign({ vid: id.vid || null }, meta || {}))]);
    } catch (_) {}
}

// ── estado completo ──────────────────────────────────────────────────────────
router.get('/encounters/state', optionalUser, async (req, res) => {
    try {
        const cfg = await E.loadConfig();
        const id = E.identityOf(req);
        if (!cfg.enabled) return res.json({ success: true, enabled: false });
        if (!id.key) return res.json({ success: true, enabled: true, needs_identity: true });

        const plan = await planOf(id.email);
        const profile = await E.profileFor(id);
        const st = await E.getState(id.key);

        // trava vencida → libera e zera o contador
        let lockUntil = st.lock_until ? new Date(st.lock_until) : null;
        let likesUsed = st.likes_used;
        if (lockUntil && lockUntil <= new Date()) {
            await db.query(`UPDATE encounter_state SET lock_until = NULL, likes_used = 0, updated_at = NOW() WHERE identity = $1`, [id.key]);
            lockUntil = null; likesUsed = 0;
        }

        // deck: chats habilitados que ele ainda não deslizou; "passou" volta
        // depois de 24h (recarga); "curtiu" não volta.
        const { rows: chats } = await db.query(
            `SELECT c.* FROM chats c
              WHERE c.active = true AND c.enc_enabled = true
                AND NOT EXISTS (SELECT 1 FROM encounter_swipes s WHERE s.identity = $1 AND s.chat_id = c.id
                                  AND (s.action = 'like' OR s.created_at > NOW() - INTERVAL '24 hours'))
              ORDER BY c.enc_order, c.display_order, c.id`, [id.key]);
        const deck = chats.map(c => cardOf(c, id.key, cfg));

        // curtidas recebidas (entregues) + matches
        const { rows: likes } = await db.query(
            `SELECT l.chat_id, l.is_match, l.seen_at, l.delivered_at, l.free_msgs_left, c.name, c.avatar_url, c.enc_age, c.enc_tag
               FROM encounter_likes l JOIN chats c ON c.id = l.chat_id
              WHERE l.identity = $1 AND l.delivered_at IS NOT NULL ORDER BY l.delivered_at DESC`, [id.key]);
        const received = likes.map(l => ({
            chat_id: l.chat_id, name: l.name, avatar_url: l.avatar_url, age: l.enc_age,
            dist_km: E.distanceKm(id.key, l.chat_id, cfg), is_match: l.is_match, seen: !!l.seen_at,
            can_open: plan.premium || l.is_match,
        }));
        const { rows: cnt } = await db.query(`SELECT COUNT(*)::int AS n FROM encounter_swipes WHERE identity = $1`, [id.key]);

        return res.json({
            success: true, enabled: true,
            cfg: { free_likes: cfg.free_likes, profile_after: cfg.profile_after, free_msgs: cfg.free_msgs,
                   intro_title: cfg.intro_title, intro_text: cfg.intro_text },
            online: E.onlineCount(cfg),
            plan,
            identified: !!id.email,
            profile: profile ? { name: profile.name, age: profile.age, age_min: profile.age_min, age_max: profile.age_max, photo_url: profile.photo_url } : null,
            swipes: cnt[0].n,
            likes_used: likesUsed,
            likes_left: plan.vip ? null : Math.max(0, cfg.free_likes - likesUsed),
            lock_until: lockUntil ? lockUntil.toISOString() : null,
            received,
            unseen: received.filter(r => !r.seen).length,
            deck,
        });
    } catch (err) {
        logger.error('[encontros] state:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// ── deslizar ─────────────────────────────────────────────────────────────────
router.post('/encounters/swipe', optionalUser, async (req, res) => {
    try {
        const cfg = await E.loadConfig();
        const id = E.identityOf(req);
        if (!cfg.enabled || !id.key) return res.status(400).json({ success: false, error: 'indisponível' });
        const chatId = parseInt(req.body && req.body.chat_id, 10);
        const action = req.body && req.body.action === 'like' ? 'like' : 'pass';
        if (!chatId) return res.status(400).json({ success: false, error: 'chat_id' });
        const { rows: cr } = await db.query(`SELECT id FROM chats WHERE id = $1 AND active = true AND enc_enabled = true`, [chatId]);
        if (!cr.length) return res.status(404).json({ success: false, error: 'perfil não encontrado' });

        const plan = await planOf(id.email);
        const st = await E.getState(id.key);

        if (action === 'like' && !plan.vip) {
            if (st.lock_until && new Date(st.lock_until) > new Date()) {
                return res.json({ success: true, locked: true, lock_until: new Date(st.lock_until).toISOString() });
            }
            if (st.lock_until) { // trava venceu: zera
                await db.query(`UPDATE encounter_state SET lock_until = NULL, likes_used = 0 WHERE identity = $1`, [id.key]);
                st.likes_used = 0;
            }
            if (st.likes_used >= cfg.free_likes) {
                const hours = cfg.lock_hours * Math.pow(cfg.lock_mult, st.lock_count);
                const until = new Date(Date.now() + hours * 3600000);
                await db.query(`UPDATE encounter_state SET lock_until = $2, lock_count = lock_count + 1, updated_at = NOW() WHERE identity = $1`, [id.key, until]);
                await track('enc_locked', id, { lock_count: st.lock_count + 1, hours });
                return res.json({ success: true, locked: true, lock_until: until.toISOString() });
            }
        }

        await db.query(
            `INSERT INTO encounter_swipes (identity, chat_id, action) VALUES ($1, $2, $3)
             ON CONFLICT (identity, chat_id) DO UPDATE SET action = EXCLUDED.action, created_at = NOW()`,
            [id.key, chatId, action]);
        let likesLeft = null;
        if (action === 'like') {
            if (!plan.vip) {
                const { rows: up } = await db.query(`UPDATE encounter_state SET likes_used = likes_used + 1, updated_at = NOW() WHERE identity = $1 RETURNING likes_used`, [id.key]);
                likesLeft = Math.max(0, cfg.free_likes - up[0].likes_used);
            }
            // agenda a curtida de volta (Premium: sempre match; grátis: % do painel)
            const { rows: n } = await db.query(`SELECT COUNT(*)::int AS n FROM encounter_likes WHERE identity = $1`, [id.key]);
            const isMatch = plan.premium || (Math.random() * 100 < cfg.match_pct);
            const due = E.likeBackDue(cfg, n[0].n);
            await db.query(
                `INSERT INTO encounter_likes (identity, email, chat_id, due_at, is_match, free_msgs_left)
                 VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (identity, chat_id) DO NOTHING`,
                [id.key, id.email, chatId, due, isMatch, isMatch ? cfg.free_msgs : 0]);
        }
        await track(action === 'like' ? 'enc_like' : 'enc_pass', id, { chat_id: chatId });
        return res.json({ success: true, locked: false, likes_left: likesLeft });
    } catch (err) {
        logger.error('[encontros] swipe:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// ── desfazer (Premium) ───────────────────────────────────────────────────────
router.post('/encounters/undo', optionalUser, async (req, res) => {
    try {
        const id = E.identityOf(req);
        if (!id.key) return res.status(400).json({ success: false });
        const plan = await planOf(id.email);
        if (!plan.premium) return res.status(403).json({ success: false, error: 'premium_required' });
        const { rows } = await db.query(
            `DELETE FROM encounter_swipes WHERE id = (SELECT id FROM encounter_swipes WHERE identity = $1 ORDER BY created_at DESC LIMIT 1) RETURNING chat_id, action`, [id.key]);
        if (rows[0] && rows[0].action === 'like') {
            await db.query(`DELETE FROM encounter_likes WHERE identity = $1 AND chat_id = $2 AND delivered_at IS NULL`, [id.key, rows[0].chat_id]);
        }
        return res.json({ success: true, chat_id: rows[0] ? rows[0].chat_id : null });
    } catch (err) {
        logger.error('[encontros] undo:', err);
        return res.status(500).json({ success: false });
    }
});

// ── perfil do lead ───────────────────────────────────────────────────────────
router.post('/encounters/profile', optionalUser, async (req, res) => {
    try {
        const b = req.body || {};
        let id = E.identityOf(req);
        const name = String(b.name || '').trim().slice(0, 60);
        const age = parseInt(b.age, 10);
        if (!name) return res.status(400).json({ success: false, error: 'Coloque seu nome ou apelido.' });
        if (!age || age < 18 || age > 99) return res.status(400).json({ success: false, error: 'Idade precisa ser 18 ou mais.' });
        let ageMin = Math.max(18, Math.min(60, parseInt(b.age_min, 10) || 18));
        let ageMax = Math.max(18, Math.min(60, parseInt(b.age_max, 10) || 45));
        if (ageMin > ageMax) { const t = ageMin; ageMin = ageMax; ageMax = t; }

        // lead ainda sem e-mail → e-mail OBRIGATÓRIO aqui (vira login de verdade)
        let loggedNow = null;
        if (!id.email) {
            const email = String(b.email || '').trim().toLowerCase();
            if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ success: false, error: 'Coloque um e-mail válido.' });
            const result = await loginClient(email);
            if (!result.success) return res.status(400).json({ success: false, error: result.error || 'Não deu pra entrar.' });
            res.cookie(USER_COOKIE_NAME, result.token, USER_COOKIE_OPTIONS);
            loggedNow = result.email.toLowerCase();
            // tudo que ele fez como visitante passa pro e-mail
            if (id.vid) await E.mergeIdentity('v:' + id.vid, loggedNow).catch(() => {});
            id = { email: loggedNow, vid: id.vid, key: loggedNow };
        }
        if (!id.key) return res.status(400).json({ success: false, error: 'visitor_id' });

        const photo = (typeof b.photo_url === 'string' && /^(https?:\/\/|data:image\/)/.test(b.photo_url) && b.photo_url.length <= 400000) ? b.photo_url : null;
        await db.query(
            `INSERT INTO encounter_profiles (identity, email, visitor_id, name, age, age_min, age_max, photo_url)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (identity) DO UPDATE SET name = EXCLUDED.name, age = EXCLUDED.age, age_min = EXCLUDED.age_min, age_max = EXCLUDED.age_max,
                 photo_url = COALESCE(EXCLUDED.photo_url, encounter_profiles.photo_url), email = COALESCE(EXCLUDED.email, encounter_profiles.email), updated_at = NOW()`,
            [id.key, id.email, id.vid, name, age, ageMin, ageMax, photo]);
        // nome no cadastro do cliente (alimenta {nome} em TODOS os chats)
        if (id.email) {
            await db.query(`UPDATE customers SET name = COALESCE(NULLIF(name, ''), $2) WHERE LOWER(email) = $1`, [id.email, name]).catch(() => {});
        }
        await track('enc_profile', id, { age, logged_now: !!loggedNow });
        return res.json({ success: true, email: id.email, logged_now: !!loggedNow });
    } catch (err) {
        logger.error('[encontros] profile:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

router.post('/encounters/seen', optionalUser, async (req, res) => {
    try {
        const id = E.identityOf(req);
        if (id.key) await db.query(`UPDATE encounter_likes SET seen_at = NOW() WHERE identity = $1 AND seen_at IS NULL AND delivered_at IS NOT NULL`, [id.key]);
    } catch (_) {}
    return res.json({ success: true });
});

// ── abrir conversa a partir do Encontros ─────────────────────────────────────
// src: 'match' (curtida mútua) | 'msg' (botão verde, Premium) | 'likes'
// Devolve se pode abrir e quantas mensagens grátis tem (chat VIP + match).
router.post('/encounters/open', optionalUser, async (req, res) => {
    try {
        const cfg = await E.loadConfig();
        const id = E.identityOf(req);
        const chatId = parseInt(req.body && req.body.chat_id, 10);
        const src = String((req.body && req.body.src) || 'match').slice(0, 20);
        if (!id.key || !chatId) return res.status(400).json({ success: false });
        const plan = await planOf(id.email);
        if (src === 'msg' && !plan.premium) return res.status(403).json({ success: false, error: 'premium_required' });
        if (src === 'msg') {
            // mensagem direta: conta como curtida + match na hora (sem fila)
            await db.query(`INSERT INTO encounter_swipes (identity, chat_id, action) VALUES ($1, $2, 'like') ON CONFLICT (identity, chat_id) DO UPDATE SET action = 'like'`, [id.key, chatId]);
            await db.query(
                `INSERT INTO encounter_likes (identity, email, chat_id, due_at, is_match, delivered_at, seen_at, free_msgs_left)
                 VALUES ($1, $2, $3, NOW(), true, NOW(), NOW(), 0)
                 ON CONFLICT (identity, chat_id) DO UPDATE SET is_match = true, delivered_at = COALESCE(encounter_likes.delivered_at, NOW()), seen_at = NOW()`,
                [id.key, id.email, chatId]);
        } else {
            const { rows } = await db.query(`SELECT is_match FROM encounter_likes WHERE identity = $1 AND chat_id = $2 AND delivered_at IS NOT NULL`, [id.key, chatId]);
            if (!rows.length || (!rows[0].is_match && !plan.premium)) return res.status(403).json({ success: false, error: 'premium_required' });
        }
        await track('enc_open_chat', id, { chat_id: chatId, src });
        return res.json({ success: true, chat_id: chatId, free_msgs: plan.vip ? null : cfg.free_msgs });
    } catch (err) {
        logger.error('[encontros] open:', err);
        return res.status(500).json({ success: false });
    }
});

router.post('/encounters/event', optionalUser, async (req, res) => {
    try {
        const id = E.identityOf(req);
        const type = String((req.body && req.body.type) || '').replace(/[^a-z_]/g, '').slice(0, 40);
        if (type && /^enc_/.test(type)) await track(type, id, (req.body && req.body.meta) || {});
    } catch (_) {}
    return res.json({ success: true });
});

module.exports = router;
