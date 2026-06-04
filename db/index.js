/**
 * =============================================================================
 * db/index.js — Conexão com PostgreSQL
 * =============================================================================
 *
 * Módulo central de acesso ao banco.
 * Todas as queries do sistema passam por aqui.
 *
 * Uso:
 *   const db = require('./db');
 *   const result = await db.query('SELECT * FROM products WHERE id = $1', [id]);
 *
 * =============================================================================
 */

const { Pool } = require('pg');
const { logger } = require('../lib/logger');

if (!process.env.DATABASE_URL) {
    logger.error('DATABASE_URL não configurada! Configure nas variáveis de ambiente.');
    process.exit(1);
}

// Pool de conexões — reutiliza conexões entre requisições
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 20,                        // máximo de conexões simultâneas
    idleTimeoutMillis: 30000,       // fecha conexão ociosa após 30s
    connectionTimeoutMillis: 5000,  // timeout pra criar nova conexão
    // Em produção no EasyPanel, SSL não é necessário (rede interna)
    // Se você for apontar pra outro Postgres externo, descomente a linha abaixo:
    // ssl: { rejectUnauthorized: false }
});

// Log de erros no pool
pool.on('error', (err) => {
    logger.error('Erro no pool do Postgres:', err);
});

// Testar conexão logo ao iniciar
pool.connect()
    .then(client => {
        logger.info('Conectado ao PostgreSQL');
        client.release();
    })
    .catch(err => {
        logger.error('Falha ao conectar no PostgreSQL:', err.message);
    });


/**
 * Executa uma query simples.
 *
 * @param {string} text    SQL com placeholders $1, $2, ...
 * @param {Array}  params  Valores dos placeholders
 * @returns {Promise<QueryResult>}
 */
async function query(text, params = []) {
    const start = Date.now();
    try {
        const result = await pool.query(text, params);
        const duration = Date.now() - start;
        
        // Log de queries lentas (> 500ms)
        if (duration > 500) {
            logger.warn(`Query lenta (${duration}ms): ${text.substring(0, 100)}`);
        }
        
        return result;
    } catch (err) {
        logger.error(`Erro na query: ${err.message}`);
        logger.error(`SQL: ${text.substring(0, 200)}`);
        throw err;
    }
}


/**
 * Executa múltiplas queries em uma transação.
 * Se qualquer uma falhar, faz rollback de todas.
 *
 * @param {Function} callback  Função que recebe o client e executa queries
 * @returns {Promise<any>}
 *
 * Exemplo:
 *   await db.transaction(async (client) => {
 *     await client.query('INSERT INTO ...');
 *     await client.query('UPDATE ...');
 *   });
 */
async function transaction(callback) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}


/**
 * Fecha o pool de conexões (usado no shutdown graceful).
 */
async function close() {
    await pool.end();
    logger.info('Pool do Postgres fechado');
}


module.exports = {
    query,
    transaction,
    close,
    pool, // exportado pra casos específicos
};
