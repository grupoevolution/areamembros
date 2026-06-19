/**
 * =============================================================================
 * lib/chat-worker.js — Continuação de conversa com o app FECHADO
 * =============================================================================
 *
 * A cada 30s retoma os roteiros de chat que estavam pausados num bloco
 * "Esperar" (delay) e cujo horário venceu — MESMO com o cliente fora do app.
 * As mensagens entram no histórico (chat_messages) e, pra quem tem push e
 * e-mail real, dispara uma notificação no celular com o texto da 1ª mensagem
 * nova. O clique abre o app direto na conversa (/?chat=<id>).
 *
 * Reusa o MESMO motor do chat (routes/user-chats.js → resumeDelayed) e o
 * mesmo VAPID do push do funil.
 * =============================================================================
 */

const db = require('../db');
const { logger } = require('./logger');

let webpush = null;
try { webpush = require('web-push'); } catch (_) { /* sem push: só continua o roteiro */ }

let vapidReady = false;
async function ensureVapid() {
    if (!webpush) return false;
    if (vapidReady) return true;
    try {
        const { rows } = await db.query(
            `SELECT key, value FROM system_settings WHERE key IN ('vapid_public_key','vapid_private_key','vapid_subject')`
        );
        const map = {}; for (const r of rows) map[r.key] = r.value;
        const unwrap = v => (typeof v === 'string' ? v.replace(/^"|"$/g, '') : v);
        const pub = map.vapid_public_key && unwrap(map.vapid_public_key);
        const priv = map.vapid_private_key && unwrap(map.vapid_private_key);
        const subject = (map.vapid_subject && unwrap(map.vapid_subject)) || 'mailto:noreply@membrosvips.com';
        if (!pub || !priv) return false; // push do funil gera as chaves; aqui só usa
        webpush.setVapidDetails(subject, pub, priv);
        vapidReady = true;
        return true;
    } catch (_) { return false; }
}

// Texto da notificação — NÃO vaza o conteúdo. Genérico "Nova mensagem"; só muda
// quando é mídia (igual o cliente pediu: te enviou uma imagem/um vídeo/um áudio).
function previewText(m) {
    if (!m) return 'Nova mensagem';
    if (m.type === 'audio') return 'Te enviou um áudio';
    if (m.type === 'image') return 'Te enviou uma imagem';
    if (m.type === 'view_once_image') return 'Te enviou uma imagem';
    if (m.type === 'view_once_video') return 'Te enviou um vídeo';
    return 'Nova mensagem';
}

async function sendChatPush(email, chat, firstMsg) {
    if (!(await ensureVapid()) || !email) return;
    let subs = [];
    try {
        const { rows } = await db.query(
            `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE LOWER(customer_email) = LOWER($1)`, [email]
        );
        subs = rows;
    } catch (_) { return; }
    if (!subs.length) return;
    const payload = JSON.stringify({
        title: chat.name || 'Nova mensagem',
        body: previewText(firstMsg),
        url: '/?chat=' + chat.id,
        tag: 'chat-' + chat.id,
        // foto da modelo aparece redonda no push (igual notificação de WhatsApp)
        icon: chat.avatar_url || undefined,
        type: 'chat',
    });
    for (const s of subs) {
        try {
            await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
        } catch (err) {
            if (err.statusCode === 404 || err.statusCode === 410) {
                await db.query(`DELETE FROM push_subscriptions WHERE id = $1`, [s.id]).catch(() => {});
            }
        }
    }
}

async function tick() {
    const chatsApi = (() => { try { return require('../routes/user-chats'); } catch (_) { return null; } })();
    if (!chatsApi) return;

    // Rotina de status: posta os agendamentos cujo horário (Brasília) venceu
    if (typeof chatsApi.postDueStatusSchedules === 'function') {
        try {
            const n = await chatsApi.postDueStatusSchedules();
            if (n) logger.info('[chat-worker] ' + n + ' status agendado(s) postado(s)');
        } catch (err) { logger.warn('[chat-worker] rotina de status: ' + err.message); }
    }

    const resumeDelayed = chatsApi.resumeDelayed;
    if (typeof resumeDelayed !== 'function') return;
    let results = [];
    try { results = await resumeDelayed(30); } catch (err) { logger.warn('[chat-worker] ' + err.message); return; }
    for (const r of results) {
        // 1ª mensagem do bot da leva (a que o push anuncia)
        const firstBot = (r.messages || []).find(m => m.sender === 'bot') || r.messages[0];
        if (r.email) {
            try { await sendChatPush(r.email, r.chat, firstBot); } catch (_) {}
        }
    }
    if (results.length) logger.info('[chat-worker] ' + results.length + ' conversa(s) retomada(s)');
}

let timer = null;
function startChatWorker() {
    if (timer) return;
    // 2s: as mensagens são entregues UMA a UMA (pacing no servidor). Pro cliente
    // FORA da conversa, isso faz cada mensagem chegar perto do tempo real e
    // disparar a notificação. Carga é baixa (1 query indexada por tick).
    timer = setInterval(() => { tick().catch(e => logger.warn('[chat-worker] erro: ' + e.message)); }, 2 * 1000);
    setTimeout(() => { tick().catch(() => {}); }, 2 * 1000);
    logger.info('[chat-worker] iniciado — entrega mensagens em delay a cada 2s');
}

module.exports = { startChatWorker, tick, sendChatPush };
