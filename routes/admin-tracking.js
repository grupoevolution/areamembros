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

// GET /api/admin/tracking/funnel-analytics?from=YYYY-MM-DD&to=YYYY-MM-DD
// Análise dos funis no período (horário de Brasília, UTC-3):
//   cliques (funnel_visits), e-mails capturados (converted), instalações reais
//   do PWA (tracking_events pwa_app_installed) + abriram instalado, compras
//   (user_access), por funil, por dia e por hora, e o funil de etapas (drop-off).
router.get('/funnel-analytics', requireAdmin, async (req, res) => {
    const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
    // default: últimos 7 dias (Brasília)
    const today = new Date(Date.now() - 3 * 3600 * 1000);
    const iso = (d) => d.toISOString().slice(0, 10);
    const to = isDate(req.query.to) ? req.query.to : iso(today);
    const from = isDate(req.query.from) ? req.query.from : iso(new Date(today.getTime() - 6 * 86400000));
    // janela em Brasília: [from 00:00, to+1 00:00) convertida pra UTC (+3h)
    const A = from + ' 03:00:00';            // 00:00 BRT = 03:00 UTC
    const B = to + ' 03:00:00';              // será somado +1 dia no SQL
    try {
        const [totals, byFunnel, byDay, byHour, steps] = await Promise.all([
            db.query(`
                SELECT
                  (SELECT COUNT(*)::int FROM funnel_visits WHERE visited_at >= $1::timestamptz AND visited_at < ($2::timestamptz + INTERVAL '1 day')) AS clicks,
                  (SELECT COUNT(*)::int FROM funnel_visits WHERE converted = true AND visited_at >= $1::timestamptz AND visited_at < ($2::timestamptz + INTERVAL '1 day')) AS emails,
                  (SELECT COUNT(*)::int FROM tracking_events WHERE event_type = 'pwa_app_installed' AND created_at >= $1::timestamptz AND created_at < ($2::timestamptz + INTERVAL '1 day')) AS pwa_installs,
                  (SELECT COUNT(*)::int FROM tracking_events WHERE event_type = 'pwa_opened_standalone' AND created_at >= $1::timestamptz AND created_at < ($2::timestamptz + INTERVAL '1 day')) AS pwa_opened,
                  (SELECT COUNT(*)::int FROM user_access WHERE status = 'active' AND granted_at >= $1::timestamptz AND granted_at < ($2::timestamptz + INTERVAL '1 day')) AS purchases
            `, [A, B]),
            db.query(`
                SELECT v.funnel_slug AS slug, COALESCE(f.name, v.funnel_slug) AS name,
                       COUNT(*)::int AS clicks,
                       COUNT(*) FILTER (WHERE v.converted)::int AS emails
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
                SELECT EXTRACT(HOUR FROM (visited_at - INTERVAL '3 hours'))::int AS hour,
                       COUNT(*)::int AS clicks
                FROM funnel_visits
                WHERE visited_at >= $1::timestamptz AND visited_at < ($2::timestamptz + INTERVAL '1 day')
                GROUP BY 1 ORDER BY 1
            `, [A, B]),
            db.query(`
                SELECT
                  (SELECT COUNT(*)::int FROM funnel_visits WHERE visited_at >= $1::timestamptz AND visited_at < ($2::timestamptz + INTERVAL '1 day')) AS clicks,
                  (SELECT COUNT(DISTINCT LOWER(customer_email))::int FROM funnel_visits WHERE converted = true AND customer_email IS NOT NULL AND visited_at >= $1::timestamptz AND visited_at < ($2::timestamptz + INTERVAL '1 day')) AS emails,
                  (SELECT COUNT(DISTINCT LOWER(customer_email))::int FROM tracking_events WHERE event_type = 'pwa_app_installed' AND customer_email IS NOT NULL AND created_at >= $1::timestamptz AND created_at < ($2::timestamptz + INTERVAL '1 day')) AS installs,
                  (SELECT COUNT(DISTINCT LOWER(email))::int FROM user_access WHERE status = 'active' AND granted_at >= $1::timestamptz AND granted_at < ($2::timestamptz + INTERVAL '1 day')) AS purchases
            `, [A, B]),
        ]);
        return res.json({
            success: true,
            from, to,
            totals: totals.rows[0],
            by_funnel: byFunnel.rows,
            by_day: byDay.rows,
            by_hour: byHour.rows,
            steps: steps.rows[0],
        });
    } catch (err) {
        logger.error('funnel-analytics falhou:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

module.exports = router;
