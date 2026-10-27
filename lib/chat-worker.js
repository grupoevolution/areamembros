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

// Retorna true quando ao menos 1 push foi aceito (o painel de broadcast conta).
async function sendChatPush(email, chat, firstMsg, opts) {
    opts = opts || {};
    if (!(await ensureVapid()) || !email) return false;
    let subs = [];
    try {
        const { rows } = await db.query(
            `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE LOWER(customer_email) = LOWER($1)`, [email]
        );
        subs = rows;
    } catch (_) { return false; }
    if (!subs.length) return false;
    // relatório: bucket diário por modelo (source 'chat')
    const { openPushLog, bumpPushLog } = require('./push-log');
    const pid = await openPushLog({ source: 'chat', refId: chat.id, title: chat.name });
    const payload = JSON.stringify({
        title: chat.name || 'Nova mensagem',
        body: opts.body || previewText(firstMsg),
        url: opts.url || ('/?chat=' + chat.id),
        tag: opts.tag || ('chat-' + chat.id),
        // foto da modelo aparece redonda no push (igual notificação de WhatsApp)
        icon: chat.avatar_url || undefined,
        type: 'chat',
        pid: pid || undefined,
    });
    let sent = 0;
    for (const s of subs) {
        try {
            await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
            sent++;
        } catch (err) {
            if (err.statusCode === 404 || err.statusCode === 410) {
                await db.query(`DELETE FROM push_subscriptions WHERE id = $1`, [s.id]).catch(() => {});
            }
        }
    }
    await bumpPushLog(pid, { targets: subs.length, accepted: sent });
    return sent > 0;
}

// Notificação avulsa pra UM cliente (pagamento confirmado, lembrete do Pix…).
// Mesmo envio do chat, sem estar presa a uma modelo.
async function sendUserPush(email, { title, body, url, tag, icon, source }) {
    if (!(await ensureVapid()) || !email) return false;
    let subs = [];
    try {
        const { rows } = await db.query(
            `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE LOWER(customer_email) = LOWER($1)`, [email]);
        subs = rows;
    } catch (_) { return false; }
    if (!subs.length) return false;
    let pid = null, bump = null;
    try {
        const pl = require('./push-log');
        pid = await pl.openPushLog({ source: source || 'sistema', refId: 0, title: String(title || '').slice(0, 100) });
        bump = pl.bumpPushLog;
    } catch (_) {}
    const payload = JSON.stringify({
        title: String(title || '').slice(0, 100), body: String(body || '').slice(0, 200),
        url: url || '/', tag: tag || undefined, icon: icon || undefined, pid: pid || undefined,
    });
    let sent = 0;
    for (const s of subs) {
        try {
            await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
            sent++;
        } catch (err) {
            if (err.statusCode === 404 || err.statusCode === 410) {
                await db.query(`DELETE FROM push_subscriptions WHERE id = $1`, [s.id]).catch(() => {});
            }
        }
    }
    if (bump && pid) await bump(pid, { targets: subs.length, accepted: sent }).catch(() => {});
    return sent > 0;
}

async function tick() {
    const chatsApi = (() => { try { return require('../routes/user-chats'); } catch (_) { return null; } })();
    if (!chatsApi) return;

    // Rotina de status: posta os agendamentos cujo horário (Brasília) venceu.
    // Gate de 15s (igual ao abandono): precisão de segundos não importa pra
    // status agendado, e sem o gate a varredura rodava a cada 2s à toa.
    if (typeof chatsApi.postDueStatusSchedules === 'function'
        && Date.now() - (tick._lastStatus || 0) > 15000) {
        tick._lastStatus = Date.now();
        try {
            const n = await chatsApi.postDueStatusSchedules();
            if (n) logger.info('[chat-worker] ' + n + ' status agendado(s) postado(s)');
        } catch (err) { logger.warn('[chat-worker] rotina de status: ' + err.message); }
    }

    // Carrinho abandonado: checa a cada ~15s (o dono usa delay curto, em
    // segundos — 60s de gate atrasava a 1ª cobrança; a query é 1 SELECT
    // indexado numa tabela quase sempre vazia, custo desprezível)
    if (typeof chatsApi.processAbandonedCheckouts === 'function'
        && Date.now() - (tick._lastAbandon || 0) > 15000) {
        tick._lastAbandon = Date.now();
        try {
            const sent = await chatsApi.processAbandonedCheckouts();
            for (const r of sent) {
                const firstBot = (r.messages || []).find(m => m.sender === 'bot') || r.messages[0];
                if (r.email) { try { await sendChatPush(r.email, r.chat, firstBot); } catch (_) {} }
            }
            if (sent.length) logger.info('[chat-worker] ' + sent.length + ' cobrança(s) de carrinho abandonado');
        } catch (err) { logger.warn('[chat-worker] abandono: ' + err.message); }
    }

    // ENCONTROS: curtidas de volta que venceram → push "X curtiu você" (a cada ~20s)
    if (Date.now() - (tick._lastEnc || 0) > 20000) {
        tick._lastEnc = Date.now();
        try {
            const E = require('./encounters');
            const due = await E.popDueLikes(40);
            for (const l of due) {
                if (!l.email) continue;
                const { rows: [chat] } = await db.query(`SELECT id, name, avatar_url FROM chats WHERE id = $1`, [l.chat_id]);
                if (!chat) continue;
                try {
                    await sendChatPush(l.email, chat, null, {
                        body: l.is_match ? 'Deu match com você 💚 toca pra conversar' : 'Curtiu você 💗 vem ver quem é',
                        url: '/?go=encontros', tag: 'enc-' + l.chat_id,
                    });
                } catch (_) {}
            }
            if (due.length) logger.info('[chat-worker] ' + due.length + ' curtida(s) do Encontros entregue(s)');
        } catch (err) { logger.warn('[chat-worker] encontros: ' + err.message); }
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
    // Uma rodada por vez (push lento não pode empilhar rodadas a cada 2s)
    let running = false;
    timer = setInterval(() => {
        if (running) return;
        running = true;
        tick().catch(e => logger.warn('[chat-worker] erro: ' + e.message)).finally(() => { running = false; });
    }, 2 * 1000);
    setTimeout(() => { tick().catch(() => {}); }, 2 * 1000);
    logger.info('[chat-worker] iniciado — entrega mensagens em delay a cada 2s');
}

module.exports = { startChatWorker, tick, sendChatPush, sendUserPush };
