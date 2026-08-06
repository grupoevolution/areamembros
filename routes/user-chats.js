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
 *   - VIP                 → input SEMPRE liberado + pode mandar foto em TODAS
 *                           as conversas (100% liberado após pagar; allow_photo
 *                           e reply_mode/input_mode não valem mais pra ele)
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
const { parseBunnyUrl, bunnyHlsUrl, bunnyThumbUrl } = require('../lib/bunny');

// Vídeo do Bunny STREAM no chat: o link colado no painel (mediadelivery.net)
// não toca em <video> cru. Entregamos junto o endereço HLS + a capa — o app
// toca no player NATIVO (visual de WhatsApp), mesma infra das chamadinhas.
// Sem BUNNY_HLS_HOST no env devolve null e o app cai no player embutido.
function streamMediaMeta(url) {
    const b = parseBunnyUrl(url);
    if (!b) return null;
    const hls = bunnyHlsUrl(b.guid);
    if (!hls) return null;
    return { hls, thumb: bunnyThumbUrl(b.guid, 'thumbnail.jpg') };
}

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
    if (!email) return false;
    // E-mail Premium (preview) destrava tudo, inclusive chat VIP (antes do guard
    // de productId, pra preview ver tudo mesmo quando o produto não foi configurado).
    try { if (await require('../lib/preview').isPreviewEmail(email)) return true; } catch (_) {}
    if (!productId) return false;
    try {
        const { rows } = await db.query(
            `SELECT 1 FROM user_access WHERE LOWER(email) = $1 AND product_id = $2 AND status = 'active' AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1`,
            [email, productId]
        );
        return rows.length > 0;
    } catch (_) { return false; }
}

// ── Produto ÚNICO do chat ("Assinatura do Chat") ─────────────────────────────
// Um produto oculto do catálogo (products.is_chat_plan = true) vale pra TODAS
// as conversas: chats VIP e o bloco 🔒 Paywall do roteiro apontam pra ele por
// padrão. Comprou qualquer plano dele (webhook grava em user_access) = destrava
// tudo. O product_id por chat continua valendo como OVERRIDE opcional.
let _chatPlanCache = { id: null, at: 0 };
async function chatPlanProductId() {
    if (Date.now() - _chatPlanCache.at < 60000) return _chatPlanCache.id;
    try {
        const { rows } = await db.query(
            `SELECT id FROM products WHERE is_chat_plan = true AND is_active = true ORDER BY id LIMIT 1`
        );
        _chatPlanCache = { id: rows.length ? rows[0].id : null, at: Date.now() };
    } catch (_) { _chatPlanCache = { id: null, at: Date.now() }; }
    return _chatPlanCache.id;
}
// Produto efetivo de desbloqueio de um chat: o override do chat, senão o único.
async function chatUnlockProductId(chat) {
    return (chat && chat.product_id) || (await chatPlanProductId());
}
// Produto ÚNICO dos Stories VIP (products.is_story_plan) — fallback quando a
// modelo não tem story_vip_product_id próprio. Mesmo padrão do chat.
let _storyPlanCache = { id: null, at: 0 };
async function storyPlanProductId() {
    if (Date.now() - _storyPlanCache.at < 60000) return _storyPlanCache.id;
    try {
        const { rows } = await db.query(
            `SELECT id FROM products WHERE is_story_plan = true AND is_active = true ORDER BY id LIMIT 1`
        );
        _storyPlanCache = { id: rows.length ? rows[0].id : null, at: Date.now() };
    } catch (_) { _storyPlanCache = { id: null, at: Date.now() }; }
    return _storyPlanCache.id;
}
// O cliente é "VIP do chat"? Tem o produto do chat (override OU único).
async function ownsChatVip(email, chat) {
    if (!email) return false;
    if (chat && chat.product_id && await ownsProduct(email, chat.product_id)) return true;
    const globalId = await chatPlanProductId();
    if (globalId && globalId !== (chat && chat.product_id)) return ownsProduct(email, globalId);
    // sem produto nenhum configurado: cai no ownsProduct (que já trata preview)
    return ownsProduct(email, (chat && chat.product_id) || null);
}

// Monta a info de desbloqueio (produto + planos) usada nos paywalls VIP
// (conversa, stories). O frontend renderiza o banner com o nome/preço/planos.
async function loadUnlock(productId, checkoutUrl) {
    if (!productId && !checkoutUrl) return null;
    const info = { product_id: productId || null, checkout_url: checkoutUrl || null, name: null, price: null, banner_url: null, plans: [] };
    if (productId) {
        try {
            const { rows } = await db.query(`SELECT id, name, price, banner_url FROM products WHERE id = $1 LIMIT 1`, [productId]);
            if (rows.length) { info.name = rows[0].name; info.price = rows[0].price; info.banner_url = rows[0].banner_url; }
            const { rows: plans } = await db.query(
                `SELECT name, price, original_price, badge, benefits, checkout_url, is_recommended
                 FROM product_plans WHERE product_id = $1 AND active = true ORDER BY display_order, id`, [productId]
            );
            info.plans = plans;
        } catch (_) {}
    }
    return info;
}

function permissions(chat, owns, ident) {
    const isVip = owns;
    // teaser_locked (isca "só prévia") tranca IGUAL a VIP pra quem não tem
    // acesso — centralizado AQUI pra valer em TODAS as rotas (/start, /advance,
    // /photo…), não só na lista e no /open como antes (a API direta conversava
    // normal com chat teaser). A 1ª mensagem automática (a isca) não passa por
    // aqui (ensureAutoStart/worker), então continua sendo gerada.
    const locked = (chat.access === 'vip' || chat.teaser_locked === true) && !isVip;
    let canReply = false;
    if (chat.reply_mode === 'all') canReply = !!(ident.email || ident.visitor);
    else if (chat.reply_mode === 'vip') canReply = isVip;
    return {
        locked,
        is_vip: isVip,
        // VIP responde SEMPRE (independente do reply_mode) — ele pagou
        can_reply: isVip || (!locked && canReply),
        // VIP pode mandar foto em qualquer conversa (a config allow_photo vira
        // irrelevante depois de pagar — "100% liberado após pagar")
        can_photo: !locked && isVip,
        unlock: locked ? { checkout_url: chat.checkout_url || null, product_id: chat.product_id || null } : null,
    };
}

// ── Sessão ───────────────────────────────────────────────────────────────────
// Escolhe a sessão CANÔNICA de uma lista (mesmo chat+email ou chat+visitor) e
// FUNDE as duplicadas nela: move as mensagens pra canônica e apaga as vazias.
// Canônica = a com MAIS mensagens (empate = mais antiga). Resolve o bug do
// "histórico zerando": e-mail podia ter >1 sessão e o sistema pegava a vazia.
async function consolidateSessions(sessions) {
    if (!sessions || !sessions.length) return null;
    if (sessions.length === 1) return sessions[0];
    const ids = sessions.map(s => s.id);
    try {
        // TRANSAÇÃO + FOR UPDATE: duas requests consolidando as mesmas sessões
        // ao mesmo tempo — a 2ª espera a 1ª terminar e já enxerga o resultado.
        // Sem isto, o DELETE podia rodar entre o UPDATE de outra consolidação e
        // o CASCADE apagava mensagem recém-movida (janela rara, perda real).
        return await db.transaction(async (client) => {
            const { rows: locked } = await client.query(
                `SELECT * FROM chat_sessions WHERE id = ANY($1) ORDER BY id ASC FOR UPDATE`, [ids]
            );
            if (!locked.length) return null;
            if (locked.length === 1) return locked[0];
            const { rows: cnt } = await client.query(
                `SELECT session_id, COUNT(*)::int AS n FROM chat_messages WHERE session_id = ANY($1) GROUP BY session_id`,
                [locked.map(s => s.id)]
            );
            const nOf = {}; cnt.forEach(r => { nOf[r.session_id] = r.n; });
            let canon = locked[0];
            for (const s of locked) {
                const sn = nOf[s.id] || 0, cn = nOf[canon.id] || 0;
                if (sn > cn || (sn === cn && s.id < canon.id)) canon = s;
            }
            for (const s of locked) {
                if (s.id === canon.id) continue;
                await client.query(`UPDATE chat_messages SET session_id = $1 WHERE session_id = $2`, [canon.id, s.id]);
                await client.query(`DELETE FROM chat_sessions WHERE id = $1`, [s.id]);
            }
            return canon;
        });
    } catch (_) {
        // blip de banco: NÃO funde agora (próxima chamada tenta de novo), mas
        // ainda devolve a sessão COM histórico — a garantia que corrigiu o bug
        try {
            const { rows: cnt } = await db.query(
                `SELECT session_id, COUNT(*)::int AS n FROM chat_messages WHERE session_id = ANY($1) GROUP BY session_id`,
                [ids]
            );
            const nOf = {}; cnt.forEach(r => { nOf[r.session_id] = r.n; });
            let canon = sessions[0];
            for (const s of sessions) {
                const sn = nOf[s.id] || 0, cn = nOf[canon.id] || 0;
                if (sn > cn || (sn === cn && s.id < canon.id)) canon = s;
            }
            return canon;
        } catch (_) { return sessions[0]; }
    }
}

// Move as mensagens de uma sessão pra outra e apaga a origem — atômico.
async function mergeSessionInto(fromId, toId) {
    await db.transaction(async (client) => {
        await client.query(`SELECT id FROM chat_sessions WHERE id = ANY($1) FOR UPDATE`, [[fromId, toId]]);
        await client.query(`UPDATE chat_messages SET session_id = $1 WHERE session_id = $2`, [toId, fromId]);
        await client.query(`DELETE FROM chat_sessions WHERE id = $1`, [fromId]);
    });
}

