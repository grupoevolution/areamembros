/**
 * =============================================================================
 * lib/preview.js — Helper de "e-mail premium" (preview mode)
 * =============================================================================
 *
 * Lista de e-mails que entram no app como se tivessem comprado TODOS os
 * produtos publicados. Pra admin testar a experiencia do cliente sem
 * precisar gerar venda real.
 *
 * Cache em memoria com TTL de 30s pra nao bater no banco a cada request.
 * Em servidor multi-instancia o TTL pequeno garante que toda instancia
 * pegue o estado novo em ate 30s — eventual consistency aceitavel pra
 * uma feature de teste interno.
 *
 * Quando o admin CRUD adiciona/remove email, chama invalidatePreviewCache()
 * pra zerar o cache imediatamente NA INSTANCIA QUE PROCESSOU. As outras
 * instancias pegam pelo TTL — bom o suficiente.
 * =============================================================================
 */

const db = require('../db');
const { logger } = require('./logger');

const TTL_MS = 30_000;
let cache = new Set();   // emails normalizados (lowercase + trim)
let cacheExpiresAt = 0;
let inflight = null;     // promise compartilhada quando varias requests batem juntas

async function refresh() {
    try {
        const { rows } = await db.query(`SELECT LOWER(email) AS email FROM preview_emails`);
        cache = new Set(rows.map(r => r.email));
        cacheExpiresAt = Date.now() + TTL_MS;
    } catch (err) {
        // Tabela ainda nao migrou? Trata como "ninguem e premium" e tenta de novo
        // no proximo request. Nao quebra o /library nem o /calls/start.
        logger.warn('[preview] falha lendo preview_emails (migration pendente?):', err.message);
        cache = new Set();
        cacheExpiresAt = Date.now() + 5_000; // retry em 5s
    } finally {
        inflight = null;
    }
}

async function isPreviewEmail(email) {
    if (!email) return false;
    const normalized = String(email).toLowerCase().trim();
    if (!normalized) return false;

    const now = Date.now();
    if (now > cacheExpiresAt) {
        // Coalesce: se 10 requests batem ao mesmo tempo, so 1 query no banco.
        if (!inflight) inflight = refresh();
        await inflight;
    }
    return cache.has(normalized);
}

function invalidatePreviewCache() {
    cache = new Set();
    cacheExpiresAt = 0;
    inflight = null;
}

module.exports = { isPreviewEmail, invalidatePreviewCache };
