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
                    (SELECT COUNT(*)::int FROM webhook_logs WHERE received_at > NOW() - INTERVAL '24 hours' AND processed = true) as sales_24h,
                    (SELECT COUNT(*)::int FROM webhook_logs WHERE received_at > NOW() - INTERVAL '7 days' AND processed = true) as sales_7d,
                    (SELECT COUNT(*)::int FROM webhook_logs WHERE received_at > NOW() - INTERVAL '30 days' AND processed = true) as sales_30d
            `),
            // Vendas por dia (últimos 30 dias) — pra gráfico
            db.query(`
                SELECT
                    DATE(received_at) as day,
                    COUNT(*)::int as count
                FROM webhook_logs
                WHERE received_at > NOW() - INTERVAL '30 days' AND processed = true
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
