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
const { parseBunnyUrl, bunnyHlsUrl } = require('../lib/bunny');

const MAX_STEPS_PER_RUN = 25;

// Tempo padrão (segundos) que a mídia de visualização única fica aberta antes de
// fechar sozinha, quando o bloco não definir. Cada mídia define o seu no painel.
const DEFAULT_VIEW_SECONDS = 7;

// Carrega + enriquece a chamada vinculada ao chat (pro VideoCall do app)
async function loadChatCall(callId) {
    if (!callId) return null;
    try {
        const { rows } = await db.query(
            `SELECT id, slug, category, model_name, model_photo, video_url, redirect_link,
                    cta_text, trigger_delay_sec, COALESCE(cta_type,'home') AS cta_type, cta_target_id
             FROM video_calls WHERE id = $1 AND active = true LIMIT 1`, [callId]
        );
        if (!rows.length) return null;
        const c = rows[0];
        const bunny = parseBunnyUrl(c.video_url);
        return { ...c, is_bunny: !!bunny, bunny_hls_url: bunny ? bunnyHlsUrl(bunny.guid) : null };
    } catch (_) { return null; }
}

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

// ── Variáveis: {nome}, {saudacao}, {cidade} ──────────────────────────────────
function saudacaoBrasilia() {
    // Brasília = UTC-3 (sem horário de verão desde 2019)
    const h = new Date(Date.now() - 3 * 3600 * 1000).getUTCHours();
    if (h >= 5 && h < 12) return 'bom dia';
    if (h >= 12 && h < 18) return 'boa tarde';
    return 'boa noite';
}
async function fillVars(text, ctx) {
    if (!text || text.indexOf('{') === -1) return text;
    let nome = 'amor';
    if (ctx && ctx.email) {
        try {
            const { rows } = await db.query(`SELECT name FROM customers WHERE LOWER(email) = $1 LIMIT 1`, [ctx.email]);
            const n = (rows[0]?.name || '').trim().split(/\s+/)[0];
            if (n) nome = n.charAt(0).toUpperCase() + n.slice(1).toLowerCase();
        } catch (_) {}
    }
    const cidade = (ctx && ctx.city) || (ctx && ctx.cityFallback) || 'sua região';
    return text
        .replace(/\{nome\}/gi, nome)
        .replace(/\{saudacao\}/gi, saudacaoBrasilia())
        .replace(/\{cidade\}/gi, cidade);
}

// Resolve IP→cidade UMA vez por sessão e guarda (alimenta {cidade})
async function ensureSessionGeo(session, req) {
    if (!session || session.ip) return session;
    const ip = (String(req.headers['x-forwarded-for'] || '').split(',')[0].trim())
        || req.headers['x-real-ip'] || req.ip || '';
    let city = null;
    try { city = require('../lib/geo').resolveCity(ip); } catch (_) {}
    try {
        await db.query(`UPDATE chat_sessions SET ip = $2, city = $3 WHERE id = $1`,
            [session.id, (ip || '').slice(0, 45) || null, city]);
    } catch (_) {}
    session.ip = ip || null;
    session.city = city;
    return session;
}

