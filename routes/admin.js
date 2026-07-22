/**
 * =============================================================================
 * routes/admin.js — Rotas do painel administrativo
 * =============================================================================
 *
 * Fase 0: apenas login funciona.
 * Fase 4: CRUD de produtos, gestão de acessos, estatísticas, etc.
 *
 * =============================================================================
 */

const express = require('express');
const router = express.Router();

const db = require('../db');
const { loginAdmin, requireAdmin } = require('../lib/auth');
const { adminLoginLimiter } = require('../lib/rate-limit');
const { logger } = require('../lib/logger');
const { getIp } = require('../lib/device-check');


/**
 * POST /api/admin/login
 * Autentica admin e retorna token JWT.
 */
router.post('/login', adminLoginLimiter, async (req, res) => {
    const { username, password } = req.body || {};
    
    if (!username || !password) {
        return res.status(400).json({ 
            success: false, 
            error: 'Usuário e senha obrigatórios' 
        });
    }
    
    try {
        const result = await loginAdmin(username, password);
        
        if (!result.success) {
            return res.status(401).json(result);
        }
        
        // Salva IP do login
        await db.query(
            'UPDATE admins SET last_login_ip = $1 WHERE username = $2',
            [getIp(req), username]
        );
        
        // Define token em cookie httpOnly (mais seguro que localStorage)
        res.cookie('admin_token', result.token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 8 * 60 * 60 * 1000, // 8h
        });
        
        return res.json({
            success: true,
            token: result.token,
            message: 'Login realizado com sucesso',
        });
    } catch (err) {
        logger.error('Erro no login admin:', err);
        return res.status(500).json({ 
            success: false, 
            error: 'Erro interno' 
        });
    }
});


/**
 * POST /api/admin/logout
 * Limpa cookie de autenticação.
 */
router.post('/logout', (req, res) => {
    res.clearCookie('admin_token');
    return res.json({ success: true });
});


/**
 * GET /api/admin/me
 * Retorna dados do admin autenticado.
 */
