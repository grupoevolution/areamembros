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
        const { rows: emCount } = await db.query(
            `SELECT COUNT(DISTINCT LOWER(customer_email))::int AS n FROM push_subscriptions WHERE customer_email IS NOT NULL`
        );
        return res.json({
            success: true,
            ready: !!vapid,
            public_key: vapid?.pub,
            subscribers: subsCount[0]?.total || 0,
            emails: emCount[0]?.n || 0,
        });
    } catch (err) {
        logger.error('push status falhou:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

router.post('/send', requireAdmin, async (req, res) => {
    // try/catch no handler inteiro: era a ÚNICA rota do sistema sem — um blip
    // de banco/VAPID rejeitava a promise e o Express 4 nunca respondia (o botão
    // "Enviar" do painel ficava girando até o proxy estourar).
    try {
    if (!webpush) {
        return res.status(500).json({ success: false, error: 'web-push não instalado. Adicione "web-push" ao package.json e rebuild.' });
    }
    const vapid = await ensureVapid();
    if (!vapid) return res.status(500).json({ success: false, error: 'VAPID não configurado' });

    const { title, body, url, target_emails, icon } = req.body || {};
    if (!title || !body) return res.status(400).json({ success: false, error: 'title e body obrigatórios' });

    let query = 'SELECT id, endpoint, p256dh, auth FROM push_subscriptions';
    const params = [];
    const targeted = Array.isArray(target_emails) && target_emails.length > 0;
    if (targeted) {
        query += ` WHERE LOWER(customer_email) = ANY($1::text[])`;
        params.push(target_emails.map(e => String(e).toLowerCase()));
    }
    const { rows: subs } = await db.query(query, params);

    // relatório: 1 linha por disparo manual/broadcast
    const { openPushLog, bumpPushLog } = require('../lib/push-log');
    const pid = await openPushLog({ source: targeted ? 'manual' : 'broadcast', title });

    const payload = JSON.stringify({
        title: String(title).slice(0, 100),
        body: String(body).slice(0, 200),
        url: url || '/',
        icon: icon ? String(icon).slice(0, 500) : undefined,
        pid: pid || undefined,
    });

    // Envio em LOTES PARALELOS (40 por vez): 455 aparelhos em sequência
    // estourava o timeout do proxy → a resposta voltava como página HTML
    // ("Unexpected token <"), mesmo com os pushes saindo. Assim responde
    // em segundos.
    let sent = 0, failed = 0;
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
            failed++;
            const err = results[j].reason || {};
            if (err.statusCode === 404 || err.statusCode === 410) {
                await db.query(`DELETE FROM push_subscriptions WHERE id = $1`, [chunk[j].id]).catch(() => {});
            }
        }
    }
    await bumpPushLog(pid, { targets: subs.length, accepted: sent });

    return res.json({ success: true, total: subs.length, sent, failed, pid });
    } catch (err) {
        logger.error('push send falhou:', err);
        return res.status(500).json({ success: false, error: 'Erro interno ao enviar — tente de novo' });
    }
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
    // dias da semana: array de 0..6 (0=domingo). Vazio = todos os dias.
    let weekdays = Array.isArray(b.weekdays)
        ? [...new Set(b.weekdays.map(n => parseInt(n, 10)).filter(n => n >= 0 && n <= 6))].sort()
        : [];
    if (weekdays.length === 7 || !weekdays.length) weekdays = null; // 7/7 ou vazio = todo dia
    return {
        send_time: time,
        title,
        body: String(b.body || '').trim().slice(0, 300) || null,
        url: String(b.url || '/').trim().slice(0, 300) || '/',
        icon_url: String(b.icon_url || '').trim().slice(0, 500) || null,
        audience,
        active: b.active !== false,
        weekdays,
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
            `INSERT INTO engagement_push_slots (send_time, title, body, url, icon_url, audience, active, weekdays)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
            [s.send_time, s.title, s.body, s.url, s.icon_url, s.audience, s.active, s.weekdays]
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
             SET send_time=$1, title=$2, body=$3, url=$4, icon_url=$5, audience=$6, active=$7, weekdays=$8
             WHERE id=$9 RETURNING *`,
            [s.send_time, s.title, s.body, s.url, s.icon_url, s.audience, s.active, s.weekdays, id]
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

// ── Banco de frases das notificações com foto (push_phrases) ──────────────
// O painel edita em texto: uma frase por linha, "tipo | título | texto".
const PHRASE_PERIODS = ['manha', 'tarde', 'noite', 'madrugada'];
const PHRASE_KINDS = ['chat', 'midia', 'encontros'];
router.get('/phrases', requireAdmin, async (req, res) => {
    try {
        const { rows } = await db.query(`SELECT period, kind, title, body FROM push_phrases WHERE active = true ORDER BY period, sort_order, id`);
        return res.json({ success: true, phrases: rows });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});
router.put('/phrases/:period', requireAdmin, async (req, res) => {
    const period = String(req.params.period || '');
    if (!PHRASE_PERIODS.includes(period)) return res.status(400).json({ success: false, error: 'Período inválido' });
    const list = (Array.isArray(req.body && req.body.phrases) ? req.body.phrases : [])
        .map(p => ({
            kind: PHRASE_KINDS.includes(String(p.kind || '').toLowerCase()) ? String(p.kind).toLowerCase() : 'chat',
            title: String(p.title || '').trim().slice(0, 100),
            body: String(p.body || '').trim().slice(0, 200),
        }))
        .filter(p => p.title && p.body)
        .slice(0, 200);
    if (!list.length) return res.status(400).json({ success: false, error: 'Coloque pelo menos 1 frase' });
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(`DELETE FROM push_phrases WHERE period = $1`, [period]);
        for (let i = 0; i < list.length; i++) {
            await client.query(
                `INSERT INTO push_phrases (period, kind, title, body, sort_order) VALUES ($1,$2,$3,$4,$5)`,
                [period, list[i].kind, list[i].title, list[i].body, i + 1]);
        }
        await client.query('COMMIT');
        return res.json({ success: true, count: list.length });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        logger.error('frases push: salvar falhou:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    } finally {
        client.release();
    }
});

// ── Teste da barra de notificação (A/B/C) ─────────────────────────────────
// Compara só a PRIMEIRA barra de cada pessoa (sorteada = justo). Quem ativou
// numa barra seguinte aparece à parte, por versão que viu primeiro.
router.get('/bar-stats', requireAdmin, async (req, res) => {
    const days = Math.max(1, Math.min(90, parseInt(req.query.days, 10) || 30));
    const IDENT = `COALESCE(LOWER(customer_email), metadata->>'vid')`;
    try {
        const { rows } = await db.reportQuery(`
            WITH s AS (
                SELECT DISTINCT ${IDENT} AS who, metadata->>'variant' AS v
                FROM tracking_events
                WHERE event_type = 'push_bar_shown' AND metadata->>'attempt' = '1'
                  AND created_at > NOW() - make_interval(days => $1)),
            e AS (
                SELECT DISTINCT ${IDENT} AS who, metadata->>'first_variant' AS fv,
                       (metadata->>'attempt') = '1' AS at_first
                FROM tracking_events
                WHERE event_type = 'push_bar_enabled'
                  AND created_at > NOW() - make_interval(days => $1))
            SELECT s.v AS variant, COUNT(DISTINCT s.who)::int AS shown,
                   COUNT(DISTINCT e1.who)::int AS enabled_first,
                   COUNT(DISTINCT e2.who)::int AS enabled_later
            FROM s
            LEFT JOIN e e1 ON e1.who = s.who AND e1.fv = s.v AND e1.at_first
            LEFT JOIN e e2 ON e2.who = s.who AND e2.fv = s.v AND NOT e2.at_first
            WHERE s.who IS NOT NULL AND s.v IN ('A','B','C')
            GROUP BY s.v ORDER BY s.v`, [days]);
        const { rows: cfg } = await db.query(`SELECT value FROM gamification_config WHERE key = 'push_bar'`);
        return res.json({ success: true, days, rows, winner: (cfg[0] && cfg[0].value && cfg[0].value.winner) || null });
    } catch (err) {
        logger.warn('bar-stats: ' + err.message);
        return res.status(500).json({ success: false });
    }
});

// ── Alarme de lentidão (lib/ops-monitor.js) ──────────────────────────────
router.get('/ops', requireAdmin, async (req, res) => {
    try {
        const mon = require('../lib/ops-monitor').status();
        const { rows: alerts } = await db.query(
            `SELECT id, kind, title, body, created_at FROM ops_alerts ORDER BY id DESC LIMIT 20`).catch(() => ({ rows: [] }));
        const { rows: cfg } = await db.query(`SELECT value FROM gamification_config WHERE key = 'ops_alerts'`);
        return res.json({ success: true, monitor: mon, alerts, config: (cfg[0] && cfg[0].value) || {} });
    } catch (err) {
        return res.status(500).json({ success: false });
    }
});
router.post('/ops/test', requireAdmin, async (req, res) => {
    try {
        const sent = await require('../lib/ops-monitor').notify('test', '🔔 Teste do alarme',
            'Se você recebeu isto pelo Argos, o alarme de lentidão está funcionando.', null);
        return res.json({ success: true, sent });
    } catch (err) {
        return res.status(500).json({ success: false });
    }
});

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

// =============================================================================
// RELATÓRIO DE NOTIFICAÇÕES — funil alvos → aceitos → exibidos → abertos
// =============================================================================
router.get('/report', requireAdmin, async (req, res) => {
    try {
        const { rows } = await db.query(
            `SELECT id, source, ref_id, day, title, targets, accepted, delivered, opened, created_at
             FROM push_log ORDER BY day DESC, id DESC LIMIT 120`
        );
        return res.json({ success: true, rows });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// RELATÓRIO v2 (28/10) — período em dias (Brasília), tudo pela fila de
// relatórios (db.reportQuery), nunca pesa o app:
//   days    — por dia: enviadas, exibidas, abertas, vendas após abrir, app instalado, novos inscritos
//   ranking — por tipo (origem + item): mesmas colunas, ordenado por vendas/abertura
//   totals  — inscritos ativos hoje (aparelhos que recebem push)
// "Venda após abrir" = compra (webhook) do MESMO e-mail até 24h depois de
// tocar numa notificação; se abriu várias, conta pra ÚLTIMA antes da compra.
router.get('/report-v2', requireAdmin, async (req, res) => {
    const days = Math.max(1, Math.min(90, parseInt(req.query.days, 10) || 7));
    const TZ = 'America/Sao_Paulo';
    const startSql = `((((NOW() AT TIME ZONE '${TZ}')::date - ${days - 1}))::timestamp AT TIME ZONE '${TZ}')`;
    const startDay = `((NOW() AT TIME ZONE '${TZ}')::date - ${days - 1})`;
    const salesCte = `
        WITH o AS (
            SELECT pid, email, opened_at FROM push_opens
            WHERE opened_at >= ${startSql} - INTERVAL '24 hours' AND email IS NOT NULL
        ), s AS (
            SELECT DISTINCT ON (COALESCE(ua.sale_id, ua.id::text))
                   o.pid, ua.created_at, COALESCE(ua.sale_amount, 0)::float AS amount
            FROM user_access ua
            JOIN o ON LOWER(ua.email) = o.email
                  AND ua.created_at > o.opened_at
                  AND ua.created_at <= o.opened_at + INTERVAL '24 hours'
            WHERE ua.granted_by = 'webhook' AND ua.created_at >= ${startSql}
            ORDER BY COALESCE(ua.sale_id, ua.id::text), o.opened_at DESC
        )`;
    const safe = (p) => p.then(r => r.rows).catch(err => { logger.warn('[push report-v2] ' + err.message); return null; });
    try {
        const [daily, salesDay, installs, subsNew, ranking, salesRank, subsTotal] = await Promise.all([
            safe(db.reportQuery(`
                SELECT day::text AS day, SUM(accepted)::int AS sent, SUM(delivered)::int AS shown, SUM(opened)::int AS opened
                FROM push_log WHERE day >= ${startDay} GROUP BY day`)),
            safe(db.reportQuery(`${salesCte}
                SELECT (created_at AT TIME ZONE '${TZ}')::date::text AS day, COUNT(*)::int AS sales, SUM(amount)::float AS revenue
                FROM s GROUP BY 1`)),
            safe(db.reportQuery(`
                SELECT (created_at AT TIME ZONE '${TZ}')::date::text AS day, COUNT(*)::int AS n
                FROM tracking_events WHERE event_type = 'pwa_app_installed' AND created_at >= ${startSql} GROUP BY 1`)),
            safe(db.reportQuery(`
                SELECT (created_at AT TIME ZONE '${TZ}')::date::text AS day, COUNT(*)::int AS n
                FROM push_subscriptions WHERE created_at >= ${startSql} GROUP BY 1`)),
            safe(db.reportQuery(`
                SELECT source, ref_id, MAX(title) AS title, COUNT(DISTINCT day)::int AS days,
                       SUM(accepted)::int AS sent, SUM(delivered)::int AS shown, SUM(opened)::int AS opened,
                       ARRAY_AGG(id) AS ids
                FROM push_log WHERE day >= ${startDay}
                GROUP BY source, ref_id, CASE WHEN ref_id IS NULL THEN title END`)),
            safe(db.reportQuery(`${salesCte}
                SELECT pid, COUNT(*)::int AS sales, SUM(amount)::float AS revenue FROM s GROUP BY pid`)),
            safe(db.reportQuery(`SELECT COUNT(*)::int AS n FROM push_subscriptions`)),
        ]);
        const failed = [daily, salesDay, installs, subsNew, ranking, salesRank, subsTotal].some(x => x === null);

        // por dia (preenche dias vazios)
        const byDay = {};
        const ensure = (d) => (byDay[d] = byDay[d] || { day: d, sent: 0, shown: 0, opened: 0, sales: 0, revenue: 0, installs: 0, new_subs: 0 });
        (daily || []).forEach(r => Object.assign(ensure(r.day), { sent: r.sent, shown: r.shown, opened: r.opened }));
        (salesDay || []).forEach(r => Object.assign(ensure(r.day), { sales: r.sales, revenue: r.revenue }));
        (installs || []).forEach(r => { ensure(r.day).installs = r.n; });
        (subsNew || []).forEach(r => { ensure(r.day).new_subs = r.n; });
        const dayRows = Object.values(byDay).sort((a, b) => b.day.localeCompare(a.day));

        // ranking: soma as vendas dos pids de cada grupo
        const salesByPid = {};
        (salesRank || []).forEach(r => { salesByPid[r.pid] = r; });
        const rank = (ranking || []).map(r => {
            let sales = 0, revenue = 0;
            (r.ids || []).forEach(id => { const s = salesByPid[id]; if (s) { sales += s.sales; revenue += s.revenue; } });
            return { source: r.source, ref_id: r.ref_id, title: r.title, days: r.days, sent: r.sent, shown: r.shown, opened: r.opened, sales, revenue };
        }).sort((a, b) => (b.sales - a.sales) || (b.opened - a.opened));

        return res.json({ success: true, days, failed, subscribers: subsTotal && subsTotal[0] ? subsTotal[0].n : null, daily: dayRows, ranking: rank });
    } catch (err) {
        logger.error('[push report-v2]', err);
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
