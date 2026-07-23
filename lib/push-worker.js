/**
 * =============================================================================
 * lib/push-worker.js — Worker de push agendado (Funil 2.0)
 * =============================================================================
 *
 * Processa a fila `funnel_scheduled_pushes` a cada 60s e envia web push
 * pros leads — MESMO COM O APP FECHADO. É a peça de re-engajamento do funil:
 * o lead digita o e-mail, as etapas tipo 'push' do funil são agendadas
 * (routes/user.js → scheduleFunnelPushes) e este worker entrega no horário.
 *
 * Status de cada job:
 *   pending          → aguardando o horário
 *   sent             → entregue em pelo menos 1 dispositivo
 *   no_subscription  → lead não instalou o app / não permitiu notificação
 *   failed           → todas as tentativas falharam
 *   canceled         → lead COMPROU antes do envio (sales-processor cancela)
 *
 * VAPID: mesmas chaves do push manual (system_settings), geradas se faltarem.
 * iOS: web push só chega depois do cliente adicionar o PWA à tela de início.
 * =============================================================================
 */

const db = require('../db');
const { logger } = require('./logger');

let webpush = null;
try {
    webpush = require('web-push');
} catch (err) {
    logger.warn('[push-worker] web-push não instalado — worker desativado.');
}

let vapidConfigured = false;

async function ensureVapid() {
    if (!webpush) return false;
    if (vapidConfigured) return true;
    const { rows } = await db.query(`
        SELECT key, value FROM system_settings
        WHERE key IN ('vapid_public_key', 'vapid_private_key', 'vapid_subject')
    `);
    const map = {};
    for (const r of rows) map[r.key] = r.value;
    const unwrap = (v) => (typeof v === 'string' ? v.replace(/^"|"$/g, '') : v);

    let pub = map.vapid_public_key && unwrap(map.vapid_public_key);
    let priv = map.vapid_private_key && unwrap(map.vapid_private_key);
    let subject = (map.vapid_subject && unwrap(map.vapid_subject)) || 'mailto:noreply@membrosvips.com';

    if (!pub || !priv) {
        const keys = webpush.generateVAPIDKeys();
        pub = keys.publicKey;
        priv = keys.privateKey;
        await db.query(`
            INSERT INTO system_settings (key, value, description) VALUES
              ('vapid_public_key', $1::jsonb, 'VAPID public key (Web Push)'),
              ('vapid_private_key', $2::jsonb, 'VAPID private key (Web Push) - sensível'),
              ('vapid_subject', $3::jsonb, 'VAPID subject (mailto:)')
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
        `, [JSON.stringify(pub), JSON.stringify(priv), JSON.stringify(subject)]);
    }

    webpush.setVapidDetails(subject, pub, priv);
    vapidConfigured = true;
    return true;
}

