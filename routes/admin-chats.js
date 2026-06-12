/**
 * =============================================================================
 * routes/admin-chats.js — gestão dos CHATS (personas + roteiros + conversas)
 * =============================================================================
 *
 * CRUD das personas (chats), dos blocos do roteiro (chat_steps) e leitura
 * das conversas recebidas dos leads (chat_sessions/chat_messages).
 * Mesmo padrão do admin-funnels.
 * =============================================================================
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAdmin } = require('../lib/auth');
const { logger } = require('../lib/logger');

const STEP_TYPES = ['text', 'audio', 'image', 'view_once_image', 'view_once_video', 'buttons', 'wait_input', 'cta'];
const REPLY_MODES = ['vip', 'all', 'none'];

// ── CHATS (personas) ─────────────────────────────────────────────────────────

router.get('/', requireAdmin, async (req, res) => {
    try {
        const { rows } = await db.query(`
            SELECT c.*,
                   p.name AS product_name,
                   (SELECT COUNT(*)::int FROM chat_steps cs WHERE cs.chat_id = c.id AND cs.active = true) AS steps_count,
                   (SELECT COUNT(*)::int FROM chat_sessions s WHERE s.chat_id = c.id) AS sessions_count
            FROM chats c
            LEFT JOIN products p ON p.id = c.product_id
            ORDER BY c.display_order, c.id
        `);
        return res.json({ success: true, chats: rows });
    } catch (err) {
        logger.error('Erro listando chats:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

router.post('/', requireAdmin, async (req, res) => {
    try {
        const { name, avatar_url, section, status_label, show_online, access,
                product_id, checkout_url, reply_mode, allow_photo, display_order, active } = req.body || {};
        if (!name || !String(name).trim()) return res.status(400).json({ success: false, error: 'Nome obrigatório' });
        const { rows } = await db.query(`
            INSERT INTO chats (name, avatar_url, section, status_label, show_online, access,
                               product_id, checkout_url, reply_mode, allow_photo, display_order, active)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *
        `, [
            String(name).trim().slice(0, 80),
            (avatar_url || '').trim().slice(0, 1000) || null,
            (section || 'Minhas conversas').trim().slice(0, 60),
            (status_label || 'online').trim().slice(0, 40),
            show_online !== false,
            access === 'vip' ? 'vip' : 'free',
            product_id ? parseInt(product_id, 10) : null,
            (checkout_url || '').trim().slice(0, 1000) || null,
            REPLY_MODES.includes(reply_mode) ? reply_mode : 'vip',
            allow_photo === true,
            parseInt(display_order, 10) || 0,
            active !== false,
        ]);
        return res.json({ success: true, chat: rows[0] });
    } catch (err) {
        logger.error('Erro criando chat:', err);
        return res.status(500).json({ success: false, error: err.message || 'Erro interno' });
    }
});

router.put('/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const b = req.body || {};
        const updates = []; const values = []; let p = 1;
        const set = (col, val) => { updates.push(`${col} = $${p++}`); values.push(val); };
        if (b.name !== undefined) set('name', String(b.name).trim().slice(0, 80));
        if (b.avatar_url !== undefined) set('avatar_url', (b.avatar_url || '').trim().slice(0, 1000) || null);
        if (b.section !== undefined) set('section', (b.section || 'Minhas conversas').trim().slice(0, 60));
        if (b.status_label !== undefined) set('status_label', (b.status_label || 'online').trim().slice(0, 40));
        if (b.show_online !== undefined) set('show_online', !!b.show_online);
        if (b.access !== undefined) set('access', b.access === 'vip' ? 'vip' : 'free');
        if (b.product_id !== undefined) set('product_id', b.product_id ? parseInt(b.product_id, 10) : null);
        if (b.checkout_url !== undefined) set('checkout_url', (b.checkout_url || '').trim().slice(0, 1000) || null);
        if (b.reply_mode !== undefined) set('reply_mode', REPLY_MODES.includes(b.reply_mode) ? b.reply_mode : 'vip');
        if (b.allow_photo !== undefined) set('allow_photo', !!b.allow_photo);
        if (b.display_order !== undefined) set('display_order', parseInt(b.display_order, 10) || 0);
        if (b.active !== undefined) set('active', !!b.active);
        if (!updates.length) return res.status(400).json({ success: false, error: 'Nada pra atualizar' });
        values.push(id);
        const { rows } = await db.query(`UPDATE chats SET ${updates.join(', ')} WHERE id = $${p} RETURNING *`, values);
        if (!rows.length) return res.status(404).json({ success: false, error: 'Não encontrado' });
        return res.json({ success: true, chat: rows[0] });
    } catch (err) {
        logger.error('Erro atualizando chat:', err);
        return res.status(500).json({ success: false, error: err.message || 'Erro interno' });
    }
});

router.delete('/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { rowCount } = await db.query(`DELETE FROM chats WHERE id = $1`, [id]);
        if (!rowCount) return res.status(404).json({ success: false, error: 'Não encontrado' });
        return res.json({ success: true, deleted: true });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// ── BLOCOS DO ROTEIRO ────────────────────────────────────────────────────────

router.get('/:id/steps', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { rows } = await db.query(
            `SELECT * FROM chat_steps WHERE chat_id = $1 ORDER BY step_order, id`, [id]
        );
        return res.json({ success: true, steps: rows });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

function parseButtons(raw) {
    if (!Array.isArray(raw)) return null;
    const out = raw
        .map(b => ({ label: String(b?.label || '').trim().slice(0, 60), goto: String(b?.goto || '').trim().slice(0, 40) || null }))
        .filter(b => b.label)
        .slice(0, 4);
    return out.length ? JSON.stringify(out) : null;
}

router.post('/:id/steps', requireAdmin, async (req, res) => {
    const chatId = parseInt(req.params.id, 10);
    if (!chatId) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const b = req.body || {};
        const type = STEP_TYPES.includes(b.type) ? b.type : 'text';
        const { rows } = await db.query(`
            INSERT INTO chat_steps (chat_id, step_order, step_key, type, content, media_url, buttons, link_url, product_id, typing_ms, goto_key, active)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *
        `, [
            chatId,
            parseInt(b.step_order, 10) || 0,
            (b.step_key || '').trim().slice(0, 40) || null,
            type,
            (b.content || '').trim().slice(0, 2000) || null,
            (b.media_url || '').trim().slice(0, 1000) || null,
            parseButtons(b.buttons),
            (b.link_url || '').trim().slice(0, 1000) || null,
            b.product_id ? parseInt(b.product_id, 10) : null,
            Math.max(0, Math.min(8000, parseInt(b.typing_ms, 10) || 1200)),
            (b.goto_key || '').trim().slice(0, 40) || null,
            b.active !== false,
        ]);
        return res.json({ success: true, step: rows[0] });
    } catch (err) {
        logger.error('Erro criando bloco do chat:', err);
        return res.status(500).json({ success: false, error: err.message || 'Erro interno' });
    }
});

router.put('/:id/steps/:stepId', requireAdmin, async (req, res) => {
    const stepId = parseInt(req.params.stepId, 10);
    if (!stepId) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const b = req.body || {};
        const updates = []; const values = []; let p = 1;
        const set = (col, val) => { updates.push(`${col} = $${p++}`); values.push(val); };
        if (b.step_order !== undefined) set('step_order', parseInt(b.step_order, 10) || 0);
        if (b.step_key !== undefined) set('step_key', (b.step_key || '').trim().slice(0, 40) || null);
        if (b.type !== undefined) set('type', STEP_TYPES.includes(b.type) ? b.type : 'text');
        if (b.content !== undefined) set('content', (b.content || '').trim().slice(0, 2000) || null);
        if (b.media_url !== undefined) set('media_url', (b.media_url || '').trim().slice(0, 1000) || null);
        if (b.buttons !== undefined) set('buttons', parseButtons(b.buttons));
        if (b.link_url !== undefined) set('link_url', (b.link_url || '').trim().slice(0, 1000) || null);
        if (b.product_id !== undefined) set('product_id', b.product_id ? parseInt(b.product_id, 10) : null);
        if (b.typing_ms !== undefined) set('typing_ms', Math.max(0, Math.min(8000, parseInt(b.typing_ms, 10) || 1200)));
        if (b.goto_key !== undefined) set('goto_key', (b.goto_key || '').trim().slice(0, 40) || null);
        if (b.active !== undefined) set('active', !!b.active);
        if (!updates.length) return res.status(400).json({ success: false, error: 'Nada pra atualizar' });
        values.push(stepId);
        const { rows } = await db.query(`UPDATE chat_steps SET ${updates.join(', ')} WHERE id = $${p} RETURNING *`, values);
        if (!rows.length) return res.status(404).json({ success: false, error: 'Não encontrado' });
        return res.json({ success: true, step: rows[0] });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message || 'Erro interno' });
    }
});

router.delete('/:id/steps/:stepId', requireAdmin, async (req, res) => {
    const stepId = parseInt(req.params.stepId, 10);
    if (!stepId) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { rowCount } = await db.query(`DELETE FROM chat_steps WHERE id = $1`, [stepId]);
        if (!rowCount) return res.status(404).json({ success: false, error: 'Não encontrado' });
        return res.json({ success: true, deleted: true });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// ── EXPORTAR / IMPORTAR roteiro completo (JSON) ──────────────────────────────

// GET /:id/export — persona + todos os blocos num JSON (backup/replicação)
router.get('/:id/export', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { rows: cr } = await db.query(`SELECT * FROM chats WHERE id = $1`, [id]);
        if (!cr.length) return res.status(404).json({ success: false, error: 'Não encontrado' });
        const c = cr[0];
        const { rows: steps } = await db.query(
            `SELECT step_order, step_key, type, content, media_url, buttons, link_url, product_id, typing_ms, goto_key, active
             FROM chat_steps WHERE chat_id = $1 ORDER BY step_order, id`, [id]
        );
        const payload = {
            format: 'mvchat',
            version: 1,
            exported_at: new Date().toISOString(),
            chat: {
                name: c.name, avatar_url: c.avatar_url, section: c.section,
                status_label: c.status_label, show_online: c.show_online,
                access: c.access, product_id: c.product_id, checkout_url: c.checkout_url,
                reply_mode: c.reply_mode, allow_photo: c.allow_photo, display_order: c.display_order,
            },
            steps,
        };
        const fname = 'chat-' + String(c.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) + '.json';
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
        return res.send(JSON.stringify(payload, null, 2));
    } catch (err) {
        logger.error('Erro exportando chat:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// POST /import — cria um chat NOVO a partir do JSON exportado
router.post('/import', requireAdmin, async (req, res) => {
    try {
        const data = req.body || {};
        if (data.format !== 'mvchat' || !data.chat || !Array.isArray(data.steps)) {
            return res.status(400).json({ success: false, error: 'Arquivo inválido — exporte um chat pelo painel pra ver o formato.' });
        }
        const c = data.chat;
        const { rows: created } = await db.query(`
            INSERT INTO chats (name, avatar_url, section, status_label, show_online, access,
                               product_id, checkout_url, reply_mode, allow_photo, display_order, active)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true) RETURNING *
        `, [
            String(c.name || 'Chat importado').trim().slice(0, 80),
            (c.avatar_url || '').trim().slice(0, 1000) || null,
            (c.section || 'Minhas conversas').trim().slice(0, 60),
            (c.status_label || 'online').trim().slice(0, 40),
            c.show_online !== false,
            c.access === 'vip' ? 'vip' : 'free',
            c.product_id ? parseInt(c.product_id, 10) : null,
            (c.checkout_url || '').trim().slice(0, 1000) || null,
            REPLY_MODES.includes(c.reply_mode) ? c.reply_mode : 'vip',
            c.allow_photo === true,
            parseInt(c.display_order, 10) || 0,
        ]);
        const chat = created[0];
        let imported = 0;
        for (const s of data.steps.slice(0, 200)) {
            const type = STEP_TYPES.includes(s.type) ? s.type : 'text';
            await db.query(`
                INSERT INTO chat_steps (chat_id, step_order, step_key, type, content, media_url, buttons, link_url, product_id, typing_ms, goto_key, active)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
            `, [
                chat.id,
                parseInt(s.step_order, 10) || 0,
                (s.step_key || '').trim().slice(0, 40) || null,
                type,
                (s.content || '').trim().slice(0, 2000) || null,
                (s.media_url || '').trim().slice(0, 1000) || null,
                parseButtons(s.buttons),
                (s.link_url || '').trim().slice(0, 1000) || null,
                s.product_id ? parseInt(s.product_id, 10) : null,
                Math.max(0, Math.min(8000, parseInt(s.typing_ms, 10) || 1200)),
                (s.goto_key || '').trim().slice(0, 40) || null,
                s.active !== false,
            ]);
            imported++;
        }
        return res.json({ success: true, chat, steps_imported: imported });
    } catch (err) {
        logger.error('Erro importando chat:', err);
        return res.status(500).json({ success: false, error: err.message || 'Erro interno' });
    }
});

// ── CONVERSAS RECEBIDAS (leitura) ────────────────────────────────────────────

router.get('/:id/sessions', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { rows } = await db.query(`
            SELECT s.id, s.customer_email, s.visitor_id, s.created_at, s.updated_at,
                   (SELECT COUNT(*)::int FROM chat_messages m WHERE m.session_id = s.id AND m.sender = 'user') AS user_messages,
                   (SELECT content FROM chat_messages m WHERE m.session_id = s.id AND m.sender = 'user' ORDER BY m.id DESC LIMIT 1) AS last_user_message
            FROM chat_sessions s
            WHERE s.chat_id = $1
            ORDER BY s.updated_at DESC
            LIMIT 200
        `, [id]);
        return res.json({ success: true, sessions: rows });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

router.get('/sessions/:sid/messages', requireAdmin, async (req, res) => {
    const sid = parseInt(req.params.sid, 10);
    if (!sid) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { rows } = await db.query(
            `SELECT id, sender, type, content, media_url, meta, viewed_at, created_at
             FROM chat_messages WHERE session_id = $1 ORDER BY id LIMIT 500`, [sid]
        );
        return res.json({ success: true, messages: rows });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

module.exports = router;
