/**
 * =============================================================================
 * lib/device-check.js — Detecção de dispositivo (mobile vs desktop)
 * =============================================================================
 *
 * Bloqueia acesso via desktop mostrando uma página de erro falsa.
 * Usuário com a chave secreta (DESKTOP_ACCESS_KEY) pode acessar de qualquer
 * dispositivo.
 *
 * Estratégia em camadas:
 *   1. Servidor detecta User-Agent → rejeita desktop
 *   2. Cookie "devbypass" libera acesso por 30 dias (pra você)
 *   3. Query string "?devkey=XXX" cria esse cookie
 *
 * Na Fase 5, adicionamos detecção client-side também (touch, screen size).
 *
 * =============================================================================
 */

const { logger } = require('./logger');

const MOBILE_USER_AGENT_REGEX = /Android|iPhone|iPad|iPod|Opera Mini|IEMobile|Mobile|webOS|BlackBerry|Windows Phone/i;

const DESKTOP_BYPASS_COOKIE = 'devbypass';
const DESKTOP_BYPASS_DURATION_DAYS = 30;


/**
 * Verifica se o User-Agent é de um dispositivo mobile.
 */
function isMobileUserAgent(userAgent) {
    if (!userAgent) return false;
    return MOBILE_USER_AGENT_REGEX.test(userAgent);
}


/**
 * Middleware que verifica se a requisição vem de mobile ou tem bypass.
 * Se for desktop sem bypass, redireciona pra página de erro falsa.
 *
 * EM DESENVOLVIMENTO: desktop é liberado automaticamente (NODE_ENV=development).
 * EM PRODUÇÃO: apenas mobile ou com devkey correta.
 */
function deviceCheckMiddleware(req, res, next) {
    const isDev = process.env.NODE_ENV !== 'production';
    const forceBlock = process.env.FORCE_DESKTOP_BLOCK === 'true';

    // Em desenvolvimento libera tudo, A NÃO SER QUE FORCE_DESKTOP_BLOCK esteja ativo.
    // Use FORCE_DESKTOP_BLOCK=true pra testar o bloqueio em dev local.
    if (isDev && !forceBlock) {
        return next();
    }
    
    // Rotas que sempre funcionam (assets, API, webhooks, health)
    const exemptPaths = [
        '/health',
        '/api/',
        '/webhook/',
        '/assets/',
        '/manifest.json',
        '/sw.js',
        '/favicon',
        '/robots.txt',
    ];
    
    if (exemptPaths.some(path => req.path.startsWith(path))) {
        return next();
    }
    
    // Processa devkey na URL (cria cookie de bypass)
    const devkey = req.query.devkey;
    if (devkey && devkey === process.env.DESKTOP_ACCESS_KEY) {
        const maxAge = DESKTOP_BYPASS_DURATION_DAYS * 24 * 60 * 60 * 1000;
        res.cookie(DESKTOP_BYPASS_COOKIE, devkey, {
            maxAge,
            httpOnly: true,
            secure: true,
            sameSite: 'strict',
        });
        logger.info(`Desktop bypass ativado via devkey (IP: ${getIp(req)})`);
        
        // Remove devkey da URL e redireciona (pra não deixar na barra)
        const cleanUrl = req.path;
        return res.redirect(cleanUrl);
    }
    
    // Verifica cookie de bypass
    const bypassCookie = req.cookies?.[DESKTOP_BYPASS_COOKIE];
    if (bypassCookie && bypassCookie === process.env.DESKTOP_ACCESS_KEY) {
        return next();
    }
    
    // Checa User-Agent
    const userAgent = req.headers['user-agent'] || '';
    if (isMobileUserAgent(userAgent)) {
        return next();
    }
    
    // Desktop sem bypass: mostra página de erro falsa
    logger.debug(`Desktop bloqueado (IP: ${getIp(req)}, UA: ${userAgent.substring(0, 50)})`);
    return sendFakeErrorPage(res);
}


/**
 * Retorna uma página de erro falsa (parece erro de rede/servidor).
 * Objetivo: parecer que o site tá fora do ar, não que bloqueamos desktop.
 */
function sendFakeErrorPage(res) {
    res.status(503);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Retry-After', '120');
    res.setHeader('Server', 'cloudflare');
    res.removeHeader('X-Powered-By');
    res.send(buildFakeErrorHTML());
}


/**
 * Pega o IP real do cliente (considera proxies tipo EasyPanel/Cloudflare).
 */
function getIp(req) {
    return (
        req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
        req.headers['x-real-ip'] ||
        req.socket.remoteAddress ||
        'unknown'
    );
}


/**
 * HTML estilo "503 Service Unavailable" do Cloudflare — parece erro real do servidor.
 * Não menciona nada sobre mobile-only. Anti-clonagem.
 * Gera ray-id pseudo-aleatório a cada request pra parecer mais real.
 */
function fakeRayId() {
    const chars = '0123456789abcdef';
    let id = '';
    for (let i = 0; i < 16; i++) id += chars[Math.floor(Math.random() * chars.length)];
    return id;
}

