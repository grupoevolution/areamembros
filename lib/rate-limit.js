/**
 * =============================================================================
 * lib/rate-limit.js — Rate limiting (proteção contra brute force e spam)
 * =============================================================================
 */

const rateLimit = require('express-rate-limit');
const { logger } = require('./logger');
const { getIp } = require('./device-check');


/**
 * Rate limit pra login admin: 10 tentativas por 15 minutos por IP.
 */
const adminLoginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { success: false, error: 'Muitas tentativas de login. Tente novamente em 15 minutos.' },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => getIp(req),
    handler: (req, res) => {
        logger.warn(`Rate limit atingido em login admin (IP: ${getIp(req)})`);
        res.status(429).json({ 
            success: false, 
            error: 'Muitas tentativas de login. Tente novamente em 15 minutos.' 
        });
    }
});


/**
 * Rate limit pra login de cliente: 20 tentativas por 15 minutos por IP.
 */
const clientLoginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { success: false, error: 'Muitas tentativas. Tente novamente mais tarde.' },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => getIp(req),
});


/**
 * Rate limit geral pra APIs: 300 requests por minuto por IP.
 * Generoso pra não atrapalhar uso normal.
 */
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => getIp(req),
});


/**
 * Rate limit pra webhooks: 100 por minuto por IP.
 * Gateways não deveriam passar disso nunca.
 */
const webhookLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => getIp(req),
});


module.exports = {
    adminLoginLimiter,
    clientLoginLimiter,
    apiLimiter,
    webhookLimiter,
};
