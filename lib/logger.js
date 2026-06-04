/**
 * =============================================================================
 * lib/logger.js — Logger estruturado
 * =============================================================================
 *
 * Logger simples e eficiente, com níveis e timestamp.
 * Mascara automaticamente emails em mensagens (proteção LGPD).
 *
 * Uso:
 *   const { logger } = require('./lib/logger');
 *   logger.info('Servidor iniciado');
 *   logger.warn('Tentativa de login suspeita');
 *   logger.error('Erro ao processar', err);
 *
 * =============================================================================
 */

const LEVELS = {
    debug: 0,
    info:  1,
    warn:  2,
    error: 3,
};

// Nível mínimo a ser logado (configurável via env)
const MIN_LEVEL = LEVELS[process.env.LOG_LEVEL || 'info'] ?? LEVELS.info;

const isProduction = process.env.NODE_ENV === 'production';

// Cores ANSI (só em dev)
const COLORS = {
    debug: '\x1b[36m',  // ciano
    info:  '\x1b[32m',  // verde
    warn:  '\x1b[33m',  // amarelo
    error: '\x1b[31m',  // vermelho
    reset: '\x1b[0m',
    gray:  '\x1b[90m',
};


/**
 * Mascara emails em strings.
 * Ex: "cliente@gmail.com" → "c******@gmail.com"
 */
function maskEmail(text) {
    if (typeof text !== 'string') return text;
    return text.replace(/([a-zA-Z0-9._-])[a-zA-Z0-9._-]*(@[a-zA-Z0-9.-]+)/g, '$1***$2');
}


/**
 * Formata argumentos de log (com máscara de email em prod).
 */
function formatArgs(args) {
    return args.map(arg => {
        if (arg instanceof Error) {
            return arg.stack || arg.message;
        }
        if (typeof arg === 'object') {
            try {
                const str = JSON.stringify(arg);
                return isProduction ? maskEmail(str) : str;
            } catch {
                return String(arg);
            }
        }
        return isProduction ? maskEmail(String(arg)) : String(arg);
    }).join(' ');
}


/**
 * Loga uma mensagem em um nível específico.
 */
function log(level, ...args) {
    if (LEVELS[level] < MIN_LEVEL) return;
    
    const timestamp = new Date().toISOString();
    const message = formatArgs(args);
    
    if (isProduction) {
        // Em produção: JSON estruturado (fácil de parsear em serviços de log)
        console.log(JSON.stringify({
            timestamp,
            level,
            message,
        }));
    } else {
        // Em dev: formato colorido e legível
        const color = COLORS[level] || '';
        const levelStr = level.toUpperCase().padEnd(5);
        console.log(`${COLORS.gray}${timestamp}${COLORS.reset} ${color}${levelStr}${COLORS.reset} ${message}`);
    }
}


const logger = {
    debug: (...args) => log('debug', ...args),
    info:  (...args) => log('info',  ...args),
    warn:  (...args) => log('warn',  ...args),
    error: (...args) => log('error', ...args),
};


module.exports = { logger, maskEmail };
