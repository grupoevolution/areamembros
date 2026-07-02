/**
 * /api/admin/tracking — agregados de comportamento pro dashboard admin.
 * Lê de tracking_events e product_views.
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAdmin } = require('../lib/auth');
const { logger } = require('../lib/logger');

// GET /api/admin/tracking/summary?days=30
router.get('/summary', requireAdmin, async (req, res) => {
    const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 30));
    try {
        const [topViews, topClicks, eventsAgg] = await Promise.all([
            db.query(`
                SELECT pv.product_id, p.name, COUNT(*)::int AS views,
                       COUNT(DISTINCT pv.customer_email)::int AS unique_viewers,
                       SUM(CASE WHEN pv.clicked_buy THEN 1 ELSE 0 END)::int AS buy_clicks
                FROM product_views pv
                LEFT JOIN products p ON p.id = pv.product_id
                WHERE pv.viewed_at >= NOW() - ($1 || ' days')::interval
                GROUP BY pv.product_id, p.name
                ORDER BY views DESC
                LIMIT 20
            `, [String(days)]),
            db.query(`
                SELECT t.product_id, p.name, COUNT(*)::int AS clicks
                FROM tracking_events t
                LEFT JOIN products p ON p.id = t.product_id
                WHERE t.event_type IN ('cta_buy_click', 'cta_access_click')
                  AND t.created_at >= NOW() - ($1 || ' days')::interval
                  AND t.product_id IS NOT NULL
                GROUP BY t.product_id, p.name
                ORDER BY clicks DESC
                LIMIT 20
            `, [String(days)]),
            db.query(`
                SELECT event_type, COUNT(*)::int AS total
                FROM tracking_events
                WHERE created_at >= NOW() - ($1 || ' days')::interval
                GROUP BY event_type
                ORDER BY total DESC
            `, [String(days)]),
        ]);

        return res.json({
            success: true,
            days,
            top_views: topViews.rows,
            top_clicks: topClicks.rows,
            events_breakdown: eventsAgg.rows,
        });
    } catch (err) {
        logger.error('admin tracking summary falhou:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// ── Helpers de janela (horário de Brasília, UTC-3) ──────────────────────────
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const isoDay = (d) => d.toISOString().slice(0, 10);
// janela em Brasília: [from 00:00, to+1 00:00) convertida pra UTC (+3h)
const winStart = (from) => from + ' 03:00:00';
const winEnd = (to) => to + ' 03:00:00'; // soma +1 dia no SQL

// Estatísticas de UM período — o "funil completo" que o dashboard mostra:
// pressel → chegadas /f/ → e-mails → instalou PWA → 1ª interação no chat →
// popup do paywall aberto → clique no plano → compras + receita.
async function periodStats(A, B) {
    const { rows: [r] } = await db.query(`
        SELECT
          (SELECT COUNT(*)::int FROM tracking_events WHERE event_type = 'pressel_view' AND created_at >= $1::timestamptz AND created_at < ($2::timestamptz + INTERVAL '1 day')) AS pressel_views,
          (SELECT COUNT(*)::int FROM tracking_events WHERE event_type = 'pressel_click' AND created_at >= $1::timestamptz AND created_at < ($2::timestamptz + INTERVAL '1 day')) AS pressel_clicks,
          (SELECT COUNT(*)::int FROM funnel_visits WHERE visited_at >= $1::timestamptz AND visited_at < ($2::timestamptz + INTERVAL '1 day')) AS clicks,
          (SELECT COUNT(*)::int FROM funnel_visits WHERE converted = true AND visited_at >= $1::timestamptz AND visited_at < ($2::timestamptz + INTERVAL '1 day')) AS emails,
          (SELECT COUNT(*)::int FROM tracking_events WHERE event_type = 'pwa_app_installed' AND created_at >= $1::timestamptz AND created_at < ($2::timestamptz + INTERVAL '1 day')) AS pwa_installs,
          (SELECT COUNT(*)::int FROM tracking_events WHERE event_type = 'pwa_opened_standalone' AND created_at >= $1::timestamptz AND created_at < ($2::timestamptz + INTERVAL '1 day')) AS pwa_opened,
          (
            -- 1ª interação: sessões cuja PRIMEIRA mensagem do lead caiu no período
            SELECT COUNT(*)::int FROM (
                SELECT m.session_id, MIN(m.created_at) AS first_at
                FROM chat_messages m WHERE m.sender = 'user' GROUP BY m.session_id
            ) fi
            WHERE fi.first_at >= $1::timestamptz AND fi.first_at < ($2::timestamptz + INTERVAL '1 day')
          ) AS first_interactions,
          (SELECT COUNT(*)::int FROM tracking_events WHERE event_type = 'chat_paywall_open' AND created_at >= $1::timestamptz AND created_at < ($2::timestamptz + INTERVAL '1 day')) AS paywall_opens,
          (SELECT COUNT(*)::int FROM tracking_events WHERE event_type = 'chat_paywall_click' AND created_at >= $1::timestamptz AND created_at < ($2::timestamptz + INTERVAL '1 day')) AS paywall_clicks,
          (SELECT COUNT(*)::int FROM user_access WHERE status = 'active' AND granted_by = 'webhook' AND granted_at >= $1::timestamptz AND granted_at < ($2::timestamptz + INTERVAL '1 day')) AS purchases,
          (SELECT COALESCE(SUM(sale_amount), 0)::float FROM user_access WHERE status = 'active' AND granted_by = 'webhook' AND granted_at >= $1::timestamptz AND granted_at < ($2::timestamptz + INTERVAL '1 day')) AS revenue
    `, [A, B]);
    return r;
}

// GET /api/admin/tracking/funnel-analytics
//   ?from=YYYY-MM-DD&to=YYYY-MM-DD                 período principal
//   &cmp_from=YYYY-MM-DD&cmp_to=YYYY-MM-DD         período de comparação (opcional)
// Retorna o funil completo do período (com comparação), séries por dia e por
// hora, tabela por funil e tabela por chat (interações, progresso no roteiro,
// popup aberto/clicado).
router.get('/funnel-analytics', requireAdmin, async (req, res) => {
    // default: últimos 7 dias (Brasília)
    const today = new Date(Date.now() - 3 * 3600 * 1000);
    const to = isDate(req.query.to) ? req.query.to : isoDay(today);
    const from = isDate(req.query.from) ? req.query.from : isoDay(new Date(today.getTime() - 6 * 86400000));
    const A = winStart(from), B = winEnd(to);
    const hasCmp = isDate(req.query.cmp_from) && isDate(req.query.cmp_to);
    try {
        const [totals, compare, byFunnel, byDay, purchasesByDay, byHour, byChat] = await Promise.all([
            periodStats(A, B),
            hasCmp ? periodStats(winStart(req.query.cmp_from), winEnd(req.query.cmp_to)) : Promise.resolve(null),
            db.query(`
                SELECT v.funnel_slug AS slug, COALESCE(f.name, v.funnel_slug) AS name,
                       COUNT(*)::int AS clicks,
                       COUNT(*) FILTER (WHERE v.converted)::int AS emails,
                       (SELECT COUNT(*)::int FROM tracking_events te
                        WHERE te.event_type = 'pressel_view' AND te.metadata->>'funnel_slug' = v.funnel_slug
                          AND te.created_at >= $1::timestamptz AND te.created_at < ($2::timestamptz + INTERVAL '1 day')) AS pressel_views,
                       (SELECT COUNT(*)::int FROM tracking_events te
                        WHERE te.event_type = 'pressel_click' AND te.metadata->>'funnel_slug' = v.funnel_slug
                          AND te.created_at >= $1::timestamptz AND te.created_at < ($2::timestamptz + INTERVAL '1 day')) AS pressel_clicks
                FROM funnel_visits v
                LEFT JOIN funnels f ON f.slug = v.funnel_slug
                WHERE v.visited_at >= $1::timestamptz AND v.visited_at < ($2::timestamptz + INTERVAL '1 day')
                GROUP BY v.funnel_slug, f.name
                ORDER BY clicks DESC
                LIMIT 50
            `, [A, B]),
            db.query(`
                SELECT to_char((visited_at - INTERVAL '3 hours')::date, 'YYYY-MM-DD') AS day,
                       COUNT(*)::int AS clicks,
                       COUNT(*) FILTER (WHERE converted)::int AS emails
                FROM funnel_visits
                WHERE visited_at >= $1::timestamptz AND visited_at < ($2::timestamptz + INTERVAL '1 day')
                GROUP BY 1 ORDER BY 1
            `, [A, B]),
            db.query(`
                SELECT to_char((granted_at - INTERVAL '3 hours')::date, 'YYYY-MM-DD') AS day,
                       COUNT(*)::int AS purchases,
                       COALESCE(SUM(sale_amount), 0)::float AS revenue
                FROM user_access
                WHERE status = 'active' AND granted_by = 'webhook'
                  AND granted_at >= $1::timestamptz AND granted_at < ($2::timestamptz + INTERVAL '1 day')
                GROUP BY 1 ORDER BY 1
            `, [A, B]),
            db.query(`
                SELECT EXTRACT(HOUR FROM (visited_at - INTERVAL '3 hours'))::int AS hour,
                       COUNT(*)::int AS clicks
                FROM funnel_visits
                WHERE visited_at >= $1::timestamptz AND visited_at < ($2::timestamptz + INTERVAL '1 day')
                GROUP BY 1 ORDER BY 1
            `, [A, B]),
            db.query(`
                SELECT c.id, c.name, c.access,
                       (SELECT COUNT(*)::int FROM chat_sessions s
                        WHERE s.chat_id = c.id AND s.created_at >= $1::timestamptz AND s.created_at < ($2::timestamptz + INTERVAL '1 day')) AS sessions,
                       (SELECT COUNT(DISTINCT m.session_id)::int FROM chat_messages m
                        JOIN chat_sessions s ON s.id = m.session_id
                        WHERE s.chat_id = c.id AND m.sender = 'user'
                          AND m.created_at >= $1::timestamptz AND m.created_at < ($2::timestamptz + INTERVAL '1 day')) AS engaged,
                       (SELECT COALESCE(ROUND(AVG(s.current_order)), 0)::int FROM chat_sessions s
                        WHERE s.chat_id = c.id AND s.created_at >= $1::timestamptz AND s.created_at < ($2::timestamptz + INTERVAL '1 day')) AS avg_step,
                       (SELECT COUNT(*)::int FROM chat_steps st WHERE st.chat_id = c.id AND st.active = true AND COALESCE(st.flow, 'open') = 'open') AS total_steps,
                       (SELECT COUNT(*)::int FROM tracking_events te
                        WHERE te.event_type = 'chat_paywall_open' AND (te.metadata->>'chat_id')::int = c.id
                          AND te.created_at >= $1::timestamptz AND te.created_at < ($2::timestamptz + INTERVAL '1 day')) AS paywall_opens,
                       (SELECT COUNT(*)::int FROM tracking_events te
                        WHERE te.event_type = 'chat_paywall_click' AND (te.metadata->>'chat_id')::int = c.id
                          AND te.created_at >= $1::timestamptz AND te.created_at < ($2::timestamptz + INTERVAL '1 day')) AS paywall_clicks
                FROM chats c
                WHERE c.active = true
                ORDER BY sessions DESC, c.display_order
                LIMIT 60
            `, [A, B]),
        ]);
        // Junta compras/receita nas linhas por dia (a série do gráfico)
        const purchaseMap = {};
        purchasesByDay.rows.forEach(r => { purchaseMap[r.day] = r; });
        const days = {};
        byDay.rows.forEach(r => { days[r.day] = { day: r.day, clicks: r.clicks, emails: r.emails, purchases: 0, revenue: 0 }; });
        purchasesByDay.rows.forEach(r => {
            if (!days[r.day]) days[r.day] = { day: r.day, clicks: 0, emails: 0, purchases: 0, revenue: 0 };
            days[r.day].purchases = r.purchases; days[r.day].revenue = r.revenue;
        });
        const byDayMerged = Object.values(days).sort((a, b) => a.day < b.day ? -1 : 1);
        return res.json({
            success: true,
            from, to,
            totals,
            compare,
            cmp_from: hasCmp ? req.query.cmp_from : null,
            cmp_to: hasCmp ? req.query.cmp_to : null,
            by_funnel: byFunnel.rows,
            by_day: byDayMerged,
            by_hour: byHour.rows,
            by_chat: byChat.rows,
            // compat: o card antigo de etapas lia d.steps
            steps: { clicks: totals.clicks, emails: totals.emails, installs: totals.pwa_installs, purchases: totals.purchases },
        });
    } catch (err) {
        logger.error('funnel-analytics falhou:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// GET /api/admin/tracking/chat-dropoff?chat_id=N&from=&to=
// Queda por BLOCO do roteiro: quantas sessões (criadas no período) chegaram
// em cada bloco do fluxo 'open' — mostra até onde os leads estão indo.
router.get('/chat-dropoff', requireAdmin, async (req, res) => {
    const chatId = parseInt(req.query.chat_id, 10);
    if (!chatId) return res.status(400).json({ success: false, error: 'chat_id obrigatório' });
    const today = new Date(Date.now() - 3 * 3600 * 1000);
    const to = isDate(req.query.to) ? req.query.to : isoDay(today);
    const from = isDate(req.query.from) ? req.query.from : isoDay(new Date(today.getTime() - 6 * 86400000));
    const A = winStart(from), B = winEnd(to);
    try {
        const [{ rows: steps }, { rows: sessions }] = await Promise.all([
            db.query(`
                SELECT id, step_order, type, content, step_key
                FROM chat_steps
                WHERE chat_id = $1 AND active = true AND COALESCE(flow, 'open') = 'open'
                ORDER BY step_order, id
            `, [chatId]),
            db.query(`
                SELECT current_order, COUNT(*)::int AS n
                FROM chat_sessions
                WHERE chat_id = $1 AND created_at >= $2::timestamptz AND created_at < ($3::timestamptz + INTERVAL '1 day')
                GROUP BY current_order
            `, [chatId, A, B]),
        ]);
        const totalSessions = sessions.reduce((s, r) => s + r.n, 0);
        // reached[i] = sessões que chegaram ATÉ o bloco i (current_order >= i)
        const out = steps.map((s, i) => {
            const reached = sessions.reduce((acc, r) => acc + (r.current_order >= i ? r.n : 0), 0);
            const label = s.type === 'text' ? (s.content || 'Texto') : s.type;
            return {
                index: i, step_id: s.id, type: s.type, step_key: s.step_key || null,
                label: String(label).slice(0, 60),
                reached,
                pct: totalSessions > 0 ? Math.round(reached / totalSessions * 100) : 0,
            };
        });
        return res.json({ success: true, chat_id: chatId, from, to, total_sessions: totalSessions, steps: out });
    } catch (err) {
        logger.error('chat-dropoff falhou:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

module.exports = router;
