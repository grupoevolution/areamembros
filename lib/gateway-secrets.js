/**
 * =============================================================================
 * lib/gateway-secrets.js — Carrega secrets dos webhooks
 * =============================================================================
 *
 * Prioridade:
 *   1. Banco (system_settings) — definido pelo admin via /admin
 *   2. Variável de ambiente (process.env) — fallback
 *
 * Cache: 60 segundos (pra não bater no banco a cada webhook).
 * Pra invalidar manualmente: chame `invalidateCache()`.
 * =============================================================================
 */

const db = require('../db');
const { logger } = require('./logger');

const CACHE_TTL_MS = 60 * 1000; // 1 minuto
let cache = {
    secrets: {},
    activeGateway: null,
    expiresAt: 0,
};

async function loadFromDB() {
    try {
        const { rows } = await db.query(`
            SELECT key, value FROM system_settings
            WHERE key IN (
                'kirvano_webhook_secret',
                'perfectpay_webhook_secret',
                'active_gateway'
            )
        `);
        
        const result = { secrets: {}, activeGateway: null };
        for (const row of rows) {
            // value vem do JSONB - é string ou bool
            if (row.key === 'kirvano_webhook_secret' && typeof row.value === 'string') {
                result.secrets.kirvano = row.value;
            } else if (row.key === 'perfectpay_webhook_secret' && typeof row.value === 'string') {
                result.secrets.perfectpay = row.value;
            } else if (row.key === 'active_gateway' && typeof row.value === 'string') {
                result.activeGateway = row.value;
            }
        }
        return result;
    } catch (err) {
        logger.error('Erro lendo secrets do banco:', err.message);
        return { secrets: {}, activeGateway: null };
    }
}

async function refreshCache() {
    const fresh = await loadFromDB();
    cache = {
        ...fresh,
        expiresAt: Date.now() + CACHE_TTL_MS,
    };
    return cache;
}

async function getCache() {
    if (Date.now() < cache.expiresAt) return cache;
    return await refreshCache();
}

/**
 * Retorna o secret do gateway (banco > env).
 * @param {string} gateway - 'kirvano' ou 'perfectpay'
 * @returns {Promise<string|null>}
 */
async function getSecret(gateway) {
    const c = await getCache();
    if (c.secrets[gateway]) return c.secrets[gateway];
    
    // Fallback pro env
    const envKey = gateway === 'kirvano' ? 'KIRVANO_WEBHOOK_SECRET' : 'PERFECTPAY_WEBHOOK_SECRET';
    const envValue = process.env[envKey];
    return envValue && envValue.trim() ? envValue.trim() : null;
}

/**
 * Retorna o gateway ativo (que aparece nos botões "Comprar" do app).
 * @returns {Promise<string>} 'kirvano' ou 'perfectpay'
 */
async function getActiveGateway() {
    const c = await getCache();
    return c.activeGateway || 'kirvano';
}

/**
 * Invalida o cache. Útil após salvar novo secret pelo admin.
 */
function invalidateCache() {
    cache.expiresAt = 0;
}

module.exports = {
    getSecret,
    getActiveGateway,
    invalidateCache,
};
