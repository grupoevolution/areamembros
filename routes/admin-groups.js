/**
 * =============================================================================
 * routes/admin-groups.js — gestão dos GRUPOS (grupos-bot estilo WhatsApp)
 * =============================================================================
 * CRUD dos grupos, elenco (personas) e import de cenas por JSON.
 * Formato das cenas (gerado fora e colado no painel):
 *   [{ "category": "papo|pesado|apresentacao|midia|cta|reacao|bomdia|boanoite",
 *      "period": "any|manha|tarde|noite|madrugada", "weight": 1,
 *      "messages": [{ "p": 1, "g": "f", "t": "text|image|presentation|cta",
 *                     "text": "...", "gap_s": 8, "link": "...", "pid": 12 }] }]
 * =============================================================================
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAdmin } = require('../lib/auth');
const { logger } = require('../lib/logger');

const CATEGORIES = ['papo', 'pesado', 'apresentacao', 'midia', 'cta', 'reacao', 'bomdia', 'boanoite'];
const PERIODS = ['any', 'manha', 'tarde', 'noite', 'madrugada'];

const urlList = (v) => {
    if (Array.isArray(v)) return v.map(s => String(s).trim()).filter(Boolean).slice(0, 500);
    if (typeof v === 'string') return v.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 500);
    return null;
};
const intOr = (v, d, min, max) => {
    const n = parseInt(v, 10);
    if (isNaN(n)) return d;
    return Math.max(min, Math.min(max, n));
};

function groupPayload(b) {
    return {
        name: (b.name || '').trim().slice(0, 120),
        avatar_url: (b.avatar_url || '').trim().slice(0, 1000) || null,
        description: (b.description || '').trim().slice(0, 1000) || null,
        is_free: b.is_free === true,
        pinned: b.pinned === true,
        product_id: b.product_id ? parseInt(b.product_id, 10) : null,
        telegram_url: (b.telegram_url || '').trim().slice(0, 500) || null,
        cta_label: (b.cta_label || '').trim().slice(0, 120) || null,
        cta_link: (b.cta_link || '').trim().slice(0, 1000) || null,
        media_video_library_id: (b.media_video_library_id || '').trim().slice(0, 20) || null,
        media_video_collection_id: (b.media_video_collection_id || '').trim().slice(0, 60) || null,
        media_image_urls: urlList(b.media_image_urls),
        presentation_male_urls: urlList(b.presentation_male_urls),
        presentation_female_urls: urlList(b.presentation_female_urls),
        msgs_per_hour: intOr(b.msgs_per_hour, 60, 10, 600),
        retention_hours: intOr(b.retention_hours, 24, 1, 720),
        trial_seconds: intOr(b.trial_seconds, 60, 15, 3600),
        members_count: intOr(b.members_count, 248, 2, 99999),
        online_count: intOr(b.online_count, 25, 1, 9999),
        invite_chat_ids: Array.isArray(b.invite_chat_ids)
            ? b.invite_chat_ids.map(x => parseInt(x, 10)).filter(Boolean).slice(0, 3)
            : null,
        invite_delay_seconds: intOr(b.invite_delay_seconds, 120, 5, 86400),
        display_order: intOr(b.display_order, 0, 0, 9999),
        active: b.active !== false,
    };
}

// GET / — lista com contagens
router.get('/', requireAdmin, async (req, res) => {
    try {
        const { rows } = await db.query(`
            SELECT g.*, p.name AS product_name,
                   (SELECT COUNT(*)::int FROM group_personas gp WHERE gp.group_id = g.id AND gp.active = true) AS personas_count,
                   (SELECT COUNT(*)::int FROM group_scenes gs WHERE gs.group_id = g.id AND gs.active = true) AS scenes_count,
                   (SELECT COUNT(*)::int FROM group_sessions s WHERE s.group_id = g.id) AS sessions_count
            FROM groups g
            LEFT JOIN products p ON p.id = g.product_id
            ORDER BY g.display_order, g.id
        `);
        return res.json({ success: true, groups: rows });
    } catch (err) {
        logger.error('Erro listando grupos (admin):', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// POST / — cria
router.post('/', requireAdmin, async (req, res) => {
    try {
        const p = groupPayload(req.body || {});
        if (!p.name) return res.status(400).json({ success: false, error: 'Nome obrigatório' });
        const cols = Object.keys(p);
        const vals = cols.map(k => {
            const v = p[k];
            return (v !== null && typeof v === 'object') ? JSON.stringify(v) : v;
        });
        const ph = cols.map((_, i) => '$' + (i + 1)).join(', ');
        const { rows } = await db.query(
            `INSERT INTO groups (${cols.join(', ')}) VALUES (${ph}) RETURNING *`, vals
        );
        return res.json({ success: true, group: rows[0] });
    } catch (err) {
        logger.error('Erro criando grupo:', err);
        return res.status(500).json({ success: false, error: err.message || 'Erro interno' });
    }
});

// PUT /:id — edita (parcial)
router.put('/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const b = req.body || {};
        const full = groupPayload(b);
        const updates = []; const values = []; let p = 1;
        for (const k of Object.keys(full)) {
            if (b[k] === undefined) continue;
            updates.push(`${k} = $${p++}`);
            const v = full[k];
            values.push((v !== null && typeof v === 'object') ? JSON.stringify(v) : v);
        }
        if (!updates.length) return res.status(400).json({ success: false, error: 'Nada pra atualizar' });
        values.push(id);
        const { rows } = await db.query(
            `UPDATE groups SET ${updates.join(', ')} WHERE id = $${p} RETURNING *`, values
        );
        if (!rows.length) return res.status(404).json({ success: false, error: 'Não encontrado' });
        return res.json({ success: true, group: rows[0] });
    } catch (err) {
        logger.error('Erro atualizando grupo:', err);
        return res.status(500).json({ success: false, error: err.message || 'Erro interno' });
    }
});

// DELETE /:id
router.delete('/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { rowCount } = await db.query(`DELETE FROM groups WHERE id = $1`, [id]);
        if (!rowCount) return res.status(404).json({ success: false, error: 'Não encontrado' });
        return res.json({ success: true });
    } catch (err) {
        logger.error('Erro excluindo grupo:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// GET /:id/personas — elenco
router.get('/:id/personas', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { rows } = await db.query(
            `SELECT id, name, gender FROM group_personas WHERE group_id = $1 AND active = true ORDER BY id`, [id]
        );
        return res.json({ success: true, personas: rows });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// PUT /:id/personas — SUBSTITUI o elenco. body.lines = ["Amanda|f", "Marcos|m"]
router.put('/:id/personas', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const raw = Array.isArray(req.body?.lines) ? req.body.lines
            : String(req.body?.lines || '').split('\n');
        const personas = raw
            .map(l => String(l).trim())
            .filter(Boolean)
            .slice(0, 200)
            .map(l => {
                const [name, g] = l.split('|').map(s => (s || '').trim());
                return { name: name.slice(0, 60), gender: (g || 'f').toLowerCase() === 'm' ? 'm' : 'f' };
            })
            .filter(pp => pp.name);
        await db.query(`DELETE FROM group_personas WHERE group_id = $1`, [id]);
        for (const pp of personas) {
            await db.query(
                `INSERT INTO group_personas (group_id, name, gender) VALUES ($1, $2, $3)`,
                [id, pp.name, pp.gender]
            );
        }
        return res.json({ success: true, count: personas.length });
    } catch (err) {
        logger.error('Erro salvando personas:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// GET /:id/scenes — resumo por categoria
router.get('/:id/scenes', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { rows } = await db.query(
            `SELECT category, COUNT(*)::int AS n,
                    SUM(jsonb_array_length(messages))::int AS msgs
             FROM group_scenes WHERE group_id = $1 AND active = true
             GROUP BY category ORDER BY category`, [id]
        );
        return res.json({ success: true, summary: rows });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// POST /:id/scenes/import — body.scenes = array no formato do topo do arquivo
// (aceita também string JSON). replace=true limpa as cenas antes.
router.post('/:id/scenes/import', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        let scenes = req.body?.scenes;
        if (typeof scenes === 'string') {
            try { scenes = JSON.parse(scenes); } catch (e) {
                return res.status(400).json({ success: false, error: 'JSON inválido: ' + e.message });
            }
        }
        if (!Array.isArray(scenes) || !scenes.length) {
            return res.status(400).json({ success: false, error: 'Envie um array de cenas' });
        }
        if (scenes.length > 500) return res.status(400).json({ success: false, error: 'Máximo de 500 cenas por import' });
        // valida e normaliza
        const clean = [];
        for (let i = 0; i < scenes.length; i++) {
            const s = scenes[i] || {};
            const cat = CATEGORIES.includes(s.category) ? s.category : 'papo';
            const per = PERIODS.includes(s.period) ? s.period : 'any';
            const weight = intOr(s.weight, 1, 1, 100);
            const msgs = (Array.isArray(s.messages) ? s.messages : []).slice(0, 40).map(m => ({
                p: intOr(m.p, 1, 1, 12),
                g: m.g === 'm' || m.g === 'f' ? m.g : undefined,
                t: ['text', 'image', 'presentation', 'cta'].includes(m.t) ? m.t : 'text',
                text: (m.text || '').toString().slice(0, 1000) || undefined,
                gap_s: m.gap_s !== undefined ? intOr(m.gap_s, 8, 2, 600) : undefined,
                link: (m.link || '').toString().slice(0, 1000) || undefined,
                pid: m.pid ? parseInt(m.pid, 10) : undefined,
                color: (m.color || '').toString().slice(0, 20) || undefined,
            })).filter(m => m.text || m.t === 'image' || m.t === 'presentation');
            if (!msgs.length) continue;
            clean.push({ category: cat, period: per, weight, messages: msgs });
        }
        if (!clean.length) return res.status(400).json({ success: false, error: 'Nenhuma cena válida no JSON' });
        if (req.body?.replace === true) {
            await db.query(`DELETE FROM group_scenes WHERE group_id = $1`, [id]);
        }
        for (const s of clean) {
            await db.query(
                `INSERT INTO group_scenes (group_id, category, period, weight, messages)
                 VALUES ($1, $2, $3, $4, $5::jsonb)`,
                [id, s.category, s.period, s.weight, JSON.stringify(s.messages)]
            );
        }
        return res.json({ success: true, imported: clean.length });
    } catch (err) {
        logger.error('Erro importando cenas:', err);
        return res.status(500).json({ success: false, error: err.message || 'Erro interno' });
    }
});

// DELETE /:id/scenes — limpa todas as cenas do grupo
router.delete('/:id/scenes', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { rowCount } = await db.query(`DELETE FROM group_scenes WHERE group_id = $1`, [id]);
        return res.json({ success: true, deleted: rowCount });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

module.exports = router;
