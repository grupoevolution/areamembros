/**
 * =============================================================================
 * routes/admin-dashboard.js — Dashboard novo (Visão Geral) — ago/2026
 * =============================================================================
 *
 * UM endpoint que alimenta a tela inteira, com os números CERTOS:
 *   - "venda" = SEMPRE user_access deduplicado por (gateway, sale_id)
 *     (nunca webhook_logs — retry do gateway inflava);
 *   - "visitante" = PESSOA única no dia (DISTINCT email/vid do session_start),
 *     não carregamento de página (o antigo COUNT(*) dava 20 mil num dia);
 *   - períodos: today | yesterday | 7 | month (fuso Brasília).
 *
 * GET /api/admin/dashboard-v2?period=7
 * =============================================================================
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const { logger } = require('../lib/logger');
const { requireAdmin } = require('../lib/auth');

const TZ = 'America/Sao_Paulo';
const DAY = `(created_at AT TIME ZONE '${TZ}')::date`;
const TODAY = `(NOW() AT TIME ZONE '${TZ}')::date`;

// Janela [from, to) em SQL pro período pedido
function windowSql(period, col = 'created_at') {
    const start = `((NOW() AT TIME ZONE '${TZ}')::date::timestamp AT TIME ZONE '${TZ}')`;
    if (period === 'today') return `${col} >= ${start}`;
    if (period === 'yesterday') {
        return `${col} >= (((NOW() AT TIME ZONE '${TZ}')::date - 1)::timestamp AT TIME ZONE '${TZ}')
            AND ${col} < ${start}`;
    }
    if (period === 'month') {
        return `${col} >= (date_trunc('month', NOW() AT TIME ZONE '${TZ}')::timestamp AT TIME ZONE '${TZ}')`;
    }
    // default: últimos 7 dias (contando hoje)
    return `${col} >= (((NOW() AT TIME ZONE '${TZ}')::date - 6)::timestamp AT TIME ZONE '${TZ}')`;
}

// identidade única de um session_start (email > vid)
const IDENT = `COALESCE(LOWER(customer_email), metadata->>'vid', metadata->>'visitor_id')`;

// Classificação da venda → fatia da pizza. PELO PRODUTO (pedido do dono):
// o carimbo (utm) só desempata — venda antiga/renovação sem carimbo também
// cai na categoria certa. Ordem importa (upgrade antes do plano de chat).
// $EXPLORE_PID = produto de Vídeos/Lives (config do Explorar), injetado.
const PIE_CASE = `CASE
    WHEN LOWER(COALESCE(po.offer_name, '')) = 'upgrade premium'
         OR ua.utm_content = 'upgrade_offer' THEN 'upgrade'
    WHEN COALESCE(p.is_chat_plan, false) = true
         AND (COALESCE(po.is_premium, false) = true OR ua.metadata->>'premium' = 'true') THEN 'chat_premium'
    WHEN COALESCE(p.is_chat_plan, false) = true THEN 'chat_vip'
    WHEN p.product_type = 'video_call' OR p.video_call_id IS NOT NULL
         OR NULLIF(TRIM(COALESCE(p.direct_call_video_url, '')), '') IS NOT NULL THEN 'chamadas'
    WHEN COALESCE(p.is_group_pass, false) = true
         OR ua.product_id IN (SELECT product_id FROM groups WHERE product_id IS NOT NULL)
         OR ua.utm_content LIKE 'group%' THEN 'grupos'
    WHEN ($EXPLORE_PID > 0 AND ua.product_id = $EXPLORE_PID)
         OR ua.utm_content = 'explore_premium' THEN 'videos_lives'
    WHEN ua.product_id IS NOT NULL THEN 'catalogo'
    ELSE 'outros'
END`;

// vendas deduplicadas (1 linha por venda real) dentro da janela
function dedupSales(period) {
    return `SELECT DISTINCT ON (gateway, COALESCE(sale_id, 'ua_' || id))
                LOWER(email) AS email, product_id, sale_amount, net_amount, utm_content, granted_at
            FROM user_access
            WHERE granted_by = 'webhook' AND status NOT IN ('refunded', 'chargeback')
              AND ${windowSql(period, 'granted_at')}`;
}

router.get('/dashboard-v2', requireAdmin, async (req, res) => {
    const period = ['today', 'yesterday', '7', 'month'].includes(String(req.query.period))
        ? String(req.query.period) : '7';
    try {
        const q = (sql, params) => db.query(sql, params).catch(err => {
            logger.warn('[dash-v2] query falhou: ' + err.message);
            return { rows: [] };
        });

        const [
            hoje, ontemParcial, vendasHoje, vendasOntemParcial,
            carrinhos, online,
            serie, pie, money, topProdutos, orfas,
            installs, engaj, sumidos, recompra, multiProduto,
            porHora, topVendedoras,
        ] = await Promise.all([
            // visitantes únicos HOJE e ONTEM até a mesma hora
            q(`SELECT COUNT(DISTINCT ${IDENT})::int AS n FROM tracking_events
               WHERE event_type = 'session_start' AND ${windowSql('today')}`),
            q(`SELECT COUNT(DISTINCT ${IDENT})::int AS n FROM tracking_events
               WHERE event_type = 'session_start'
                 AND created_at >= (((NOW() AT TIME ZONE '${TZ}')::date - 1)::timestamp AT TIME ZONE '${TZ}')
                 AND created_at < NOW() - INTERVAL '24 hours'`),
            q(`SELECT COUNT(*)::int AS n, COALESCE(SUM(sale_amount), 0)::float AS gross
               FROM (${dedupSales('today')}) s`),
            q(`SELECT COUNT(*)::int AS n, COALESCE(SUM(sale_amount), 0)::float AS gross
               FROM (SELECT DISTINCT ON (gateway, COALESCE(sale_id, 'ua_' || id)) sale_amount
                     FROM user_access
                     WHERE granted_by = 'webhook' AND status NOT IN ('refunded', 'chargeback')
                       AND granted_at >= (((NOW() AT TIME ZONE '${TZ}')::date - 1)::timestamp AT TIME ZONE '${TZ}')
                       AND granted_at < NOW() - INTERVAL '24 hours') s`),
            // carrinhos HOJE: cobrados pelo suporte + recuperados (pagou depois)
            q(`SELECT COUNT(*) FILTER (WHERE abandon_sent_at IS NOT NULL)::int AS abandonados,
                      COUNT(*) FILTER (WHERE abandon_sent_at IS NOT NULL AND completed = true)::int AS recuperados
               FROM checkout_intents WHERE ${windowSql('today')}`),
            q(`SELECT COUNT(*)::int AS n FROM customers WHERE last_seen_at > NOW() - INTERVAL '5 minutes'`),

            // série diária do período: visitantes / conversaram / e-mails / compras
            q(`WITH dias AS (
                    SELECT d::date AS day FROM generate_series(
                        CASE WHEN '${period}' = 'today' THEN ${TODAY}
                             WHEN '${period}' = 'yesterday' THEN ${TODAY} - 1
                             WHEN '${period}' = 'month' THEN date_trunc('month', NOW() AT TIME ZONE '${TZ}')::date
                             ELSE ${TODAY} - 6 END,
                        CASE WHEN '${period}' = 'yesterday' THEN ${TODAY} - 1 ELSE ${TODAY} END,
                        '1 day') d
               ),
               v AS (SELECT ${DAY} AS day, COUNT(DISTINCT ${IDENT})::int AS n
                     FROM tracking_events WHERE event_type = 'session_start' AND ${windowSql(period)} GROUP BY 1),
               c AS (SELECT (m.created_at AT TIME ZONE '${TZ}')::date AS day,
                            COUNT(DISTINCT COALESCE(LOWER(s.customer_email), s.visitor_id))::int AS n
                     FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id
                     WHERE m.sender = 'user' AND ${windowSql(period, 'm.created_at')} GROUP BY 1),
               e AS (SELECT ${DAY} AS day, COUNT(*)::int AS n FROM customers WHERE ${windowSql(period)} GROUP BY 1),
               p AS (SELECT (granted_at AT TIME ZONE '${TZ}')::date AS day, COUNT(*)::int AS n,
                            COALESCE(SUM(sale_amount), 0)::float AS gross
                     FROM (${dedupSales(period)}) s GROUP BY 1)
               SELECT to_char(dias.day, 'YYYY-MM-DD') AS day,
                      COALESCE(v.n, 0) AS visitors, COALESCE(c.n, 0) AS chatted,
                      COALESCE(e.n, 0) AS emails, COALESCE(p.n, 0) AS purchases,
                      COALESCE(p.gross, 0) AS revenue
               FROM dias LEFT JOIN v ON v.day = dias.day LEFT JOIN c ON c.day = dias.day
               LEFT JOIN e ON e.day = dias.day LEFT JOIN p ON p.day = dias.day
               ORDER BY dias.day`),

            // pizza por área (classificada pelo PRODUTO, com joins)
            q(`WITH vendas AS (
                   SELECT DISTINCT ON (ua.gateway, COALESCE(ua.sale_id, 'ua_' || ua.id))
                          ua.sale_amount,
                          ${PIE_CASE.replace(/\$EXPLORE_PID/g, '$1')} AS area
                   FROM user_access ua
                   LEFT JOIN product_offers po ON po.id = ua.offer_id
                   LEFT JOIN products p ON p.id = ua.product_id
                   WHERE ua.granted_by = 'webhook' AND ua.status NOT IN ('refunded', 'chargeback')
                     AND ${windowSql(period, 'ua.granted_at')}
               )
               SELECT area, COUNT(*)::int AS n, COALESCE(SUM(sale_amount), 0)::float AS gross
               FROM vendas GROUP BY 1 ORDER BY n DESC`,
               [await (async () => {
                   try {
                       const { rows } = await db.query(`SELECT value->>'product_id' AS pid FROM gamification_config WHERE key = 'explore_config'`);
                       return parseInt((rows[0] || {}).pid, 10) || 0;
                   } catch (_) { return 0; }
               })()]),

            // dinheiro
            q(`SELECT COUNT(*)::int AS vendas,
                      COALESCE(SUM(sale_amount), 0)::float AS gross,
                      COALESCE(SUM(net_amount), 0)::float AS net,
                      CASE WHEN COUNT(*) > 0 THEN (COALESCE(SUM(sale_amount), 0) / COUNT(*))::float ELSE 0 END AS ticket
               FROM (${dedupSales(period)}) s`),
            q(`SELECT p.name, COUNT(*)::int AS vendas, COALESCE(SUM(s.net_amount), 0)::float AS net
               FROM (${dedupSales(period)}) s LEFT JOIN products p ON p.id = s.product_id
               GROUP BY p.name ORDER BY vendas DESC LIMIT 6`),
            q(`SELECT COUNT(DISTINCT (gateway, COALESCE(sale_id, id::text)))::int AS n
               FROM webhook_logs
               WHERE processed = false AND processing_error LIKE '%cadastre%'
                 AND created_at > NOW() - INTERVAL '30 days'`),

            // instalação (números REAIS): pessoa que abriu pelo ícone + cliques
            q(`SELECT
                 (SELECT COUNT(DISTINCT ${IDENT})::int FROM tracking_events
                   WHERE ${windowSql(period)}
                     AND (event_type = 'pwa_opened_standalone'
                          OR (event_type = 'session_start' AND metadata->>'standalone' = 'true'))) AS installed,
                 (SELECT COUNT(*)::int FROM tracking_events
                   WHERE event_type = 'pwa_install_clicked' AND ${windowSql(period)}) AS clicks`),

            // engajamento: tempo médio (min/pessoa/dia) e retornantes (2+ dias no período)
            q(`SELECT COALESCE(AVG(minutes), 0)::float AS avg_min,
                      COUNT(DISTINCT identity)::int AS people
               FROM usage_minutes WHERE ${windowSql(period, `(day_key::timestamp AT TIME ZONE '${TZ}')`)}`),
            q(`SELECT COUNT(*)::int AS n FROM customers
               WHERE total_purchases > 0 AND last_seen_at IS NOT NULL
                 AND last_seen_at < NOW() - INTERVAL '7 days'`),

            // recompra: compradores do período que JÁ tinham comprado antes
            q(`WITH compradores AS (SELECT DISTINCT email FROM (${dedupSales(period)}) s)
               SELECT COUNT(*)::int AS buyers,
                      COUNT(*) FILTER (WHERE c.total_purchases >= 2)::int AS repeat,
                      COALESCE((SELECT SUM(s2.sale_amount) FROM (${dedupSales(period)}) s2
                                JOIN customers c2 ON LOWER(c2.email) = s2.email
                                WHERE c2.total_purchases >= 2), 0)::float AS repeat_gross
               FROM compradores b LEFT JOIN customers c ON LOWER(c.email) = b.email`),
            q(`SELECT COUNT(*)::int AS n FROM (
                   SELECT LOWER(email) FROM user_access
                   WHERE granted_by = 'webhook' AND status NOT IN ('refunded', 'chargeback')
                   GROUP BY LOWER(email) HAVING COUNT(DISTINCT product_id) >= 2) t`),

            // vendas por hora (SEMPRE últimos 7 dias — calibra push/lives)
            q(`SELECT EXTRACT(HOUR FROM granted_at AT TIME ZONE '${TZ}')::int AS h, COUNT(*)::int AS n
               FROM (${dedupSales('7')}) s GROUP BY 1 ORDER BY 1`),

            // top vendedoras: carimbo chat_X / group_X → nome real
            q(`WITH src AS (
                   SELECT utm_content, COUNT(*)::int AS n, COALESCE(SUM(sale_amount), 0)::float AS gross
                   FROM (${dedupSales(period)}) s
                   WHERE utm_content ~ '^(chat|group)_[0-9]+$' OR utm_content = 'group_pass'
                   GROUP BY 1)
               SELECT src.utm_content, src.n, src.gross,
                      CASE WHEN src.utm_content = 'group_pass' THEN 'Passe — Todos os Grupos'
                           WHEN src.utm_content LIKE 'chat_%' THEN COALESCE(ch.name, src.utm_content)
                           ELSE COALESCE(gr.name, src.utm_content) END AS label,
                      CASE WHEN src.utm_content LIKE 'chat_%' THEN 'chat' ELSE 'grupo' END AS kind
               FROM src
               LEFT JOIN chats ch ON src.utm_content = 'chat_' || ch.id
               LEFT JOIN groups gr ON src.utm_content = 'group_' || gr.id
               ORDER BY src.n DESC LIMIT 6`),
        ]);

        const r0 = (r) => r.rows[0] || {};
        return res.json({
            success: true,
            period,
            today: {
                visitors: r0(hoje).n || 0,
                visitors_prev: r0(ontemParcial).n || 0,
                sales: r0(vendasHoje).n || 0,
                sales_prev: r0(vendasOntemParcial).n || 0,
                revenue: r0(vendasHoje).gross || 0,
                revenue_prev: r0(vendasOntemParcial).gross || 0,
                carts: r0(carrinhos).abandonados || 0,
                carts_recovered: r0(carrinhos).recuperados || 0,
                online_now: r0(online).n || 0,
            },
            funnel_days: serie.rows,
            pie: pie.rows,
            money: { ...r0(money), top: topProdutos.rows, orphans: r0(orfas).n || 0 },
            installs: r0(installs),
            engagement: {
                avg_minutes: Math.round((r0(engaj).avg_min || 0) * 10) / 10,
                people: r0(engaj).people || 0,
                gone_buyers: r0(sumidos).n || 0,
            },
            repurchase: {
                buyers: r0(recompra).buyers || 0,
                repeat: r0(recompra).repeat || 0,
                repeat_gross: r0(recompra).repeat_gross || 0,
                multi_product: r0(multiProduto).n || 0,
            },
            sales_by_hour: porHora.rows,
            top_sellers: topVendedoras.rows,
        });
    } catch (err) {
        logger.error('[dash-v2] erro:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

module.exports = router;
