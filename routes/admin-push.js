/**
 * /api/admin/push — gestão de Web Push (VAPID).
 *
 * Inicializa VAPID keys (geradas 1x e salvas em system_settings).
 * Lista subscribers. Dispara push manual ou em eventos.
 *
 * Lib: web-push (npm). Se não estiver instalada, falha gracioso e instrui.
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAdmin } = require('../lib/auth');
const { logger } = require('../lib/logger');

let webpush = null;
try {
    webpush = require('web-push');
} catch (err) {
    logger.warn('web-push não instalado. Instale com: npm install web-push');
}

async function ensureVapid() {
    if (!webpush) return null;

    const { rows } = await db.query(`
        SELECT key, value FROM system_settings
        WHERE key IN ('vapid_public_key', 'vapid_private_key', 'vapid_subject')
    `);
    const map = {};
    for (const r of rows) map[r.key] = r.value;

    let pub = map.vapid_public_key && (typeof map.vapid_public_key === 'string' ? map.vapid_public_key.replace(/^"|"$/g, '') : map.vapid_public_key);
    let priv = map.vapid_private_key && (typeof map.vapid_private_key === 'string' ? map.vapid_private_key.replace(/^"|"$/g, '') : map.vapid_private_key);
    let subject = map.vapid_subject && (typeof map.vapid_subject === 'string' ? map.vapid_subject.replace(/^"|"$/g, '') : map.vapid_subject);

    if (!pub || !priv) {
        const keys = webpush.generateVAPIDKeys();
        pub = keys.publicKey;
        priv = keys.privateKey;
        subject = subject || 'mailto:noreply@membrosvips.com';
        await db.query(`
            INSERT INTO system_settings (key, value, description) VALUES
              ('vapid_public_key', $1::jsonb, 'VAPID public key (Web Push)'),
              ('vapid_private_key', $2::jsonb, 'VAPID private key (Web Push) - sensível'),
              ('vapid_subject', $3::jsonb, 'VAPID subject (mailto:)')
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
        `, [JSON.stringify(pub), JSON.stringify(priv), JSON.stringify(subject)]);
    }

    webpush.setVapidDetails(subject, pub, priv);
    return { pub, priv, subject };
}

router.get('/status', requireAdmin, async (req, res) => {
    try {
        if (!webpush) {
            return res.json({ success: true, ready: false, reason: 'web-push package não instalado' });
        }
        const vapid = await ensureVapid();
        const { rows: subsCount } = await db.query(`SELECT COUNT(*)::int AS total FROM push_subscriptions`);
        return res.json({
            success: true,
            ready: !!vapid,
            public_key: vapid?.pub,
            subscribers: subsCount[0]?.total || 0,
        });
    } catch (err) {
        logger.error('push status falhou:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

router.post('/send', requireAdmin, async (req, res) => {
    if (!webpush) {
        return res.status(500).json({ success: false, error: 'web-push não instalado. Adicione "web-push" ao package.json e rebuild.' });
    }
    const vapid = await ensureVapid();
    if (!vapid) return res.status(500).json({ success: false, error: 'VAPID não configurado' });

    const { title, body, url, target_emails } = req.body || {};
    if (!title || !body) return res.status(400).json({ success: false, error: 'title e body obrigatórios' });

    let query = 'SELECT id, endpoint, p256dh, auth FROM push_subscriptions';
    const params = [];
    if (Array.isArray(target_emails) && target_emails.length > 0) {
        query += ` WHERE LOWER(customer_email) = ANY($1::text[])`;
        params.push(target_emails.map(e => String(e).toLowerCase()));
    }
    const { rows: subs } = await db.query(query, params);

    const payload = JSON.stringify({
        title: String(title).slice(0, 100),
        body: String(body).slice(0, 200),
        url: url || '/',
    });

    let sent = 0, failed = 0;
    for (const sub of subs) {
        try {
            await webpush.sendNotification(
                { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
                payload
            );
            sent++;
        } catch (err) {
            failed++;
            // Endpoint expirou: remove
            if (err.statusCode === 404 || err.statusCode === 410) {
                await db.query(`DELETE FROM push_subscriptions WHERE id = $1`, [sub.id]);
            }
        }
    }

    return res.json({ success: true, total: subs.length, sent, failed });
});

router.get('/subscribers', requireAdmin, async (req, res) => {
    try {
        const { rows } = await db.query(`
            SELECT id, customer_email, user_agent, created_at, last_used_at
            FROM push_subscriptions
            ORDER BY created_at DESC
            LIMIT 200
        `);
        return res.json({ success: true, subscribers: rows });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

module.exports = router;
