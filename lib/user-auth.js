/**
 * =============================================================================
 * lib/user-auth.js — Autenticação do cliente (app do comprador)
 * =============================================================================
 *
 * Fluxo email-only:
 *   1. Cliente digita email → POST /api/user/login { email }
 *   2. Backend valida formato + sugere correção se houver typo
 *   3. Se email OK: gera JWT de 90 dias → salva em cookie httpOnly
 *   4. Cliente fica logado automaticamente nas próximas requisições
 *
 * Não tem senha, não tem email de confirmação, não tem PIN.
 * O controle de quem compra o quê é feito via user_access (webhooks).
 * Se email digitou sem ter comprado nada, ainda entra (vitrine pra vender).
 *
 * JWT do cliente é SEPARADO do JWT de admin:
 *   - Admin usa `JWT_SECRET` puro (claim: adminId + username)
 *   - Cliente usa `JWT_SECRET + ":user"` (claim: email)
 *   - Isso impede que um token seja usado no contexto errado
 *
 * =============================================================================
 */

const jwt = require('jsonwebtoken');
const db = require('../db');
const { logger } = require('./logger');
const { suggestEmail, isValidEmail } = require('./mailcheck');

// Token do cliente dura bem mais que o de admin (UX: não quer que cliente relogue)
const USER_TOKEN_EXPIRES_IN = '90d';

// Nome do cookie onde o token fica armazenado
const USER_COOKIE_NAME = 'member_token';

// Options do cookie (httpOnly pra não vazar pra JS malicioso,
// secure pra só trafegar em HTTPS, sameSite pra evitar CSRF)
const USER_COOKIE_OPTIONS = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 90 * 24 * 60 * 60 * 1000, // 90 dias em milissegundos
    path: '/',
};

// JWT_SECRET é garantido pelo server.js (auto-gera se faltar).
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    logger.warn('JWT_SECRET fraco em user-auth — usando fallback.');
    process.env.JWT_SECRET = process.env.JWT_SECRET || require('crypto').randomBytes(32).toString('hex');
}

// Secret derivado — separa contexto admin de cliente
const USER_JWT_SECRET = process.env.JWT_SECRET + ':user';


/**
 * Tenta fazer login do cliente com email.
 * Se email tem typo comum, retorna sugestão SEM fazer login
 * (pra frontend perguntar "você quis dizer X?").
 *
 * @param {string} email - Email digitado pelo cliente
 * @returns {Object}
 *   Sucesso: { success: true, token, email, productsCount }
 *   Sugestão: { success: false, needsConfirmation: true, suggestion, original }
 *   Erro: { success: false, error }
 */
async function loginClient(email) {
    // Valida tipo
    if (!email || typeof email !== 'string') {
        return { success: false, error: 'Email obrigatório' };
    }
    
    // Normaliza e analisa
    const analysis = suggestEmail(email);
    
    if (!analysis.valid) {
        return { 
            success: false, 
            error: 'Formato de email inválido. Confere se digitou direito.' 
        };
    }
    
    const normalizedEmail = analysis.original;
    
    // Se tem sugestão de correção, retorna SEM logar
    // (frontend vai mostrar "você quis dizer user@gmail.com?")
    if (analysis.suggestion) {
        logger.debug(`Sugestão mailcheck: ${analysis.reason}`);
        return {
            success: false,
            needsConfirmation: true,
            suggestion: analysis.suggestion,
            original: normalizedEmail,
            reason: analysis.reason,
        };
    }
    
    // Email parece OK: cria/atualiza customer e gera token
    try {
        // Upsert do customer (idempotente — cria se não existe, atualiza se existe)
        await db.query(`
            INSERT INTO customers (email, first_seen_at, last_login_at)
            VALUES ($1, NOW(), NOW())
            ON CONFLICT (email) DO UPDATE 
                SET last_login_at = NOW()
        `, [normalizedEmail]);
        
        // Conta quantos produtos esse email tem acesso
        const { rows: [{ count }] } = await db.query(`
            SELECT COUNT(*)::int as count
            FROM user_access 
            WHERE LOWER(email) = $1 AND status = 'active'
        `, [normalizedEmail]);
        
        // Gera token JWT com email como claim
        const token = jwt.sign(
            { 
                email: normalizedEmail,
                type: 'user',
            },
            USER_JWT_SECRET,
            { expiresIn: USER_TOKEN_EXPIRES_IN }
        );
        
        logger.info(`Cliente '${normalizedEmail}' logou (${count} produtos ativos)`);
        
        return {
            success: true,
            token,
            email: normalizedEmail,
            productsCount: count,
        };
    } catch (err) {
        logger.error('Erro no loginClient:', err);
        return { success: false, error: 'Erro interno. Tenta de novo em instantes.' };
    }
}