function buildFakeErrorHTML() {
    const rayId = fakeRayId();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>m.membrosvips.com | 503: Service Temporarily Unavailable</title>
<meta http-equiv="X-UA-Compatible" content="IE=Edge">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, "Helvetica Neue", Arial, sans-serif; color: #404040; background: #fff; min-height: 100vh; }
body { display: flex; flex-direction: column; }
.cf-error-overview { background: #fff; padding: 25px 0; border-bottom: 1px solid #ededed; }
.cf-error-overview .container { max-width: 980px; margin: 0 auto; padding: 0 25px; }
.cf-error-overview h1 { font-size: 28px; font-weight: 700; color: #404040; margin-bottom: 8px; }
.cf-error-overview h1 .heading-ray-id { font-weight: 400; font-size: 16px; color: #757575; margin-left: 6px; }
.cf-error-overview h2 { font-size: 19px; font-weight: 400; color: #404040; }
.cf-error-details-wrapper { padding: 30px 0 50px; flex: 1; background: #fafafa; }
.cf-error-details { max-width: 980px; margin: 0 auto; padding: 0 25px; }
.cf-error-details h2 { font-size: 22px; font-weight: 400; color: #404040; margin-bottom: 14px; }
.cf-error-details p { font-size: 15px; line-height: 1.5; color: #404040; margin-bottom: 16px; }
.cf-error-details .cf-error-code { font-family: "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace; font-size: 13px; color: #757575; padding: 12px 16px; background: #f5f5f5; border-radius: 4px; display: inline-block; margin-bottom: 24px; }
.cf-bubbles { margin: 28px 0; padding: 24px; background: #fff; border: 1px solid #e0e0e0; border-radius: 6px; }
.cf-bubble-item { display: flex; align-items: flex-start; gap: 14px; margin-bottom: 18px; }
.cf-bubble-item:last-child { margin-bottom: 0; }
.cf-bubble-circle { flex-shrink: 0; width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 13px; font-weight: 700; background: #f38020; }
.cf-bubble-circle.ok { background: #62c462; }
.cf-bubble-circle.err { background: #ee513b; }
.cf-bubble-text strong { display: block; font-size: 14px; color: #404040; margin-bottom: 2px; }
.cf-bubble-text span { font-size: 12px; color: #757575; }
.cf-footer { margin-top: 30px; font-size: 12px; color: #757575; line-height: 1.6; }
.cf-footer a { color: #f38020; text-decoration: none; }
.cf-footer a:hover { text-decoration: underline; }
.cf-footer p { margin-bottom: 4px; }
.cf-cloudflare-link { color: #f38020; }
@media (max-width: 600px) {
  .cf-error-overview h1 { font-size: 20px; }
  .cf-error-overview h1 .heading-ray-id { display: block; margin-left: 0; margin-top: 4px; }
  .cf-error-details h2 { font-size: 18px; }
}
</style>
</head>
<body>
<section class="cf-error-overview">
  <div class="container">
    <h1>
      <span>Error</span>
      <span class="cf-error-code">503</span>
      <span class="heading-ray-id">Ray ID: ${rayId} &bull; ${new Date().toUTCString().replace('GMT','UTC')}</span>
    </h1>
    <h2>Service Temporarily Unavailable</h2>
  </div>
</section>
<section class="cf-error-details-wrapper">
  <div class="cf-error-details">
    <h2>What happened?</h2>
    <p>The web server reported a gateway time-out error. The origin web server is temporarily unable to handle the request, likely because it is overloaded or down for maintenance.</p>
    <div class="cf-bubbles">
      <div class="cf-bubble-item">
        <div class="cf-bubble-circle ok">&#10003;</div>
        <div class="cf-bubble-text">
          <strong>You</strong>
          <span>Browser &mdash; Working</span>
        </div>
      </div>
      <div class="cf-bubble-item">
        <div class="cf-bubble-circle ok">&#10003;</div>
        <div class="cf-bubble-text">
          <strong>Network</strong>
          <span>Cloudflare &mdash; Working</span>
        </div>
      </div>
      <div class="cf-bubble-item">
        <div class="cf-bubble-circle err">&#10005;</div>
        <div class="cf-bubble-text">
          <strong>m.membrosvips.com</strong>
          <span>Host &mdash; Error</span>
        </div>
      </div>
    </div>
    <h2>What can I do?</h2>
    <p>Please try again in a few minutes. If you continue to experience issues, the server administrators have been notified.</p>
    <div class="cf-footer">
      <p>Cloudflare Ray ID: <strong>${rayId}</strong></p>
      <p>Your IP: <span style="color:#404040">[redacted]</span> &bull; Performance &amp; security by <a href="#" class="cf-cloudflare-link">Cloudflare</a></p>
    </div>
  </div>
</section>
</body>
</html>`;
}

const FAKE_ERROR_HTML = null; // mantido por compat, gerado dinamicamente abaixo


module.exports = {
    deviceCheckMiddleware,
    isMobileUserAgent,
    getIp,
};
