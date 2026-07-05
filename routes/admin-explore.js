/**
 * =============================================================================
 * routes/admin-explore.js — Admin do feed Explorar/TikTok
 * =============================================================================
 * CRUD de explore_videos + config (limite grátis, gate de PWA, produto de
 * desbloqueio) e config do gate de PWA global. Tudo sob requireAdmin.
 * =============================================================================
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const { logger } = require('../lib/logger');
const { requireAdmin } = require('../lib/auth');

// ── sanitizadores ────────────────────────────────────────────────────────────
function sanitizeUrl(raw) {
    const s = (raw || '').toString().trim().slice(0, 1000);
    if (!s) return null;
    if (!/^https?:\/\//i.test(s)) return null;
    return s;
}
function sanitizeBunnyLib(raw) {
    const s = (raw || '').toString().trim();
    return /^\d+$/.test(s) ? s.slice(0, 20) : null;
}
function sanitizeBunnyGuid(raw) {
    const s = (raw || '').toString().trim();
    return /^[a-zA-Z0-9\-_]+$/.test(s) ? s.slice(0, 60) : null;
}

// ── CONFIG (explore_config + pwa_gate_config) ────────────────────────────────
const DEFAULT_EXPLORE = {
    enabled: false, free_limit: 15, pwa_gate_after: 2,
    product_id: null, checkout_url: null, unlock_offer_codes: null,
    // Pasta (coleção) do Bunny — preenchida, alimenta o feed inteiro de uma vez
    // (igual aos conteúdos do produto). Tem prioridade sobre a lista manual.
    collection_library_id: null, collection_id: null, creator_name: null,
    paywall_title: 'Isso foi só a amostra 🔥',
    paywall_text: 'Acesso TOTAL a todos os vídeos, sem limite nenhum — com conteúdo novo entrando todo dia. Os mais quentes ficam do outro lado.',
    paywall_cta: 'QUERO ACESSO VIP',
    // Oferta exibida no paywall (de X por Y)
    offer_original_price: 49.90,
    offer_price: 19.90,
    offer_note: 'liberação imediata após o pagamento',
};
const DEFAULT_PWA_GATE = {
    gate_stories: true, gate_view_once: true, gate_explore: true,
    title: 'Falta um passo',
    text: 'Instale o app na tela inicial pra ver esse conteúdo.',
};

async function readConfig(key, fallback) {
    try {
        const { rows } = await db.query(`SELECT value FROM gamification_config WHERE key = $1`, [key]);
        return { ...fallback, ...(rows[0]?.value || {}) };
    } catch (_) { return { ...fallback }; }
}
async function writeConfig(key, value, who) {
    await db.query(
        `INSERT INTO gamification_config (key, value, updated_by, updated_at)
         VALUES ($1, $2::jsonb, $3, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_by = $3, updated_at = NOW()`,
        [key, JSON.stringify(value), who || 'admin']
    );
}

// GET /settings — devolve as duas configs (Explorar + gate de PWA)
router.get('/settings', requireAdmin, async (req, res) => {
    try {
        const explore = await readConfig('explore_config', DEFAULT_EXPLORE);
        const pwa_gate = await readConfig('pwa_gate_config', DEFAULT_PWA_GATE);
        return res.json({ success: true, explore, pwa_gate });
    } catch (err) {
        logger.error('Erro lendo settings do Explorar:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// PUT /settings — grava explore_config e/ou pwa_gate_config
router.put('/settings', requireAdmin, async (req, res) => {
    try {
        const b = req.body || {};
        if (b.explore && typeof b.explore === 'object') {
            const cur = await readConfig('explore_config', DEFAULT_EXPLORE);
            const e = b.explore;
            const next = {
                ...cur,
                enabled: e.enabled === true,
                free_limit: Math.max(0, Math.min(9999, parseInt(e.free_limit, 10) || 0)),
                pwa_gate_after: Math.max(0, Math.min(9999, parseInt(e.pwa_gate_after, 10) || 0)),
                product_id: e.product_id ? parseInt(e.product_id, 10) : null,
                checkout_url: sanitizeUrl(e.checkout_url),
                unlock_offer_codes: (e.unlock_offer_codes || '').toString().trim().slice(0, 500) || null,
                collection_library_id: sanitizeBunnyLib(e.collection_library_id),
                collection_id: sanitizeBunnyGuid(e.collection_id),
                creator_name: (e.creator_name || '').toString().trim().slice(0, 120) || null,
                paywall_title: (e.paywall_title || '').toString().trim().slice(0, 120) || DEFAULT_EXPLORE.paywall_title,
                paywall_text: (e.paywall_text || '').toString().trim().slice(0, 300) || DEFAULT_EXPLORE.paywall_text,
                paywall_cta: (e.paywall_cta || '').toString().trim().slice(0, 40) || DEFAULT_EXPLORE.paywall_cta,
                offer_original_price: e.offer_original_price != null && e.offer_original_price !== '' ? Math.max(0, parseFloat(e.offer_original_price)) || null : null,
                offer_price: e.offer_price != null && e.offer_price !== '' ? Math.max(0, parseFloat(e.offer_price)) || null : null,
                offer_note: (e.offer_note || '').toString().trim().slice(0, 80) || null,
            };
            await writeConfig('explore_config', next, req.admin?.username);
        }
        if (b.pwa_gate && typeof b.pwa_gate === 'object') {
            const cur = await readConfig('pwa_gate_config', DEFAULT_PWA_GATE);
            const g = b.pwa_gate;
            const next = {
                ...cur,
                gate_stories: g.gate_stories === true,
                gate_view_once: g.gate_view_once === true,
                gate_explore: g.gate_explore === true,
                title: (g.title || '').toString().trim().slice(0, 80) || DEFAULT_PWA_GATE.title,
                text: (g.text || '').toString().trim().slice(0, 200) || DEFAULT_PWA_GATE.text,
            };
            await writeConfig('pwa_gate_config', next, req.admin?.username);
        }
        return res.json({ success: true });
    } catch (err) {
        logger.error('Erro salvando settings do Explorar:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// ── VÍDEOS ───────────────────────────────────────────────────────────────────
router.get('/videos', requireAdmin, async (req, res) => {
    try {
        const { rows } = await db.query(`SELECT * FROM explore_videos ORDER BY position, id`);
        return res.json({ success: true, videos: rows });
    } catch (err) {
        logger.error('Erro listando vídeos do Explorar:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

router.post('/videos', requireAdmin, async (req, res) => {
    try {
        const b = req.body || {};
        const { rows } = await db.query(`
            INSERT INTO explore_videos (caption, creator_name, video_url, bunny_library_id, bunny_video_id, hls_url, thumbnail_url, likes_seed, position, active)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
        `, [
            (b.caption || '').toString().trim().slice(0, 300) || null,
            (b.creator_name || '').toString().trim().slice(0, 120) || null,
            sanitizeUrl(b.video_url),
            sanitizeBunnyLib(b.bunny_library_id),
            sanitizeBunnyGuid(b.bunny_video_id),
            sanitizeUrl(b.hls_url),
            sanitizeUrl(b.thumbnail_url),
            Math.max(0, parseInt(b.likes_seed, 10) || 0),
            parseInt(b.position, 10) || 0,
            b.active !== false,
        ]);
        return res.json({ success: true, video: rows[0] });
    } catch (err) {
        logger.error('Erro criando vídeo do Explorar:', err);
        return res.status(500).json({ success: false, error: err.message || 'Erro interno' });
    }
});

router.put('/videos/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const b = req.body || {};
        const updates = []; const values = []; let p = 1;
        const set = (col, val) => { updates.push(`${col} = $${p++}`); values.push(val); };
        if (b.caption !== undefined) set('caption', (b.caption || '').toString().trim().slice(0, 300) || null);
        if (b.creator_name !== undefined) set('creator_name', (b.creator_name || '').toString().trim().slice(0, 120) || null);
        if (b.video_url !== undefined) set('video_url', sanitizeUrl(b.video_url));
        if (b.bunny_library_id !== undefined) set('bunny_library_id', sanitizeBunnyLib(b.bunny_library_id));
        if (b.bunny_video_id !== undefined) set('bunny_video_id', sanitizeBunnyGuid(b.bunny_video_id));
        if (b.hls_url !== undefined) set('hls_url', sanitizeUrl(b.hls_url));
        if (b.thumbnail_url !== undefined) set('thumbnail_url', sanitizeUrl(b.thumbnail_url));
        if (b.likes_seed !== undefined) set('likes_seed', Math.max(0, parseInt(b.likes_seed, 10) || 0));
        if (b.position !== undefined) set('position', parseInt(b.position, 10) || 0);
        if (b.active !== undefined) set('active', !!b.active);
        if (!updates.length) return res.status(400).json({ success: false, error: 'Nada pra atualizar' });
        set('updated_at', new Date());
        values.push(id);
        const { rows } = await db.query(`UPDATE explore_videos SET ${updates.join(', ')} WHERE id = $${p} RETURNING *`, values);
        if (!rows.length) return res.status(404).json({ success: false, error: 'Não encontrado' });
        return res.json({ success: true, video: rows[0] });
    } catch (err) {
        logger.error('Erro atualizando vídeo do Explorar:', err);
        return res.status(500).json({ success: false, error: err.message || 'Erro interno' });
    }
});

router.delete('/videos/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { rowCount } = await db.query(`DELETE FROM explore_videos WHERE id = $1`, [id]);
        if (!rowCount) return res.status(404).json({ success: false, error: 'Não encontrado' });
        return res.json({ success: true, deleted: true });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// POST /videos/reorder — recebe array de ids na ordem desejada
router.post('/videos/reorder', requireAdmin, async (req, res) => {
    try {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(x => parseInt(x, 10)).filter(Boolean) : [];
        if (!ids.length) return res.json({ success: true });
        await db.transaction(async (client) => {
            for (let i = 0; i < ids.length; i++) {
                await client.query(`UPDATE explore_videos SET position = $1, updated_at = NOW() WHERE id = $2`, [i, ids[i]]);
            }
        });
        return res.json({ success: true });
    } catch (err) {
        logger.error('Erro reordenando vídeos do Explorar:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

module.exports = router;