async function processDuePushes() {
    if (!webpush) return;
    if (!(await ensureVapid())) return;

    // Pega o lote vencido e marca como 'sending' na mesma query — se o
    // processo morrer no meio, os 'sending' órfãos são re-enfileirados abaixo.
    const { rows: due } = await db.query(`
        UPDATE funnel_scheduled_pushes
        SET status = 'sending'
        WHERE id IN (
            SELECT id FROM funnel_scheduled_pushes
            WHERE status = 'pending' AND send_at <= NOW()
            ORDER BY send_at
            LIMIT 50
            FOR UPDATE SKIP LOCKED
        )
        RETURNING *
    `);

    for (const job of due) {
        try {
            const { rows: subs } = await db.query(
                `SELECT id, endpoint, p256dh, auth FROM push_subscriptions
                 WHERE LOWER(customer_email) = LOWER($1)`,
                [job.customer_email]
            );
            if (!subs.length) {
                await db.query(
                    `UPDATE funnel_scheduled_pushes SET status = 'no_subscription', sent_at = NOW() WHERE id = $1`,
                    [job.id]
                );
                continue;
            }
            // relatório: bucket diário — 'funil' (etapa) ou 'boasvindas' (passo da sequência)
            const { openPushLog, bumpPushLog } = require('./push-log');
            const pid = job.step_id
                ? await openPushLog({ source: 'funil', refId: job.step_id, title: job.title })
                : await openPushLog({ source: 'boasvindas', refId: job.install_step_id || 0, title: job.title });
            const payload = JSON.stringify({
                title: String(job.title || 'Novidade').slice(0, 100),
                body: String(job.message || '').slice(0, 200),
                url: job.url || '/',
                icon: job.icon_url || undefined,
                tag: 'funnel-' + job.id,
                pid: pid || undefined,
            });
            let sent = 0, dead = 0;
            for (const sub of subs) {
                try {
                    await webpush.sendNotification(
                        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
                        payload
                    );
                    sent++;
                } catch (err) {
                    // Endpoint morto: limpa da base
                    if (err.statusCode === 404 || err.statusCode === 410) {
                        dead++;
                        await db.query(`DELETE FROM push_subscriptions WHERE id = $1`, [sub.id]).catch(() => {});
                    }
                }
            }
            await bumpPushLog(pid, { targets: subs.length, accepted: sent });
            if (sent > 0) {
                await db.query(
                    `UPDATE funnel_scheduled_pushes SET status = 'sent', sent_at = NOW() WHERE id = $1`,
                    [job.id]
                );
            } else if (dead >= subs.length) {
                // todos os endpoints morreram (app desinstalado/permissão revogada)
                await db.query(
                    `UPDATE funnel_scheduled_pushes SET status = 'no_subscription', sent_at = NOW() WHERE id = $1`,
                    [job.id]
                );
            } else {
                // Erro TEMPORÁRIO (429 rate limit, timeout, rede): re-agenda com
                // backoff em vez de marcar 'failed' pra sempre — antes, qualquer
                // instabilidade do serviço de push perdia a notificação de vez.
                await retryOrFail(job);
            }
        } catch (err) {
            logger.warn(`[push-worker] job ${job.id} falhou: ${err.message}`);
            await retryOrFail(job).catch(() => {});
        }
    }

    if (due.length) {
        logger.info(`[push-worker] ${due.length} push(es) agendado(s) processado(s)`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ROTINA DIÁRIA (engagement_push_slots): cada slot ativo dispara 1x por dia
// no horário de Brasília pra TODOS os inscritos do público escolhido.
// É o "3 notificações por dia chamando de volta" — configurado no painel
// (Push → Rotina diária), sem funil, sem agendamento manual.
// ─────────────────────────────────────────────────────────────────────────────

function brasiliaNow() {
    const d = new Date(Date.now() - 3 * 3600 * 1000); // UTC-3
    const pad = (n) => String(n).padStart(2, '0');
    return {
        date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
        minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
        weekday: d.getUTCDay(), // 0=domingo … 6=sábado (horário de Brasília)
    };
}

function slotMinutes(sendTime) {
    const m = String(sendTime || '').match(/^(\d{1,2}):(\d{2})/);
    return m ? (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) : null;
}

async function subsForAudience(audience) {
    if (audience === 'buyers') {
        const { rows } = await db.query(`
            SELECT ps.id, ps.endpoint, ps.p256dh, ps.auth FROM push_subscriptions ps
            JOIN customers c ON LOWER(c.email) = LOWER(ps.customer_email)
            WHERE c.total_purchases > 0
        `);
        return rows;
    }
    if (audience === 'leads') {
        const { rows } = await db.query(`
            SELECT ps.id, ps.endpoint, ps.p256dh, ps.auth FROM push_subscriptions ps
            LEFT JOIN customers c ON LOWER(c.email) = LOWER(ps.customer_email)
            WHERE c.id IS NULL OR c.total_purchases = 0
        `);
        return rows;
    }
    const { rows } = await db.query(`SELECT id, endpoint, p256dh, auth FROM push_subscriptions`);
    return rows;
}

async function processEngagementSlots() {
    if (!webpush) return;
    if (!(await ensureVapid())) return;
    const now = brasiliaNow();

    const { rows: slots } = await db.query(`
        SELECT * FROM engagement_push_slots
        WHERE active = true AND (last_sent_date IS NULL OR last_sent_date < $1::date)
    `, [now.date]);

    for (const slot of slots) {
        const due = slotMinutes(slot.send_time);
        if (due == null || now.minutes < due) continue;

        // Dias da semana: se o slot restringe dias (weekdays não-vazio) e HOJE
        // (Brasília) não está na lista, pula sem reivindicar. Vazio/NULL = todo dia.
        if (Array.isArray(slot.weekdays) && slot.weekdays.length && !slot.weekdays.includes(now.weekday)) continue;

        // Reivindica o dia ANTES de enviar (processo que morrer no meio não
        // manda em dobro no restart; melhor faltar 1 do que chegar 2).
        const { rows: claim } = await db.query(`
            UPDATE engagement_push_slots SET last_sent_date = $1::date
            WHERE id = $2 AND (last_sent_date IS NULL OR last_sent_date < $1::date)
            RETURNING id
        `, [now.date, slot.id]);
        if (!claim.length) continue;

        // Janela de 2h: servidor que ficou fora o dia todo não despeja push
        // das 9h às 23h — marca o dia como perdido e segue.
        if (now.minutes - due > 120) {
            logger.info(`[push-worker] rotina slot ${slot.id} fora da janela (${slot.send_time}) — pulado hoje`);
            continue;
        }

        try {
            const subs = await subsForAudience(slot.audience);
            if (!subs.length) continue;
            const { openPushLog, bumpPushLog } = require('./push-log');
            const pid = await openPushLog({ source: 'rotina', refId: slot.id, title: slot.title });
            const payload = JSON.stringify({
                title: String(slot.title || '').slice(0, 100),
                body: String(slot.body || '').slice(0, 200),
                url: slot.url || '/',
                icon: slot.icon_url || undefined,
                tag: 'engage-' + slot.id,
                pid: pid || undefined,
            });
            let sent = 0;
            const BATCH = 40;
            for (let i = 0; i < subs.length; i += BATCH) {
                const chunk = subs.slice(i, i + BATCH);
                const results = await Promise.allSettled(chunk.map(sub =>
                    webpush.sendNotification(
                        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
                        payload
                    )
                ));
                for (let j = 0; j < results.length; j++) {
                    if (results[j].status === 'fulfilled') { sent++; continue; }
                    const err = results[j].reason || {};
                    if (err.statusCode === 404 || err.statusCode === 410) {
                        await db.query(`DELETE FROM push_subscriptions WHERE id = $1`, [chunk[j].id]).catch(() => {});
                    }
                }
            }
            await bumpPushLog(pid, { targets: subs.length, accepted: sent });
            logger.info(`[push-worker] rotina slot ${slot.id} (${slot.send_time}): ${sent}/${subs.length} enviados`);
        } catch (err) {
            logger.warn(`[push-worker] rotina slot ${slot.id} falhou: ${err.message}`);
        }
    }
}

// Erro temporário: re-agenda com backoff progressivo (2min × tentativa).
// Depois de 5 tentativas sem sucesso, aí sim marca 'failed' de vez.
const MAX_ATTEMPTS = 5;
async function retryOrFail(job) {
    const attempts = (job.attempts || 0) + 1;
    if (attempts >= MAX_ATTEMPTS) {
        await db.query(
            `UPDATE funnel_scheduled_pushes SET status = 'failed', attempts = $2, sent_at = NOW() WHERE id = $1`,
            [job.id, attempts]
        );
        return;
    }
    await db.query(
        `UPDATE funnel_scheduled_pushes
         SET status = 'pending', attempts = $2,
             send_at = NOW() + make_interval(mins => $3)
         WHERE id = $1`,
        [job.id, attempts, attempts * 2]
    );
}

// Re-enfileira 'sending' órfãos (processo morreu no meio do envio há +10min)
async function requeueStuck() {
    try {
        await db.query(`
            UPDATE funnel_scheduled_pushes SET status = 'pending'
            WHERE status = 'sending' AND send_at < NOW() - INTERVAL '10 minutes'
        `);
    } catch (_) {}
}

let timer = null;
function startPushWorker() {
    if (!webpush) return;
    if (timer) return;
    timer = setInterval(() => {
        processDuePushes().catch(err => logger.warn('[push-worker] erro: ' + err.message));
        processEngagementSlots().catch(err => logger.warn('[push-worker] rotina erro: ' + err.message));
    }, 60 * 1000);
    // 1ª rodada 15s após o boot (migrations/conexões já assentaram)
    setTimeout(() => {
        requeueStuck().then(() => processDuePushes()).catch(() => {});
    }, 15 * 1000);
    logger.info('[push-worker] iniciado — fila de push do funil a cada 60s');
}

module.exports = { startPushWorker, processDuePushes };