async function findOrCreateSession(chatId, ident, createIfMissing) {
    let row = null;
    if (ident.email) {
        // TODAS as sessões desse e-mail+chat (pode haver duplicatas do bug antigo)
        // → funde numa só e carrega SEMPRE a que tem o histórico.
        const { rows: emailSessions } = await db.query(
            `SELECT * FROM chat_sessions WHERE chat_id = $1 AND LOWER(customer_email) = $2 ORDER BY id ASC`,
            [chatId, ident.email]
        );
        row = await consolidateSessions(emailSessions);
        // Sessão anônima do mesmo device (antes do login): em vez de virar uma
        // 2ª sessão do e-mail (o que zerava o histórico), MOVE as mensagens dela
        // pra sessão do e-mail — ou adota ela se o e-mail ainda não tinha nenhuma.
        if (ident.visitor) {
            const { rows: anon } = await db.query(
                `SELECT * FROM chat_sessions WHERE chat_id = $1 AND visitor_id = $2 AND customer_email IS NULL ORDER BY id ASC`,
                [chatId, ident.visitor]
            );
            if (anon.length) {
                if (!row) {
                    const canonAnon = await consolidateSessions(anon);
                    await db.query(`UPDATE chat_sessions SET customer_email = $2, updated_at = NOW() WHERE id = $1`, [canonAnon.id, ident.email]);
                    canonAnon.customer_email = ident.email; row = canonAnon;
                } else {
                    for (const a of anon) {
                        try { await mergeSessionInto(a.id, row.id); } catch (_) {}
                    }
                }
            }
        }
    } else if (ident.visitor) {
        const { rows } = await db.query(
            `SELECT * FROM chat_sessions WHERE chat_id = $1 AND visitor_id = $2 AND customer_email IS NULL ORDER BY id ASC`,
            [chatId, ident.visitor]
        );
        row = await consolidateSessions(rows);
    }
    if (!row && createIfMissing && (ident.email || ident.visitor)) {
        // Trava atômica (advisory lock) na criação: dois pedidos simultâneos do
        // mesmo lead (boot dispara /chats + /open + /poll juntos) criavam DUAS
        // sessões — o roteiro de abertura rodava em dobro e depois a fusão
        // juntava as mensagens duplicadas. Com a trava, o 2º pedido espera e
        // encontra a sessão que o 1º criou.
        const lockKey = `chat_sess:${chatId}:${ident.email || ident.visitor}`;
        row = await db.transaction(async (client) => {
            await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [lockKey]);
            const { rows: again } = ident.email
                ? await client.query(
                    `SELECT * FROM chat_sessions WHERE chat_id = $1 AND LOWER(customer_email) = $2 ORDER BY id ASC LIMIT 1`,
                    [chatId, ident.email])
                : await client.query(
                    `SELECT * FROM chat_sessions WHERE chat_id = $1 AND visitor_id = $2 AND customer_email IS NULL ORDER BY id ASC LIMIT 1`,
                    [chatId, ident.visitor]);
            if (again[0]) return again[0];
            const { rows } = await client.query(
                `INSERT INTO chat_sessions (chat_id, customer_email, visitor_id) VALUES ($1, $2, $3) RETURNING *`,
                [chatId, ident.email, ident.visitor]
            );
            return rows[0];
        });
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
// Período do dia em Brasília — casa com o campo "period" das frases da
// saudação automática (gamification_config.chat_greetings).
function periodoBrasilia() {
    const h = new Date(Date.now() - 3 * 3600 * 1000).getUTCHours();
    if (h >= 5 && h < 12) return 'manha';
    if (h >= 12 && h < 18) return 'tarde';
    if (h >= 18) return 'noite';
    return 'madrugada';
}

// SAUDAÇÃO AUTOMÁTICA: sorteia UMA frase da lista global respeitando o período
// (Brasília). Frases com {cidade} só entram no sorteio se a sessão TEM cidade
// (senão o cliente veria "vi que vc é de sua região" — quebra a ilusão).
async function pickGreetingPhrase(session) {
    try {
        const { rows } = await db.query(`SELECT value FROM gamification_config WHERE key = 'chat_greetings'`);
        const cfg = rows[0]?.value || {};
        const all = Array.isArray(cfg.phrases) ? cfg.phrases : [];
        const per = periodoBrasilia();
        let pool = all.filter(p => p && typeof p.text === 'string' && p.text.trim()
            && (!p.period || p.period === 'any' || p.period === per));
        if (!session || !session.city) pool = pool.filter(p => p.text.indexOf('{cidade}') === -1);
        if (!pool.length) return null;
        return pool[Math.floor(Math.random() * pool.length)].text;
    } catch (_) { return null; }
}

// Entrega a saudação AGENDADA (chat_sessions.pending_greeting) se houver:
// insere como mensagem da modelo, limpa o agendamento e devolve a mensagem.
// Chamado nos 3 pontos que "acordam" um delay vencido (worker, /poll e /open).
async function deliverPendingGreeting(session) {
    if (!session || !session.pending_greeting) return null;
    const msg = await insertMsg(session.id, 'bot', 'text', session.pending_greeting, null, { typing_ms: 2500 }, null);
    await db.query(
        `UPDATE chat_sessions SET pending_greeting = NULL, awaiting = NULL, resume_at = NULL,
                last_seen_at = NULL, updated_at = NOW() WHERE id = $1`,
        [session.id]
    );
    session.pending_greeting = null;
    session.awaiting = null;
    return msg;
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

// Motor de conversas: agenda a 1ª mensagem da modelo pra chegar SOZINHA X minutos
// depois que o cliente entra no app. Cria a sessão num estado "delay" que o worker
// (chat-worker) retoma no horário rodando o fluxo 'open'. Só agenda 1x (se já tem
// sessão, não mexe). Vale pra chat VIP também (a prévia aparece borrada na lista).
async function ensureAutoStart(chat, ident) {
    if (!chat || !chat.auto_start_minutes || chat.auto_start_minutes <= 0) return;
    if (!ident.email && !ident.visitor) return;
    const existing = await findOrCreateSession(chat.id, ident, false);
    if (existing) return; // já começou/agendou
    const steps = await loadSteps(chat.id, 'open');
    if (!steps.length) return; // sem roteiro de abertura, nada a agendar
    const session = await findOrCreateSession(chat.id, ident, true);
    await db.query(
        `UPDATE chat_sessions SET awaiting = 'delay', current_flow = 'open', current_order = 0,
         resume_at = NOW() + make_interval(mins => $2), last_seen_at = NULL, updated_at = NOW()
         WHERE id = $1`,
        [session.id, chat.auto_start_minutes]
    );
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
    // 1ª mensagem do run: o "digitando..." usa o tempo REAL configurado no
    // bloco (as seguintes pegam pacing server-side, que já espera esse tempo).
    let firstOut = true;
    while (idx >= 0 && idx < steps.length && guard-- > 0) {
        const s = steps[idx];
        const typing = Math.max(0, Math.min(10000, parseInt(s.typing_ms, 10) || 3000));
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
        if (s.type === 'paywall') {
            // 🔒 Marca o PONTO do paywall e SEGUE o roteiro (decisão do dono):
            // a modelo continua mandando mensagens/ligações normalmente — é o
            // LEAD que não consegue responder, ligar nem atender sem assinar
            // (digitar vira "não entregue" + popup). VIP passa sem marca.
            // A CONTINUAÇÃO pós-venda mora no fluxo 'vip': dispara quando o
            // lead PAGA e manda a primeira mensagem (o input dele liberou).
            const vip = await ownsChatVip(ident.email, chat);
            if (!vip && !session.paywalled_at) {
                await db.query(
                    `UPDATE chat_sessions SET paywalled_at = NOW(), updated_at = NOW() WHERE id = $1`,
                    [session.id]
                );
                session.paywalled_at = new Date();
            }
            idx = idx + 1;
            continue;
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
        // O "tempo de digitar" vira a ESPERA no servidor (pacing) — então a
        // mensagem em si renderiza rápido no cliente (settle curto). O "digitando…"
        // aparece durante a espera (awaiting='delay'), não em cima da mensagem.
        // Exceção: a 1ª mensagem do run não teve pacing antes — ela carrega o
        // typing REAL do bloco pro cliente mostrar "digitando..." pelo tempo certo.
        let type = s.type, content = null, media = null, meta = { typing_ms: firstOut ? typing : 500 };
        firstOut = false;
        if (s.type === 'text') content = await fillVars(s.content, ident);
        else if (s.type === 'audio') { media = s.media_url; }
        else if (s.type === 'image') { media = s.media_url; content = await fillVars(s.content, ident); }
        else if (s.type === 'video') { media = s.media_url; content = await fillVars(s.content, ident); }
        else if (s.type === 'view_once_image' || s.type === 'view_once_video') {
            media = s.media_url;
            const vs = parseInt(s.view_seconds, 10) || 0;
            meta.view_seconds = vs > 0 ? vs : DEFAULT_VIEW_SECONDS;
            // gate: pede e-mail+instalar pra abrir, se o bloco pedir OU a persona
            // estiver com o gate global (gate_media) ligado.
            meta.gate = (s.gate === true) || (chat.gate_media === true);
        }
        else if (s.type === 'cta') {
            content = await fillVars(s.content, ident) || 'Ver oferta';
            meta.link_url = s.link_url || null;
            meta.product_id = s.product_id || null;
            meta.cta_color = s.cta_color || null;
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
        // Visualização única SEMPRE pausa o fluxo aqui (padrão): a conversa só
        // continua (do próximo bloco = idx atual) quando o cliente ABRIR a mídia
        // (/viewed). Evita as próximas mensagens chegarem antes dele ver a 1x.
        if (s.type === 'view_once_image' || s.type === 'view_once_video') {
            awaiting = 'view_once';
            break;
        }
        // "Ela liga" TAMBÉM pausa o fluxo: os próximos blocos só saem quando a
        // ligação ENCERRAR e o lead voltar pra conversa (/call-done). Sem isso,
        // as mensagens chegavam DURANTE a chamada. Fallbacks: /open (saiu e
        // voltou) e /poll (chamada abandonada há 4+ min) também retomam.
        if (s.type === 'call') {
            awaiting = 'call';
            break;
        }
        // PACING AUTOMÁTICO: entrega UMA mensagem por vez. Se o próximo bloco também
        // é mensagem (passivo), agenda ele via 'delay' (= o tempo de digitar dele) e
        // retorna agora. Assim as mensagens chegam ESPAÇADAS no servidor: o worker
        // entrega enquanto o cliente está FORA (dispara notificação por mensagem) e,
        // ao voltar, ele NÃO recebe um monte de uma vez.
        if (idx >= 0 && idx < steps.length) {
            const nx = steps[idx];
            const PASSIVE = ['text', 'audio', 'image', 'video', 'view_once_image', 'view_once_video', 'cta', 'call'];
            if (nx && PASSIVE.indexOf(nx.type) >= 0) {
                // respeita o "digitando" configurado no bloco (até 30s — antes o
                // teto de 8s comia o tempo e as mensagens chegavam rápido demais)
                const gapMs = Math.max(800, Math.min(30000, parseInt(nx.typing_ms, 10) || 3000));
                const secs = Math.max(1, Math.round(gapMs / 1000));
                const { rows: rr } = await db.query(
                    `UPDATE chat_sessions SET current_order = $2, awaiting = 'delay', current_flow = $4,
                     resume_at = NOW() + make_interval(secs => $3), updated_at = NOW() WHERE id = $1 RETURNING resume_at`,
                    [session.id, idx, secs, session.current_flow || 'open']
                );
                session.current_order = idx;
                session.awaiting = 'delay';
                session.resume_at = rr[0] ? rr[0].resume_at : null;
                return out;
            }
        }
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
    const mediaUrl = isOnce && m.viewed_at ? null : m.media_url;
    let meta = m.meta || null;
    // vídeo do Stream: manda hls+thumb pro player nativo (estilo WhatsApp)
    if ((m.type === 'video' || m.type === 'view_once_video') && mediaUrl) {
        const sm = streamMediaMeta(mediaUrl);
        if (sm) meta = { ...(meta || {}), hls: sm.hls, thumb: sm.thumb };
    }
    return {
        id: m.id,
        sender: m.sender,
        type: m.type,
        content: m.content,
        media_url: mediaUrl,
        viewed: isOnce ? !!m.viewed_at : undefined,
        meta,
        created_at: m.created_at,
    };
}

// ── ROTAS ────────────────────────────────────────────────────────────────────

// GET /chats — lista pra tela de conversas (com lock por usuário)
router.get('/chats', optionalUser, async (req, res) => {
    try {
        const ident = getIdentity(req);
        // FUNIL com conversas restritas: lead ANÔNIMO (ainda sem e-mail) que
        // entrou por um funil com visible_chat_ids vê SÓ essas conversas.
        // Depois do e-mail a lista volta ao normal.
        let onlyIds = null;
        const funnelSlug = String(req.query.funnel || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 80);
        if (!ident.email && funnelSlug) {
            try {
                const { rows: fr } = await db.query(
                    `SELECT visible_chat_ids FROM funnels WHERE slug = $1 AND active = true LIMIT 1`, [funnelSlug]
                );
                const ids = fr.length && Array.isArray(fr[0].visible_chat_ids) ? fr[0].visible_chat_ids.map(Number).filter(Boolean) : null;
                if (ids && ids.length) onlyIds = ids;
            } catch (_) {}
        }
        // Lista os chats visíveis (listed=true) MAIS os ocultos que JÁ tiveram
        // interação com este usuário (sessão com ≥1 mensagem) OU que foram
        // REVELADOS pela etapa 'Mostrar conversa' do funil (revealed_at, sem
        // mensagem/notificação) — assim um chat oculto só "aparece" quando o
        // funil manda ou quando a conversa começou.
        const { rows: chats } = await db.query(
            `SELECT * FROM chats
             WHERE active = true AND ($3::int[] IS NULL OR id = ANY($3::int[])) AND (
                listed = true
                OR ($3::int[] IS NOT NULL AND id = ANY($3::int[]))
                OR id IN (
                    SELECT cs.chat_id FROM chat_sessions cs
                    WHERE ( ($1::text IS NOT NULL AND LOWER(cs.customer_email) = $1)
                         OR ($2::text IS NOT NULL AND cs.visitor_id = $2) )
                      AND ( cs.revealed_at IS NOT NULL
                            OR EXISTS (SELECT 1 FROM chat_messages cm WHERE cm.session_id = cs.id) )
                )
             )
             ORDER BY display_order, id`,
            [ident.email, ident.visitor, onlyIds]
        );
        // "Sumir pra VIP/Premium": se algum chat pede isso, calcula 1x se este
        // cliente é Premium (leva-tudo). O VIP-daquela-conversa já vem do `owns`.
        let isPremium = false;
        if (ident.email && chats.some(c => c.hide_when_member)) {
            try { isPremium = await require('./user').isPremiumCustomer(ident.email); } catch (_) {}
        }
        // RODÍZIO de online (esteira): calcula quem está online agora entre as
        // conversas marcadas "in_rotation". As demais ficam sempre online.
        let onlineMap = null, rotCfg = null;
        try {
            const rotation = require('../lib/chat-rotation');
            rotCfg = await rotation.loadRotationConfig();
            if (rotCfg.enabled) {
                // SEMPRE sobre TODOS os chats ativos em rodízio — o mesmo
                // conjunto que /advance e o worker usam. Computar só sobre os
                // chats VISÍVEIS deste usuário mudava M e a ordem da esteira:
                // a lista dizia "online" e o /advance calculava offline (a
                // modelo "online" engolia a mensagem em silêncio).
                const { rows: rr } = await db.query(`SELECT id FROM chats WHERE active = true AND in_rotation = true`);
                const rotIds = rr.map(r => r.id);
                if (rotIds.length) onlineMap = rotation.computeOnline(rotIds, rotCfg, Date.now());
            }
        } catch (_) {}
        const { lastSeenLabel } = require('../lib/chat-rotation');
        const out = [];
        for (const c of chats) {
            const owns = await ownsChatVip(ident.email, c);
            // conversa marcada pra sumir depois que o cliente vira membro
            // (VIP daquela conversa OU Premium) — some mesmo se já conversou.
            if (c.hide_when_member && (owns || isPremium)) continue;
            const perm = permissions(c, owns, ident);
            // ISCA "só prévia": pro não-VIP, trava a conversa (tocar → popup, não
            // abre) MAS deixa a prévia da mensagem VISÍVEL na lista (o `teaser`
            // avisa o app pra não borrar). Pro VIP, abre normal.
            const isTeaser = c.teaser_locked === true && !perm.is_vip;
            if (isTeaser) perm.locked = true;
            // enriquece o desbloqueio com produto + planos (banner VIP rico)
            if (perm.locked) perm.unlock = await loadUnlock(await chatUnlockProductId(c), c.checkout_url);
            // RODÍZIO: estado online desta conversa (null = sempre online)
            const rotState = (onlineMap && c.in_rotation) ? onlineMap.get(c.id) : null;
            const isOffline = !!(rotState && !rotState.online);
            // motor de conversas: agenda a 1ª mensagem sozinha (auto_start_minutes)
            // — NÃO agenda enquanto a conversa está offline no rodízio.
            if (!isOffline) await ensureAutoStart(c, ident);
            // preview da última mensagem + não-lidas (bot, após last_seen_at)
            let last = null;
            let unread = 0;
            const session = await findOrCreateSession(c.id, ident, false);
            if (session) {
                const { rows: lm } = await db.query(
                    `SELECT id, sender, type, content, created_at FROM chat_messages WHERE session_id = $1 ORDER BY id DESC LIMIT 1`,
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
                        // id + type alimentam a NOTIFICAÇÃO (detecção por id, texto por tipo)
                        id: lm[0].id,
                        type: t,
                        sender: lm[0].sender,
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
                // offline no rodízio: mostra "visto há X" no lugar de "online"
                status_label: isOffline ? lastSeenLabel(rotState.mins_offline) : c.status_label,
                show_online: isOffline ? false : c.show_online,
                online: !isOffline,          // pro app ordenar online no topo
                locked: perm.locked,
                teaser: isTeaser,   // isca: travada mas com prévia visível
                unlock: perm.unlock,
                last,
                unread,
            });
        }
        // Plano do lead: alimenta o selo FREE/VIP do topo e o card do Perfil.
        // paywall_unlock = planos do produto único (pro botão "Virar VIP").
        const globalPlanId = await chatPlanProductId();
        const vipUser = await ownsProduct(ident.email, globalPlanId);
        return res.json({
            success: true,
            chats: out,
            vip: vipUser,
            paywall_unlock: vipUser ? null : await loadUnlock(globalPlanId, null),
        });
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
        const owns = await ownsChatVip(ident.email, chat);
        const perm = permissions(chat, owns, ident);
        // ISCA "só prévia": trava também no /open (defesa se chamarem a API direto)
        if (chat.teaser_locked === true && !perm.is_vip) perm.locked = true;
        // enriquece o desbloqueio com produto + planos (banner VIP rico)
        if (perm.locked) perm.unlock = await loadUnlock(await chatUnlockProductId(chat), chat.checkout_url);

        // RODÍZIO: o cabeçalho da conversa precisa contar a MESMA história da
        // lista — modelo offline abria mostrando "online" (bug relatado pelo
        // dono). Calcula o estado da esteira sobre TODOS os chats em rodízio.
        let headerLabel = chat.status_label, headerOnline = chat.show_online;
        if (chat.in_rotation) {
            try {
                const rotation = require('../lib/chat-rotation');
                const rc = await rotation.loadRotationConfig();
                if (rc.enabled) {
                    const { rows: rr } = await db.query(`SELECT id FROM chats WHERE active = true AND in_rotation = true`);
                    const st = rotation.computeOnline(rr.map(r => r.id), rc, Date.now()).get(chat.id);
                    if (st && !st.online) {
                        headerLabel = rotation.lastSeenLabel(st.mins_offline);
                        headerOnline = false;
                    }
                }
            } catch (_) {}
        }

        const callPayload = await loadChatCall(chat.call_video_call_id);
        const persona = {
            id: chat.id, name: chat.name, avatar_url: chat.avatar_url,
            status_label: headerLabel, show_online: headerOnline,
            tag: chat.tag || null,
            gate_media: chat.gate_media === true,
            input_mode: chat.input_mode === 'gated' ? 'gated' : 'always',
            checkout_url: chat.checkout_url || null,
            has_call: !!callPayload,
            call_trigger: !!chat.call_goto_key,
            video_call: callPayload,
            // chat de SUPORTE com WhatsApp configurado → o app mostra a faixa
            // fixa "Falar no WhatsApp" no topo (estilo banner de mídias do grupo)
            support_whatsapp: chat.is_support === true
                ? ((await getSupportConfig()).whatsapp_link || null)
                : null,
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

        // Comprou o VIP depois de bater no paywall? Limpa a marca AQUI (em
        // qualquer estado da sessão, não só no legado awaiting='paywall') —
        // sem isso o app continuava tratando o cliente pagante como travado.
        if (session.paywalled_at && perm.is_vip) {
            await db.query(`UPDATE chat_sessions SET paywalled_at = NULL WHERE id = $1`, [session.id]);
            session.paywalled_at = null;
        }

        const { rows: history } = await db.query(
            `SELECT * FROM chat_messages WHERE session_id = $1 ORDER BY id`, [session.id]
        );
        let fresh = [];
        if (history.length === 0) {
            // conversa nova → roda o fluxo "Abre conversa"
            session.current_flow = 'open';
            const steps = await loadSteps(chatId, 'open');
            if (steps.length > 0) fresh = await runScript(session, chat, steps, 0, ident);
        } else if (session.awaiting === 'delay' && session.resume_at && new Date(session.resume_at) <= new Date()
                   && !(await chatOfflineNow(chatId))) {
            // Delay venceu e o cliente abriu: retoma — MAS reivindica atomicamente
            // (awaiting 'delay'→'resuming') pra NÃO rodar junto com o worker. Sem isso,
            // os dois inseriam as mesmas mensagens = duplicadas/"cacetada" ao reabrir.
            // Modelo OFFLINE no rodízio: NÃO retoma aqui — fica em 'delay' e o worker
            // entrega quando ela voltar online (mesma regra do resumeDelayed).
            const claim = await db.query(
                `UPDATE chat_sessions SET awaiting = 'resuming', updated_at = NOW() WHERE id = $1 AND awaiting = 'delay' RETURNING id`,
                [session.id]
            );
            if (claim.rows.length) {
                // saudação agendada vence primeiro que qualquer roteiro
                const g = await deliverPendingGreeting(session);
                if (g) fresh = [g];
                else {
                    const steps = await loadSteps(chatId, session.current_flow || 'open');
                    fresh = await runScript(session, chat, steps, session.current_order, ident);
                }
            }
        } else if (session.awaiting === 'paywall') {
            // MIGRAÇÃO: sessões paradas no paywall antigo (que travava o roteiro)
            // retomam daqui — o bloco agora só marca e segue. VIP: limpa a marca.
            if (owns) {
                await db.query(`UPDATE chat_sessions SET paywalled_at = NULL WHERE id = $1`, [session.id]);
                session.paywalled_at = null;
            }
            const steps = await loadSteps(chatId, session.current_flow || 'open');
            fresh = await runScript(session, chat, steps, session.current_order, ident);
        } else if (session.awaiting === 'call') {
            // Saiu no meio da ligação e voltou pra conversa: a chamada acabou —
            // retoma o roteiro pausado (mesma reivindicação atômica do /call-done).
            if (await chatOfflineNow(chatId)) {
                // Modelo offline: converte pra 'delay' vencido — o worker entrega
                // quando ela voltar online (sem isso ficaria presa em 'call').
                await db.query(
                    `UPDATE chat_sessions SET awaiting = 'delay', resume_at = NOW(), updated_at = NOW()
                     WHERE id = $1 AND awaiting = 'call'`, [session.id]);
            } else {
            const claim = await db.query(
                `UPDATE chat_sessions SET awaiting = 'resuming', updated_at = NOW()
                 WHERE id = $1 AND awaiting = 'call' RETURNING id`,
                [session.id]
            );
            if (claim.rows.length) {
                const steps = await loadSteps(chatId, session.current_flow || 'open');
                fresh = await runScript(session, chat, steps, session.current_order, ident);
            }
            }
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
            // passou do bloco 🔒 Paywall sem assinar: TUDO neste chat exige VIP
            // (digitar, chamada do topo, atender chamada recebida)
            paywalled: !!(session.paywalled_at && !perm.is_vip),
            // planos do popup (VIP/PREMIUM do produto único) SEMPRE disponíveis:
            // qualquer gatilho de paywall no app renderiza os cards completos —
            // sem isso, gatilhos sem erro do servidor caíam no popup "genérico"
            // sem planos e sem link de checkout.
            paywall_unlock: perm.is_vip ? null : await loadUnlock(await chatUnlockProductId(chat), chat.checkout_url),
        });
    } catch (err) {
        logger.error('Erro abrindo chat:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// POST /chats/:id/reveal — torna a conversa VISÍVEL na lista deste lead
// (etapa 'Mostrar conversa' do funil): cria a sessão vazia com revealed_at,
// SEM mensagem, SEM notificação e SEM rodar o roteiro. O roteiro só roda
// quando o lead abrir a conversa por vontade própria.
router.post('/chats/:id/reveal', optionalUser, async (req, res) => {
    const chatId = parseInt(req.params.id, 10);
    if (!chatId) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const ident = getIdentity(req);
        if (!ident.email && !ident.visitor) return res.status(400).json({ success: false, error: 'visitor_id obrigatório' });
        const { rows: cr } = await db.query(`SELECT id FROM chats WHERE id = $1 AND active = true`, [chatId]);
        if (!cr.length) return res.status(404).json({ success: false, error: 'Chat não encontrado' });
        const session = await findOrCreateSession(chatId, ident, true);
        await db.query(`UPDATE chat_sessions SET revealed_at = COALESCE(revealed_at, NOW()) WHERE id = $1`, [session.id]);
        return res.json({ success: true });
    } catch (err) {
        logger.error('Erro revelando chat:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// POST /chats/:id/start — inicia a conversa em BACKGROUND (sem abrir a tela).
// Usado quando o cliente ENTRA num produto configurado com "modelo manda
// mensagem ao abrir": cria a sessão + roda o fluxo "open" (mensagens ficam
// salvas no histórico), mas NÃO marca como lido — pra aparecer com badge de
// não-lida e disparar o banner. Retorna nome + avatar pra montar o banner.
router.post('/chats/:id/start', optionalUser, async (req, res) => {
    const chatId = parseInt(req.params.id, 10);
    if (!chatId) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const ident = getIdentity(req);
        const { rows: cr } = await db.query(`SELECT * FROM chats WHERE id = $1 AND active = true`, [chatId]);
        if (!cr.length) return res.status(404).json({ success: false, error: 'Chat não encontrado' });
        const chat = cr[0];
        const owns = await ownsChatVip(ident.email, chat);
        const perm = permissions(chat, owns, ident);
        const info = { id: chat.id, name: chat.name, avatar_url: chat.avatar_url || null };
        // Chat bloqueado (VIP sem acesso): não cria sessão nem roda roteiro.
        if (perm.locked) return res.json({ success: true, chat: info, started: false, locked: true });
        if (!ident.email && !ident.visitor) return res.status(400).json({ success: false, error: 'visitor_id obrigatório' });

        const session = await findOrCreateSession(chatId, ident, true);
        await ensureSessionGeo(session, req);
        ident.city = session.city;
        ident.cityFallback = chat.city_fallback;

        const { rows: history } = await db.query(
            `SELECT id FROM chat_messages WHERE session_id = $1 ORDER BY id LIMIT 1`, [session.id]
        );
        let started = false;
        if (history.length === 0) {
            session.current_flow = 'open';
            const steps = await loadSteps(chatId, 'open');
            if (steps.length > 0) { await runScript(session, chat, steps, 0, ident); started = true; }
        }
        // NÃO atualiza last_seen_at — fica como não-lida de propósito.
        return res.json({ success: true, chat: info, started });
    } catch (err) {
        logger.error('Erro iniciando chat (start):', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// Dispara uma conversa em BACKGROUND pra um lead sem passar pelo HTTP — mesmo
// efeito do POST /chats/:id/start. Usado pelo gatilho de FIM DE TRIAL dos
// grupos (heartbeat cruza o limite → a "modelo" chama no privado com a oferta).
// Só roda se a conversa ainda não tem histórico (não re-dispara).
async function startChatForIdentity(ident, chatId, req) {
    const { rows: cr } = await db.query(`SELECT * FROM chats WHERE id = $1 AND active = true`, [chatId]);
    if (!cr.length) return false;
    const chat = cr[0];
    const owns = await ownsChatVip(ident.email, chat);
    const perm = permissions(chat, owns, ident);
    if (perm.locked) return false;
    if (!ident.email && !ident.visitor) return false;
    const session = await findOrCreateSession(chatId, ident, true);
    if (req) { try { await ensureSessionGeo(session, req); ident.city = session.city; } catch (_) {} }
    ident.cityFallback = chat.city_fallback;
    const { rows: history } = await db.query(
        `SELECT id FROM chat_messages WHERE session_id = $1 ORDER BY id LIMIT 1`, [session.id]
    );
    if (history.length) return false;
    session.current_flow = 'open';
    const steps = await loadSteps(chatId, 'open');
    if (!steps.length) return false;
    await runScript(session, chat, steps, 0, ident);
    return true;
}

// POST /chats/:id/advance — botão escolhido, input do roteiro ou mensagem livre
router.post('/chats/:id/advance', optionalUser, async (req, res) => {
    const chatId = parseInt(req.params.id, 10);
    if (!chatId) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const ident = getIdentity(req);
        const { rows: cr } = await db.query(`SELECT * FROM chats WHERE id = $1 AND active = true`, [chatId]);
        if (!cr.length) return res.status(404).json({ success: false, error: 'Chat não encontrado' });
        const chat = cr[0];
        const owns = await ownsChatVip(ident.email, chat);
        const perm = permissions(chat, owns, ident);
        if (perm.locked) {
            return res.status(403).json({
                success: false, error: 'vip_required',
                unlock: await loadUnlock(await chatUnlockProductId(chat), chat.checkout_url),
            });
        }

        const session = await findOrCreateSession(chatId, ident, true);
        await ensureSessionGeo(session, req);
        ident.city = session.city;
        ident.cityFallback = chat.city_fallback;
        const steps = await loadSteps(chatId, session.current_flow || 'open');

        const choice = req.body?.choice;
        const text = (req.body?.text || '').toString().trim().slice(0, 1000);
        const newMsgs = [];

        // GATE do paywall: depois do bloco 🔒 (paywalled_at), um lead SEM VIP
        // não avança o roteiro por NENHUM caminho. Antes o gate existia só no
        // texto livre — se o roteiro tinha botões/input DEPOIS do 🔒, o lead
        // consumia esse conteúdo de graça (vazamento de venda). Agora
        // botão/input também caem no popup de assinar.
        const isPaywalled = (session.awaiting === 'paywall' || session.paywalled_at) && !perm.is_vip;
        if (isPaywalled && (choice !== undefined && choice !== null || text)) {
            return res.status(403).json({
                success: false, error: 'vip_required',
                unlock: await loadUnlock(await chatUnlockProductId(chat), chat.checkout_url),
            });
        }

        // RODÍZIO: se a conversa está OFFLINE agora, guarda a mensagem do lead
        // mas a modelo NÃO responde (mesmo com o funil mandando responder). O
        // roteiro retoma quando ela voltar online e o lead interagir de novo.
        // Roda DEPOIS do gate de paywall (senão o desvio offline deixava o
        // lead travado "mandar" mensagem sem ver o popup de assinar) e aplica
        // o mesmo can_reply da mensagem livre.
        if (chat.in_rotation) {
            try {
                const rotation = require('../lib/chat-rotation');
                const rc = await rotation.loadRotationConfig();
                if (rc.enabled) {
                    const { rows: rr } = await db.query(`SELECT id FROM chats WHERE active = true AND in_rotation = true`);
                    const st = rotation.computeOnline(rr.map(r => r.id), rc, Date.now()).get(chatId);
                    if (st && !st.online) {
                        const isScript = session.awaiting === 'input' || session.awaiting === 'buttons';
                        if (text && !isScript && !perm.can_reply) {
                            return res.status(403).json({
                                success: false, error: 'vip_required',
                                unlock: await loadUnlock(await chatUnlockProductId(chat), chat.checkout_url),
                            });
                        }
                        const out = [];
                        if (text) out.push(await insertMsg(session.id, 'user', 'text', text, null, null, null));
                        return res.json({ success: true, messages: out.map(publicMsg), awaiting: session.awaiting, offline: true });
                    }
                }
            } catch (_) {}
        }

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
            // Mensagem LIVRE (fora do roteiro) — aqui mora o gate VIP do enviar.
            // Depois do bloco 🔒 Paywall (paywalled_at), digitar SEM assinatura
            // devolve vip_required + unlock: o app mostra a bolha "não entregue"
            // e reabre o popup de assinar.
            const paywalled = (session.awaiting === 'paywall' || session.paywalled_at) && !perm.is_vip;
            if (paywalled || !perm.can_reply) {
                return res.status(403).json({
                    success: false, error: 'vip_required',
                    unlock: await loadUnlock(await chatUnlockProductId(chat), chat.checkout_url),
                });
            }
            newMsgs.push(await insertMsg(session.id, 'user', 'text', text, null, null, null));

            // 💎 FUNIL PÓS-VENDA (decisão do dono): o gatilho da continuação é
            // a PRIMEIRA MENSAGEM que o lead consegue mandar depois de pagar.
            // VIP mandou mensagem livre + roteiro PARADO (sem delay/input/
            // botões pendentes) + ainda não está no fluxo 'vip' → troca pro
            // fluxo "💎 VIP respondeu" e a conversa continua dali. Roda 1x
            // (current_flow='vip' fica gravado; não reinicia a cada mensagem).
            if (perm.is_vip && !session.awaiting && (session.current_flow || 'open') !== 'vip') {
                const vipSteps = await loadSteps(chatId, 'vip');
                if (vipSteps.length) {
                    session.current_flow = 'vip';
                    await db.query(
                        `UPDATE chat_sessions SET current_flow = 'vip', current_order = 0, updated_at = NOW() WHERE id = $1`,
                        [session.id]
                    );
                    const fresh = await runScript(session, chat, vipSteps, 0, ident);
                    newMsgs.push(...fresh);
                }
            }

            // SAUDAÇÃO AUTOMÁTICA: conversa VAZIA (a modelo nunca falou — zero
            // mensagens de bot, nem o fluxo VIP acima rodou) + chat com a
            // saudação ligada + sem roteiro pendente → responde a 1ª mensagem
            // do cliente com uma frase aleatória da lista global, como se a
            // modelo respondesse. Depois disso a conversa fica parada (a IA
            // assume no futuro). O COUNT roda DEPOIS do bloco VIP: se ele
            // gerou mensagens, o count já vem > 0 e a saudação não dispara.
            if (chat.greeting_enabled === true && !session.awaiting) {
                try {
                    const { rows: [bc] } = await db.query(
                        `SELECT COUNT(*)::int AS n FROM chat_messages WHERE session_id = $1 AND sender = 'bot'`,
                        [session.id]
                    );
                    if ((bc ? bc.n : 0) === 0) {
                        const phrase = await pickGreetingPhrase(session);
                        if (phrase) {
                            // AGENDA a resposta pra 30-90s (pedido do dono:
                            // resposta imediata denuncia — pessoa real demora).
                            // O app fica em silêncio e mostra "digitando…" só
                            // nos ~30s finais (comportamento nativo do delay).
                            const content = await fillVars(phrase, ident);
                            const waitS = 30 + Math.floor(Math.random() * 61); // 30-90s
                            await db.query(
                                `UPDATE chat_sessions SET pending_greeting = $2, awaiting = 'delay',
                                        resume_at = NOW() + make_interval(secs => $3), updated_at = NOW()
                                 WHERE id = $1`,
                                [session.id, content, waitS]
                            );
                            session.awaiting = 'delay';
                            session.resume_at = new Date(Date.now() + waitS * 1000);
                        }
                    }
                } catch (_) {}
            }
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
            paywalled: !!(session.paywalled_at && !perm.is_vip),
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

        // ISCA "só prévia" (teaser_locked): não-VIP não recebe o conteúdo nem
        // por aqui — sem esta trava o /poll?after=0 devolvia o texto e as
        // mídias da 1ª mensagem automática pra quem nunca pagou. Query extra
        // só existe pra chats marcados como teaser.
        try {
            const { rows: tk } = await db.query(`SELECT * FROM chats WHERE id = $1 AND teaser_locked = true`, [chatId]);
            if (tk.length && !(await ownsChatVip(ident.email, tk[0]))) {
                return res.json({ success: true, messages: [], awaiting: null, locked: true });
            }
        } catch (_) {}

        // Se o delay venceu, retoma o roteiro AGORA (cliente está com a tela aberta)
        // — com reivindicação ATÔMICA ('delay'→'resuming'), igual ao /open, pra não
        // rodar junto com o worker e duplicar mensagens.
        if (session.awaiting === 'delay' && session.resume_at && new Date(session.resume_at) <= new Date()
            && !(await chatOfflineNow(chatId))) {
            // (offline no rodízio: fica em 'delay'; o worker entrega quando voltar)
            const claim = await db.query(
                `UPDATE chat_sessions SET awaiting = 'resuming', updated_at = NOW() WHERE id = $1 AND awaiting = 'delay' RETURNING id`,
                [session.id]
            );
            if (claim.rows.length) {
                // saudação agendada vence primeiro que qualquer roteiro
                if (!(await deliverPendingGreeting(session))) {
                    const { rows: cr } = await db.query(`SELECT * FROM chats WHERE id = $1 AND active = true`, [chatId]);
                    if (cr.length) {
                        ident.city = session.city;
                        ident.cityFallback = cr[0].city_fallback;
                        const steps = await loadSteps(chatId, session.current_flow || 'open');
                        await runScript(session, cr[0], steps, session.current_order, ident);
                    }
                }
            }
        }
        // Chamada abandonada (fechou o app/tela no meio): se o roteiro ficou
        // pausado em 'call' por 4+ min, retoma sozinho no próximo poll.
        if (session.awaiting === 'call' && session.updated_at &&
            (Date.now() - new Date(session.updated_at).getTime()) > 4 * 60000) {
            if (await chatOfflineNow(chatId)) {
                await db.query(
                    `UPDATE chat_sessions SET awaiting = 'delay', resume_at = NOW(), updated_at = NOW()
                     WHERE id = $1 AND awaiting = 'call'`, [session.id]);
                session.awaiting = 'delay';
            }
            const claim = session.awaiting !== 'call' ? { rows: [] } : await db.query(
                `UPDATE chat_sessions SET awaiting = 'resuming', updated_at = NOW()
                 WHERE id = $1 AND awaiting = 'call' RETURNING id`,
                [session.id]
            );
            if (claim.rows.length) {
                const { rows: cr } = await db.query(`SELECT * FROM chats WHERE id = $1 AND active = true`, [chatId]);
                if (cr.length) {
                    ident.city = session.city;
                    ident.cityFallback = cr[0].city_fallback;
                    const steps = await loadSteps(chatId, session.current_flow || 'open');
                    await runScript(session, cr[0], steps, session.current_order, ident);
                }
            }
        }
        const { rows: msgs } = await db.query(
            `SELECT * FROM chat_messages WHERE session_id = $1 AND id > $2 ORDER BY id`,
            [session.id, after]
        );
        if (msgs.length) {
            await db.query(`UPDATE chat_sessions SET last_seen_at = NOW() WHERE id = $1`, [session.id]);
        }
        // Re-lê o estado ATUAL da sessão: quando o chat-worker resume o delay
        // em paralelo (corrida worker×poll), o snapshot local fica velho e o
        // app receberia awaiting='delay' junto com a mensagem nova — em modo
        // gated o input nunca aparecia até sair e reabrir a conversa.
        try {
            const { rows: [fresh] } = await db.query(
                `SELECT awaiting, resume_at, paywalled_at FROM chat_sessions WHERE id = $1`, [session.id]
            );
            if (fresh) {
                session.awaiting = fresh.awaiting;
                session.resume_at = fresh.resume_at;
                session.paywalled_at = fresh.paywalled_at;
            }
        } catch (_) {}
        // avisa o app que a sessão passou do paywall (o roteiro CONTINUA rodando;
        // é o lead que fica travado — digitar/ligar/atender exigem VIP).
        // Se ele COMPROU nesse meio-tempo, limpa a marca já no poll — é assim
        // que a conversa destrava sozinha segundos após o webhook, sem F5.
        let paywalled = false;
        if (session.paywalled_at) {
            const { rows: pc } = await db.query(`SELECT id, product_id FROM chats WHERE id = $1`, [chatId]);
            const vip = await ownsChatVip(ident.email, pc[0] || {});
            if (vip) {
                await db.query(`UPDATE chat_sessions SET paywalled_at = NULL WHERE id = $1`, [session.id]);
                session.paywalled_at = null;
            }
            paywalled = !vip;
        }
        return res.json({
            success: true,
            messages: msgs.map(publicMsg),
            awaiting: session.awaiting,
            resume_at: session.awaiting === 'delay' ? session.resume_at : null,
            paywalled,
        });
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

        // "Esperar abrir": se o fluxo estava PAUSADO esperando o cliente abrir
        // esta mídia 1x, CONTINUA agora do próximo bloco e devolve as mensagens.
        let newMessages = [];
        try {
            const { rows: sr } = await db.query(
                `SELECT s.* FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id WHERE m.id = $1 LIMIT 1`, [msgId]
            );
            const session = sr[0];
            if (session && session.awaiting === 'view_once') {
                // Reivindica atomicamente ('view_once'→'resuming') — dois toques
                // rápidos na mídia (ou toque + poll) não podem retomar em dobro.
                const claim = await db.query(
                    `UPDATE chat_sessions SET awaiting = 'resuming', updated_at = NOW() WHERE id = $1 AND awaiting = 'view_once' RETURNING id`,
                    [session.id]
                );
                const { rows: cr } = claim.rows.length
                    ? await db.query(`SELECT * FROM chats WHERE id = $1 AND active = true`, [session.chat_id])
                    : { rows: [] };
                if (cr.length) {
                    const chat = cr[0];
                    const ident2 = {
                        email: session.customer_email && !String(session.customer_email).endsWith('@preview.local') ? String(session.customer_email).toLowerCase() : null,
                        visitor: session.visitor_id || null,
                        city: session.city || null,
                        cityFallback: chat.city_fallback,
                    };
                    const steps = await loadSteps(session.chat_id, session.current_flow || 'open');
                    const fresh = await runScript(session, chat, steps, session.current_order, ident2);
                    newMessages = fresh.map(publicMsg);
                }
            }
        } catch (_) {}
        return res.json({ success: true, consumed: rowCount > 0, messages: newMessages });
    } catch (err) {
        return res.json({ success: false });
    }
});

// POST /chats/:id/call-done — a ligação do roteiro ENCERROU e o lead voltou
// pra conversa: retoma o fluxo pausado em awaiting='call' e devolve as
// mensagens novas (o app injeta direto, sem esperar o poll).
router.post('/chats/:id/call-done', optionalUser, async (req, res) => {
    const chatId = parseInt(req.params.id, 10);
    if (!chatId) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const ident = getIdentity(req);
        const session = await findOrCreateSession(chatId, ident, false);
        if (!session) return res.json({ success: true, messages: [], awaiting: null });
        const { rows: cr } = await db.query(`SELECT * FROM chats WHERE id = $1 AND active = true`, [chatId]);
        if (!cr.length) return res.status(404).json({ success: false, error: 'Chat não encontrado' });
        const chat = cr[0];
        let fresh = [];
        // reivindica atomicamente (call → resuming) pra não rodar 2x (onClose +
        // vigia disparando juntos, ou junto com o /open)
        const claim = await db.query(
            `UPDATE chat_sessions SET awaiting = 'resuming', updated_at = NOW()
             WHERE id = $1 AND awaiting = 'call' RETURNING id`,
            [session.id]
        );
        if (claim.rows.length) {
            ident.city = session.city;
            ident.cityFallback = chat.city_fallback;
            const steps = await loadSteps(chatId, session.current_flow || 'open');
            fresh = await runScript(session, chat, steps, session.current_order, ident);
        }
        const owns = await ownsChatVip(ident.email, chat);
        return res.json({
            success: true,
            messages: fresh.map(publicMsg),
            awaiting: session.awaiting,
            resume_at: session.awaiting === 'delay' ? session.resume_at : null,
            paywalled: !!(session.paywalled_at && !owns),
        });
    } catch (err) {
        logger.error('Erro no call-done do chat:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
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
            const owns = await ownsChatVip(ident.email, chat);
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

// RODÍZIO: a modelo deste chat está OFFLINE agora? Mesmo conjunto e mesma conta
// do worker (resumeDelayed). Usado pelos caminhos de retomada do /open e /poll:
// sem esta checagem, o cabeçalho dizia "visto há 40 min" e, ao abrir a conversa,
// a modelo "offline" começava a digitar na hora — quebrava a ilusão do rodízio.
// Só roda queries quando o rodízio está LIGADO e há retomada devida (raro).
async function chatOfflineNow(chatId) {
    try {
        const rotation = require('../lib/chat-rotation');
        const rc = await rotation.loadRotationConfig();
        if (!rc.enabled) return false;
        const { rows } = await db.query(`SELECT id FROM chats WHERE active = true AND in_rotation = true`);
        const ids = rows.map(r => r.id);
        if (!ids.includes(chatId)) return false; // fora do rodízio = sempre online
        const st = rotation.computeOnline(ids, rc, Date.now()).get(chatId);
        return !!(st && !st.online);
    } catch (_) { return false; }
}

// ── Retomada de delays (chamada pelo worker — app fechado) ───────────────────
// Pega sessões cujo delay venceu, continua o roteiro do ponto pausado e
// devolve as mensagens novas + dados pro push. Reusa o MESMO motor (runScript).
async function resumeDelayed(limit) {
    // RODÍZIO: chats offline não entregam mensagem agora — a conversa PAUSA e
    // retoma quando a modelo voltar online. Calcula o mapa ANTES do claim e
    // EXCLUI os offline já no SQL: antes o claim pegava as 30 sessões com
    // resume_at mais antigo, devolvia as offline pra 'delay' sem mexer no
    // resume_at, e elas voltavam SEMPRE no topo do ORDER BY — com 30+ sessões
    // offline acumuladas, o lote inteiro era consumido por elas a cada tick e
    // NENHUM chat entregava mensagem (nem os de funil, sempre online).
    // RESGATE: sessão presa em 'resuming' há 3+ min = o processo caiu/reiniciou
    // no meio da entrega (deploy, crash). Ninguém mais tocava nela e a conversa
    // morria em silêncio pra sempre. Volta pra 'delay' e o worker re-entrega.
    // (Todo claim 'x'→'resuming' carimba updated_at=NOW(); runScript termina em
    // segundos, então 3 min parado = travou de verdade.)
    try {
        const { rowCount: rescued } = await db.query(
            `UPDATE chat_sessions SET awaiting = 'delay', resume_at = COALESCE(resume_at, NOW())
             WHERE awaiting = 'resuming' AND updated_at < NOW() - INTERVAL '3 minutes'`);
        if (rescued) logger.warn('[chat] ' + rescued + ' sessão(ões) presas em resuming resgatadas');
    } catch (_) {}

    let offlineIds = [];
    try {
        const rotation = require('../lib/chat-rotation');
        const rc = await rotation.loadRotationConfig();
        if (rc.enabled) {
            const { rows: rr } = await db.query(`SELECT id FROM chats WHERE active = true AND in_rotation = true`);
            const ids = rr.map(r => r.id);
            if (ids.length) {
                const m = rotation.computeOnline(ids, rc, Date.now());
                offlineIds = [...m.entries()].filter(([, s]) => !s.online).map(([id]) => id);
            }
        }
    } catch (_) {}

    const { rows: due } = await db.query(`
        UPDATE chat_sessions SET awaiting = 'resuming', updated_at = NOW()
        WHERE id IN (
            SELECT id FROM chat_sessions
            WHERE awaiting = 'delay' AND resume_at IS NOT NULL AND resume_at <= NOW()
              AND NOT (chat_id = ANY($2::int[]))
            ORDER BY resume_at LIMIT $1 FOR UPDATE SKIP LOCKED
        ) RETURNING *
    `, [limit || 30, offlineIds]);

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
            // saudação agendada (30-90s): entrega e segue — sem roteiro envolvido
            if (session.pending_greeting) {
                const g = await deliverPendingGreeting(session);
                if (g) results.push({ session, chat, messages: [g], email: ident.email });
                continue;
            }
            const steps = await loadSteps(session.chat_id, session.current_flow || 'open');
            session.awaiting = 'delay'; // runScript lê/sobrescreve normalmente
            const fresh = await runScript(session, chat, steps, session.current_order, ident);
            if (fresh.length) {
                results.push({ session, chat, messages: fresh, email: ident.email });
            }
        } catch (err) {
            logger.warn('[chat] resumeDelayed falhou na sessão ' + session.id + ': ' + err.message);
            // volta pra 'delay' (não NULL): a claim foi 'delay'→'resuming'; se
            // deu erro TRANSITÓRIO (blip de banco), soltar de volta pra 'delay'
            // deixa o worker tentar de novo no próximo tick. Antes ia pra NULL
            // e a conversa morria em silêncio (input nunca mais aparecia).
            await db.query(`UPDATE chat_sessions SET awaiting = 'delay' WHERE id = $1 AND awaiting = 'resuming'`, [session.id]).catch(() => {});
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

// Entrega de venda aprovada no chat de SUPORTE (chats.is_support). A cada compra
// aprovada, injeta a mensagem de pós-compra do produto (texto {nome}/{produto} +
// botão de acesso + recomendados manuais). Aditivo ao WhatsApp; chega NÃO-lida.
// Diferente do trigger_product_ids: NÃO roda roteiro fixo e dispara TODA compra.
async function deliverPurchaseToSupport(email, productIds) {
    const e = String(email || '').toLowerCase().trim();
    const ids = (Array.isArray(productIds) ? productIds : []).map(x => parseInt(x, 10)).filter(Boolean);
    if (!e || e.endsWith('@preview.local') || !ids.length) return [];
    const { rows: sc } = await db.query(`SELECT * FROM chats WHERE active = true AND is_support = true ORDER BY id LIMIT 1`);
    if (!sc.length) return []; // nenhum chat marcado como Suporte → nada a entregar
    const chat = sc[0];
    const { rows: prods } = await db.query(
        `SELECT id, name, post_purchase_message, post_purchase_link, post_purchase_recommended_ids
         FROM products WHERE id = ANY($1)`, [ids]
    );
    // produto vinculado a um GRUPO: o botão de acesso cai DENTRO do grupo
    const { rows: linkedGroups } = await db.query(
        `SELECT id, product_id FROM groups WHERE active = true AND product_id = ANY($1)`, [ids]
    );
    const groupByProduct = {};
    for (const g of linkedGroups) if (!groupByProduct[g.product_id]) groupByProduct[g.product_id] = g.id;
    if (!prods.length) return [];
    const session = await findOrCreateSession(chat.id, { email: e, visitor: null }, true);
    const ctx = { email: e, city: session.city || null, cityFallback: chat.city_fallback };
    const cfg = await getSupportConfig();
    const GREEN = '#1fa855', RED = '#e50914';
    let firstMsg = null;
    // Saudação pelo horário de Brasília (abre a entrega com calor humano)
    try {
        const hBr = (new Date(Date.now() - 3 * 3600 * 1000)).getUTCHours();
        const sauda = hBr >= 5 && hBr < 12 ? 'Bom dia' : hBr >= 12 && hBr < 18 ? 'Boa tarde' : 'Boa noite';
        firstMsg = await insertMsg(session.id, 'bot', 'text', await fillVars(sauda + ', {nome}! 👋', ctx), null, { typing_ms: 0 }, null);
    } catch (_) {}
    for (const p of prods) {
        // ordem: mensagem do PRODUTO (exceção) → template GLOBAL editável no
        // painel (Central de Suporte) → default do código
        const base = (p.post_purchase_message && p.post_purchase_message.trim())
            || cfg.purchase_template;
        let text = base.replace(/\{produto\}/gi, p.name || 'seu produto');
        text = capFirst(await fillVars(text, ctx));
        const m1 = await insertMsg(session.id, 'bot', 'text', text, null, { typing_ms: 0 }, null);
        if (!firstMsg) firstMsg = m1;
        if (p.post_purchase_link && p.post_purchase_link.trim()) {
            await insertMsg(session.id, 'bot', 'cta', 'Acessar agora', null, { link_url: p.post_purchase_link.trim(), cta_color: GREEN }, null);
        } else if (groupByProduct[p.id]) {
            // sem link configurado + produto de grupo → direto pro grupo
            await insertMsg(session.id, 'bot', 'cta', 'Entrar no grupo agora', null, { link_url: '/?group=' + groupByProduct[p.id], cta_color: GREEN }, null);
        }
        let rec = [];
        try { rec = Array.isArray(p.post_purchase_recommended_ids) ? p.post_purchase_recommended_ids : JSON.parse(p.post_purchase_recommended_ids || '[]'); } catch (_) {}
        rec = rec.map(x => parseInt(x, 10)).filter(Boolean).slice(0, 3);
        // produto sem recomendados próprios → OFERTAS PADRÃO da Central de
        // Suporte (cross-sell no piloto automático), sem oferecer o que ele
        // acabou de comprar
        if (!rec.length && Array.isArray(cfg.default_offer_ids)) {
            rec = cfg.default_offer_ids.map(x => parseInt(x, 10))
                .filter(x => x && !ids.includes(x)).slice(0, 3);
        }
        if (rec.length) {
            const { rows: recProds } = await db.query(
                `SELECT id, name, discount_checkout_url FROM products WHERE id = ANY($1) AND is_active = true`, [rec]
            );
            if (recProds.length) {
                await insertMsg(session.id, 'bot', 'text', 'Separei isso aqui que tem tudo a ver com você 👇', null, { typing_ms: 0 }, null);
                for (const rp of recProds) {
                    // produto com link de DESCONTO → checkout promocional direto;
                    // sem desconto → página do produto in-app (funil normal)
                    if (rp.discount_checkout_url && rp.discount_checkout_url.trim()) {
                        await insertMsg(session.id, 'bot', 'cta', rp.name + ' — com DESCONTO 🔥', null,
                            { link_url: rp.discount_checkout_url.trim(), cta_color: RED }, null);
                    } else {
                        await insertMsg(session.id, 'bot', 'cta', rp.name, null, { product_id: rp.id, cta_color: RED }, null);
                    }
                }
            }
        }
    }
    // Incentivo de instalar o PWA: o app SÓ mostra este botão se o cliente
    // ainda não instalou (meta.action='install_pwa' → fluxo de instalação).
    try {
        await insertMsg(session.id, 'bot', 'cta', '📲 Instalar o app no celular', null,
            { action: 'install_pwa', cta_color: RED }, null);
    } catch (_) {}
    await db.query(`UPDATE chat_sessions SET last_seen_at = NULL, updated_at = NOW() WHERE id = $1`, [session.id]);
    return firstMsg ? [{ chat, messages: [firstMsg], email: e }] : [];
}

// ── CENTRAL DE SUPORTE: configuração editável no painel ─────────────────────
// system_settings key 'support_config'. Tudo tem default no código — o painel
// só sobrescreve o que o dono editar. Variáveis: {nome} {saudacao} {produto}
// {valor} (produto/valor só onde fazem sentido).
const SUPPORT_DEFAULTS = {
    whatsapp_link: '',
    pix_template: 'Oi {nome}. Vi aqui que você gerou o Pix{valor} pra liberar {produto} — o pagamento ainda não caiu.',
    purchase_template: 'Parabéns, {nome}! 🎉 Sua compra de {produto} foi APROVADA e o acesso JÁ TÁ liberado em Minhas Compras. Corre lá 😈 Qualquer dúvida, me chama aqui!',
    welcome_enabled: true,
    welcome_template: '{saudacao}, {nome}! 👋 Eu sou o suporte oficial do app. Qualquer dúvida, pagamento ou problema, me chama AQUI nessa conversa que eu resolvo rapidinho. Bom proveito 🔥',
    default_offer_ids: [],
    // CARRINHO ABANDONADO: abriu o checkout identificado e não pagou →
    // o suporte cobra citando a modelo ({modelo}) e depois oferece o plano.
    abandon_enabled: true,
    abandon_delay_seconds: 60,
    abandon_template: 'Ei {nome}! Vi que você quase liberou a conversa com a {modelo} 👀 Ela continua aqui te esperando — pra responder você, mandar foto, atender sua chamada… Finaliza o pagamento e continua exatamente de onde parou 🔥',
    abandon_generic_template: 'Ei {nome}! Vi que você chegou pertinho de finalizar 👀 Tá tudo separado te esperando. Qualquer dúvida no pagamento me chama AQUI que eu resolvo com você na hora!',
    abandon_cta_label: 'CONTINUAR DE ONDE PAREI 🔥',
    upsell_delay_minutes: 5,
    upsell_template: 'Ahh e um segredo, {nome}: tem plano que libera a conversa com TODAS as mulheres do app de uma vez — sem limite, todas te respondendo 😈 Olha aqui:',
    upsell_product_id: null,
};
let _supportCfgCache = { at: 0, cfg: null };
async function getSupportConfig() {
    if (_supportCfgCache.cfg && Date.now() - _supportCfgCache.at < 60000) return _supportCfgCache.cfg;
    let cfg = { ...SUPPORT_DEFAULTS };
    try {
        const { rows } = await db.query(`SELECT value FROM system_settings WHERE key = 'support_config'`);
        const saved = rows[0]?.value;
        if (saved && typeof saved === 'object') {
            for (const k of Object.keys(SUPPORT_DEFAULTS)) {
                if (saved[k] !== undefined && saved[k] !== null && saved[k] !== '') cfg[k] = saved[k];
                // strings vazias mantêm default, EXCETO whatsapp_link (vazio = sem botão)
            }
            if (saved.whatsapp_link !== undefined) cfg.whatsapp_link = String(saved.whatsapp_link || '');
            if (saved.welcome_enabled !== undefined) cfg.welcome_enabled = saved.welcome_enabled === true;
        }
    } catch (_) {}
    _supportCfgCache = { at: Date.now(), cfg };
    return cfg;
}
function invalidateSupportConfig() { _supportCfgCache = { at: 0, cfg: null }; }

// Primeira letra maiúscula (mensagens que começam com {saudacao} viravam
// "boa tarde, ..." — feio na abertura da conversa)
function capFirst(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }

// (O WhatsApp de ajuda NÃO vai mais como botão no meio da conversa — vira a
// faixa fixa no topo do chat de suporte, via persona.support_whatsapp.)

// BOAS-VINDAS ao instalar o app (welcome_enabled): 1 mensagem no suporte,
// chega não-lida (badge chama atenção). Dedupe fica no caller (user.js,
// trava install_sequence_sent — 1x por e-mail).
async function deliverInstallWelcome(email) {
    const e = String(email || '').toLowerCase().trim();
    if (!e || e.endsWith('@preview.local')) return null;
    const cfg = await getSupportConfig();
    if (!cfg.welcome_enabled) return null;
    const { rows: sc } = await db.query(`SELECT * FROM chats WHERE active = true AND is_support = true ORDER BY id LIMIT 1`);
    if (!sc.length) return null;
    const chat = sc[0];
    const session = await findOrCreateSession(chat.id, { email: e, visitor: null }, true);
    const ctx = { email: e, city: session.city || null, cityFallback: chat.city_fallback };
    const msg = await insertMsg(session.id, 'bot', 'text', capFirst(await fillVars(cfg.welcome_template, ctx)), null, { typing_ms: 0 }, null);
    await db.query(`UPDATE chat_sessions SET last_seen_at = NULL, updated_at = NOW() WHERE id = $1`, [session.id]);
    return { chat, messages: [msg], email: e };
}

// PIX GERADO (evento 'pending' do gateway) → mensagem de "só falta pagar" no
// chat de SUPORTE: copy de urgência + botão COPIAR CÓDIGO (o app copia pro
// clipboard) + instrução passo-a-passo pra leigo + aviso de liberação
// automática. Dedupe por venda fica no sales-processor (pix_pending_notices).
async function deliverPixPendingToSupport(email, info) {
    const e = String(email || '').toLowerCase().trim();
    if (!e || e.endsWith('@preview.local')) return [];
    const { rows: sc } = await db.query(`SELECT * FROM chats WHERE active = true AND is_support = true ORDER BY id LIMIT 1`);
    if (!sc.length) return [];
    const chat = sc[0];
    const session = await findOrCreateSession(chat.id, { email: e, visitor: null }, true);
    const ctx = { email: e, city: session.city || null, cityFallback: chat.city_fallback };
    const cfg = await getSupportConfig();
    const GREEN = '#1fa855';
    const prod = (info && info.product_name) ? String(info.product_name) : 'seu acesso';
    const valor = (info && info.amount > 0)
        ? (' de R$ ' + Number(info.amount).toFixed(2).replace('.', ','))
        : '';

    // template editável no painel (Central de Suporte) — {produto}/{valor}
    // entram aqui; {nome}/{saudacao} no fillVars
    const t1 = capFirst(await fillVars(
        String(cfg.pix_template).replace(/\{produto\}/gi, prod).replace(/\{valor\}/gi, valor), ctx
    ));
    const first = await insertMsg(session.id, 'bot', 'text', t1, null, { typing_ms: 0 }, null);

    if (info && info.pix_code) {
        await insertMsg(session.id, 'bot', 'text',
            'O código vence em pouco tempo. Pagar é rápido:\n\n'
            + '1. Toca no botão verde aqui embaixo — o código copia sozinho\n\n'
            + '2. Abre o app do seu banco\n\n'
            + '3. Escolhe Pix e depois "Copia e Cola"\n\n'
            + '4. Cola o código e confirma', null, { typing_ms: 0 }, null);
        await insertMsg(session.id, 'bot', 'cta', 'Copiar código Pix', null,
            { action: 'copy_pix', pix_code: String(info.pix_code), cta_color: GREEN }, null);
    } else if (info && info.pix_url) {
        await insertMsg(session.id, 'bot', 'cta', 'Abrir a tela de pagamento', null,
            { link_url: String(info.pix_url), cta_color: GREEN }, null);
    }

    await insertMsg(session.id, 'bot', 'text',
        'Assim que o pagamento cair, seu acesso libera automático aqui no app.\n\nEu te aviso na hora — qualquer dúvida, fala comigo por aqui.', null, { typing_ms: 0 }, null);

    await db.query(`UPDATE chat_sessions SET last_seen_at = NULL, updated_at = NOW() WHERE id = $1`, [session.id]);
    return [{ chat, messages: [first], email: e }];
}

// ── CARRINHO ABANDONADO ──────────────────────────────────────────────────────
// O app avisa quando um lead IDENTIFICADO abre o checkout (POST /checkout-intent).
// O chat-worker chama processAbandonedCheckouts() de tempos em tempos: quem não
// pagou depois de X min recebe a cobrança do SUPORTE personalizada com a modelo
// ("a {modelo} tá te esperando") + botão pro MESMO link do checkout; depois de
// mais Y min sem pagar, o upsell do plano completo (todas as modelos).
router.post('/checkout-intent', optionalUser, async (req, res) => {
    try {
        const ident = getIdentity(req);
        if (!ident.email) return res.json({ success: true, skipped: 'anon' });
        const url = String(req.body?.url || '').slice(0, 1000);
        const src = String(req.body?.src || '');
        const m = src.match(/^chat_(\d+)$/);
        const chatId = m ? parseInt(m[1], 10) : null;
        // Já tem intent ABERTA recente sem cobrança enviada? Só atualiza (o
        // lead clicando 3x no botão não vira 3 cobranças).
        const { rows: open } = await db.query(
            `SELECT id FROM checkout_intents
              WHERE LOWER(customer_email) = $1 AND completed = false
                AND created_at > NOW() - INTERVAL '24 hours'
              ORDER BY id DESC LIMIT 1`,
            [ident.email]
        );
        if (open.length) {
            await db.query(
                `UPDATE checkout_intents
                    SET chat_id = COALESCE($2, chat_id), checkout_url = COALESCE(NULLIF($3,''), checkout_url),
                        created_at = CASE WHEN abandon_sent_at IS NULL THEN NOW() ELSE created_at END
                  WHERE id = $1`,
                [open[0].id, chatId, url]
            );
        } else {
            await db.query(
                `INSERT INTO checkout_intents (customer_email, chat_id, checkout_url) VALUES ($1, $2, $3)`,
                [ident.email, chatId, url || null]
            );
        }
        return res.json({ success: true });
    } catch (err) {
        logger.warn('checkout-intent falhou: ' + err.message);
        return res.json({ success: false });
    }
});

async function _supportSessionFor(email) {
    const { rows: sc } = await db.query(`SELECT * FROM chats WHERE active = true AND is_support = true ORDER BY id LIMIT 1`);
    if (!sc.length) return null;
    const chat = sc[0];
    const session = await findOrCreateSession(chat.id, { email, visitor: null }, true);
    return { chat, session };
}

async function processAbandonedCheckouts() {
    const cfg = await getSupportConfig();
    if (cfg.abandon_enabled !== true) return [];
    const out = [];
    // delay da 1ª cobrança em SEGUNDOS (dono quer quase-imediato; config
    // antiga em minutos é convertida). Piso 10s — o worker checa a cada ~15s.
    const delaySec = Math.max(10, parseInt(cfg.abandon_delay_seconds, 10)
        || (parseInt(cfg.abandon_delay_minutes, 10) || 1) * 60);
    const upDelay = Math.max(1, parseInt(cfg.upsell_delay_minutes, 10) || 5);

    // Etapa 1 — cobrança do abandono (claim atômico; intents velhas >48h não
    // cobram mais — mensagem requentada de dias atrás só queima a isca)
    const { rows: due } = await db.query(`
        UPDATE checkout_intents SET abandon_sent_at = NOW()
        WHERE id IN (
            SELECT id FROM checkout_intents
             WHERE completed = false AND abandon_sent_at IS NULL
               AND created_at <= NOW() - make_interval(secs => $1)
               AND created_at > NOW() - INTERVAL '48 hours'
             ORDER BY created_at LIMIT 20 FOR UPDATE SKIP LOCKED
        ) RETURNING *`, [delaySec]);
    for (const it of due) {
        try {
            const email = String(it.customer_email).toLowerCase();
            // pagou depois do clique? fecha em silêncio. granted_at cobre a
            // RENOVAÇÃO/recompra (o grantAccess atualiza a linha existente e
            // created_at não muda — só created_at deixava o suporte cobrar
            // cliente que acabou de pagar de novo).
            const { rows: bought } = await db.query(
                `SELECT 1 FROM user_access WHERE LOWER(email) = $1
                   AND (created_at >= $2 OR granted_at >= $2) LIMIT 1`,
                [email, it.created_at]);
            if (bought.length) {
                await db.query(`UPDATE checkout_intents SET completed = true WHERE id = $1`, [it.id]);
                continue;
            }
            // gerou Pix e o suporte JÁ cobrou por isso? não cobra em dobro
            try {
                const { rows: pix } = await db.query(
                    `SELECT 1 FROM pix_pending_notices WHERE LOWER(customer_email) = $1 AND created_at >= $2 LIMIT 1`,
                    [email, it.created_at]);
                if (pix.length) continue; // abandon_sent_at já marcado = não repete
            } catch (_) {}
            const sup = await _supportSessionFor(email);
            if (!sup) continue;
            let modelo = null;
            if (it.chat_id) {
                try {
                    const { rows: cr } = await db.query(`SELECT name FROM chats WHERE id = $1`, [it.chat_id]);
                    modelo = cr[0] ? cr[0].name : null;
                } catch (_) {}
            }
            const ctx = { email, city: sup.session.city || null, cityFallback: sup.chat.city_fallback };
            const tpl = modelo ? cfg.abandon_template : cfg.abandon_generic_template;
            const txt = capFirst(await fillVars(String(tpl).replace(/\{modelo\}/gi, modelo || ''), ctx));
            const first = await insertMsg(sup.session.id, 'bot', 'text', txt, null, { typing_ms: 0 }, null);
            if (it.checkout_url) {
                await insertMsg(sup.session.id, 'bot', 'cta', String(cfg.abandon_cta_label || 'CONTINUAR DE ONDE PAREI 🔥').slice(0, 60), null,
                    { link_url: String(it.checkout_url), cta_color: '#e50914' }, null);
            }
            await db.query(`UPDATE chat_sessions SET last_seen_at = NULL, updated_at = NOW() WHERE id = $1`, [sup.session.id]);
            out.push({ chat: sup.chat, messages: [first], email });
        } catch (err) { logger.warn('[abandono] falhou intent ' + it.id + ': ' + err.message); }
    }

    // Etapa 2 — upsell do plano completo (só se configurado um produto)
    const upsellPid = parseInt(cfg.upsell_product_id, 10) || null;
    if (upsellPid) {
        const { rows: due2 } = await db.query(`
            UPDATE checkout_intents SET upsell_sent_at = NOW()
            WHERE id IN (
                SELECT id FROM checkout_intents
                 WHERE completed = false AND abandon_sent_at IS NOT NULL AND upsell_sent_at IS NULL
                   AND abandon_sent_at <= NOW() - make_interval(mins => $1)
                   AND created_at > NOW() - INTERVAL '72 hours'
                 ORDER BY abandon_sent_at LIMIT 20 FOR UPDATE SKIP LOCKED
            ) RETURNING *`, [upDelay]);
        for (const it of due2) {
            try {
                const email = String(it.customer_email).toLowerCase();
                // granted_at cobre renovação/recompra (ver comentário na etapa 1)
                const { rows: bought } = await db.query(
                    `SELECT 1 FROM user_access WHERE LOWER(email) = $1
                       AND (created_at >= $2 OR granted_at >= $2) LIMIT 1`,
                    [email, it.created_at]);
                if (bought.length) {
                    await db.query(`UPDATE checkout_intents SET completed = true WHERE id = $1`, [it.id]);
                    continue;
                }
                const { rows: pr } = await db.query(`SELECT id, name FROM products WHERE id = $1 AND is_active = true`, [upsellPid]);
                if (!pr.length) continue;
                const sup = await _supportSessionFor(email);
                if (!sup) continue;
                let modelo = null;
                if (it.chat_id) {
                    try {
                        const { rows: cr } = await db.query(`SELECT name FROM chats WHERE id = $1`, [it.chat_id]);
                        modelo = cr[0] ? cr[0].name : null;
                    } catch (_) {}
                }
                const ctx = { email, city: sup.session.city || null, cityFallback: sup.chat.city_fallback };
                const txt = capFirst(await fillVars(String(cfg.upsell_template).replace(/\{modelo\}/gi, modelo || 'sua preferida'), ctx));
                const first = await insertMsg(sup.session.id, 'bot', 'text', txt, null, { typing_ms: 0 }, null);
                await insertMsg(sup.session.id, 'bot', 'cta', pr[0].name, null, { product_id: pr[0].id, cta_color: '#e50914' }, null);
                await db.query(`UPDATE chat_sessions SET last_seen_at = NULL, updated_at = NOW() WHERE id = $1`, [sup.session.id]);
                out.push({ chat: sup.chat, messages: [first], email });
            } catch (err) { logger.warn('[abandono/upsell] falhou intent ' + it.id + ': ' + err.message); }
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
                   COALESCE(s.is_vip, false) AS is_vip,
                   c.name, c.avatar_url, c.display_order,
                   c.story_vip_product_id, c.story_vip_checkout_url,
                   EXISTS(SELECT 1 FROM chat_status_views v WHERE v.status_id = s.id
                          AND (($1 <> '' AND LOWER(v.customer_email) = $1) OR ($2 <> '' AND v.visitor_id = $2))) AS seen
            FROM chat_status s
            JOIN chats c ON c.id = s.chat_id
            WHERE s.active = true AND s.expires_at > NOW() AND c.active = true
            ORDER BY c.display_order, c.id, s.created_at
        `, [ident.email || '', ident.visitor || '']);
        // Resolve, 1x por modelo, se o cliente JÁ pagou os stories VIP dela.
        const ownsVipCache = new Map();
        async function ownsStoryVip(productId) {
            if (!productId) return false;
            if (ownsVipCache.has(productId)) return ownsVipCache.get(productId);
            const ok = await ownsProduct(ident.email, productId);
            ownsVipCache.set(productId, ok);
            return ok;
        }
        // Produto global de Status VIP: fallback pras modelos sem produto próprio
        const globalStoryId = await storyPlanProductId();
        const map = new Map();
        for (const r of rows) {
            const effStoryProd = r.story_vip_product_id || globalStoryId || null;
            if (!map.has(r.chat_id)) {
                map.set(r.chat_id, {
                    chat_id: r.chat_id, name: r.name, avatar_url: r.avatar_url,
                    has_unseen: false, has_vip_locked: false, vip_unlock: null,
                    story_vip_product_id: effStoryProd,
                    story_vip_checkout_url: r.story_vip_checkout_url || null,
                    items: [],
                });
            }
            const g = map.get(r.chat_id);
            // Só trava se o story é VIP E existe produto de desbloqueio (próprio da
            // modelo OU o global). Sem produto nenhum → degrada pra story normal.
            const vipLocked = r.is_vip === true && !!effStoryProd && !(await ownsStoryVip(effStoryProd));
            const stMeta = r.type === 'video' ? streamMediaMeta(r.media_url) : null;
            g.items.push({ id: r.id, type: r.type, media_url: r.media_url, caption: r.caption, bg_color: r.bg_color, created_at: r.created_at, is_vip: r.is_vip === true, vip_locked: vipLocked, hls: stMeta ? stMeta.hls : undefined, thumb: stMeta ? stMeta.thumb : undefined });
            if (!r.seen && !vipLocked) g.has_unseen = true;
            if (vipLocked) g.has_vip_locked = true;
        }
        // Anexa a info de desbloqueio (produto/planos) nos grupos com story VIP travado
        for (const g of map.values()) {
            if (g.has_vip_locked) {
                g.vip_unlock = await loadUnlock(g.story_vip_product_id, g.story_vip_checkout_url);
            }
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
        // Story VIP: só responde/destrava quem pagou os stories dessa modelo
        // (produto próprio OU o global de Status VIP). Sem produto nenhum
        // configurado, o story não é travado (degrada pra normal).
        const effStoryProd = chat.story_vip_product_id || (await storyPlanProductId());
        if (st.is_vip === true && effStoryProd && !(await ownsProduct(ident.email, effStoryProd))) {
            return res.status(403).json({
                success: false, error: 'vip_required',
                unlock: await loadUnlock(effStoryProd, chat.story_vip_checkout_url),
            });
        }
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
                `INSERT INTO chat_status (chat_id, type, media_url, caption, bg_color, reply_goto_key, is_vip, expires_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7, NOW() + make_interval(hours => $8))`,
                [s.chat_id, s.type, s.media_url, s.caption, s.bg_color, s.reply_goto_key, s.is_vip === true, Math.max(1, Math.min(168, s.expires_hours || 24))]
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
module.exports.deliverPurchaseToSupport = deliverPurchaseToSupport;
module.exports.deliverPixPendingToSupport = deliverPixPendingToSupport;
module.exports.deliverInstallWelcome = deliverInstallWelcome;
module.exports.invalidateSupportConfig = invalidateSupportConfig;
module.exports.postDueStatusSchedules = postDueStatusSchedules;
module.exports.startChatForIdentity = startChatForIdentity;
module.exports.processAbandonedCheckouts = processAbandonedCheckouts;
