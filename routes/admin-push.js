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

    const { title, body, url, target_emails, icon } = req.body || {};
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
        icon: icon ? String(icon).slice(0, 500) : undefined,
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

// =============================================================================
// ROTINA DIÁRIA DE NOTIFICAÇÕES (pós-instalação do PWA)
// =============================================================================
// Slots de horário (Brasília) com mensagem e público. O push-worker dispara
// cada slot 1x por dia pra todos os inscritos do público escolhido — é a
// máquina de trazer o lead de volta pro app sem o admin fazer nada.

function cleanSlot(body) {
    const b = body || {};
    const time = String(b.send_time || '').trim();
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(time)) return { error: 'Horário inválido (use HH:MM)' };
    const title = String(b.title || '').trim().slice(0, 120);
    if (!title) return { error: 'Título obrigatório' };
    const audience = ['all', 'leads', 'buyers'].includes(b.audience) ? b.audience : 'all';
    return {
        send_time: time,
        title,
        body: String(b.body || '').trim().slice(0, 300) || null,
        url: String(b.url || '/').trim().slice(0, 300) || '/',
        icon_url: String(b.icon_url || '').trim().slice(0, 500) || null,
        audience,
        active: b.active !== false,
    };
}

router.get('/routine', requireAdmin, async (req, res) => {
    try {
        const { rows } = await db.query(`SELECT * FROM engagement_push_slots ORDER BY send_time, id`);
        return res.json({ success: true, slots: rows });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

router.post('/routine', requireAdmin, async (req, res) => {
    const s = cleanSlot(req.body);
    if (s.error) return res.status(400).json({ success: false, error: s.error });
    try {
        const { rows } = await db.query(
            `INSERT INTO engagement_push_slots (send_time, title, body, url, icon_url, audience, active)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [s.send_time, s.title, s.body, s.url, s.icon_url, s.audience, s.active]
        );
        return res.json({ success: true, slot: rows[0] });
    } catch (err) {
        logger.error('rotina push: criar falhou:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

router.put('/routine/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    const s = cleanSlot(req.body);
    if (s.error) return res.status(400).json({ success: false, error: s.error });
    try {
        const { rows } = await db.query(
            `UPDATE engagement_push_slots
             SET send_time=$1, title=$2, body=$3, url=$4, icon_url=$5, audience=$6, active=$7
             WHERE id=$8 RETURNING *`,
            [s.send_time, s.title, s.body, s.url, s.icon_url, s.audience, s.active, id]
        );
        if (!rows.length) return res.status(404).json({ success: false, error: 'Slot não encontrado' });
        return res.json({ success: true, slot: rows[0] });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

router.delete('/routine/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        await db.query(`DELETE FROM engagement_push_slots WHERE id = $1`, [id]);
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// =============================================================================
// SEQUÊNCIA PÓS-INSTALAÇÃO (install_push_steps)
// =============================================================================
// Passos com atraso RELATIVO à instalação (1ª subscription do e-mail).
// Agendados na hora do subscribe; compra aprovada cancela o restante.

function cleanStep(body) {
    const b = body || {};
    const delay = parseInt(b.delay_minutes, 10);
    if (!delay || delay < 1 || delay > 60 * 24 * 7) return { error: 'Atraso inválido (1 min a 7 dias)' };
    const title = String(b.title || '').trim().slice(0, 120);
    if (!title) return { error: 'Título obrigatório' };
    return {
        delay_minutes: delay,
        title,
        body: String(b.body || '').trim().slice(0, 300) || null,
        url: String(b.url || '/').trim().slice(0, 300) || '/',
        icon_url: String(b.icon_url || '').trim().slice(0, 500) || null,
        active: b.active !== false,
    };
}

router.get('/install-steps', requireAdmin, async (req, res) => {
    try {
        const { rows } = await db.query(`SELECT * FROM install_push_steps ORDER BY delay_minutes, id`);
        return res.json({ success: true, steps: rows });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

router.post('/install-steps', requireAdmin, async (req, res) => {
    const s = cleanStep(req.body);
    if (s.error) return res.status(400).json({ success: false, error: s.error });
    try {
        const { rows } = await db.query(
            `INSERT INTO install_push_steps (delay_minutes, title, body, url, icon_url, active)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
            [s.delay_minutes, s.title, s.body, s.url, s.icon_url, s.active]
        );
        return res.json({ success: true, step: rows[0] });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

router.put('/install-steps/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    const s = cleanStep(req.body);
    if (s.error) return res.status(400).json({ success: false, error: s.error });
    try {
        const { rows } = await db.query(
            `UPDATE install_push_steps
             SET delay_minutes=$1, title=$2, body=$3, url=$4, icon_url=$5, active=$6
             WHERE id=$7 RETURNING *`,
            [s.delay_minutes, s.title, s.body, s.url, s.icon_url, s.active, id]
        );
        if (!rows.length) return res.status(404).json({ success: false, error: 'Passo não encontrado' });
        return res.json({ success: true, step: rows[0] });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

router.delete('/install-steps/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        await db.query(`DELETE FROM install_push_steps WHERE id = $1`, [id]);
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
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
