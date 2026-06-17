/**
 * =============================================================================
 * routes/admin-funnels.js — CRUD de Funís
 * =============================================================================
 *
 * Funís são landings customizadas por link.
 * Cada funíl tem:
 *   - slug (URL: /f/SLUG)
 *   - produto destaque (opcional — aparece em destaque na landing)
 *   - chamada vinculada (opcional — dispara após login)
 *
 * Endpoints:
 *   GET    /api/admin/funnels                Lista todos
 *   GET    /api/admin/funnels/:id            Detalhe
 *   POST   /api/admin/funnels                Cria
 *   PUT    /api/admin/funnels/:id            Edita
 *   POST   /api/admin/funnels/:id/toggle     Ativa/desativa
 *   DELETE /api/admin/funnels/:id            Exclui
 *   GET    /api/admin/funnels/:id/stats      Stats (visitas, conversões)
 * =============================================================================
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const { logger } = require('../lib/logger');
const { requireAdmin } = require('../lib/auth');


function sanitizeSlug(input) {
    return String(input || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
}


// GET /api/admin/funnels — lista
router.get('/', requireAdmin, async (req, res) => {
    try {
        const { rows } = await db.query(`
            SELECT f.*,
                   p.name AS featured_product_name,
                   p.banner_url AS featured_product_banner,
                   v.model_name AS video_call_model_name,
                   v.slug AS video_call_slug,
                   (SELECT COUNT(*)::int FROM funnel_visits fv WHERE fv.funnel_id = f.id) AS visits_total,
                   (SELECT COUNT(*)::int FROM funnel_visits fv WHERE fv.funnel_id = f.id AND fv.converted = true) AS conversions
            FROM funnels f
            LEFT JOIN products p ON p.id = f.featured_product_id
            LEFT JOIN video_calls v ON v.id = f.video_call_id
            ORDER BY f.created_at DESC
        `);
        return res.json({ success: true, funnels: rows });
    } catch (err) {
        logger.error('Erro listando funís:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// GET /:id
router.get('/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { rows } = await db.query(`SELECT * FROM funnels WHERE id = $1`, [id]);
        if (!rows.length) return res.status(404).json({ success: false, error: 'Não encontrado' });
        return res.json({ success: true, funnel: rows[0] });
    } catch (err) {
        logger.error('Erro buscando funíl:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// POST — cria
router.post('/', requireAdmin, async (req, res) => {
    try {
        const { slug, name, description, featured_product_id, video_call_id, active,
                entry_type, entry_product_id, entry_category_id, entry_chat_id } = req.body || {};
        const cleanSlug = sanitizeSlug(slug || name);
        if (!cleanSlug) return res.status(400).json({ success: false, error: 'Slug inválido' });
        if (!name || name.trim().length < 1) return res.status(400).json({ success: false, error: 'Nome obrigatório' });

        const { rows: dup } = await db.query('SELECT id FROM funnels WHERE slug = $1', [cleanSlug]);
        if (dup.length) return res.status(400).json({ success: false, error: 'Slug já existe' });

        const fpId = featured_product_id ? parseInt(featured_product_id, 10) : null;
        const vcId = video_call_id ? parseInt(video_call_id, 10) : null;
        const entryT = ['home', 'product', 'category', 'chat', 'chat_list'].includes(entry_type) ? entry_type : 'home';
        const entryP = entry_product_id ? parseInt(entry_product_id, 10) : null;
        const entryC = entry_category_id ? parseInt(entry_category_id, 10) : null;
        const entryCh = entry_chat_id ? parseInt(entry_chat_id, 10) : null;

        const { rows } = await db.query(`
            INSERT INTO funnels (slug, name, description, featured_product_id, video_call_id, active,
                                 entry_type, entry_product_id, entry_category_id, entry_chat_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *
        `, [
            cleanSlug,
            name.trim().slice(0, 120),
            (description || '').trim().slice(0, 1000) || null,
            fpId,
            vcId,
            active !== false,
            entryT,
            entryP,
            entryC,
            entryCh,
        ]);

        return res.json({ success: true, funnel: rows[0] });
    } catch (err) {
        logger.error('Erro criando funíl:', err);
        return res.status(500).json({ success: false, error: err.message || 'Erro interno' });
    }
});


// PUT — edita
router.put('/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { slug, name, description, featured_product_id, video_call_id, active,
                entry_type, entry_product_id, entry_category_id, entry_chat_id } = req.body || {};
        const updates = [];
        const values = [];
        let p = 1;

        if (entry_type !== undefined) {
            updates.push(`entry_type = $${p++}`);
            values.push(['home', 'product', 'category', 'chat', 'chat_list'].includes(entry_type) ? entry_type : 'home');
        }
        if (entry_product_id !== undefined) {
            updates.push(`entry_product_id = $${p++}`);
            values.push(entry_product_id ? parseInt(entry_product_id, 10) : null);
        }
        if (entry_category_id !== undefined) {
            updates.push(`entry_category_id = $${p++}`);
            values.push(entry_category_id ? parseInt(entry_category_id, 10) : null);
        }
        if (entry_chat_id !== undefined) {
            updates.push(`entry_chat_id = $${p++}`);
            values.push(entry_chat_id ? parseInt(entry_chat_id, 10) : null);
        }

        if (slug !== undefined) {
            const clean = sanitizeSlug(slug);
            if (!clean) return res.status(400).json({ success: false, error: 'Slug inválido' });
            const { rows: dup } = await db.query('SELECT id FROM funnels WHERE slug = $1 AND id <> $2', [clean, id]);
            if (dup.length) return res.status(400).json({ success: false, error: 'Slug já existe' });
            updates.push(`slug = $${p++}`); values.push(clean);
        }
        if (name !== undefined) { updates.push(`name = $${p++}`); values.push(String(name).trim().slice(0, 120)); }
        if (description !== undefined) { updates.push(`description = $${p++}`); values.push((description || '').trim().slice(0, 1000) || null); }
        if (featured_product_id !== undefined) {
            const v = featured_product_id ? parseInt(featured_product_id, 10) : null;
            updates.push(`featured_product_id = $${p++}`); values.push(v);
        }
        if (video_call_id !== undefined) {
            const v = video_call_id ? parseInt(video_call_id, 10) : null;
            updates.push(`video_call_id = $${p++}`); values.push(v);
        }
        if (active !== undefined) { updates.push(`active = $${p++}`); values.push(!!active); }

        if (!updates.length) return res.status(400).json({ success: false, error: 'Nada pra atualizar' });
        updates.push('updated_at = NOW()');
        values.push(id);

        const { rows } = await db.query(
            `UPDATE funnels SET ${updates.join(', ')} WHERE id = $${p} RETURNING *`,
            values
        );
        if (!rows.length) return res.status(404).json({ success: false, error: 'Não encontrado' });
        return res.json({ success: true, funnel: rows[0] });
    } catch (err) {
        logger.error('Erro atualizando funíl:', err);
        return res.status(500).json({ success: false, error: err.message || 'Erro interno' });
    }
});


// POST /:id/toggle
router.post('/:id/toggle', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { rows } = await db.query(
            `UPDATE funnels SET active = NOT active, updated_at = NOW() WHERE id = $1 RETURNING active`,
            [id]
        );
        if (!rows.length) return res.status(404).json({ success: false, error: 'Não encontrado' });
        return res.json({ success: true, active: rows[0].active });
    } catch (err) {
        logger.error('Erro toggle funíl:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// DELETE
router.delete('/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { rowCount } = await db.query(`DELETE FROM funnels WHERE id = $1`, [id]);
        if (!rowCount) return res.status(404).json({ success: false, error: 'Não encontrado' });
        return res.json({ success: true, deleted: true });
    } catch (err) {
        logger.error('Erro deletando funíl:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// GET /:id/stats — estatísticas com filtro de período
// Query params opcionais: ?from=YYYY-MM-DD&to=YYYY-MM-DD (inclusivos).
// Sem filtro = tudo. Retorna totais + série diária (pra gráfico e comparação
// de períodos no painel — o painel chama 2x pra comparar dois períodos).
router.get('/:id/stats', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const parseDay = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? s : null);
        const from = parseDay(req.query.from);
        const to = parseDay(req.query.to);
        const conds = ['funnel_id = $1'];
        const params = [id];
        if (from) { params.push(from); conds.push(`visited_at >= $${params.length}::date`); }
        if (to)   { params.push(to);   conds.push(`visited_at < ($${params.length}::date + INTERVAL '1 day')`); }
        const where = conds.join(' AND ');

        const { rows: stats } = await db.query(`
            SELECT
                COUNT(*)::int as visits_total,
                COUNT(DISTINCT ip)::int as unique_ips,
                COUNT(DISTINCT customer_email) FILTER (WHERE customer_email IS NOT NULL)::int as unique_emails,
                COUNT(*) FILTER (WHERE converted = true)::int as conversions
            FROM funnel_visits
            WHERE ${where}
        `, params);

        // Série diária — alimenta as barras e a comparação dia a dia
        const { rows: daily } = await db.query(`
            SELECT
                TO_CHAR(visited_at::date, 'YYYY-MM-DD') as day,
                COUNT(*)::int as visits,
                COUNT(DISTINCT ip)::int as unique_ips,
                COUNT(DISTINCT customer_email) FILTER (WHERE customer_email IS NOT NULL)::int as emails,
                COUNT(*) FILTER (WHERE converted = true)::int as conversions
            FROM funnel_visits
            WHERE ${where}
            GROUP BY visited_at::date
            ORDER BY visited_at::date
        `, params);

        const { rows: recent } = await db.query(`
            SELECT customer_email, ip, converted, visited_at, converted_at
            FROM funnel_visits
            WHERE ${where}
            ORDER BY visited_at DESC
            LIMIT 50
        `, params);

        return res.json({ success: true, stats: stats[0], daily, recent, from, to });
    } catch (err) {
        logger.error('Erro stats funíl:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// =============================================================================
// ETAPAS DO FUNÍL (sequência de eventos pós-login)
// =============================================================================

// GET /:id/steps — lista etapas do funíl
router.get('/:id/steps', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { rows } = await db.query(`
            SELECT fs.*,
                   vc.model_name AS video_call_name,
                   p.name AS product_name,
                   ch.name AS chat_name
            FROM funnel_steps fs
            LEFT JOIN video_calls vc ON vc.id = fs.video_call_id
            LEFT JOIN products p ON p.id = fs.product_id
            LEFT JOIN chats ch ON ch.id = fs.chat_id
            WHERE fs.funnel_id = $1
            ORDER BY fs.step_order, fs.id
        `, [id]);
        return res.json({ success: true, steps: rows });
    } catch (err) {
        logger.error('Erro listando etapas:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// POST /:id/steps — cria etapa
router.post('/:id/steps', requireAdmin, async (req, res) => {
    const funnelId = parseInt(req.params.id, 10);
    if (!funnelId) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { type, delay_seconds, video_call_id, product_id, chat_id, title, message, link_url, step_order, active } = req.body || {};
        // Tipos: 'notification' (banner in-app) · 'chat' (inicia conversa) ·
        // 'navigate'/'open_product' (leva pra algo) · 'wait' (só espera) ·
        // 'push' (web push do SERVIDOR) · 'video_call'.
        const validTypes = ['video_call', 'notification', 'open_product', 'push', 'chat', 'navigate', 'wait'];
        const t = validTypes.includes(type) ? type : 'notification';
        const delay = Math.max(0, parseInt(delay_seconds, 10) || 0);
        const vcId = video_call_id ? parseInt(video_call_id, 10) : null;
        const pId = product_id ? parseInt(product_id, 10) : null;
        const chId = chat_id ? parseInt(chat_id, 10) : null;
        const order = parseInt(step_order, 10) || 0;
        const { rows } = await db.query(`
            INSERT INTO funnel_steps (funnel_id, type, delay_seconds, video_call_id, product_id, chat_id, title, message, link_url, step_order, active)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *
        `, [funnelId, t, delay, vcId, pId, chId, (title||'').trim().slice(0,120) || null, (message||'').trim().slice(0,500) || null, (link_url||'').trim().slice(0,1000) || null, order, active !== false]);
        return res.json({ success: true, step: rows[0] });
    } catch (err) {
        logger.error('Erro criando etapa:', err);
        return res.status(500).json({ success: false, error: err.message || 'Erro interno' });
    }
});

// PUT /:id/steps/:stepId — edita etapa
router.put('/:id/steps/:stepId', requireAdmin, async (req, res) => {
    const stepId = parseInt(req.params.stepId, 10);
    if (!stepId) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { type, delay_seconds, video_call_id, product_id, chat_id, title, message, link_url, step_order, active } = req.body || {};
        const updates = []; const values = []; let p = 1;
        if (type !== undefined) {
            const valid = ['video_call', 'notification', 'open_product', 'push', 'chat', 'navigate', 'wait'];
            updates.push(`type = $${p++}`); values.push(valid.includes(type) ? type : 'notification');
        }
        if (delay_seconds !== undefined) { updates.push(`delay_seconds = $${p++}`); values.push(Math.max(0, parseInt(delay_seconds, 10) || 0)); }
        if (video_call_id !== undefined) { updates.push(`video_call_id = $${p++}`); values.push(video_call_id ? parseInt(video_call_id, 10) : null); }
        if (product_id !== undefined) { updates.push(`product_id = $${p++}`); values.push(product_id ? parseInt(product_id, 10) : null); }
        if (chat_id !== undefined) { updates.push(`chat_id = $${p++}`); values.push(chat_id ? parseInt(chat_id, 10) : null); }
        if (title !== undefined) { updates.push(`title = $${p++}`); values.push((title || '').trim().slice(0, 120) || null); }
        if (message !== undefined) { updates.push(`message = $${p++}`); values.push((message || '').trim().slice(0, 500) || null); }
        if (link_url !== undefined) { updates.push(`link_url = $${p++}`); values.push((link_url || '').trim().slice(0, 1000) || null); }
        if (step_order !== undefined) { updates.push(`step_order = $${p++}`); values.push(parseInt(step_order, 10) || 0); }
        if (active !== undefined) { updates.push(`active = $${p++}`); values.push(!!active); }
        if (!updates.length) return res.status(400).json({ success: false, error: 'Nada pra atualizar' });
        values.push(stepId);
        const { rows } = await db.query(`UPDATE funnel_steps SET ${updates.join(', ')} WHERE id = $${p} RETURNING *`, values);
        if (!rows.length) return res.status(404).json({ success: false, error: 'Não encontrado' });
        return res.json({ success: true, step: rows[0] });
    } catch (err) {
        logger.error('Erro atualizando etapa:', err);
        return res.status(500).json({ success: false, error: err.message || 'Erro interno' });
    }
});

// DELETE /:id/steps/:stepId
router.delete('/:id/steps/:stepId', requireAdmin, async (req, res) => {
    const stepId = parseInt(req.params.stepId, 10);
    if (!stepId) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { rowCount } = await db.query(`DELETE FROM funnel_steps WHERE id = $1`, [stepId]);
        if (!rowCount) return res.status(404).json({ success: false, error: 'Não encontrado' });
        return res.json({ success: true, deleted: true });
    } catch (err) {
        logger.error('Erro deletando etapa:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


module.exports = router;
