/**
 * =============================================================================
 * lib/auth.js — Autenticação de admin
 * =============================================================================
 *
 * Login admin com bcrypt (senha criptografada) + JWT (token de sessão).
 * Rate limiting e lockout após tentativas falhas.
 *
 * =============================================================================
 */

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { logger } = require('./logger');

const BCRYPT_ROUNDS = 12;
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;
const TOKEN_EXPIRES_IN = '8h'; // JWT válido por 8 horas

// JWT_SECRET é garantido pelo server.js (auto-gera se faltar).
// Apenas warn se não for forte o bastante — não derruba o processo.
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    logger.warn('JWT_SECRET fraco ou ausente — usando fallback temporário.');
    process.env.JWT_SECRET = process.env.JWT_SECRET || require('crypto').randomBytes(32).toString('hex');
}


/**
 * Criptografa uma senha com bcrypt.
 */
async function hashPassword(plainPassword) {
    return bcrypt.hash(plainPassword, BCRYPT_ROUNDS);
}


/**
 * Verifica se uma senha bate com o hash armazenado.
 */
async function verifyPassword(plainPassword, hash) {
    return bcrypt.compare(plainPassword, hash);
}


/**
 * Tenta fazer login de um admin.
 *
 * @param {string} username
 * @param {string} password
 * @returns {{ success: boolean, token?: string, error?: string }}
 */
async function loginAdmin(username, password) {
    // Busca admin
    const { rows } = await db.query(
        'SELECT * FROM admins WHERE username = $1',
        [username]
    );
    
    const admin = rows[0];
    
    // Mesmo que não exista, executa bcrypt pra evitar timing attack
    if (!admin) {
        await bcrypt.compare(password, '$2b$12$fakefakefakefakefakefakefakefakefakefakefakefakefakefak');
        return { success: false, error: 'Credenciais inválidas' };
    }
    
    // Verifica se conta tá travada
    if (admin.locked_until && new Date(admin.locked_until) > new Date()) {
        const minutesLeft = Math.ceil((new Date(admin.locked_until) - new Date()) / 60000);
        return { 
            success: false, 
            error: `Conta bloqueada. Tente em ${minutesLeft} minuto(s).`,
            locked: true 
        };
    }
    
    // Verifica senha
    const passwordMatch = await verifyPassword(password, admin.password_hash);
    
    if (!passwordMatch) {
        // Incrementa contador de falhas
        const newFails = admin.failed_logins + 1;
        const shouldLock = newFails >= MAX_FAILED_LOGINS;
        
        await db.query(
            `UPDATE admins 
             SET failed_logins = $1, 
                 locked_until = $2
             WHERE id = $3`,
            [
                shouldLock ? 0 : newFails,
                shouldLock ? new Date(Date.now() + LOCKOUT_MINUTES * 60000) : null,
                admin.id
            ]
        );
        
        if (shouldLock) {
            logger.warn(`Admin '${username}' travado após ${MAX_FAILED_LOGINS} tentativas`);
            return { 
                success: false, 
                error: `Muitas tentativas. Conta bloqueada por ${LOCKOUT_MINUTES} minutos.`,
                locked: true 
            };
        }
        
        return { success: false, error: 'Credenciais inválidas' };
    }
    
    // Login bem-sucedido: gera token
    const token = jwt.sign(
        { 
            adminId: admin.id, 
            username: admin.username,
        },
        process.env.JWT_SECRET,
        { expiresIn: TOKEN_EXPIRES_IN }
    );
    
    // Atualiza último login e reseta contador
    await db.query(
        `UPDATE admins 
         SET failed_logins = 0, 
             locked_until = NULL,
             last_login_at = NOW()
         WHERE id = $1`,
        [admin.id]
    );
    
    logger.info(`Admin '${username}' logou com sucesso`);
    
    return { success: true, token };
}


/**
 * Verifica um token JWT e retorna os dados decodificados.
 *
 * @returns {{ valid: boolean, data?: object, error?: string }}
 */
function verifyToken(token) {
    try {
        const data = jwt.verify(token, process.env.JWT_SECRET);
        return { valid: true, data };
    } catch (err) {
        return { valid: false, error: err.message };
    }
}


/**
 * Middleware que protege rotas — exige token JWT válido de admin.
 * O token pode vir no header Authorization: Bearer TOKEN
 * ou em cookie "admin_token".
 */
function requireAdmin(req, res, next) {
    // Tenta pegar do header
    let token = null;
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
        token = authHeader.substring(7);
    }
    
    // Tenta pegar do cookie
    if (!token && req.cookies?.admin_token) {
        token = req.cookies.admin_token;
    }
    
    if (!token) {
        return res.status(401).json({ 
            success: false, 
            error: 'Não autenticado' 
        });
    }
    
    const result = verifyToken(token);
    if (!result.valid) {
        return res.status(401).json({ 
            success: false, 
            error: 'Token inválido ou expirado' 
        });
    }
    
    req.admin = result.data;
    next();
}


module.exports = {
    hashPassword,
    verifyPassword,
    loginAdmin,
    verifyToken,
    requireAdmin,
};
