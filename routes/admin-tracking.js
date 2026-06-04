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

module.exports = router;