// ── Motor do roteiro ─────────────────────────────────────────────────────────
async function loadSteps(chatId, flow) {
    const { rows } = await db.query(
        `SELECT * FROM chat_steps WHERE chat_id = $1 AND active = true AND flow = $2 ORDER BY step_order, id`,
        [chatId, flow || 'open']
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
                { buttons: btns.map(b => ({ label: String(b.label || '').slice(0, 60) })), typing_ms: typing, allow_input: s.allow_input === true }, s.id);
            out.push(msg);
            awaiting = 'buttons';
            break;
        }
        if (s.type === 'wait_input') {
            awaiting = 'input';
            break;
        }
        if (s.type === 'delay') {
            // PAUSA o roteiro: marca quando retomar. O worker (app fechado) ou
            // o poll (app aberto) seguem a partir do PRÓXIMO bloco no horário.
            const secs = Math.max(1, Math.min(7 * 24 * 3600, parseInt(s.delay_seconds, 10) || 0));
            const j = keyIndex(steps, s.goto_key);
            const resumeIdx = j >= 0 ? j : idx + 1;
            awaiting = 'delay';
            const { rows: rr } = await db.query(
                `UPDATE chat_sessions SET current_order = $2, awaiting = 'delay', current_flow = $4,
                 resume_at = NOW() + make_interval(secs => $3), updated_at = NOW() WHERE id = $1
                 RETURNING resume_at`,
                [session.id, resumeIdx, secs, session.current_flow || 'open']
            );
            session.current_order = resumeIdx;
            session.awaiting = 'delay';
            session.resume_at = rr[0] ? rr[0].resume_at : null;
            return out; // sai sem o UPDATE final (já gravamos resume_at aqui)
        }
        let type = s.type, content = null, media = null, meta = { typing_ms: typing };
        if (s.type === 'text') content = await fillVars(s.content, ident);
        else if (s.type === 'audio') { media = s.media_url; }
        else if (s.type === 'image') { media = s.media_url; content = await fillVars(s.content, ident); }
        else if (s.type === 'view_once_image' || s.type === 'view_once_video') {
            media = s.media_url;
            const vs = parseInt(s.view_seconds, 10) || 0;
            meta.view_seconds = vs > 0 ? vs : DEFAULT_VIEW_SECONDS;
        }
        else if (s.type === 'cta') {
            content = await fillVars(s.content, ident) || 'Ver oferta';
            meta.link_url = s.link_url || null;
            meta.product_id = s.product_id || null;
        } else if (s.type === 'call') {
            // "Ela liga": o app dispara a chamada recebida (VideoCall). A mensagem
            // carrega só uma marca + texto; o payload da chamada vem do chat.
            content = await fillVars(s.content, ident) || null;
            meta.is_call = true;
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
        `UPDATE chat_sessions SET current_order = $2, awaiting = $3, current_flow = $4, updated_at = NOW() WHERE id = $1`,
        [session.id, idx, awaiting, session.current_flow || 'open']
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
            // preview da última mensagem + não-lidas (bot, após last_seen_at)
            let last = null;
            let unread = 0;
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
                const { rows: ur } = await db.query(
                    `SELECT COUNT(*)::int AS n FROM chat_messages
                     WHERE session_id = $1 AND sender = 'bot'
                       AND ($2::timestamptz IS NULL OR created_at > $2)`,
                    [session.id, session.last_seen_at]
                );
                unread = ur[0]?.n || 0;
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
                unread,
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

        const callPayload = await loadChatCall(chat.call_video_call_id);
        const persona = {
            id: chat.id, name: chat.name, avatar_url: chat.avatar_url,
            status_label: chat.status_label, show_online: chat.show_online,
            tag: chat.tag || null,
            gate_media: chat.gate_media === true,
            input_mode: chat.input_mode === 'gated' ? 'gated' : 'always',
            checkout_url: chat.checkout_url || null,
            has_call: !!callPayload,
            call_trigger: !!chat.call_goto_key,
            video_call: callPayload,
        };
        // identificado = e-mail real capturado (gate de mídia só vale pra anônimo)
        const identified = !!ident.email;
        // Bloqueado: não roda roteiro nem cria sessão
        if (perm.locked) {
            return res.json({ success: true, chat: persona, permissions: perm, identified, messages: [], awaiting: null });
        }
        if (!ident.email && !ident.visitor) {
            return res.status(400).json({ success: false, error: 'visitor_id obrigatório' });
        }
        const session = await findOrCreateSession(chatId, ident, true);
        await ensureSessionGeo(session, req);
        ident.city = session.city;
        ident.cityFallback = chat.city_fallback;

        const { rows: history } = await db.query(
            `SELECT * FROM chat_messages WHERE session_id = $1 ORDER BY id`, [session.id]
        );
        let fresh = [];
        if (history.length === 0) {
            // conversa nova → roda o fluxo "Abre conversa"
            session.current_flow = 'open';
            const steps = await loadSteps(chatId, 'open');
            if (steps.length > 0) fresh = await runScript(session, chat, steps, 0, ident);
        } else if (session.awaiting === 'delay' && session.resume_at && new Date(session.resume_at) <= new Date()) {
            // Delay já venceu e o cliente abriu a conversa: retoma no fluxo atual
            const steps = await loadSteps(chatId, session.current_flow || 'open');
            fresh = await runScript(session, chat, steps, session.current_order, ident);
        }
        const all = history.concat(fresh).map(publicMsg);
        // histórico antigo não "re-digita": typing só nas mensagens novas
        const freshIds = new Set(fresh.map(m => m.id));
        for (const m of all) {
            if (!freshIds.has(m.id) && m.meta && m.meta.typing_ms) m.meta.typing_ms = 0;
        }
        // Abrir = ler tudo até agora (zera não-lidas)
        await db.query(`UPDATE chat_sessions SET last_seen_at = NOW() WHERE id = $1`, [session.id]);
        return res.json({
            success: true,
            chat: persona,
            permissions: perm,
            identified,
            call_seen: !!session.call_seen_at,
            messages: all,
            awaiting: session.awaiting,
            resume_at: session.awaiting === 'delay' ? session.resume_at : null,
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
        await ensureSessionGeo(session, req);
        ident.city = session.city;
        ident.cityFallback = chat.city_fallback;
        const steps = await loadSteps(chatId, session.current_flow || 'open');

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
        } else if (text && session.awaiting === 'buttons') {
            // Bloco de BOTÕES com "permitir digitar" (allow_input): o cliente
            // pode DIGITAR em vez de clicar — a resposta livre avança o roteiro
            // (segue o goto do bloco, ou o próximo). É o modo TapBot.
            const stepIdx = Math.min(session.current_order, steps.length - 1);
            const step = steps[stepIdx];
            if (!step || step.allow_input !== true) {
                // Botões sem digitação liberada: não avança por texto.
                return res.status(400).json({ success: false, error: 'Escolha uma opção' });
            }
            await db.query(
                `UPDATE chat_messages SET meta = COALESCE(meta, '{}'::jsonb) || '{"answered":true}'::jsonb
                 WHERE session_id = $1 AND type = 'buttons' AND step_id = $2`,
                [session.id, step.id]
            );
            newMsgs.push(await insertMsg(session.id, 'user', 'text', text, null, null, step.id));
            const j = keyIndex(steps, step.goto_key);
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

        // Cliente interagiu = leu o que veio antes; só as mensagens novas do
        // bot (geradas agora) é que contam como não-lidas até ele ver.
        await db.query(`UPDATE chat_sessions SET last_seen_at = NOW() WHERE id = $1`, [session.id]);
        return res.json({
            success: true,
            messages: newMsgs.map(publicMsg),
            awaiting: session.awaiting,
            resume_at: session.awaiting === 'delay' ? session.resume_at : null,
        });
    } catch (err) {
        logger.error('Erro no advance do chat:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// GET /chats/:id/poll?after=<msgId> — mensagens novas (usado quando a conversa
// está aberta e o roteiro tem delay: o app busca o que o bot mandou desde então)
router.get('/chats/:id/poll', optionalUser, async (req, res) => {
    const chatId = parseInt(req.params.id, 10);
    const after = parseInt(req.query.after, 10) || 0;
    if (!chatId) return res.json({ success: false });
    try {
        const ident = getIdentity(req);
        const session = await findOrCreateSession(chatId, ident, false);
        if (!session) return res.json({ success: true, messages: [], awaiting: null });

        // Se o delay venceu, retoma o roteiro AGORA (cliente está com a tela aberta)
        if (session.awaiting === 'delay' && session.resume_at && new Date(session.resume_at) <= new Date()) {
            const { rows: cr } = await db.query(`SELECT * FROM chats WHERE id = $1 AND active = true`, [chatId]);
            if (cr.length) {
                ident.city = session.city;
                ident.cityFallback = cr[0].city_fallback;
                const steps = await loadSteps(chatId, session.current_flow || 'open');
                await runScript(session, cr[0], steps, session.current_order, ident);
            }
        }
        const { rows: msgs } = await db.query(
            `SELECT * FROM chat_messages WHERE session_id = $1 AND id > $2 ORDER BY id`,
            [session.id, after]
        );
        if (msgs.length) {
            await db.query(`UPDATE chat_sessions SET last_seen_at = NOW() WHERE id = $1`, [session.id]);
        }
        return res.json({ success: true, messages: msgs.map(publicMsg), awaiting: session.awaiting });
    } catch (err) {
        return res.json({ success: false });
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

// POST /chats/:id/call-seen — marca que o não-VIP já tentou ligar (blur 1x).
// Na próxima vez o app mostra só o aviso, sem a tela de chamada borrada.
router.post('/chats/:id/call-seen', optionalUser, async (req, res) => {
    const chatId = parseInt(req.params.id, 10);
    if (!chatId) return res.json({ success: false });
    try {
        const ident = getIdentity(req);
        const session = await findOrCreateSession(chatId, ident, true);
        if (session) await db.query(`UPDATE chat_sessions SET call_seen_at = NOW() WHERE id = $1 AND call_seen_at IS NULL`, [session.id]);
        return res.json({ success: true });
    } catch (_) { return res.json({ success: false }); }
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

// ── Retomada de delays (chamada pelo worker — app fechado) ───────────────────
// Pega sessões cujo delay venceu, continua o roteiro do ponto pausado e
// devolve as mensagens novas + dados pro push. Reusa o MESMO motor (runScript).
async function resumeDelayed(limit) {
    const { rows: due } = await db.query(`
        UPDATE chat_sessions SET awaiting = 'resuming'
        WHERE id IN (
            SELECT id FROM chat_sessions
            WHERE awaiting = 'delay' AND resume_at IS NOT NULL AND resume_at <= NOW()
            ORDER BY resume_at LIMIT $1 FOR UPDATE SKIP LOCKED
        ) RETURNING *
    `, [limit || 30]);

    const results = [];
    for (const session of due) {
        try {
            const { rows: cr } = await db.query(`SELECT * FROM chats WHERE id = $1 AND active = true`, [session.chat_id]);
            if (!cr.length) {
                await db.query(`UPDATE chat_sessions SET awaiting = NULL WHERE id = $1`, [session.id]);
                continue;
            }
            const chat = cr[0];
            const ident = {
                email: session.customer_email && !String(session.customer_email).endsWith('@preview.local') ? String(session.customer_email).toLowerCase() : null,
                visitor: session.visitor_id || null,
                city: session.city || null,
                cityFallback: chat.city_fallback,
            };
            const steps = await loadSteps(session.chat_id, session.current_flow || 'open');
            session.awaiting = 'delay'; // runScript lê/sobrescreve normalmente
            const fresh = await runScript(session, chat, steps, session.current_order, ident);
            if (fresh.length) {
                results.push({ session, chat, messages: fresh, email: ident.email });
            }
        } catch (err) {
            logger.warn('[chat] resumeDelayed falhou na sessão ' + session.id + ': ' + err.message);
            await db.query(`UPDATE chat_sessions SET awaiting = NULL WHERE id = $1`, [session.id]).catch(() => {});
        }
    }
    return results;
}

// ── Pós-compra: inicia o roteiro dos chats vinculados ao produto comprado ────
// Chamado pelo sales-processor quando uma venda é aprovada. Para cada chat com
// trigger_product_ids contendo um dos produtos, cria a sessão do e-mail (se a
// conversa ainda não começou) e roda o roteiro. Devolve [{chat, messages}] pro
// caller disparar o push de "ela te mandou mensagem".
async function triggerPostPurchaseChats(email, productIds) {
    const e = String(email || '').toLowerCase().trim();
    const ids = (Array.isArray(productIds) ? productIds : []).map(x => parseInt(x, 10)).filter(Boolean);
    if (!e || e.endsWith('@preview.local') || !ids.length) return [];
    const { rows: chats } = await db.query(`SELECT * FROM chats WHERE active = true AND trigger_product_ids IS NOT NULL`);
    const out = [];
    for (const chat of chats) {
        let trig = [];
        try { trig = Array.isArray(chat.trigger_product_ids) ? chat.trigger_product_ids : JSON.parse(chat.trigger_product_ids || '[]'); } catch (_) {}
        if (!trig.some(pid => ids.includes(parseInt(pid, 10)))) continue;
        try {
            // sessão por e-mail; se já existe e já tem mensagens, não reinicia
            let session = await findOrCreateSession(chat.id, { email: e, visitor: null }, true);
            const { rows: existing } = await db.query(`SELECT COUNT(*)::int AS n FROM chat_messages WHERE session_id = $1`, [session.id]);
            const steps = await loadSteps(chat.id, 'open');
            if (existing[0].n > 0 || !steps.length) continue;
            const ident = { email: e, visitor: null, city: session.city || null, cityFallback: chat.city_fallback };
            session.current_flow = 'open';
            const fresh = await runScript(session, chat, steps, 0, ident);
            // pós-compra chega como NÃO-lida (last_seen fica no passado)
            await db.query(`UPDATE chat_sessions SET last_seen_at = NULL WHERE id = $1`, [session.id]);
            if (fresh.length) out.push({ chat, messages: fresh, email: e });
        } catch (err) {
            logger.warn('[chat] triggerPostPurchase falhou chat ' + chat.id + ': ' + err.message);
        }
    }
    return out;
}

// ── STATUS (stories) ─────────────────────────────────────────────────────────
async function markStatusViewed(sid, ident) {
    try {
        await db.query(
            `INSERT INTO chat_status_views (status_id, customer_email, visitor_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
            [sid, ident.email, ident.visitor]
        );
    } catch (_) {}
}

// GET /chats/status — fileira de stories: personas com status ativo (24h) + não-visto
router.get('/chats/status', optionalUser, async (req, res) => {
    try {
        const ident = getIdentity(req);
        const { rows } = await db.query(`
            SELECT s.id, s.chat_id, s.type, s.media_url, s.caption, s.bg_color, s.created_at,
                   c.name, c.avatar_url, c.display_order,
                   EXISTS(SELECT 1 FROM chat_status_views v WHERE v.status_id = s.id
                          AND (($1 <> '' AND LOWER(v.customer_email) = $1) OR ($2 <> '' AND v.visitor_id = $2))) AS seen
            FROM chat_status s
            JOIN chats c ON c.id = s.chat_id
            WHERE s.active = true AND s.expires_at > NOW() AND c.active = true
            ORDER BY c.display_order, c.id, s.created_at
        `, [ident.email || '', ident.visitor || '']);
        const map = new Map();
        for (const r of rows) {
            if (!map.has(r.chat_id)) {
                map.set(r.chat_id, { chat_id: r.chat_id, name: r.name, avatar_url: r.avatar_url, has_unseen: false, items: [] });
            }
            const g = map.get(r.chat_id);
            g.items.push({ id: r.id, type: r.type, media_url: r.media_url, caption: r.caption, bg_color: r.bg_color, created_at: r.created_at });
            if (!r.seen) g.has_unseen = true;
        }
        // não-vistos primeiro (anel verde acende), igual WhatsApp
        const stories = Array.from(map.values()).sort((a, b) => (b.has_unseen - a.has_unseen));
        return res.json({ success: true, stories });
    } catch (err) {
        logger.error('Erro no feed de status:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// POST /chats/status/:sid/view — marca que o cliente viu o status
router.post('/chats/status/:sid/view', optionalUser, async (req, res) => {
    const sid = parseInt(req.params.sid, 10);
    if (!sid) return res.json({ success: false });
    const ident = getIdentity(req);
    if (!ident.email && !ident.visitor) return res.json({ success: false });
    await markStatusViewed(sid, ident);
    return res.json({ success: true });
});

// POST /status/:sid/reply — responder o status: a resposta CAI NA CONVERSA e,
// se o status tiver gatilho (reply_goto_key), o roteiro pula pro bloco e a
// modelo "reage". Devolve chat_id pro app abrir a conversa.
router.post('/chats/status/:sid/reply', optionalUser, async (req, res) => {
    const sid = parseInt(req.params.sid, 10);
    if (!sid) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const ident = getIdentity(req);
        if (!ident.email && !ident.visitor) return res.status(400).json({ success: false, error: 'visitor_id obrigatório' });
        const text = (req.body?.text || '').toString().trim().slice(0, 1000);
        const { rows: sr } = await db.query(
            `SELECT s.* FROM chat_status s JOIN chats c ON c.id = s.chat_id
             WHERE s.id = $1 AND s.active = true AND s.expires_at > NOW() AND c.active = true`, [sid]
        );
        if (!sr.length) return res.status(404).json({ success: false, error: 'Status expirado' });
        const st = sr[0];
        const { rows: cr } = await db.query(`SELECT * FROM chats WHERE id = $1`, [st.chat_id]);
        if (!cr.length) return res.status(404).json({ success: false, error: 'Chat não encontrado' });
        const chat = cr[0];
        const session = await findOrCreateSession(st.chat_id, ident, true);
        await ensureSessionGeo(session, req);
        ident.city = session.city; ident.cityFallback = chat.city_fallback;
        await markStatusViewed(sid, ident);
        if (text) {
            // guarda a referência do status pra mostrar o "respondeu status"
            // (estilo WhatsApp: miniatura + nome) acima da resposta.
            const ref = {
                status_reply: sid,
                ref: {
                    type: st.type,
                    media_url: (st.type === 'image' || st.type === 'video') ? st.media_url : null,
                    caption: st.caption || null,
                    bg_color: st.bg_color || null,
                    name: chat.name,
                },
            };
            await insertMsg(session.id, 'user', 'text', text, null, ref, null);
        }
        // gatilho: roda o FLUXO "Respondeu status" (a modelo reage). Se não houver
        // blocos nesse fluxo, cai no fallback antigo (reply_goto_key dentro de 'open').
        let triggered = false;
        const flowSteps = await loadSteps(st.chat_id, 'status_reply');
        if (flowSteps.length > 0) {
            session.current_flow = 'status_reply';
            await runScript(session, chat, flowSteps, 0, ident);
            triggered = true;
        } else if (st.reply_goto_key) {
            const steps = await loadSteps(st.chat_id, 'open');
            const j = keyIndex(steps, st.reply_goto_key);
            if (j >= 0) { session.current_flow = 'open'; await runScript(session, chat, steps, j, ident); triggered = true; }
        }
        // chega como não-lida (o app vai abrir a conversa e marcar como visto)
        await db.query(`UPDATE chat_sessions SET last_seen_at = NULL WHERE id = $1`, [session.id]);
        return res.json({ success: true, chat_id: st.chat_id, replied: !!text, triggered });
    } catch (err) {
        logger.error('Erro respondendo status:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// POST /chats/:id/call-trigger — gatilho de LIGAÇÃO: quando o cliente liga, o
// roteiro pula pro bloco call_goto_key (a "reação" da ligação). Idempotente o
// suficiente: só roda se o bloco existir. Devolve as mensagens novas pro app.
router.post('/chats/:id/call-trigger', optionalUser, async (req, res) => {
    const chatId = parseInt(req.params.id, 10);
    if (!chatId) return res.json({ success: false });
    try {
        const ident = getIdentity(req);
        if (!ident.email && !ident.visitor) return res.json({ success: false });
        const { rows: cr } = await db.query(`SELECT * FROM chats WHERE id = $1 AND active = true`, [chatId]);
        if (!cr.length) return res.json({ success: true, messages: [] });
        const chat = cr[0];
        const session = await findOrCreateSession(chatId, ident, true);
        await ensureSessionGeo(session, req);
        ident.city = session.city; ident.cityFallback = chat.city_fallback;
        // roda o FLUXO "Tentou ligar". Fallback: call_goto_key dentro de 'open'.
        let fresh = [];
        const flowSteps = await loadSteps(chatId, 'call');
        if (flowSteps.length > 0) {
            session.current_flow = 'call';
            fresh = await runScript(session, chat, flowSteps, 0, ident);
        } else if (chat.call_goto_key) {
            const steps = await loadSteps(chatId, 'open');
            const j = keyIndex(steps, chat.call_goto_key);
            if (j >= 0) { session.current_flow = 'open'; fresh = await runScript(session, chat, steps, j, ident); }
        }
        return res.json({ success: true, messages: fresh.map(publicMsg), awaiting: session.awaiting });
    } catch (err) {
        logger.error('Erro no gatilho de ligação:', err);
        return res.json({ success: false });
    }
});

// ── Rotina de status: posta os agendamentos cujo horário (Brasília) venceu ───
// Chamado pelo worker. Cria um chat_status (story) por agendamento devido, 1x/dia.
async function postDueStatusSchedules() {
    const bz = new Date(Date.now() - 3 * 3600 * 1000); // Brasília UTC-3
    const weekday = bz.getUTCDay(); // 0=Dom .. 6=Sáb
    const nowHM = String(bz.getUTCHours()).padStart(2, '0') + ':' + String(bz.getUTCMinutes()).padStart(2, '0');
    const today = bz.getUTCFullYear() + '-' + String(bz.getUTCMonth() + 1).padStart(2, '0') + '-' + String(bz.getUTCDate()).padStart(2, '0');
    let rows;
    try {
        const r = await db.query(
            `SELECT * FROM chat_status_schedule WHERE active = true AND (last_posted_date IS NULL OR last_posted_date <> $1::date)`,
            [today]
        );
        rows = r.rows;
    } catch (_) { return 0; }
    let posted = 0;
    for (const s of rows) {
        let wd = [];
        try { wd = Array.isArray(s.weekdays) ? s.weekdays : JSON.parse(s.weekdays || '[]'); } catch (_) {}
        if (!wd.map(Number).includes(weekday)) continue;
        if (String(s.post_time) > nowHM) continue; // ainda não deu o horário
        try {
            await db.query(
                `INSERT INTO chat_status (chat_id, type, media_url, caption, bg_color, reply_goto_key, expires_at)
                 VALUES ($1,$2,$3,$4,$5,$6, NOW() + make_interval(hours => $7))`,
                [s.chat_id, s.type, s.media_url, s.caption, s.bg_color, s.reply_goto_key, Math.max(1, Math.min(168, s.expires_hours || 24))]
            );
            await db.query(`UPDATE chat_status_schedule SET last_posted_date = $2::date WHERE id = $1`, [s.id, today]);
            posted++;
        } catch (err) { logger.warn('[status-schedule] falhou id ' + s.id + ': ' + err.message); }
    }
    return posted;
}

module.exports = router;
module.exports.resumeDelayed = resumeDelayed;
module.exports.triggerPostPurchaseChats = triggerPostPurchaseChats;
module.exports.postDueStatusSchedules = postDueStatusSchedules;
