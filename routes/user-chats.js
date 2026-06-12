/**
 * =============================================================================
 * routes/user-chats.js — Chat estilo WhatsApp com roteiro (lado do cliente)
 * =============================================================================
 *
 * Substitui o Typebot: cada chat é uma persona com um ROTEIRO em blocos
 * (chat_steps). O motor roda NO SERVIDOR — o cliente nunca recebe o roteiro
 * inteiro, só as mensagens até o próximo ponto interativo (botões / digitação).
 *
 * Identificação: e-mail logado (cookie do app) OU visitor_id anônimo
 * (localStorage do /chat-lab). Histórico fica em chat_messages (servidor).
 *
 * Gates:
 *   - chat.access='vip'   → bloqueado sem o produto vinculado (lista mostra 🔒)
 *   - reply_mode='vip'    → digitar livre só com o produto; 'all' = todos;
 *     'none' = ninguém (só botões do roteiro)
 *   - allow_photo + VIP   → cliente pode mandar foto
 *   - visualização única  → mídia entregue UMA vez; depois viewed_at trava
 * =============================================================================
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db');
const { logger } = require('../lib/logger');
const { optionalUser } = require('../lib/user-auth');

const MAX_STEPS_PER_RUN = 25;

// ── Identidade do cliente ────────────────────────────────────────────────────
function getIdentity(req) {
    const email = (req.user?.email || '').toLowerCase().trim() || null;
    const raw = (req.body?.visitor_id || req.query?.visitor_id || '');
    const visitor = String(raw).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || null;
    return { email: email && !email.endsWith('@preview.local') ? email : null, visitor };
}

async function ownsProduct(email, productId) {
    if (!email || !productId) return false;
    try {
        const { rows } = await db.query(
            `SELECT 1 FROM user_access WHERE LOWER(email) = $1 AND product_id = $2 AND status = 'active' LIMIT 1`,
            [email, productId]
        );
        return rows.length > 0;
    } catch (_) { return false; }
}

function permissions(chat, owns, ident) {
    const isVip = owns;
    const locked = chat.access === 'vip' && !isVip;
    let canReply = false;
    if (chat.reply_mode === 'all') canReply = !!(ident.email || ident.visitor);
    else if (chat.reply_mode === 'vip') canReply = isVip;
    return {
        locked,
        is_vip: isVip,
        can_reply: !locked && canReply,
        can_photo: !locked && isVip && chat.allow_photo === true,
        unlock: locked ? { checkout_url: chat.checkout_url || null, product_id: chat.product_id || null } : null,
    };
}

// ── Sessão ───────────────────────────────────────────────────────────────────
async function findOrCreateSession(chatId, ident, createIfMissing) {
    let row = null;
    if (ident.email) {
        const { rows } = await db.query(
            `SELECT * FROM chat_sessions WHERE chat_id = $1 AND LOWER(customer_email) = $2 ORDER BY id DESC LIMIT 1`,
            [chatId, ident.email]
        );
        row = rows[0] || null;
        // Mescla sessão anônima antiga do mesmo device pro e-mail logado
        if (!row && ident.visitor) {
            const { rows: anon } = await db.query(
                `UPDATE chat_sessions SET customer_email = $3, updated_at = NOW()
                 WHERE chat_id = $1 AND visitor_id = $2 AND customer_email IS NULL
                 RETURNING *`,
                [chatId, ident.visitor, ident.email]
            );
            row = anon[0] || null;
        }
    } else if (ident.visitor) {
        const { rows } = await db.query(
            `SELECT * FROM chat_sessions WHERE chat_id = $1 AND visitor_id = $2 AND customer_email IS NULL ORDER BY id DESC LIMIT 1`,
            [chatId, ident.visitor]
        );
        row = rows[0] || null;
    }
    if (!row && createIfMissing && (ident.email || ident.visitor)) {
        const { rows } = await db.query(
            `INSERT INTO chat_sessions (chat_id, customer_email, visitor_id) VALUES ($1, $2, $3) RETURNING *`,
            [chatId, ident.email, ident.visitor]
        );
        row = rows[0];
    }
    return row;
}

// ── Variáveis ({nome}) ───────────────────────────────────────────────────────
async function fillVars(text, ident) {
    if (!text || text.indexOf('{') === -1) return text;
    let nome = 'amor';
    if (ident.email) {
        try {
            const { rows } = await db.query(`SELECT name FROM customers WHERE LOWER(email) = $1 LIMIT 1`, [ident.email]);
            const n = (rows[0]?.name || '').trim().split(/\s+/)[0];
            if (n) nome = n.charAt(0).toUpperCase() + n.slice(1).toLowerCase();
        } catch (_) {}
    }
    return text.replace(/\{nome\}/gi, nome);
}

// ── Motor do roteiro ─────────────────────────────────────────────────────────
async function loadSteps(chatId) {
    const { rows } = await db.query(
        `SELECT * FROM chat_steps WHERE chat_id = $1 AND active = true ORDER BY step_order, id`,
        [chatId]
    );
    return rows;
}

function keyIndex(steps, key) {
    if (!key) return -1;
    const k = String(key).trim().toLowerCase();
    return steps.findIndex(s => (s.step_key || '').trim().toLowerCase() === k);
}

async function insertMsg(sessionId, sender, type, content, mediaUrl, meta, stepId) {
    const { rows } = await db.query(
        `INSERT INTO chat_messages (session_id, sender, type, content, media_url, meta, step_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [sessionId, sender, type, content || null, mediaUrl || null, meta ? JSON.stringify(meta) : null, stepId || null]
    );
    return rows[0];
}

// Executa o roteiro a partir do índice `idx` até o próximo ponto interativo.
// Retorna { newMessages, awaiting, currentIdx }.
async function runScript(session, chat, steps, idx, ident) {
    const out = [];
    let guard = MAX_STEPS_PER_RUN;
    let awaiting = null;
    while (idx >= 0 && idx < steps.length && guard-- > 0) {
        const s = steps[idx];
        const typing = Math.max(0, Math.min(8000, parseInt(s.typing_ms, 10) || 1200));
        if (s.type === 'buttons') {
            const btns = Array.isArray(s.buttons) ? s.buttons : [];
            const msg = await insertMsg(session.id, 'bot', 'buttons',
                await fillVars(s.content, ident), null,
                { buttons: btns.map(b => ({ label: String(b.label || '').slice(0, 60) })), typing_ms: typing }, s.id);
            out.push(msg);
            awaiting = 'buttons';
            break;
        }
        if (s.type === 'wait_input') {
            awaiting = 'input';
            break;
        }
        let type = s.type, content = null, media = null, meta = { typing_ms: typing };
        if (s.type === 'text') content = await fillVars(s.content, ident);
        else if (s.type === 'audio') { media = s.media_url; }
        else if (s.type === 'image') { media = s.media_url; content = await fillVars(s.content, ident); }
        else if (s.type === 'view_once_image' || s.type === 'view_once_video') { media = s.media_url; }
        else if (s.type === 'cta') {
            content = await fillVars(s.content, ident) || 'Ver oferta';
            meta.link_url = s.link_url || null;
            meta.product_id = s.product_id || null;
        } else {
            // tipo desconhecido: pula
            idx = idx + 1;
            continue;
        }
        const msg = await insertMsg(session.id, 'bot', type, content, media, meta, s.id);
        out.push(msg);
        const j = keyIndex(steps, s.goto_key);
        idx = j >= 0 ? j : idx + 1;
    }
    if (awaiting === null) idx = steps.length; // roteiro acabou
    await db.query(
        `UPDATE chat_sessions SET current_order = $2, awaiting = $3, updated_at = NOW() WHERE id = $1`,
        [session.id, idx, awaiting]
    );
    session.current_order = idx;
    session.awaiting = awaiting;
    return out;
}

// Mídia de visualização única: só entrega a URL se ainda não foi vista
function publicMsg(m) {
    const isOnce = m.type === 'view_once_image' || m.type === 'view_once_video';
    return {
        id: m.id,
        sender: m.sender,
        type: m.type,
        content: m.content,
        media_url: isOnce && m.viewed_at ? null : m.media_url,
        viewed: isOnce ? !!m.viewed_at : undefined,
        meta: m.meta || null,
        created_at: m.created_at,
    };
}

// ── ROTAS ────────────────────────────────────────────────────────────────────

// GET /chats — lista pra tela de conversas (com lock por usuário)
router.get('/chats', optionalUser, async (req, res) => {
    try {
        const ident = getIdentity(req);
        const { rows: chats } = await db.query(
            `SELECT * FROM chats WHERE active = true ORDER BY display_order, id`
        );
        const out = [];
        for (const c of chats) {
            const owns = await ownsProduct(ident.email, c.product_id);
            const perm = permissions(c, owns, ident);
            // preview da última mensagem da sessão desse cliente (se houver)
            let last = null;
            const session = await findOrCreateSession(c.id, ident, false);
            if (session) {
                const { rows: lm } = await db.query(
                    `SELECT sender, type, content, created_at FROM chat_messages WHERE session_id = $1 ORDER BY id DESC LIMIT 1`,
                    [session.id]
                );
                if (lm[0]) {
                    const t = lm[0].type;
                    last = {
                        preview: t === 'text' || t === 'buttons' ? (lm[0].content || 'Mensagem') :
                                 t === 'audio' ? 'Áudio' :
                                 t === 'image' ? 'Foto' :
                                 t === 'view_once_image' ? 'Foto · visualização única' :
                                 t === 'view_once_video' ? 'Vídeo · visualização única' :
                                 t === 'cta' ? (lm[0].content || 'Oferta') : 'Mensagem',
                        at: lm[0].created_at,
                    };
                }
            }
            out.push({
                id: c.id,
                name: c.name,
                avatar_url: c.avatar_url,
                section: c.section,
                status_label: c.status_label,
                show_online: c.show_online,
                locked: perm.locked,
                unlock: perm.unlock,
                last,
            });
        }
        return res.json({ success: true, chats: out });
    } catch (err) {
        logger.error('Erro listando chats:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// POST /chats/:id/open — abre/retoma a conversa (roda o roteiro se for nova)
router.post('/chats/:id/open', optionalUser, async (req, res) => {
    const chatId = parseInt(req.params.id, 10);
    if (!chatId) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const ident = getIdentity(req);
        const { rows: cr } = await db.query(`SELECT * FROM chats WHERE id = $1 AND active = true`, [chatId]);
        if (!cr.length) return res.status(404).json({ success: false, error: 'Chat não encontrado' });
        const chat = cr[0];
        const owns = await ownsProduct(ident.email, chat.product_id);
        const perm = permissions(chat, owns, ident);

        const persona = {
            id: chat.id, name: chat.name, avatar_url: chat.avatar_url,
            status_label: chat.status_label, show_online: chat.show_online,
        };
        // Bloqueado: não roda roteiro nem cria sessão
        if (perm.locked) {
            return res.json({ success: true, chat: persona, permissions: perm, messages: [], awaiting: null });
        }
        if (!ident.email && !ident.visitor) {
            return res.status(400).json({ success: false, error: 'visitor_id obrigatório' });
        }
        const session = await findOrCreateSession(chatId, ident, true);
        const steps = await loadSteps(chatId);

        const { rows: history } = await db.query(
            `SELECT * FROM chat_messages WHERE session_id = $1 ORDER BY id`, [session.id]
        );
        let fresh = [];
        if (history.length === 0 && steps.length > 0) {
            fresh = await runScript(session, chat, steps, 0, ident);
        }
        const all = history.concat(fresh).map(publicMsg);
        // histórico antigo não "re-digita": typing só nas mensagens novas
        const freshIds = new Set(fresh.map(m => m.id));
        for (const m of all) {
            if (!freshIds.has(m.id) && m.meta && m.meta.typing_ms) m.meta.typing_ms = 0;
        }
        return res.json({
            success: true,
            chat: persona,
            permissions: perm,
            messages: all,
            awaiting: session.awaiting,
        });
    } catch (err) {
        logger.error('Erro abrindo chat:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// POST /chats/:id/advance — botão escolhido, input do roteiro ou mensagem livre
router.post('/chats/:id/advance', optionalUser, async (req, res) => {
    const chatId = parseInt(req.params.id, 10);
    if (!chatId) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const ident = getIdentity(req);
        const { rows: cr } = await db.query(`SELECT * FROM chats WHERE id = $1 AND active = true`, [chatId]);
        if (!cr.length) return res.status(404).json({ success: false, error: 'Chat não encontrado' });
        const chat = cr[0];
        const owns = await ownsProduct(ident.email, chat.product_id);
        const perm = permissions(chat, owns, ident);
        if (perm.locked) return res.status(403).json({ success: false, error: 'vip_required' });

        const session = await findOrCreateSession(chatId, ident, true);
        const steps = await loadSteps(chatId);

        const choice = req.body?.choice;
        const text = (req.body?.text || '').toString().trim().slice(0, 1000);
        const newMsgs = [];

        if (choice !== undefined && choice !== null && session.awaiting === 'buttons') {
            const stepIdx = Math.min(session.current_order, steps.length - 1);
            const step = steps[stepIdx];
            const btns = (step && Array.isArray(step.buttons)) ? step.buttons : [];
            const chosen = btns[parseInt(choice, 10)];
            if (!chosen) return res.status(400).json({ success: false, error: 'Opção inválida' });
            // marca os botões como respondidos (some da tela ao recarregar)
            await db.query(
                `UPDATE chat_messages SET meta = COALESCE(meta, '{}'::jsonb) || '{"answered":true}'::jsonb
                 WHERE session_id = $1 AND type = 'buttons' AND step_id = $2`,
                [session.id, step.id]
            );
            newMsgs.push(await insertMsg(session.id, 'user', 'text', String(chosen.label || '').slice(0, 200), null, null, step.id));
            const j = keyIndex(steps, chosen.goto);
            const nextIdx = j >= 0 ? j : stepIdx + 1;
            const fresh = await runScript(session, chat, steps, nextIdx, ident);
            newMsgs.push(...fresh);
        } else if (text && session.awaiting === 'input') {
            const stepIdx = Math.min(session.current_order, steps.length - 1);
            const step = steps[stepIdx];
            newMsgs.push(await insertMsg(session.id, 'user', 'text', text, null, null, step ? step.id : null));
            const j = step ? keyIndex(steps, step.goto_key) : -1;
            const nextIdx = j >= 0 ? j : stepIdx + 1;
            const fresh = await runScript(session, chat, steps, nextIdx, ident);
            newMsgs.push(...fresh);
        } else if (text) {
            // Mensagem LIVRE (fora do roteiro) — aqui mora o gate VIP do enviar
            if (!perm.can_reply) {
                return res.status(403).json({ success: false, error: 'vip_required' });
            }
            newMsgs.push(await insertMsg(session.id, 'user', 'text', text, null, null, null));
        } else {
            return res.status(400).json({ success: false, error: 'Nada pra processar' });
        }

        return res.json({
            success: true,
            messages: newMsgs.map(publicMsg),
            awaiting: session.awaiting,
        });
    } catch (err) {
        logger.error('Erro no advance do chat:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// POST /chats/messages/:id/viewed — consome a visualização única
router.post('/chats/messages/:id/viewed', optionalUser, async (req, res) => {
    const msgId = parseInt(req.params.id, 10);
    if (!msgId) return res.status(400).json({ success: false });
    try {
        const ident = getIdentity(req);
        // Só marca se a mensagem pertence a uma sessão DESTE cliente
        const { rowCount } = await db.query(`
            UPDATE chat_messages m SET viewed_at = NOW()
            FROM chat_sessions s
            WHERE m.id = $1 AND m.session_id = s.id AND m.viewed_at IS NULL
              AND m.type IN ('view_once_image', 'view_once_video')
              AND (
                  ($2::text IS NOT NULL AND LOWER(s.customer_email) = $2) OR
                  ($3::text IS NOT NULL AND s.visitor_id = $3 AND s.customer_email IS NULL)
              )
        `, [msgId, ident.email, ident.visitor]);
        return res.json({ success: true, consumed: rowCount > 0 });
    } catch (err) {
        return res.json({ success: false });
    }
});

// POST /chats/:id/photo — foto do cliente (só VIP com allow_photo)
const chatPhotoUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 3 * 1024 * 1024 },
    fileFilter(_req, file, cb) {
        cb(/image\/(jpeg|png|webp)/.test(file.mimetype) ? null : new Error('Só JPG/PNG/WEBP'), true);
    },
});
router.post('/chats/:id/photo', optionalUser, (req, res) => {
    chatPhotoUpload.single('file')(req, res, async (err) => {
        if (err) return res.status(400).json({ success: false, error: err.message });
        const chatId = parseInt(req.params.id, 10);
        if (!chatId || !req.file) return res.status(400).json({ success: false, error: 'Arquivo obrigatório' });
        try {
            const ident = getIdentity(req);
            const { rows: cr } = await db.query(`SELECT * FROM chats WHERE id = $1 AND active = true`, [chatId]);
            if (!cr.length) return res.status(404).json({ success: false, error: 'Chat não encontrado' });
            const chat = cr[0];
            const owns = await ownsProduct(ident.email, chat.product_id);
            const perm = permissions(chat, owns, ident);
            if (!perm.can_photo) return res.status(403).json({ success: false, error: 'vip_required' });

            const dir = path.join(__dirname, '..', 'uploads', 'chat');
            fs.mkdirSync(dir, { recursive: true });
            const ext = req.file.mimetype === 'image/png' ? 'png' : req.file.mimetype === 'image/webp' ? 'webp' : 'jpg';
            const fname = Date.now() + '-' + crypto.randomBytes(6).toString('hex') + '.' + ext;
            fs.writeFileSync(path.join(dir, fname), req.file.buffer);
            const url = '/uploads/chat/' + fname;

            const session = await findOrCreateSession(chatId, ident, true);
            const msg = await insertMsg(session.id, 'user', 'image', null, url, null, null);
            return res.json({ success: true, message: publicMsg(msg) });
        } catch (e) {
            logger.error('Erro na foto do chat:', e);
            return res.status(500).json({ success: false, error: 'Erro interno' });
        }
    });
});

module.exports = router;