router.get('/me', requireAdmin, async (req, res) => {
    try {
        const { rows } = await db.query(
            'SELECT id, username, last_login_at, created_at FROM admins WHERE id = $1',
            [req.admin.adminId]
        );
        
        if (!rows[0]) {
            return res.status(404).json({ success: false, error: 'Admin não encontrado' });
        }
        
        return res.json({ success: true, admin: rows[0] });
    } catch (err) {
        logger.error('Erro em /me:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


/**
 * GET /api/admin/dashboard
 * Retorna estatísticas gerais (placeholder na Fase 0, expandido na Fase 4).
 */
router.get('/dashboard', requireAdmin, async (req, res) => {
    try {
        // Busca em paralelo
        const [
            countsResult,
            salesByDayResult,
            recentWebhooksResult,
            settingsResult,
        ] = await Promise.all([
            // Counts gerais
            db.query(`
                SELECT
                    (SELECT COUNT(*)::int FROM products WHERE is_active = true) as products,
                    (SELECT COUNT(*)::int FROM customers) as customers,
                    (SELECT COUNT(*)::int FROM user_access WHERE status = 'active') as active_access,
                    (SELECT COUNT(*)::int FROM webhook_logs WHERE received_at > NOW() - INTERVAL '24 hours') as webhooks_24h,
                    -- "Vendas" = só evento de venda APROVADA (Kirvano manda 'SALE_APPROVED',
                    -- PerfectPay manda 'approved'). Antes contava QUALQUER webhook processado:
                    -- reembolso, chargeback e Pix pendente inflavam o número.
                    (SELECT COUNT(*)::int FROM webhook_logs WHERE received_at > NOW() - INTERVAL '24 hours' AND processed = true AND UPPER(COALESCE(event_type,'')) LIKE '%APPROVED%') as sales_24h,
                    (SELECT COUNT(*)::int FROM webhook_logs WHERE received_at > NOW() - INTERVAL '7 days' AND processed = true AND UPPER(COALESCE(event_type,'')) LIKE '%APPROVED%') as sales_7d,
                    (SELECT COUNT(*)::int FROM webhook_logs WHERE received_at > NOW() - INTERVAL '30 days' AND processed = true AND UPPER(COALESCE(event_type,'')) LIKE '%APPROVED%') as sales_30d
            `),
            // Vendas por dia (últimos 30 dias) — pra gráfico
            db.query(`
                SELECT
                    DATE(received_at) as day,
                    COUNT(*)::int as count
                FROM webhook_logs
                WHERE received_at > NOW() - INTERVAL '30 days' AND processed = true
                  AND UPPER(COALESCE(event_type,'')) LIKE '%APPROVED%'
                GROUP BY day
                ORDER BY day ASC
            `),
            // Últimos 5 webhooks (atividade recente)
            db.query(`
                SELECT
                    id, gateway, event_type, customer_email, sale_id,
                    processed, processing_error, received_at
                FROM webhook_logs
                ORDER BY received_at DESC
                LIMIT 5
            `),
            // Configurações
            db.query(`
                SELECT key, value FROM system_settings
                WHERE key IN ('active_gateway', 'kirvano_webhook_secret_set', 'perfectpay_webhook_secret_set')
            `),
        ]);
        
        const counts = countsResult.rows[0];
        const settings = {};
        for (const row of settingsResult.rows) {
            // value é JSONB - já vem decodificado pelo pg
            settings[row.key] = row.value;
        }
        
        return res.json({
            success: true,
            stats: {
                products: counts.products,
                customers: counts.customers,
                active_access: counts.active_access,
                webhooks_24h: counts.webhooks_24h,
                sales_24h: counts.sales_24h,
                sales_7d: counts.sales_7d,
                sales_30d: counts.sales_30d,
                active_gateway: settings.active_gateway || 'kirvano',
                kirvano_secret_set: settings.kirvano_webhook_secret_set === true,
                perfectpay_secret_set: settings.perfectpay_webhook_secret_set === true,
            },
            sales_by_day: salesByDayResult.rows,
            recent_activity: recentWebhooksResult.rows,
        });
    } catch (err) {
        logger.error('Erro no dashboard:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


/**
 * GET /api/admin/results?days=N — funil diário simples (fuso Brasília):
 * acessos (session_start) → e-mails novos (customers) → instalou o app
 * (session_start com standalone, marcado pelo app) → vendas/faturamento
 * (user_access por venda única) + produtos mais vendidos do período.
 */
router.get('/results', requireAdmin, async (req, res) => {
    try {
        const days = Math.max(1, Math.min(90, parseInt(req.query.days, 10) || 7));
        const TZ = 'America/Sao_Paulo';
        const since = `NOW() - INTERVAL '${days + 1} days'`; // 1 dia de folga pro fuso

        const [acc, emails, installs, sales, topProds] = await Promise.all([
            // acessos = aberturas do app (1 session_start por abertura)
            db.query(`
                SELECT (created_at AT TIME ZONE '${TZ}')::date AS day, COUNT(*)::int AS n
                FROM tracking_events
                WHERE event_type = 'session_start' AND created_at > ${since}
                GROUP BY 1`),
            // e-mails capturados = clientes NOVOS no dia
            db.query(`
                SELECT (created_at AT TIME ZONE '${TZ}')::date AS day, COUNT(*)::int AS n
                FROM customers WHERE created_at > ${since}
                GROUP BY 1`),
            // instalou o app = pessoas DISTINTAS abrindo em modo instalado (PWA)
            db.query(`
                SELECT (created_at AT TIME ZONE '${TZ}')::date AS day,
                       COUNT(DISTINCT COALESCE(LOWER(customer_email), metadata->>'vid'))::int AS n
                FROM tracking_events
                WHERE event_type = 'session_start' AND metadata->>'standalone' = 'true'
                  AND created_at > ${since}
                GROUP BY 1`),
            // vendas por VENDA única (order bump não conta 2x) + faturamento
            db.query(`
                SELECT (t.granted_at AT TIME ZONE '${TZ}')::date AS day,
                       COUNT(*)::int AS n,
                       COALESCE(SUM(t.sale_amount), 0)::float AS revenue
                FROM (
                    SELECT DISTINCT ON (gateway, sale_id) gateway, sale_id, granted_at, sale_amount
                    FROM user_access
                    WHERE granted_by = 'webhook' AND sale_id IS NOT NULL AND granted_at > ${since}
                    ORDER BY gateway, sale_id, granted_at
                ) t
                GROUP BY 1`),
            // produtos mais vendidos do período (por item vendido)
            db.query(`
                SELECT p.name, COUNT(*)::int AS n, COALESCE(SUM(ua.net_amount), 0)::float AS net
                FROM user_access ua
                JOIN products p ON p.id = ua.product_id
                WHERE ua.granted_by = 'webhook' AND ua.granted_at > NOW() - INTERVAL '${days} days'
                GROUP BY p.name ORDER BY n DESC, net DESC LIMIT 8`),
        ]);

        // monta a série contínua de dias (Brasília), do mais antigo pro hoje
        const map = {};
        const put = (rows, key, field = 'n') => rows.forEach(r => {
            const d = r.day.toISOString().slice(0, 10);
            (map[d] = map[d] || {})[key] = r[field];
        });
        put(acc.rows, 'accesses'); put(emails.rows, 'emails'); put(installs.rows, 'installs');
        put(sales.rows, 'sales'); put(sales.rows, 'revenue', 'revenue');

        const { rows: [{ today }] } = await db.query(`SELECT (NOW() AT TIME ZONE '${TZ}')::date::text AS today`);
        const series = [];
        const t = new Date(today + 'T12:00:00Z');
        for (let i = days - 1; i >= 0; i--) {
            const d = new Date(t.getTime() - i * 86400000).toISOString().slice(0, 10);
            const row = map[d] || {};
            series.push({
                day: d,
                accesses: row.accesses || 0,
                emails: row.emails || 0,
                installs: row.installs || 0,
                sales: row.sales || 0,
                revenue: row.revenue || 0,
            });
        }
        const totals = series.reduce((a, r) => ({
            accesses: a.accesses + r.accesses, emails: a.emails + r.emails,
            installs: a.installs + r.installs, sales: a.sales + r.sales,
            revenue: a.revenue + r.revenue,
        }), { accesses: 0, emails: 0, installs: 0, sales: 0, revenue: 0 });

        return res.json({ success: true, days, series, totals, top_products: topProds.rows, today: series[series.length - 1] || null });
    } catch (err) {
        logger.error('Erro em /results:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// ============================================================================
// SETTINGS — Gateway config + webhook secrets
// ============================================================================

// Pega config do gateway/secrets (só info, não retorna secrets em texto)
router.get('/settings/gateways', requireAdmin, async (req, res) => {
    try {
        const { rows } = await db.query(`
            SELECT key, value, updated_at FROM system_settings
            WHERE key IN ('active_gateway', 'kirvano_webhook_secret_set', 'perfectpay_webhook_secret_set')
        `);
        
        const settings = {};
        for (const row of rows) {
            settings[row.key] = {
                value: row.value,
                updated_at: row.updated_at,
            };
        }
        
        return res.json({
            success: true,
            active_gateway: settings.active_gateway?.value || 'kirvano',
            kirvano_secret_set: settings.kirvano_webhook_secret_set?.value === true,
            kirvano_updated_at: settings.kirvano_webhook_secret_set?.updated_at,
            perfectpay_secret_set: settings.perfectpay_webhook_secret_set?.value === true,
            perfectpay_updated_at: settings.perfectpay_webhook_secret_set?.updated_at,
        });
    } catch (err) {
        logger.error('Erro lendo settings:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// Salva secret de gateway
router.post('/settings/gateways/secret', requireAdmin, async (req, res) => {
    try {
        const { gateway, secret } = req.body || {};
        
        if (gateway !== 'kirvano' && gateway !== 'perfectpay') {
            return res.status(400).json({ success: false, error: 'Gateway inválido' });
        }
        
        if (!secret || typeof secret !== 'string' || secret.trim().length < 8) {
            return res.status(400).json({ success: false, error: 'Secret muito curto (mín 8 caracteres)' });
        }
        
        const trimmedSecret = secret.trim();
        const secretKey = `${gateway}_webhook_secret`;
        const flagKey = `${gateway}_webhook_secret_set`;
        
        // Salva o secret real
        await db.query(`
            INSERT INTO system_settings (key, value, description, updated_by, updated_at)
            VALUES ($1, $2::jsonb, $3, $4, NOW())
            ON CONFLICT (key) DO UPDATE SET
                value = EXCLUDED.value,
                updated_by = EXCLUDED.updated_by,
                updated_at = NOW()
        `, [
            secretKey,
            JSON.stringify(trimmedSecret),
            `Secret do webhook ${gateway}`,
            req.admin?.username || 'admin',
        ]);
        
        // Salva flag indicando que está configurado (sem expor o valor)
        await db.query(`
            INSERT INTO system_settings (key, value, description, updated_by, updated_at)
            VALUES ($1, 'true'::jsonb, $2, $3, NOW())
            ON CONFLICT (key) DO UPDATE SET
                value = 'true'::jsonb,
                updated_by = EXCLUDED.updated_by,
                updated_at = NOW()
        `, [
            flagKey,
            `Flag indicando que ${gateway} secret está configurado`,
            req.admin?.username || 'admin',
        ]);
        
        // Invalida cache do helper de gateway-secrets pra próximo webhook
        try {
            const { invalidateCache } = require('../lib/gateway-secrets');
            invalidateCache();
        } catch (e) { /* ignora */ }
        
        return res.json({ success: true, message: `Secret do ${gateway} salvo com sucesso` });
    } catch (err) {
        logger.error('Erro salvando gateway secret:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// Define gateway ativo (qual aparece no botão "Comprar" do app)
router.post('/settings/gateways/active', requireAdmin, async (req, res) => {
    try {
        const { gateway } = req.body || {};
        if (gateway !== 'kirvano' && gateway !== 'perfectpay') {
            return res.status(400).json({ success: false, error: 'Gateway inválido' });
        }
        
        await db.query(`
            INSERT INTO system_settings (key, value, description, updated_by, updated_at)
            VALUES ('active_gateway', $1::jsonb, $2, $3, NOW())
            ON CONFLICT (key) DO UPDATE SET
                value = EXCLUDED.value,
                updated_by = EXCLUDED.updated_by,
                updated_at = NOW()
        `, [
            JSON.stringify(gateway),
            'Gateway ativo para os botões de compra',
            req.admin?.username || 'admin',
        ]);
        
        // Invalida cache
        try {
            const { invalidateCache } = require('../lib/gateway-secrets');
            invalidateCache();
        } catch (e) { /* ignora */ }
        
        return res.json({ success: true, active_gateway: gateway });
    } catch (err) {
        logger.error('Erro setando gateway ativo:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


module.exports = router;
