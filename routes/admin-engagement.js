/**
 * =============================================================================
 * routes/admin-engagement.js — Painel de engajamento de leads
 * =============================================================================
 *
 * Fase L5 (mai/2026). Endpoints:
 *
 *   GET /api/admin/engagement/kpis
 *     → online_now, active_today, active_7d, total_customers
 *
 *   GET /api/admin/engagement/top-engaged?limit=10
 *     → Clientes cadastrados ha >=3 dias com maior session_count (fans)
 *
 *   GET /api/admin/engagement/going-silent?days=7&limit=10
 *     → Clientes que JA COMPRARAM mas nao abrem o app ha >= N dias
 *       (oportunidade de remarketing whatsapp/email)
 *
 * Premissa: customers.last_seen_at eh populado pelo POST /api/user/heartbeat
 * (frontend bate a cada 60s enquanto app visivel).
 * =============================================================================
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const { logger } = require('../lib/logger');
const { requireAdmin } = require('../lib/auth');


// ─── KPIs gerais ────────────────────────────────────────────────────────────
// Aceita ?from=YYYY-MM-DD&to=YYYY-MM-DD pra o card "Acessos no periodo".
// Os outros KPIs (online_now, active_7d, active_30d) ficam SEMPRE em janela
// movel — sao indicadores de "agora", nao de periodo selecionado.

function parseDateMaybe(s) {
    if (!s || typeof s !== 'string') return null;
    return /^(\d{4})-(\d{2})-(\d{2})$/.test(s.trim()) ? s.trim() : null;
}

router.get('/kpis', requireAdmin, async (req, res) => {
    const from = parseDateMaybe(req.query.from);
    const to   = parseDateMaybe(req.query.to);
    try {
        // KPI variavel: "acessos no periodo" — usa from/to se fornecidos,
        // senao cai pra "hoje" (CURRENT_DATE -> agora).
        let periodSql, periodParams;
        if (from && to) {
            periodSql = `
                SELECT COUNT(*)::int AS active_period
                FROM customers
                WHERE last_seen_at >= ($1::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
                  AND last_seen_at <  ((($2::date + INTERVAL '1 day')::timestamp) AT TIME ZONE 'America/Sao_Paulo')`;
            periodParams = [from, to];
        } else {
            periodSql = `
                SELECT COUNT(*)::int AS active_period
                FROM customers
                WHERE last_seen_at >= (((NOW() AT TIME ZONE 'America/Sao_Paulo')::date)::timestamp AT TIME ZONE 'America/Sao_Paulo')`;
            periodParams = [];
        }

        const [staticRes, periodRes] = await Promise.all([
            db.query(`
                SELECT
                    (SELECT COUNT(*)::int FROM customers
                      WHERE last_seen_at > NOW() - INTERVAL '5 minutes') AS online_now,
                    (SELECT COUNT(*)::int FROM customers
                      WHERE last_seen_at >= (((NOW() AT TIME ZONE 'America/Sao_Paulo')::date)::timestamp AT TIME ZONE 'America/Sao_Paulo'))                  AS active_today,
                    (SELECT COUNT(*)::int FROM customers
                      WHERE last_seen_at >= NOW() - INTERVAL '7 days')     AS active_7d,
                    (SELECT COUNT(*)::int FROM customers
                      WHERE last_seen_at >= NOW() - INTERVAL '30 days')    AS active_30d,
                    (SELECT COUNT(*)::int FROM customers)                  AS total_customers,
                    (SELECT COUNT(*)::int FROM customers
                      WHERE last_seen_at IS NOT NULL)                      AS ever_seen
            `),
            db.query(periodSql, periodParams),
        ]);

        return res.json({
            success: true,
            kpis: { ...staticRes.rows[0], active_period: periodRes.rows[0].active_period },
            period: from && to ? { from, to } : null,
        });
    } catch (err) {
        logger.error('[engagement] /kpis erro:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// ─── Top engajados (fans) ───────────────────────────────────────────────────
// Quem abre o app COM FREQUENCIA. Cadastrado ha >= 1 dia E session_count >= 2
// E last_seen recente (ultimos 7 dias — nao traz fan dormente). Filtros
// afrouxados em 26/05/2026 pq com 3d+3sess o app novo nao tinha base
// suficiente — quase ninguem aparecia. Com 1d+2sess ja da pra agir.

router.get('/top-engaged', requireAdmin, async (req, res) => {
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
    try {
        const { rows } = await db.query(`
            SELECT
                c.email,
                c.name,
                c.session_count,
                c.last_seen_at,
                c.first_seen_at,
                c.total_purchases,
                c.total_spent,
                EXTRACT(EPOCH FROM (NOW() - c.first_seen_at))::int / 86400 AS days_since_signup
            FROM customers c
            WHERE c.first_seen_at < NOW() - INTERVAL '1 day'
              AND c.last_seen_at >= NOW() - INTERVAL '7 days'
              AND c.session_count >= 2
            ORDER BY c.session_count DESC, c.last_seen_at DESC
            LIMIT $1
        `, [limit]);
        return res.json({ success: true, customers: rows });
    } catch (err) {
        logger.error('[engagement] /top-engaged erro:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// ─── Going silent (oportunidade de remarketing) ─────────────────────────────
// Clientes que JA COMPRARAM (tem user_access ativo) mas nao abrem o app ha
// >= N dias. Sao alvos quentes pra mensagem de "saudades, olha o que tem novo".
// Filtra last_seen IS NULL OU last_seen < NOW() - N days.

router.get('/going-silent', requireAdmin, async (req, res) => {
    const days = Math.min(60, Math.max(1, parseInt(req.query.days, 10) || 7));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    try {
        const { rows } = await db.query(`
            SELECT
                c.email,
                c.name,
                c.phone,
                c.last_seen_at,
                c.total_purchases,
                c.total_spent,
                COUNT(ua.id)::int AS active_products,
                EXTRACT(EPOCH FROM (NOW() - COALESCE(c.last_seen_at, c.first_seen_at)))::int / 86400 AS days_silent
            FROM customers c
            INNER JOIN user_access ua
                ON LOWER(ua.email) = LOWER(c.email) AND ua.status = 'active'
            WHERE (c.last_seen_at IS NULL OR c.last_seen_at < NOW() - ($1 || ' days')::interval)
            GROUP BY c.email, c.name, c.phone, c.last_seen_at, c.total_purchases, c.total_spent, c.first_seen_at
            HAVING COUNT(ua.id) > 0
            ORDER BY c.last_seen_at ASC NULLS LAST, c.total_spent DESC
            LIMIT $2
        `, [String(days), limit]);
        return res.json({ success: true, days_threshold: days, customers: rows });
    } catch (err) {
        logger.error('[engagement] /going-silent erro:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


module.exports = router;
