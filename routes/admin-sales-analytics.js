/**
 * =============================================================================
 * routes/admin-sales-analytics.js — Painel de lucro + ranking + vendas orfas
 * =============================================================================
 *
 * Fase L2 (mai/2026). 3 endpoints:
 *
 *   GET /api/admin/sales-analytics/kpis?from=Y-M-D&to=Y-M-D
 *     → { sales_count, net_total, comparison: { sales_count, net_total }, period }
 *
 *   GET /api/admin/sales-analytics/ranking?from=...&to=...&limit=20
 *     → { products: [{ product_id, name, offer_name, count, net_total }] }
 *
 *   GET /api/admin/sales-analytics/orphans?days=7
 *     → { orphans: [{ offer_id, offer_name, count, last_seen, total_estimated }] }
 *
 * REGRAS:
 *  - Dashboard usa SO vendas com net_amount NOT NULL (decisao 24/05/2026).
 *    Vendas pre-Fase L1 (sem net) ficam fora — mais honesto que chutar %.
 *  - Periodo aceita ISO date YYYY-MM-DD. Sem timezone: o filtro usa o timestamp
 *    UTC interno (granted_at), entao "hoje" = 00:00 UTC ate 23:59:59 UTC.
 *    Pro fuso BR (-3), o admin pode ver vendas de hoje aparecendo so apos 03:00.
 *    Aceitavel pra MVP — se virar dor, parametriza com "tz" no futuro.
 * =============================================================================
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const { logger } = require('../lib/logger');
const { requireAdmin } = require('../lib/auth');


function parseDate(s) {
    if (!s || typeof s !== 'string') return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
    if (!m) return null;
    return s.trim();
}

// Calcula o "periodo anterior equivalente" pra comparativo.
// Ex: from=2026-05-20 to=2026-05-24 (5 dias) → prev: 2026-05-15 to 2026-05-19
function computePreviousPeriod(from, to) {
    const f = new Date(from + 'T00:00:00Z').getTime();
    const t = new Date(to + 'T23:59:59Z').getTime();
    const span = t - f;
    const prevTo = new Date(f - 1000).toISOString().slice(0, 10);
    const prevFrom = new Date(f - span - 1000).toISOString().slice(0, 10);
    return { prevFrom, prevTo };
}


// ─── KPIs: total vendas + lucro liquido + comparativo ───────────────────────

router.get('/kpis', requireAdmin, async (req, res) => {
    const from = parseDate(req.query.from);
    const to = parseDate(req.query.to);
    if (!from || !to) {
        return res.status(400).json({ success: false, error: 'from/to obrigatorios no formato YYYY-MM-DD' });
    }

    try {
        const { prevFrom, prevTo } = computePreviousPeriod(from, to);

        // L13.2: exclui ofertas marcadas como aquisicao (vendas de trafego pago)
        // — esse painel mostra LTV PURO (compras feitas DENTRO do app).
        // Aquisicao tem seu proprio bloco "Performance dos Frontends".
        // DEDUP por venda: order bump grava o valor CHEIO da venda em CADA item
        // (2 itens = 2 linhas com o mesmo total). Somar por linha DOBRAVA o
        // faturamento — deduplica por (gateway, sale_id) antes de somar, igual
        // ao Ranking de clientes.
        const [curr, prev] = await Promise.all([
            db.query(`
                SELECT
                    COUNT(*)::int AS sales_count,
                    COALESCE(SUM(net_amount), 0)::float AS net_total,
                    COALESCE(SUM(sale_amount), 0)::float AS gross_total
                FROM (
                    SELECT DISTINCT ON (ua.gateway, COALESCE(ua.sale_id, 'ua_' || ua.id))
                           ua.net_amount, ua.sale_amount
                    FROM user_access ua
                    LEFT JOIN product_offers po ON po.id = ua.offer_id
                    WHERE ua.net_amount IS NOT NULL
                      AND ua.status = 'active'
                      AND ua.granted_at >= ($1::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
                      AND ua.granted_at <  ((($2::date + INTERVAL '1 day')::timestamp) AT TIME ZONE 'America/Sao_Paulo')
                      AND NOT COALESCE(po.is_acquisition, false)
                ) s
            `, [from, to]),
            db.query(`
                SELECT
                    COUNT(*)::int AS sales_count,
                    COALESCE(SUM(net_amount), 0)::float AS net_total
                FROM (
                    SELECT DISTINCT ON (ua.gateway, COALESCE(ua.sale_id, 'ua_' || ua.id))
                           ua.net_amount
                    FROM user_access ua
                    LEFT JOIN product_offers po ON po.id = ua.offer_id
                    WHERE ua.net_amount IS NOT NULL
                      AND ua.status = 'active'
                      AND ua.granted_at >= ($1::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
                      AND ua.granted_at <  ((($2::date + INTERVAL '1 day')::timestamp) AT TIME ZONE 'America/Sao_Paulo')
                      AND NOT COALESCE(po.is_acquisition, false)
                ) s
            `, [prevFrom, prevTo]),
        ]);

        return res.json({
            success: true,
            period: { from, to },
            kpis: {
                sales_count: curr.rows[0].sales_count,
                net_total: curr.rows[0].net_total,
                gross_total: curr.rows[0].gross_total,
            },
            comparison: {
                period: { from: prevFrom, to: prevTo },
                sales_count: prev.rows[0].sales_count,
                net_total: prev.rows[0].net_total,
            },
        });
    } catch (err) {
        logger.error('[sales-analytics] /kpis erro:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// ─── Ranking: top produtos no periodo ────────────────────────────────────────

router.get('/ranking', requireAdmin, async (req, res) => {
    const from = parseDate(req.query.from);
    const to = parseDate(req.query.to);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    if (!from || !to) {
        return res.status(400).json({ success: false, error: 'from/to obrigatorios no formato YYYY-MM-DD' });
    }

    try {
        // L13.2: exclui aquisicao (ofertas com is_acquisition=true).
        // Top produtos eh APENAS LTV — Performance dos Frontends mostra aquisicao.
        const { rows } = await db.query(`
            SELECT
                ua.product_id,
                p.name AS product_name,
                po.offer_name,
                po.gateway,
                COUNT(*)::int AS sales_count,
                COALESCE(SUM(ua.net_amount), 0)::float AS net_total,
                COALESCE(SUM(ua.sale_amount), 0)::float AS gross_total
            FROM user_access ua
            LEFT JOIN products p ON p.id = ua.product_id
            LEFT JOIN product_offers po ON po.id = ua.offer_id
            WHERE ua.net_amount IS NOT NULL
              AND ua.status = 'active'
              AND ua.granted_at >= ($1::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
              AND ua.granted_at <  ((($2::date + INTERVAL '1 day')::timestamp) AT TIME ZONE 'America/Sao_Paulo')
              AND NOT COALESCE(po.is_acquisition, false)
            GROUP BY ua.product_id, p.name, po.offer_name, po.gateway
            ORDER BY net_total DESC, sales_count DESC
            LIMIT $3
        `, [from, to, limit]);

        return res.json({
            success: true,
            period: { from, to },
            products: rows,
        });
    } catch (err) {
        logger.error('[sales-analytics] /ranking erro:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// ─── Health Metrics: ativacao 24h, refund/chargeback rate, LTV vitalicio ────
//
// "Saude do negocio" — metricas operacionais pra decisao de escala.
//
//   activation_24h: % de quem comprou nas ultimas 24h e ABRIU o app pelo menos
//     uma vez apos a compra. Sinaliza problema de e-mail/login/UX se baixo.
//     Tambem retorna a janela de 7d pra ter base estatistica em volume baixo.
//
//   refund_rate / chargeback_rate (30d e 90d): % sobre o total de vendas no
//     periodo. >1% = atencao, >2% = zona vermelha (Kirvano comeca a alertar).
//     Inclui status 'replaced' como saida normal (substituicao por recompra
//     de produto-chamada), nao como problema.
//
//   ltv_lifetime: ticket medio acumulado por CLIENTE (nao por venda). Base
//     pra calcular CAC maximo. Filtra clientes que tem >=1 venda real (net
//     not null). LTV global considerando toda a vida do cliente — vendas pre
//     Fase L (sem net_amount) ficam de fora pra nao chutar valor.
//
// Tudo numa rota so pq sao indicadores que se olham juntos (saude pos-venda).

router.get('/health-metrics', requireAdmin, async (req, res) => {
    try {
        const [activation24h, activation7d, refund30, refund90, chargeback30, chargeback90, ltv] = await Promise.all([
            // Ativacao 24h: comprou ha menos de 24h E abriu o app depois da compra
            db.query(`
                WITH recent_sales AS (
                    SELECT ua.id, LOWER(ua.email) AS email_lc, ua.granted_at
                    FROM user_access ua
                    WHERE ua.granted_at >= NOW() - INTERVAL '24 hours'
                      AND ua.status IN ('active','replaced','refunded','chargeback')
                      AND ua.granted_by = 'webhook'
                )
                SELECT
                    COUNT(*)::int AS total,
                    COUNT(*) FILTER (
                        WHERE EXISTS (
                            SELECT 1 FROM customers c
                            WHERE LOWER(c.email) = rs.email_lc
                              AND c.last_seen_at IS NOT NULL
                              AND c.last_seen_at >= rs.granted_at
                        )
                    )::int AS activated
                FROM recent_sales rs
            `),
            // Ativacao 7d (janela maior pra estatistica em volume baixo)
            db.query(`
                WITH recent_sales AS (
                    SELECT ua.id, LOWER(ua.email) AS email_lc, ua.granted_at
                    FROM user_access ua
                    WHERE ua.granted_at >= NOW() - INTERVAL '7 days'
                      AND ua.status IN ('active','replaced','refunded','chargeback')
                      AND ua.granted_by = 'webhook'
                )
                SELECT
                    COUNT(*)::int AS total,
                    COUNT(*) FILTER (
                        WHERE EXISTS (
                            SELECT 1 FROM customers c
                            WHERE LOWER(c.email) = rs.email_lc
                              AND c.last_seen_at IS NOT NULL
                              AND c.last_seen_at >= rs.granted_at
                        )
                    )::int AS activated
                FROM recent_sales rs
            `),
            // Refund 30d
            db.query(`
                SELECT
                    COUNT(*) FILTER (WHERE status = 'refunded')::int AS refunds,
                    COUNT(*)::int AS total
                FROM user_access
                WHERE granted_at >= NOW() - INTERVAL '30 days'
                  AND granted_by = 'webhook'
                  AND status IN ('active','refunded','chargeback','replaced','expired')
            `),
            // Refund 90d
            db.query(`
                SELECT
                    COUNT(*) FILTER (WHERE status = 'refunded')::int AS refunds,
                    COUNT(*)::int AS total
                FROM user_access
                WHERE granted_at >= NOW() - INTERVAL '90 days'
                  AND granted_by = 'webhook'
                  AND status IN ('active','refunded','chargeback','replaced','expired')
            `),
            // Chargeback 30d
            db.query(`
                SELECT
                    COUNT(*) FILTER (WHERE status = 'chargeback')::int AS chargebacks,
                    COUNT(*)::int AS total
                FROM user_access
                WHERE granted_at >= NOW() - INTERVAL '30 days'
                  AND granted_by = 'webhook'
                  AND status IN ('active','refunded','chargeback','replaced','expired')
            `),
            // Chargeback 90d
            db.query(`
                SELECT
                    COUNT(*) FILTER (WHERE status = 'chargeback')::int AS chargebacks,
                    COUNT(*)::int AS total
                FROM user_access
                WHERE granted_at >= NOW() - INTERVAL '90 days'
                  AND granted_by = 'webhook'
                  AND status IN ('active','refunded','chargeback','replaced','expired')
            `),
            // LTV vitalicio: net total / clientes unicos (todos os tempos com net_amount).
            // L13.2: EXCLUI vendas de aquisicao. LTV aqui = quanto cliente extrai
            // DENTRO do app (recompra, upsell, chamadinhas) — a venda inicial de
            // trafego pago tem ROAS proprio no Orion, nao deve poluir LTV.
            db.query(`
                WITH per_customer AS (
                    SELECT LOWER(ua.email) AS email_lc,
                           SUM(ua.net_amount)::float AS net_sum,
                           COUNT(*)::int AS purchases
                    FROM user_access ua
                    LEFT JOIN product_offers po ON po.id = ua.offer_id
                    WHERE ua.net_amount IS NOT NULL
                      AND ua.status IN ('active','replaced')
                      AND ua.granted_by = 'webhook'
                      AND NOT COALESCE(po.is_acquisition, false)
                    GROUP BY LOWER(ua.email)
                )
                SELECT
                    COUNT(*)::int AS customers,
                    COALESCE(AVG(net_sum), 0)::float AS ltv_avg,
                    COALESCE(SUM(net_sum), 0)::float AS net_total,
                    COALESCE(AVG(purchases), 0)::float AS purchases_per_customer
                FROM per_customer
            `),
        ]);

        // helper: % com 2 casas decimais
        const pct = (num, den) => den > 0 ? +(100 * num / den).toFixed(2) : 0;

        const activation24hRow = activation24h.rows[0];
        const activation7dRow = activation7d.rows[0];
        const refund30Row = refund30.rows[0];
        const refund90Row = refund90.rows[0];
        const chargeback30Row = chargeback30.rows[0];
        const chargeback90Row = chargeback90.rows[0];
        const ltvRow = ltv.rows[0];

        return res.json({
            success: true,
            activation: {
                last_24h: {
                    total: activation24hRow.total,
                    activated: activation24hRow.activated,
                    rate_pct: pct(activation24hRow.activated, activation24hRow.total),
                },
                last_7d: {
                    total: activation7dRow.total,
                    activated: activation7dRow.activated,
                    rate_pct: pct(activation7dRow.activated, activation7dRow.total),
                },
            },
            refund: {
                last_30d: {
                    count: refund30Row.refunds,
                    total: refund30Row.total,
                    rate_pct: pct(refund30Row.refunds, refund30Row.total),
                },
                last_90d: {
                    count: refund90Row.refunds,
                    total: refund90Row.total,
                    rate_pct: pct(refund90Row.refunds, refund90Row.total),
                },
            },
            chargeback: {
                last_30d: {
                    count: chargeback30Row.chargebacks,
                    total: chargeback30Row.total,
                    rate_pct: pct(chargeback30Row.chargebacks, chargeback30Row.total),
                },
                last_90d: {
                    count: chargeback90Row.chargebacks,
                    total: chargeback90Row.total,
                    rate_pct: pct(chargeback90Row.chargebacks, chargeback90Row.total),
                },
            },
            ltv: {
                customers: ltvRow.customers,
                ltv_avg: ltvRow.ltv_avg,
                net_total: ltvRow.net_total,
                purchases_per_customer: +ltvRow.purchases_per_customer.toFixed(2),
            },
        });
    } catch (err) {
        logger.error('[sales-analytics] /health-metrics erro:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// ─── Performance dos Frontends (Fase L13.2, mai/2026) ──────────────────────
//
// Card de aquisicao: vendas vindas de trafego pago, separadas do LTV.
// Por que ler de webhook_logs.raw_payload em vez de user_access?
//   1. Cada webhook eh 1 transacao com N items (frontend + bumps). user_access
//      agrega por (email, product_id) — perde a granularidade dos bumps quando
//      eles liberam o MESMO produto que o frontend (UNIQUE index sobrescreve).
//   2. raw_payload guarda o JSON inteiro com cada item individualmente +
//      flag is_order_bump do gateway. Fonte de verdade pra contagem por offer.
//   3. Joga com a flag is_acquisition pra mostrar SO as ofertas marcadas pelo
//      admin como "aquisicao" — bumps de checkout vao aparecer com take rate.
//
// take_rate de um bump = vendas_bump / vendas_frontend total (no periodo).
// Se take_rate = 65% significa que 65% dos clientes pegaram o bump no checkout.

router.get('/acquisition-performance', requireAdmin, async (req, res) => {
    const from = parseDate(req.query.from);
    const to = parseDate(req.query.to);
    if (!from || !to) {
        return res.status(400).json({ success: false, error: 'from/to obrigatorios no formato YYYY-MM-DD' });
    }

    try {
        // Pega TODAS as ofertas marcadas como aquisicao pra fazer match com items.
        const { rows: acqOffers } = await db.query(`
            SELECT po.id, po.gateway, po.offer_id, po.offer_name,
                   po.acquisition_role, po.price,
                   p.name AS product_name
            FROM product_offers po
            LEFT JOIN products p ON p.id = po.product_id
            WHERE po.is_acquisition = true
        `);
        const acqMap = new Map();
        for (const o of acqOffers) {
            acqMap.set(`${o.gateway}::${o.offer_id}`, o);
        }

        if (acqMap.size === 0) {
            return res.json({
                success: true,
                period: { from, to },
                offers: [],
                summary: {
                    total_sales: 0,
                    total_gross: 0,
                    total_net: 0,
                    frontends_count: 0,
                    bumps_count: 0,
                    avg_ticket_with_bumps: 0,
                },
                message: 'Nenhuma oferta marcada como aquisicao. Marque pelo menos 1 oferta no admin.',
            });
        }

        // Le todos os webhooks processados com sucesso (signature_valid) que viraram
        // venda aprovada no periodo. Itera os products[] de cada payload e agrega.
        const { rows: webhooks } = await db.query(`
            SELECT wl.gateway, wl.raw_payload, wl.received_at
            FROM webhook_logs wl
            WHERE wl.signature_valid = true
              AND wl.processed = true
              AND wl.received_at >= ($1::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
              AND wl.received_at <  ((($2::date + INTERVAL '1 day')::timestamp) AT TIME ZONE 'America/Sao_Paulo')
              AND (wl.event_type ILIKE '%APPROVED%' OR wl.event_type ILIKE '%approved%')
        `, [from, to]);

        // Agrega por offer_id
        const agg = new Map(); // gateway::offer_id -> { offer, count, gross, net, as_bump_count }
        let totalSales = 0;
        let frontendSalesCount = 0; // pra calcular take_rate dos bumps

        // Primeiro passo: pre-agrega vendas de frontend pra base do take_rate
        // (depende do total de frontends VENDIDOS, nao do total de webhooks).
        // Segundo passo (no mesmo loop): conta tudo.
        for (const wh of webhooks) {
            const payload = typeof wh.raw_payload === 'string'
                ? JSON.parse(wh.raw_payload) : wh.raw_payload;
            if (!payload) continue;
            const products = Array.isArray(payload.products) ? payload.products : [];
            // No payload Kirvano cada product tem: offer_id, offer_name, price, is_order_bump
            const fiscal = payload.fiscal || {};

            for (const item of products) {
                const offerKey = `${wh.gateway}::${item.offer_id}`;
                const meta = acqMap.get(offerKey);
                if (!meta) continue; // nao eh oferta de aquisicao — ignora

                // Preco do item: usa o do payload se vier (item.price), senao
                // cai pro cadastrado na product_offers (meta.price).
                let itemPrice = 0;
                if (item.price != null && item.price !== '') {
                    // Kirvano manda "R$ 19,90" — limpa
                    const s = String(item.price).replace(/R\$\s*/i,'').replace(/\./g,'').replace(/,/g,'.').trim();
                    itemPrice = parseFloat(s) || 0;
                }
                if (!itemPrice && meta.price) itemPrice = parseFloat(meta.price) || 0;

                if (!agg.has(offerKey)) {
                    agg.set(offerKey, {
                        gateway: wh.gateway,
                        offer_id: item.offer_id,
                        offer_name: item.offer_name || meta.offer_name || '',
                        product_name: meta.product_name || null,
                        acquisition_role: meta.acquisition_role || 'frontend',
                        count: 0,
                        gross_total: 0,
                        net_estimate: 0, // estimativa — Kirvano nao manda net por item
                        as_bump_count: 0,
                    });
                }
                const a = agg.get(offerKey);
                a.count += 1;
                a.gross_total += itemPrice;
                if (item.is_order_bump) a.as_bump_count += 1;
                totalSales += 1;
                if (meta.acquisition_role === 'frontend') frontendSalesCount += 1;
            }

            // Net total da venda (commission) cai TODA pra venda — nao da pra
            // ratear net por item. Atribuimos o net inteiro ao item frontend
            // (acquisition_role='frontend'). Bumps net=0 (estimativa).
            const commission = parseFloat(fiscal.commission) || 0;
            if (commission > 0) {
                // acha o item frontend de aquisicao nesse webhook (1o que casar)
                for (const item of products) {
                    const offerKey = `${wh.gateway}::${item.offer_id}`;
                    const meta = acqMap.get(offerKey);
                    if (meta && meta.acquisition_role === 'frontend') {
                        const a = agg.get(offerKey);
                        if (a) a.net_estimate += commission;
                        break;
                    }
                }
            }
        }

        // Calcula take rate dos bumps em relacao ao total de frontends vendidos
        const offers = Array.from(agg.values()).map(o => ({
            ...o,
            take_rate_pct: (o.acquisition_role === 'bump' && frontendSalesCount > 0)
                ? +(100 * o.count / frontendSalesCount).toFixed(1)
                : null,
        }));

        // Ordena: frontends primeiro (por gross desc), depois bumps (por take_rate desc)
        offers.sort((a, b) => {
            if (a.acquisition_role !== b.acquisition_role) {
                return a.acquisition_role === 'frontend' ? -1 : 1;
            }
            if (a.acquisition_role === 'frontend') return b.gross_total - a.gross_total;
            return (b.take_rate_pct || 0) - (a.take_rate_pct || 0);
        });

        const totalGross = offers.reduce((s, o) => s + o.gross_total, 0);
        const totalNet = offers.reduce((s, o) => s + o.net_estimate, 0);
        const frontendsCount = offers.filter(o => o.acquisition_role === 'frontend').reduce((s, o) => s + o.count, 0);
        const bumpsCount = offers.filter(o => o.acquisition_role === 'bump').reduce((s, o) => s + o.count, 0);
        // Ticket medio com bumps = gross total / vendas de frontend
        const avgTicket = frontendsCount > 0 ? totalGross / frontendsCount : 0;

        return res.json({
            success: true,
            period: { from, to },
            offers,
            summary: {
                total_sales: totalSales,
                total_gross: +totalGross.toFixed(2),
                total_net: +totalNet.toFixed(2),
                frontends_count: frontendsCount,
                bumps_count: bumpsCount,
                avg_ticket_with_bumps: +avgTicket.toFixed(2),
            },
        });
    } catch (err) {
        logger.error('[sales-analytics] /acquisition-performance erro:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// ─── LTV por Cohort de Frontend (Fase L13.4, mai/2026) ──────────────────────
//
// Pergunta de negocio: cliente que comprou frontend X (29,99) gera quanto de
// LTV adicional na area de membros? E quem comprou frontend Y (49,99)?
//
// Estrategia:
//   1. Para cada oferta de aquisicao com role='frontend', pega os clientes
//      que compraram esse frontend (1a compra dessa offer = cohort entrada).
//   2. Para cada cohort, soma o net_amount de TODAS as vendas NAO-aquisicao
//      desses clientes (vendas internas, LTV puro).
//   3. Retorna: cohort size, LTV total interno, LTV medio por cliente.
//
// Isso responde: "qual frontend traz cliente mais valioso pra LTV?". Decisao
// de mídia (Meta Ads) deveria empurrar mais verba pro frontend de maior LTV
// — mesmo se ticket de aquisicao for menor.

router.get('/ltv-by-cohort', requireAdmin, async (req, res) => {
    try {
        const { rows } = await db.query(`
            WITH frontends AS (
                SELECT id, gateway, offer_id, offer_name, price
                FROM product_offers
                WHERE is_acquisition = true AND acquisition_role = 'frontend'
            ),
            -- 1a compra de cada cliente em cada frontend (data de entrada no cohort)
            cohort_entry AS (
                SELECT
                    f.id AS frontend_offer_row_id,
                    f.offer_id AS frontend_offer_id,
                    f.gateway,
                    f.offer_name AS frontend_name,
                    LOWER(ua.email) AS email_lc,
                    MIN(ua.granted_at) AS entered_at
                FROM frontends f
                JOIN user_access ua
                  ON ua.offer_id = f.id
                 AND ua.granted_by = 'webhook'
                GROUP BY f.id, f.offer_id, f.gateway, f.offer_name, LOWER(ua.email)
            ),
            -- LTV interno: soma vendas non-acquisition apos a entrada no cohort
            ltv AS (
                SELECT
                    ce.frontend_offer_row_id,
                    ce.email_lc,
                    COALESCE(SUM(ua.net_amount), 0) AS net_internal,
                    COUNT(ua.id) AS internal_purchases
                FROM cohort_entry ce
                LEFT JOIN user_access ua
                  ON LOWER(ua.email) = ce.email_lc
                 AND ua.granted_at >= ce.entered_at
                 AND ua.net_amount IS NOT NULL
                 AND ua.status IN ('active','replaced')
                 AND ua.granted_by = 'webhook'
                 AND ua.offer_id NOT IN (
                     SELECT id FROM product_offers WHERE is_acquisition = true
                 )
                GROUP BY ce.frontend_offer_row_id, ce.email_lc
            )
            SELECT
                f.gateway,
                f.offer_id AS frontend_offer_id,
                f.offer_name AS frontend_name,
                f.price AS frontend_price,
                COUNT(DISTINCT ce.email_lc)::int AS cohort_size,
                COALESCE(SUM(ltv.net_internal), 0)::float AS ltv_internal_total,
                COALESCE(AVG(ltv.net_internal), 0)::float AS ltv_per_customer_avg,
                COALESCE(AVG(ltv.internal_purchases), 0)::float AS purchases_per_customer_avg,
                COUNT(*) FILTER (WHERE ltv.internal_purchases > 0)::int AS customers_with_recompra
            FROM frontends f
            LEFT JOIN cohort_entry ce ON ce.frontend_offer_row_id = f.id
            LEFT JOIN ltv ON ltv.frontend_offer_row_id = f.id AND ltv.email_lc = ce.email_lc
            GROUP BY f.id, f.gateway, f.offer_id, f.offer_name, f.price
            ORDER BY ltv_per_customer_avg DESC
        `);

        return res.json({
            success: true,
            cohorts: rows.map(r => ({
                ...r,
                ltv_per_customer_avg: +r.ltv_per_customer_avg.toFixed(2),
                ltv_internal_total: +r.ltv_internal_total.toFixed(2),
                purchases_per_customer_avg: +r.purchases_per_customer_avg.toFixed(2),
                // Conversao em recompra: % do cohort que comprou pelo menos 1 LTV
                recompra_pct: r.cohort_size > 0
                    ? +(100 * r.customers_with_recompra / r.cohort_size).toFixed(1)
                    : 0,
            })),
        });
    } catch (err) {
        logger.error('[sales-analytics] /ltv-by-cohort erro:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// ─── Taxa de Recompra por janela (Fase L13.4, mai/2026) ─────────────────────
//
// % de clientes que compraram um frontend de aquisicao e voltaram a comprar
// pelo menos 1 produto NAO-aquisicao dentro de N dias. Quebra global +
// por cohort de frontend.

router.get('/repurchase-rate', requireAdmin, async (req, res) => {
    try {
        // Cliente eh "ativado" no cohort no dia da 1a compra do frontend.
        // Recompra = qualquer venda nao-aquisition de qualquer produto, posterior.
        // 3 janelas: 7d, 30d, 90d a partir da entrada.
        const { rows } = await db.query(`
            WITH frontends AS (
                SELECT id FROM product_offers
                WHERE is_acquisition = true AND acquisition_role = 'frontend'
            ),
            cohort_entry AS (
                SELECT
                    LOWER(ua.email) AS email_lc,
                    MIN(ua.granted_at) AS entered_at
                FROM user_access ua
                WHERE ua.offer_id IN (SELECT id FROM frontends)
                  AND ua.granted_by = 'webhook'
                GROUP BY LOWER(ua.email)
            ),
            recompras AS (
                SELECT
                    ce.email_lc,
                    ce.entered_at,
                    BOOL_OR(
                        ua.granted_at > ce.entered_at
                        AND ua.granted_at <= ce.entered_at + INTERVAL '7 days'
                    ) AS in_7d,
                    BOOL_OR(
                        ua.granted_at > ce.entered_at
                        AND ua.granted_at <= ce.entered_at + INTERVAL '30 days'
                    ) AS in_30d,
                    BOOL_OR(
                        ua.granted_at > ce.entered_at
                        AND ua.granted_at <= ce.entered_at + INTERVAL '90 days'
                    ) AS in_90d
                FROM cohort_entry ce
                LEFT JOIN user_access ua
                  ON LOWER(ua.email) = ce.email_lc
                 AND ua.status IN ('active','replaced')
                 AND ua.granted_by = 'webhook'
                 AND ua.offer_id NOT IN (
                     SELECT id FROM product_offers WHERE is_acquisition = true
                 )
                GROUP BY ce.email_lc, ce.entered_at
            )
            SELECT
                COUNT(*)::int AS cohort_total,
                COUNT(*) FILTER (WHERE in_7d)::int  AS recompra_7d,
                COUNT(*) FILTER (WHERE in_30d)::int AS recompra_30d,
                COUNT(*) FILTER (WHERE in_90d)::int AS recompra_90d,
                COUNT(*) FILTER (WHERE entered_at >= NOW() - INTERVAL '7 days')::int  AS cohort_7d_window,
                COUNT(*) FILTER (WHERE entered_at >= NOW() - INTERVAL '30 days')::int AS cohort_30d_window,
                COUNT(*) FILTER (WHERE entered_at >= NOW() - INTERVAL '90 days')::int AS cohort_90d_window
            FROM recompras
        `);

        const r = rows[0] || {};
        const pct = (num, den) => den > 0 ? +(100 * num / den).toFixed(1) : 0;

        return res.json({
            success: true,
            cohort_total: r.cohort_total || 0,
            windows: {
                in_7d:  { count: r.recompra_7d  || 0, rate_pct: pct(r.recompra_7d,  r.cohort_total) },
                in_30d: { count: r.recompra_30d || 0, rate_pct: pct(r.recompra_30d, r.cohort_total) },
                in_90d: { count: r.recompra_90d || 0, rate_pct: pct(r.recompra_90d, r.cohort_total) },
            },
        });
    } catch (err) {
        logger.error('[sales-analytics] /repurchase-rate erro:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// ─── Funil de Instalacao PWA (reformulado jul/2026) ─────────────────────────
//
// O funil antigo misturava métricas incomparáveis (instalações contadas por
// evento do navegador vs popups do período vs aberturas históricas) e cuspia
// taxas >100%. Agora, TUDO no MESMO período (fuso Brasília) e separado em:
//   FUNIL DO POPUP (confiável): mostrado → clicou → aceitou no Chrome
//   INSTALAÇÕES: eventos 'appinstalled' do navegador no período (inclui via
//     menu nativo; reinstalação conta de novo — por isso é "instalações", não
//     "pessoas")
//   QUEM REALMENTE TEM O APP (o número pra confiar):
//     - pessoas ÚNICAS que ABRIRAM em modo instalado no período (uso real)
//     - inscritos de push AGORA (aparelho morto é deletado no 1º envio falho)
router.get('/pwa-funnel', requireAdmin, async (req, res) => {
    try {
        const isDate = (x) => /^\d{4}-\d{2}-\d{2}$/.test(String(x || ''));
        const TZ = 'America/Sao_Paulo';
        const today = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
        const to = isDate(req.query.to) ? req.query.to : today;
        const from = isDate(req.query.from) ? req.query.from
            : new Date(Date.parse(to + 'T12:00:00Z') - 6 * 86400000).toISOString().slice(0, 10);
        const win = (a, b) => `created_at >= ($${a}::date::timestamp AT TIME ZONE '${TZ}')
                   AND created_at < ((($${b}::date + INTERVAL '1 day')::timestamp) AT TIME ZONE '${TZ}')`;
        const W = win(2, 3), W2 = win(1, 2);

        const [{ rows: [f] }, { rows: [reach] }] = await Promise.all([
            db.query(`
                SELECT
                  COUNT(*) FILTER (WHERE event_type = 'pwa_prompt_shown')::int      AS shown,
                  COUNT(*) FILTER (WHERE event_type = 'pwa_install_clicked')::int   AS clicked,
                  COUNT(*) FILTER (WHERE event_type = 'pwa_install_accepted')::int  AS accepted,
                  COUNT(*) FILTER (WHERE event_type = 'pwa_install_dismissed')::int AS dismissed,
                  COUNT(*) FILTER (WHERE event_type = 'pwa_app_installed')::int     AS installed_events
                FROM tracking_events
                WHERE event_type = ANY($1) AND ${W}`,
                [['pwa_prompt_shown', 'pwa_install_clicked', 'pwa_install_accepted', 'pwa_install_dismissed', 'pwa_app_installed'], from, to]),
            db.query(`
                SELECT
                  (SELECT COUNT(DISTINCT COALESCE(LOWER(customer_email), metadata->>'vid'))::int
                     FROM tracking_events
                     WHERE (event_type = 'pwa_opened_standalone'
                            OR (event_type = 'session_start' AND metadata->>'standalone' = 'true'))
                       AND COALESCE(customer_email, metadata->>'vid') IS NOT NULL
                       AND ${W2}) AS standalone_users,
                  -- só UM evento por abertura: cada sessão instalada dispara
                  -- pwa_opened_standalone E session_start(standalone) — somar
                  -- os dois contava cada abertura em DOBRO
                  (SELECT COUNT(*)::int
                     FROM tracking_events
                     WHERE event_type = 'pwa_opened_standalone'
                       AND ${W2}) AS standalone_opens_raw,
                  (SELECT COUNT(*)::int FROM push_subscriptions) AS push_total,
                  (SELECT COUNT(DISTINCT LOWER(customer_email))::int FROM push_subscriptions
                     WHERE customer_email IS NOT NULL) AS push_people`,
                [from, to]),
        ]);

        const pct = (n, d) => d > 0 ? +(100 * n / d).toFixed(1) : 0;
        return res.json({
            success: true,
            from, to,
            funnel: {
                shown: f.shown, clicked: f.clicked, accepted: f.accepted,
                dismissed: f.dismissed, installed_events: f.installed_events,
            },
            rates: {
                click_rate: pct(f.clicked, f.shown),
                accept_rate: pct(f.accepted, f.clicked),
            },
            reach: {
                standalone_users: reach.standalone_users,
                standalone_opens: reach.standalone_opens_raw,
                push_total: reach.push_total,
                push_people: reach.push_people,
            },
        });
    } catch (err) {
        logger.error('[sales-analytics] /pwa-funnel erro:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// ─── Vendas Orfas: webhooks que chegaram com offer_id nao cadastrado ────────
//
// Le webhook_logs (que guarda payload raw de TUDO que chega) e extrai os
// items que o sales-processor logou como "Produto nao configurado". A query
// usa o processing_error que sales-processor.js:91 grava nesse formato:
//   "Produto nao configurado: kirvano/XYZ (NOME)"
// Agrupa por offer_id pra mostrar quantas vendas estao caindo na mesma oferta
// nao mapeada (= quanto o admin ta deixando de medir).

router.get('/orphans', requireAdmin, async (req, res) => {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));

    try {
        // 1) Pega webhooks processados COM erro de "Produto nao configurado"
        //    nos ultimos N dias. processing_error armazena array de erros JSON
        //    OU string com a primeira ocorrencia (depende do log).
        const { rows: orphanRows } = await db.query(`
            SELECT
                wl.id,
                wl.gateway,
                wl.received_at,
                wl.processing_error,
                wl.raw_payload,
                wl.customer_email
            FROM webhook_logs wl
            WHERE wl.received_at >= NOW() - ($1 || ' days')::interval
              AND wl.signature_valid = true
              AND wl.processing_error ILIKE '%Produto n%o configurado%'
            ORDER BY wl.received_at DESC
            LIMIT 500
        `, [String(days)]);

        // 2) Agrega por offer_id (parseado do processing_error).
        //    Formato: "Produto nao configurado: <gateway>/<offer_id> (<nome>)"
        //    Robusto a unicode (com ou sem acento, com ou sem parenteses).
        const buckets = new Map();
        const reGateway = /([a-z_]+)\/([a-zA-Z0-9\-_]+)/;
        for (const row of orphanRows) {
            const err = String(row.processing_error || '');
            const m = reGateway.exec(err);
            if (!m) continue;
            const gateway = m[1];
            const offerId = m[2];
            const key = `${gateway}::${offerId}`;
            if (!buckets.has(key)) {
                // Tenta extrair o nome do bicho (entre parenteses) e o total
                const nameMatch = /\(([^)]+)\)/.exec(err);
                const offerName = nameMatch ? nameMatch[1].trim() : null;
                // Total estimado: soma fiscal.commission ou total_price do payload
                buckets.set(key, {
                    gateway,
                    offer_id: offerId,
                    offer_name: offerName,
                    count: 0,
                    last_seen: row.received_at,
                    total_estimated_net: 0,
                    sample_email: row.customer_email || null,
                });
            }
            const b = buckets.get(key);
            b.count += 1;
            if (new Date(row.received_at) > new Date(b.last_seen)) {
                b.last_seen = row.received_at;
            }
            // Estimativa de lucro: extrai fiscal.commission do raw payload
            try {
                const raw = typeof row.raw_payload === 'string'
                    ? JSON.parse(row.raw_payload) : row.raw_payload;
                const c = parseFloat(raw?.fiscal?.commission);
                if (!isNaN(c)) b.total_estimated_net += c;
            } catch(_) {}
        }

        const orphans = Array.from(buckets.values())
            .sort((a, b) => b.count - a.count);

        return res.json({
            success: true,
            days,
            orphans,
            total_orphan_events: orphanRows.length,
            total_estimated_net_lost: orphans.reduce((s, o) => s + o.total_estimated_net, 0),
        });
    } catch (err) {
        logger.error('[sales-analytics] /orphans erro:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// ─── Ranking de CLIENTES: quem mais compra (bloco da tela "Todas as vendas") ─
// GET /customer-ranking?period=today|yesterday|7|30|total&search=email
// Agrupa user_access por e-mail (só vendas de webhook). Uma VENDA = par
// (gateway, sale_id) DISTINTO — a mesma venda pode gravar VÁRIAS linhas (uma
// por produto/item) repetindo o sale_amount, então deduplicamos antes de somar.
// Janela por granted_at (fuso Brasília): RENOVAÇÃO/recompra do mesmo produto
// ATUALIZA a linha existente (created_at nunca muda, granted_at sim) — com a
// janela em created_at o cara que renovou hoje era invisível na aba "hoje".
// A venda antiga não conta de novo: a linha renovada aparece 1x, com o sale_id
// e o valor da venda NOVA. Na aba "total", o nº de compras usa também o
// contador real da tabela customers (que soma cada venda aprovada — inclusive
// renovações que a linha única de user_access não consegue contar).
router.get('/customer-ranking', requireAdmin, async (req, res) => {
    const TZ = 'America/Sao_Paulo';
    const period = String(req.query.period || '7');
    const search = String(req.query.search || '').trim().toLowerCase().slice(0, 120);
    let where;
    if (period === 'today') {
        where = `ua.granted_at >= (((NOW() AT TIME ZONE '${TZ}')::date)::timestamp AT TIME ZONE '${TZ}')`;
    } else if (period === 'yesterday') {
        where = `ua.granted_at >= ((((NOW() AT TIME ZONE '${TZ}')::date - 1))::timestamp AT TIME ZONE '${TZ}')
                 AND ua.granted_at < (((NOW() AT TIME ZONE '${TZ}')::date)::timestamp AT TIME ZONE '${TZ}')`;
    } else if (period === 'total') {
        where = `TRUE`;
    } else {
        const days = Math.max(1, Math.min(365, parseInt(period, 10) || 7));
        where = `ua.granted_at > NOW() - INTERVAL '${days} days'`;
    }
    try {
        const params = [];
        let searchSql = '';
        if (search) {
            params.push('%' + search + '%');
            searchSql = ` AND ua.email ILIKE $${params.length}`;
        }
        // Reembolso/chargeback fica de fora (não é "compra" pra ranking); os
        // demais status contam — 'replaced'/'expired' foram compras reais.
        const baseWhere = `ua.granted_by = 'webhook'
              AND ua.status NOT IN ('refunded', 'chargeback')
              AND ${where}${searchSql}`;
        // 1 linha por venda distinta (sale_id NULL vira venda própria via id).
        // No 'total', o nº de compras usa o MAIOR entre as linhas deduplicadas
        // e customers.total_purchases (renovações da mesma linha).
        const purchasesExpr = period === 'total'
            ? `GREATEST(COUNT(*), COALESCE(MAX(c.total_purchases), 0))::int`
            : `COUNT(*)::int`;
        const customersJoin = period === 'total'
            ? `LEFT JOIN customers c ON LOWER(c.email) = v.email`
            : ``;
        const grouped = `
            WITH vendas AS (
                SELECT DISTINCT ON (LOWER(ua.email), ua.gateway, COALESCE(ua.sale_id, 'ua_' || ua.id))
                       LOWER(ua.email) AS email,
                       ua.sale_amount, ua.net_amount, ua.created_at, ua.granted_at
                FROM user_access ua
                WHERE ${baseWhere}
                ORDER BY LOWER(ua.email), ua.gateway, COALESCE(ua.sale_id, 'ua_' || ua.id), ua.created_at ASC
            )
            SELECT v.email,
                   ${purchasesExpr} AS purchases,
                   COALESCE(SUM(v.sale_amount), 0)::float AS total_gross,
                   COALESCE(SUM(v.net_amount), 0)::float AS total_net,
                   MIN(v.created_at) AS first_at,
                   MAX(v.granted_at) AS last_at
            FROM vendas v
            ${customersJoin}
            GROUP BY v.email`;
        const [rank, summary] = await Promise.all([
            db.query(`${grouped} ORDER BY purchases DESC, total_gross DESC LIMIT 100`, params),
            db.query(`SELECT COUNT(*)::int AS buyers,
                             COUNT(*) FILTER (WHERE t.purchases >= 2)::int AS repeat_buyers
                      FROM (${grouped}) t`, params),
        ]);
        const emails = rank.rows.map(r => r.email);
        const firstProduct = {};
        const productCount = {};
        if (emails.length) {
            const p2 = params.concat([emails]);
            const arrIdx = p2.length;
            // 1ª compra: nome do produto da linha mais antiga do e-mail no período
            const { rows: fp } = await db.query(`
                SELECT DISTINCT ON (LOWER(ua.email)) LOWER(ua.email) AS email, p.name AS product_name
                FROM user_access ua
                LEFT JOIN products p ON p.id = ua.product_id
                WHERE ${baseWhere} AND LOWER(ua.email) = ANY($${arrIdx})
                ORDER BY LOWER(ua.email), ua.created_at ASC, ua.id ASC`, p2);
            fp.forEach(r => { firstProduct[r.email] = r.product_name; });
            const { rows: pc } = await db.query(`
                SELECT LOWER(ua.email) AS email, COUNT(DISTINCT ua.product_id)::int AS n
                FROM user_access ua
                WHERE ${baseWhere} AND LOWER(ua.email) = ANY($${arrIdx})
                GROUP BY LOWER(ua.email)`, p2);
            pc.forEach(r => { productCount[r.email] = r.n; });
        }
        const customers = rank.rows.map(r => ({
            email: r.email,
            purchases: r.purchases,
            total_gross: r.total_gross,
            total_net: r.total_net,
            products: productCount[r.email] || 0,
            first_at: r.first_at,
            first_product: firstProduct[r.email] || null,
            last_at: r.last_at,
        }));
        return res.json({
            success: true,
            period,
            customers,
            summary: {
                buyers: summary.rows[0].buyers,
                repeat_buyers: summary.rows[0].repeat_buyers,
            },
        });
    } catch (err) {
        logger.error('[sales-analytics] /customer-ranking erro:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


module.exports = router;