/**
 * Verifica um token JWT de cliente.
 *
 * @returns {{ valid: boolean, email?: string, error?: string }}
 */
function verifyUserToken(token) {
    try {
        const data = jwt.verify(token, USER_JWT_SECRET);

        // Aceita type='user' (normal) ou type='user_anon' (preview de funíl)
        if (data.type !== 'user' && data.type !== 'user_anon') {
            return { valid: false, error: 'Token de tipo errado' };
        }
        if (!data.email) {
            return { valid: false, error: 'Token sem email' };
        }
        // Normaliza o email do claim — tokens antigos podem ter sido
        // emitidos com maiúsculas/espaços. Garante que a identidade
        // bata com customers.email (sempre lowercase+trim) e com os
        // SELECTs que usam LOWER(...).
        return {
            valid: true,
            email: String(data.email).toLowerCase().trim(),
            anonymous: data.type === 'user_anon',
            funnel: data.funnel || null,
        };
    } catch (err) {
        return { valid: false, error: err.message };
    }
}


/**
 * Middleware que protege rotas do cliente — exige cookie JWT válido.
 * Adiciona req.user = { email } se autenticado.
 */
function requireUser(req, res, next) {
    const token = req.cookies?.[USER_COOKIE_NAME];
    
    if (!token) {
        return res.status(401).json({ 
            success: false, 
            error: 'Não autenticado',
            needsLogin: true,
        });
    }
    
    const result = verifyUserToken(token);
    if (!result.valid) {
        // NÃO apaga o cookie. Falha de verificação pode ser transitória
        // (relógio, secret indisponível no boot, etc.) e destruir um
        // cookie de 90 dias por isso é caro demais. Apenas pede relogin:
        // se o token for de verdade inválido, o relogin sobrescreve o
        // cookie naturalmente. Cookie só é limpo no /logout explícito.
        return res.status(401).json({
            success: false,
            error: 'Sessão expirada',
            needsLogin: true,
        });
    }
    
    req.user = { email: result.email, anonymous: !!result.anonymous, funnel: result.funnel };
    next();
}


/**
 * Middleware que tenta autenticar mas não falha se não estiver logado.
 * Útil pra rotas que mostram conteúdo diferente se logado (ex: home pode
 * mostrar produtos comprados em destaque).
 * Se autenticado, adiciona req.user. Se não, segue sem req.user.
 */
function optionalUser(req, res, next) {
    const token = req.cookies?.[USER_COOKIE_NAME];

    if (token) {
        const result = verifyUserToken(token);
        if (result.valid) {
            req.user = { email: result.email, anonymous: !!result.anonymous, funnel: result.funnel };
        }
        // Token inválido/ilegível: trata como visitante anônimo (req.user
        // fica undefined) e segue. NÃO apaga o cookie — falha transitória
        // não deve destruir a sessão de 90 dias do cliente.
    }

    next();
}


module.exports = {
    loginClient,
    verifyUserToken,
    requireUser,
    optionalUser,
    USER_COOKIE_NAME,
    USER_COOKIE_OPTIONS,
};
