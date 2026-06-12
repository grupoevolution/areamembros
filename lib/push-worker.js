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
            const payload = JSON.stringify({
                title: String(job.title || 'Novidade').slice(0, 100),
                body: String(job.message || '').slice(0, 200),
                url: job.url || '/',
                tag: 'funnel-' + job.id,
            });
            let sent = 0;
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
                        await db.query(`DELETE FROM push_subscriptions WHERE id = $1`, [sub.id]).catch(() => {});
                    }
                }
            }
            await db.query(
                `UPDATE funnel_scheduled_pushes SET status = $2, sent_at = NOW() WHERE id = $1`,
                [job.id, sent > 0 ? 'sent' : 'failed']
            );
        } catch (err) {
            logger.warn(`[push-worker] job ${job.id} falhou: ${err.message}`);
            await db.query(
                `UPDATE funnel_scheduled_pushes SET status = 'failed', sent_at = NOW() WHERE id = $1`,
                [job.id]
            ).catch(() => {});
        }
    }

    if (due.length) {
        logger.info(`[push-worker] ${due.length} push(es) agendado(s) processado(s)`);
    }
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
    }, 60 * 1000);
    // 1ª rodada 15s após o boot (migrations/conexões já assentaram)
    setTimeout(() => {
        requeueStuck().then(() => processDuePushes()).catch(() => {});
    }, 15 * 1000);
    logger.info('[push-worker] iniciado — fila de push do funil a cada 60s');
}

module.exports = { startPushWorker, processDuePushes };
