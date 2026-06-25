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

const STEP_TYPES = ['text', 'audio', 'image', 'view_once_image', 'view_once_video', 'buttons', 'wait_input', 'cta', 'delay', 'call'];
const REPLY_MODES = ['vip', 'all', 'none'];
const INPUT_MODES = ['always', 'gated'];
// Fluxos por gatilho (cada modelo tem um roteiro independente por fluxo)
const FLOWS = ['open', 'status_reply', 'call', 'inactive'];
const cleanFlow = (f) => FLOWS.includes(f) ? f : 'open';

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
                product_id, checkout_url, reply_mode, allow_photo, display_order, active,
                city_fallback, gate_media, call_video_call_id, trigger_product_ids, input_mode, call_goto_key, tag, auto_start_minutes, listed, is_support,
                story_vip_product_id, story_vip_checkout_url } = req.body || {};
        if (!name || !String(name).trim()) return res.status(400).json({ success: false, error: 'Nome obrigatório' });
        const { rows } = await db.query(`
            INSERT INTO chats (name, avatar_url, section, status_label, show_online, access,
                               product_id, checkout_url, reply_mode, allow_photo, display_order, active,
                               city_fallback, gate_media, call_video_call_id, trigger_product_ids, input_mode, call_goto_key, tag, auto_start_minutes, listed, is_support,
                               story_vip_product_id, story_vip_checkout_url)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING *
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
            (city_fallback || 'sua região').trim().slice(0, 60),
            gate_media === true,
            call_video_call_id ? parseInt(call_video_call_id, 10) : null,
            cleanTriggerIds(trigger_product_ids),
            INPUT_MODES.includes(input_mode) ? input_mode : 'gated',
            (call_goto_key || '').trim().slice(0, 40) || null,
            (tag || '').trim().slice(0, 30) || null,
            Math.max(0, Math.min(10080, parseInt(auto_start_minutes, 10) || 0)),
            listed !== false,
            is_support === true,
            story_vip_product_id ? parseInt(story_vip_product_id, 10) : null,
            (story_vip_checkout_url || '').trim().slice(0, 1000) || null,
        ]);
        // Só um chat de Suporte por vez.
        if (is_support === true) {
            await db.query(`UPDATE chats SET is_support = false WHERE id <> $1`, [rows[0].id]);
        }
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
        if (b.city_fallback !== undefined) set('city_fallback', (b.city_fallback || 'sua região').trim().slice(0, 60));
        if (b.gate_media !== undefined) set('gate_media', !!b.gate_media);
        if (b.call_video_call_id !== undefined) set('call_video_call_id', b.call_video_call_id ? parseInt(b.call_video_call_id, 10) : null);
        if (b.trigger_product_ids !== undefined) set('trigger_product_ids', cleanTriggerIds(b.trigger_product_ids));
        if (b.input_mode !== undefined) set('input_mode', INPUT_MODES.includes(b.input_mode) ? b.input_mode : 'always');
        if (b.call_goto_key !== undefined) set('call_goto_key', (b.call_goto_key || '').trim().slice(0, 40) || null);
        if (b.tag !== undefined) set('tag', (b.tag || '').trim().slice(0, 30) || null);
        if (b.auto_start_minutes !== undefined) set('auto_start_minutes', Math.max(0, Math.min(10080, parseInt(b.auto_start_minutes, 10) || 0)));
        if (b.listed !== undefined) set('listed', !!b.listed);
        if (b.is_support !== undefined) set('is_support', !!b.is_support);
        if (b.story_vip_product_id !== undefined) set('story_vip_product_id', b.story_vip_product_id ? parseInt(b.story_vip_product_id, 10) : null);
        if (b.story_vip_checkout_url !== undefined) set('story_vip_checkout_url', (b.story_vip_checkout_url || '').trim().slice(0, 1000) || null);
        if (b.graph !== undefined) set('graph', b.graph ? JSON.stringify(b.graph) : null);
        if (!updates.length) return res.status(400).json({ success: false, error: 'Nada pra atualizar' });
        values.push(id);
        const { rows } = await db.query(`UPDATE chats SET ${updates.join(', ')} WHERE id = $${p} RETURNING *`, values);
        if (!rows.length) return res.status(404).json({ success: false, error: 'Não encontrado' });
        // Só um chat de Suporte por vez.
        if (b.is_support === true) {
            await db.query(`UPDATE chats SET is_support = false WHERE id <> $1`, [id]);
        }
        return res.json({ success: true, chat: rows[0] });
    } catch (err) {
        logger.error('Erro atualizando chat:', err);
        return res.status(500).json({ success: false, error: err.message || 'Erro interno' });
    }
});

// VIP ÚNICO: aplica o MESMO produto (e checkout) em TODAS as conversas VIP, e
// marca como VIP as conversas escolhidas. Assim quem compra esse 1 produto vira
// VIP em todas elas de uma vez.
router.post('/apply-vip-product', requireAdmin, async (req, res) => {
    const productId = req.body?.product_id ? parseInt(req.body.product_id, 10) : null;
    const checkoutUrl = (req.body?.checkout_url || '').trim().slice(0, 1000) || null;
    const alsoMarkAll = req.body?.mark_all_vip === true; // marca TODAS as conversas como VIP
    if (!productId) return res.status(400).json({ success: false, error: 'Escolha o produto' });
    try {
        if (alsoMarkAll) {
            await db.query(`UPDATE chats SET access = 'vip'`);
        }
        const { rowCount } = await db.query(
            `UPDATE chats SET product_id = $1, checkout_url = COALESCE($2, checkout_url) WHERE access = 'vip'`,
            [productId, checkoutUrl]
        );
        return res.json({ success: true, updated: rowCount });
    } catch (err) {
        logger.error('Erro aplicando VIP único:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
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

// Normaliza a lista de produtos-gatilho do pós-compra (array de IDs → JSONB)
function cleanTriggerIds(raw) {
    if (!Array.isArray(raw)) return null;
    const ids = raw.map(x => parseInt(x, 10)).filter(x => x > 0).slice(0, 50);
    return ids.length ? JSON.stringify(ids) : null;
}

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
            INSERT INTO chat_steps (chat_id, step_order, step_key, type, content, media_url, buttons, link_url, product_id, typing_ms, goto_key, delay_seconds, active, allow_input, view_seconds, flow, gate, cta_color, wait_open)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *
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
            Math.max(0, Math.min(10000, parseInt(b.typing_ms, 10) || 3000)),
            (b.goto_key || '').trim().slice(0, 40) || null,
            Math.max(0, Math.min(7 * 24 * 3600, parseInt(b.delay_seconds, 10) || 0)),
            b.active !== false,
            b.allow_input === true,
            Math.max(0, Math.min(120, parseInt(b.view_seconds, 10) || 0)),
            cleanFlow(b.flow),
            b.gate === true,
            (b.cta_color || '').trim().slice(0, 20) || null,
            b.wait_open === true,
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
        if (b.typing_ms !== undefined) set('typing_ms', Math.max(0, Math.min(10000, parseInt(b.typing_ms, 10) || 3000)));
        if (b.goto_key !== undefined) set('goto_key', (b.goto_key || '').trim().slice(0, 40) || null);
        if (b.delay_seconds !== undefined) set('delay_seconds', Math.max(0, Math.min(7 * 24 * 3600, parseInt(b.delay_seconds, 10) || 0)));
        if (b.allow_input !== undefined) set('allow_input', !!b.allow_input);
        if (b.view_seconds !== undefined) set('view_seconds', Math.max(0, Math.min(120, parseInt(b.view_seconds, 10) || 0)));
        if (b.flow !== undefined) set('flow', cleanFlow(b.flow));
        if (b.gate !== undefined) set('gate', !!b.gate);
        if (b.cta_color !== undefined) set('cta_color', (b.cta_color || '').trim().slice(0, 20) || null);
        if (b.wait_open !== undefined) set('wait_open', !!b.wait_open);
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
            `SELECT step_order, step_key, type, content, media_url, buttons, link_url, product_id, typing_ms, goto_key, delay_seconds, active, allow_input, view_seconds, flow, gate, cta_color, wait_open
             FROM chat_steps WHERE chat_id = $1 ORDER BY flow, step_order, id`, [id]
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
                input_mode: c.input_mode,
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
                               product_id, checkout_url, reply_mode, allow_photo, display_order, active, input_mode)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,$12) RETURNING *
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
            INPUT_MODES.includes(c.input_mode) ? c.input_mode : 'always',
        ]);
        const chat = created[0];
        let imported = 0;
        for (const s of data.steps.slice(0, 200)) {
            const type = STEP_TYPES.includes(s.type) ? s.type : 'text';
            await db.query(`
                INSERT INTO chat_steps (chat_id, step_order, step_key, type, content, media_url, buttons, link_url, product_id, typing_ms, goto_key, delay_seconds, active, allow_input, view_seconds, flow, gate, cta_color, wait_open)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
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
                Math.max(0, Math.min(10000, parseInt(s.typing_ms, 10) || 3000)),
                (s.goto_key || '').trim().slice(0, 40) || null,
                Math.max(0, Math.min(7 * 24 * 3600, parseInt(s.delay_seconds, 10) || 0)),
                s.active !== false,
                s.allow_input === true,
                Math.max(0, Math.min(120, parseInt(s.view_seconds, 10) || 0)),
                cleanFlow(s.flow),
                s.gate === true,
                (s.cta_color || '').trim().slice(0, 20) || null,
                s.wait_open === true,
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

// ── STATUS (stories) ─────────────────────────────────────────────────────────
const STATUS_TYPES = ['image', 'video', 'text'];

// Lista status de um chat (inclui expirados, marcados como tal — admin vê tudo)
router.get('/:id/status', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { rows } = await db.query(`
            SELECT s.*, (s.expires_at <= NOW()) AS expired,
                   (SELECT COUNT(*)::int FROM chat_status_views v WHERE v.status_id = s.id) AS views
            FROM chat_status s WHERE s.chat_id = $1 ORDER BY s.created_at DESC LIMIT 100
        `, [id]);
        return res.json({ success: true, status: rows });
    } catch (err) {
        logger.error('Erro listando status:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

router.post('/:id/status', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const b = req.body || {};
        const type = STATUS_TYPES.includes(b.type) ? b.type : 'image';
        const mediaUrl = (b.media_url || '').trim().slice(0, 1000) || null;
        if ((type === 'image' || type === 'video') && !mediaUrl) {
            return res.status(400).json({ success: false, error: 'Mídia obrigatória pra status de foto/vídeo' });
        }
        // duração configurável: padrão 24h, aceita horas custom (1..168)
        const hours = Math.max(1, Math.min(168, parseInt(b.expires_hours, 10) || 24));
        const { rows } = await db.query(`
            INSERT INTO chat_status (chat_id, type, media_url, caption, bg_color, reply_goto_key, is_vip, expires_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7, NOW() + make_interval(hours => $8)) RETURNING *
        `, [
            id, type, mediaUrl,
            (b.caption || '').trim().slice(0, 300) || null,
            (b.bg_color || '').trim().slice(0, 20) || null,
            (b.reply_goto_key || '').trim().slice(0, 40) || null,
            b.is_vip === true,
            hours,
        ]);
        return res.json({ success: true, status: rows[0] });
    } catch (err) {
        logger.error('Erro criando status:', err);
        return res.status(500).json({ success: false, error: err.message || 'Erro interno' });
    }
});

router.delete('/:id/status/:sid', requireAdmin, async (req, res) => {
    const sid = parseInt(req.params.sid, 10);
    if (!sid) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { rowCount } = await db.query(`DELETE FROM chat_status WHERE id = $1`, [sid]);
        if (!rowCount) return res.status(404).json({ success: false, error: 'Não encontrado' });
        return res.json({ success: true, deleted: true });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// ── ROTINA DE STATUS (agenda semanal) ────────────────────────────────────────
function cleanWeekdays(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [...new Set(raw.map(x => parseInt(x, 10)).filter(x => x >= 0 && x <= 6))].sort();
    return out;
}
function cleanTime(raw) {
    const m = String(raw || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return '09:00';
    const h = Math.max(0, Math.min(23, parseInt(m[1], 10)));
    const mm = Math.max(0, Math.min(59, parseInt(m[2], 10)));
    return String(h).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}

// Lista todos os agendamentos (com nome da modelo)
router.get('/status-schedule', requireAdmin, async (req, res) => {
    try {
        const { rows } = await db.query(`
            SELECT s.*, c.name AS chat_name, c.avatar_url
            FROM chat_status_schedule s JOIN chats c ON c.id = s.chat_id
            ORDER BY s.post_time, s.id
        `);
        return res.json({ success: true, schedule: rows });
    } catch (err) {
        logger.error('Erro listando rotina de status:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

router.post('/status-schedule', requireAdmin, async (req, res) => {
    try {
        const b = req.body || {};
        const chatId = parseInt(b.chat_id, 10);
        if (!chatId) return res.status(400).json({ success: false, error: 'Escolha a modelo' });
        const type = STATUS_TYPES.includes(b.type) ? b.type : 'image';
        const mediaUrl = (b.media_url || '').trim().slice(0, 1000) || null;
        if ((type === 'image' || type === 'video') && !mediaUrl) {
            return res.status(400).json({ success: false, error: 'Mídia obrigatória pra foto/vídeo' });
        }
        const weekdays = cleanWeekdays(b.weekdays);
        if (!weekdays.length) return res.status(400).json({ success: false, error: 'Escolha pelo menos 1 dia da semana' });
        const { rows } = await db.query(`
            INSERT INTO chat_status_schedule (chat_id, weekdays, post_time, type, media_url, caption, bg_color, reply_goto_key, expires_hours, active, is_vip)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *
        `, [
            chatId, JSON.stringify(weekdays), cleanTime(b.post_time), type, mediaUrl,
            (b.caption || '').trim().slice(0, 300) || null,
            (b.bg_color || '').trim().slice(0, 20) || null,
            (b.reply_goto_key || '').trim().slice(0, 40) || null,
            Math.max(1, Math.min(168, parseInt(b.expires_hours, 10) || 24)),
            b.active !== false,
            b.is_vip === true,
        ]);
        return res.json({ success: true, schedule: rows[0] });
    } catch (err) {
        logger.error('Erro criando rotina de status:', err);
        return res.status(500).json({ success: false, error: err.message || 'Erro interno' });
    }
});

router.put('/status-schedule/:sid', requireAdmin, async (req, res) => {
    const sid = parseInt(req.params.sid, 10);
    if (!sid) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const b = req.body || {};
        const updates = []; const values = []; let p = 1;
        const set = (col, val) => { updates.push(`${col} = $${p++}`); values.push(val); };
        if (b.weekdays !== undefined) set('weekdays', JSON.stringify(cleanWeekdays(b.weekdays)));
        if (b.post_time !== undefined) set('post_time', cleanTime(b.post_time));
        if (b.caption !== undefined) set('caption', (b.caption || '').trim().slice(0, 300) || null);
        if (b.active !== undefined) set('active', !!b.active);
        if (b.is_vip !== undefined) set('is_vip', !!b.is_vip);
        if (!updates.length) return res.status(400).json({ success: false, error: 'Nada pra atualizar' });
        values.push(sid);
        const { rows } = await db.query(`UPDATE chat_status_schedule SET ${updates.join(', ')} WHERE id = $${p} RETURNING *`, values);
        if (!rows.length) return res.status(404).json({ success: false, error: 'Não encontrado' });
        return res.json({ success: true, schedule: rows[0] });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

router.delete('/status-schedule/:sid', requireAdmin, async (req, res) => {
    const sid = parseInt(req.params.sid, 10);
    if (!sid) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { rowCount } = await db.query(`DELETE FROM chat_status_schedule WHERE id = $1`, [sid]);
        if (!rowCount) return res.status(404).json({ success: false, error: 'Não encontrado' });
        return res.json({ success: true, deleted: true });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

module.exports = router;
