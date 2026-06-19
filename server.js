/**
 * =============================================================================
 * server.js — Servidor principal
 * =============================================================================
 *
 * AREA DE MEMBROS 2.0
 *
 * Stack: Node.js + Express + PostgreSQL
 *
 * Fase 0 entrega:
 *   - Servidor rodando
 *   - Conexão com banco
 *   - Health check
 *   - Login admin funcional
 *   - Bloqueio desktop (só em produção)
 *   - Estrutura preparada pras próximas fases
 *
 * =============================================================================
 */

// Carrega variáveis de ambiente do arquivo .env (em dev)
require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const path = require('path');

const { logger } = require('./lib/logger');
const { deviceCheckMiddleware } = require('./lib/device-check');
const { apiLimiter } = require('./lib/rate-limit');
const db = require('./db');


// ----------------------------------------------------------------------------
// Validação de variáveis de ambiente obrigatórias
// ----------------------------------------------------------------------------

// Defaults auto-gerados — mas PERSISTIDOS em arquivo (uploads/.secrets.json)
// pra sobreviver entre restarts. Senão tokens dos clientes virariam inválidos
// a cada deploy (UX horrível: cliente precisa relogar toda hora).
const crypto = require('crypto');
const fsLocal = require('fs');
function autoSecret(len) { return crypto.randomBytes(len).toString('hex'); }

if (!process.env.DATABASE_URL) {
    logger.error('DATABASE_URL é obrigatória. Configure a conexão Postgres nas env vars.');
    process.exit(1);
}

// Carrega/cria secrets persistidos em /app/uploads/.secrets.json
const SECRETS_FILE = path.join(__dirname, 'uploads', '.secrets.json');
let persistedSecrets = {};
try {
    if (fsLocal.existsSync(SECRETS_FILE)) {
        persistedSecrets = JSON.parse(fsLocal.readFileSync(SECRETS_FILE, 'utf8'));
    }
} catch (e) {
    logger.warn('Erro lendo .secrets.json:', e.message);
}

function persistSecrets() {
    try {
        const dir = path.dirname(SECRETS_FILE);
        if (!fsLocal.existsSync(dir)) fsLocal.mkdirSync(dir, { recursive: true });
        fsLocal.writeFileSync(SECRETS_FILE, JSON.stringify(persistedSecrets, null, 2), { mode: 0o600 });
    } catch (e) {
        logger.warn('Erro salvando .secrets.json:', e.message);
    }
}

let secretsChanged = false;

// PRECEDÊNCIA: se JWT_SECRET vier da env var (EasyPanel) e for forte,
// ela MANDA — ignora o arquivo persistido e a auto-geração. Isso garante
// que o secret seja estável entre restarts/réplicas/redeploys e que os
// tokens de 90 dias dos clientes não invalidem. O fallback persistido +
// auto-gerado continua existindo só pra ambiente sem a env var setada.
if (process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32) {
    logger.info('JWT_SECRET definido via env var — usando (precedência sobre arquivo/auto-gerado).');
} else {
    if (process.env.JWT_SECRET) {
        logger.warn(`JWT_SECRET da env var é fraco (${process.env.JWT_SECRET.length} chars, mínimo 32) — ignorando e usando fallback.`);
    }
    if (persistedSecrets.JWT_SECRET && persistedSecrets.JWT_SECRET.length >= 32) {
        process.env.JWT_SECRET = persistedSecrets.JWT_SECRET;
        logger.info('JWT_SECRET carregado do arquivo persistido.');
    } else {
        process.env.JWT_SECRET = autoSecret(32);
        persistedSecrets.JWT_SECRET = process.env.JWT_SECRET;
        secretsChanged = true;
        logger.warn('JWT_SECRET gerado novo e persistido em uploads/.secrets.json — defina JWT_SECRET na env do EasyPanel pra estabilidade.');
    }
}
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 16) {
    if (persistedSecrets.SESSION_SECRET) {
        process.env.SESSION_SECRET = persistedSecrets.SESSION_SECRET;
    } else {
        process.env.SESSION_SECRET = autoSecret(32);
        persistedSecrets.SESSION_SECRET = process.env.SESSION_SECRET;
        secretsChanged = true;
    }
}
if (!process.env.DESKTOP_ACCESS_KEY) {
    if (persistedSecrets.DESKTOP_ACCESS_KEY) {
        process.env.DESKTOP_ACCESS_KEY = persistedSecrets.DESKTOP_ACCESS_KEY;
    } else {
        process.env.DESKTOP_ACCESS_KEY = autoSecret(24);
        persistedSecrets.DESKTOP_ACCESS_KEY = process.env.DESKTOP_ACCESS_KEY;
        secretsChanged = true;
    }
}
if (secretsChanged) persistSecrets();

if (!process.env.ADMIN_USERNAME) {
    process.env.ADMIN_USERNAME = 'admin';
    logger.warn('ADMIN_USERNAME não definido — usando default "admin".');
}
if (!process.env.ADMIN_INITIAL_PASSWORD || process.env.ADMIN_INITIAL_PASSWORD.length < 8) {
    process.env.ADMIN_INITIAL_PASSWORD = 'admin12345';
    logger.warn('ADMIN_INITIAL_PASSWORD não definido — usando default "admin12345". TROQUE depois do primeiro login!');
}


// ----------------------------------------------------------------------------
// Criação do app Express
// ----------------------------------------------------------------------------

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const isProduction = process.env.NODE_ENV === 'production';


// ----------------------------------------------------------------------------
// Proxy trust (importante pro EasyPanel que usa reverse proxy)
// ----------------------------------------------------------------------------

app.set('trust proxy', 1);


// ----------------------------------------------------------------------------
// Middlewares de segurança e performance
// ----------------------------------------------------------------------------

// Helmet — headers de segurança HTTP
app.use(helmet({
    contentSecurityPolicy: false, // configurado manualmente mais adiante
    crossOriginEmbedderPolicy: false, // atrapalha vídeos/iframes
    // Default do helmet eh "no-referrer" — mata a integracao com Bunny Stream
    // (Bunny exige referer dos allowed domains pra liberar HLS). Trocando pra
    // "strict-origin-when-cross-origin" o browser manda so o origin (sem path)
    // em requests cross-origin: o Bunny ve "https://m.membrosvips.com" e
    // libera. Em mesma origem, manda URL completa (comportamento normal).
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// Compressão gzip/brotli
app.use(compression());

// Cookies
app.use(cookieParser(process.env.SESSION_SECRET));

// Parse de JSON (com limite de tamanho pra evitar abuse)
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));


// ----------------------------------------------------------------------------
// Logging de requisições
// ----------------------------------------------------------------------------

app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        const level = res.statusCode >= 500 ? 'error' 
                    : res.statusCode >= 400 ? 'warn' 
                    : 'debug';
        logger[level](`${req.method} ${req.path} ${res.statusCode} (${duration}ms)`);
    });
    next();
});


// ----------------------------------------------------------------------------
// Headers anti-cache pra rotas dinâmicas
// ----------------------------------------------------------------------------

app.use((req, res, next) => {
    // API e webhooks: nunca cachear
    if (req.path.startsWith('/api/') || req.path.startsWith('/webhook/')) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.setHeader('Pragma', 'no-cache');
    }
    next();
});


// ----------------------------------------------------------------------------
// Device check (bloqueia desktop em produção)
// ----------------------------------------------------------------------------

app.use(deviceCheckMiddleware);


// ----------------------------------------------------------------------------
// Rotas
// ----------------------------------------------------------------------------

// Health check (sem rate limit, usado por monitoring)
app.use('/health', require('./routes/health'));

// Webhooks (fora do apiLimiter pra evitar conflito)
app.use('/webhook', require('./routes/webhooks'));

// API routes (com rate limit)
app.use('/api', apiLimiter);
app.use('/api/admin', require('./routes/admin'));
app.use('/api/admin/products', require('./routes/admin-products'));
app.use('/api/admin', require('./routes/admin-access'));
// Armazenamento genérico de configs (gamification_config): app_config, login_config,
// reviews_list, home_layout, live_notifications, flash_offers, etc. — não é só gamificação.
app.use('/api/admin/gamification', require('./routes/admin-gamification'));
app.use('/api/admin/notifications', require('./routes/admin-notifications'));
app.use('/api/admin/home', require('./routes/admin-home'));
app.use('/api/admin/upload', require('./routes/admin-upload'));
app.use('/api/admin/tracking', require('./routes/admin-tracking'));
app.use('/api/admin/push', require('./routes/admin-push'));
app.use('/api/admin/calls', require('./routes/admin-calls'));
app.use('/api/admin/funnels', require('./routes/admin-funnels'));
app.use('/api/admin/recall-messages', require('./routes/admin-recall'));
app.use('/api/admin/preview-emails', require('./routes/admin-preview'));
app.use('/api/admin/gifts', require('./routes/admin-gifts'));
app.use('/api/admin/gift-campaigns', require('./routes/admin-gift-campaigns'));
app.use('/api/admin/sales-analytics', require('./routes/admin-sales-analytics'));
app.use('/api/admin/engagement', require('./routes/admin-engagement'));
app.use('/api/admin/chats', require('./routes/admin-chats'));
app.use('/api/user', require('./routes/user-chats'));
app.use('/api/user', require('./routes/user'));


// ----------------------------------------------------------------------------
// Arquivos estáticos
// ----------------------------------------------------------------------------

app.use('/assets', express.static(path.join(__dirname, 'public/assets'), {
    maxAge: isProduction ? '7d' : 0,
    etag: true,
}));

// Vendor libs (hls.js etc) — versionado pelo nome do arquivo, cache agressivo.
// Servir do nosso domínio (sem CDN externo) evita ban / instabilidade de terceiro
// e melhora privacidade do cliente.
app.use('/vendor', express.static(path.join(__dirname, 'public/vendor'), {
    maxAge: '365d',
    etag: true,
    immutable: true,
}));

// Uploads (imagens enviadas via admin → resize com sharp → /uploads/<preset>/<file>.webp)
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
    // Nome do arquivo é único e imutável (timestamp + hash). Cache agressivo é seguro
    // e independe de NODE_ENV — evita o cache morrer se a env var faltar no deploy.
    maxAge: '365d',
    etag: true,
    immutable: true,
}));

// PWA: manifest e service worker (servidos da raiz)
app.get('/manifest.json', (req, res) => {
    res.setHeader('Content-Type', 'application/manifest+json');
    // no-cache (revalida sempre): mudanças de ícone/manifest propagam na hora,
    // sem ficar preso 1h no cache do navegador/CDN.
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.sendFile(path.join(__dirname, 'public/manifest.json'));
});

app.get('/sw.js', (req, res) => {
    try {
        const fs = require('fs');
        const swPath = path.join(__dirname, 'public/sw.js');
        const appPath = path.join(__dirname, 'public/app.html');
        const swMtime = fs.statSync(swPath).mtimeMs;
        const appMtime = fs.existsSync(appPath) ? fs.statSync(appPath).mtimeMs : swMtime;
        const build = Math.floor(Math.max(swMtime, appMtime)).toString(36);
        const source = fs.readFileSync(swPath, 'utf8').replace(/__BUILD__/g, build);
        res.setHeader('Content-Type', 'application/javascript');
        res.setHeader('Service-Worker-Allowed', '/');
        res.setHeader('Cache-Control', 'no-store');
        res.send(source);
    } catch (err) {
        res.status(500).send('// sw error');
    }
});

// Versão do build (mtime dos HTMLs). O painel admin consulta isso pra avisar
// "tem versão nova — recarregue" quando a aba ficou aberta através de um deploy.
app.get('/build.json', (req, res) => {
    try {
        const fs = require('fs');
        let m = 0;
        for (const f of ['public/app.html', 'public/admin.html']) {
            const p = path.join(__dirname, f);
            if (fs.existsSync(p)) m = Math.max(m, fs.statSync(p).mtimeMs);
        }
        res.setHeader('Cache-Control', 'no-store');
        res.json({ build: Math.floor(m).toString(36) });
    } catch (e) {
        res.json({ build: '0' });
    }
});


// ----------------------------------------------------------------------------
// HTML principal (Fase 0 — tela de status; Fase 3 — app Netflix)
// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------
// HTML principal
// Cliente → m.membrosvips.com/       (app cinematográfico)
// Interno → m.membrosvips.com/ops    (tela de status do servidor)
// Admin   → m.membrosvips.com/admin  (painel administrativo)
// ----------------------------------------------------------------------------

// App cliente (tela principal — login email-only, catálogo, acervo)
app.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(__dirname, 'public/app.html'));
});

// Rota de fun\u00edl \u2014 serve o app.html normal, mas seta cookie de "preview".
// O frontend detecta o cookie, faz login an\u00f4nimo autom\u00e1tico e mostra o app
// completo como preview. Qualquer a\u00e7\u00e3o real abre modal de login por cima.
app.get('/f/:slug', async (req, res) => {
    const slug = String(req.params.slug || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 80);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    // Só seta o cookie se o funil EXISTE e está ATIVO — slug aleatório não
    // liga o modo funil (antes qualquer /f/qualquercoisa ligava).
    if (slug) {
        try {
            const db = require('./db');
            const { rows } = await db.query(
                `SELECT 1 FROM funnels WHERE slug = $1 AND active = true LIMIT 1`, [slug]
            );
            if (rows.length) {
                res.cookie('mv_funnel', slug, { maxAge: 7*24*60*60*1000, path: '/', httpOnly: false, sameSite: 'lax' });
            }
        } catch (_) { /* banco fora: serve o app sem modo funil */ }
    }
    res.sendFile(path.join(__dirname, 'public/app.html'));
});

// Rota "modo anúncio" — /ir/:slug
// Pensada pra colar no anúncio do Meta (Instagram/Facebook). Quando aberta DENTRO
// do navegador in-app do Instagram/Facebook no ANDROID, força reabrir no Chrome
// (via intent://) — onde o pop-up de "Instalar app" (PWA) realmente funciona.
// Em qualquer outro caso (iOS, Chrome, navegador normal), cai direto no /f/:slug.
app.get('/ir/:slug', async (req, res) => {
    const slug = String(req.params.slug || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 80);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const slugJson = JSON.stringify(slug);
    const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    // Prévia da tela de Conversas (modelos reais) como entrada: dá uns segundos de
    // contexto antes do aviso (em vez de jogar o aviso no lead frio). QUALQUER toque
    // OU 6s sem toque → dispara o Chrome (window.location.href = intent, que FUNCIONA).
    // Vai pro /f/slug → o funil abre direto no chat configurado. É só isca (sem sessão).
    let chats = [];
    try {
        const db = require('./db');
        const { rows } = await db.query(
            `SELECT name, avatar_url, show_online FROM chats WHERE active = true AND listed = true ORDER BY display_order, id LIMIT 4`
        );
        chats = rows;
    } catch (_) {}
    if (!chats.length) chats = [{ name: 'Eliene', avatar_url: null, show_online: true }, { name: 'Fabi', avatar_url: null, show_online: true }];
    const rowsHtml = chats.map((c, i) => {
        const avStyle = c.avatar_url ? ` style="background-image:url('${esc(c.avatar_url)}')"` : '';
        const dot = (c.show_online !== false) ? '<span class="dot"></span>' : '';
        const sub = i === 0 ? '<div class="sub">Áudio</div>' : '<div class="sub on">online</div>';
        return `<div class="row"><div class="av"${avStyle}>${dot}</div><div class="mid"><div class="nm">${esc(c.name)}</div>${sub}</div><div class="tm">agora</div></div>`;
    }).join('');

    res.send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>Conversas</title>
<style>
*{box-sizing:border-box}
html,body{height:100%;margin:0;background:#fff;color:#111;font-family:-apple-system,Segoe UI,Roboto,sans-serif;-webkit-tap-highlight-color:transparent}
.hd{padding:18px 18px 12px;font-size:26px;font-weight:800;border-bottom:1px solid #f0f0f0}
.lbl{padding:16px 18px 8px;font-size:12px;font-weight:700;letter-spacing:1.5px;color:#9a9a9a}
.row{display:flex;align-items:center;gap:13px;padding:12px 18px;border-bottom:1px solid #f3f3f3;cursor:pointer}
.row:active{background:#f6f6f6}
.av{position:relative;width:54px;height:54px;border-radius:50%;flex-shrink:0;background-size:cover;background-position:center;background-color:#e3e3e6}
.dot{position:absolute;right:1px;bottom:1px;width:13px;height:13px;border-radius:50%;background:#25D366;border:2.5px solid #fff}
.mid{flex:1;min-width:0}
.nm{font-size:17px;font-weight:700;color:#111}
.sub{font-size:14px;color:#8a8a8a;margin-top:2px}
.sub.on{color:#1fa855}
.tm{font-size:13px;color:#b0b0b0;align-self:flex-start;margin-top:3px}
#load{position:fixed;inset:0;background:#fff;display:flex;align-items:center;justify-content:center}
.s{width:34px;height:34px;border:3px solid #eee;border-top-color:#e50914;border-radius:50%;animation:r 1s linear infinite}
@keyframes r{to{transform:rotate(360deg)}}
a{color:#e50914;font-weight:700;text-decoration:none}
.gw{min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:13px;text-align:center;padding:30px 26px}
.glogo{width:60px;height:60px;border-radius:18px;background:#e50914;display:flex;align-items:center;justify-content:center;font-size:30px;font-weight:800;color:#fff}
.gt{font-size:20px;font-weight:800;color:#111}
.gsub{font-size:14px;color:#777;line-height:1.5;max-width:300px;margin-bottom:4px}
.gstep{display:flex;align-items:center;gap:11px;text-align:left;width:100%;max-width:330px;background:#f5f5f6;border-radius:12px;padding:13px 14px;font-size:14px;color:#444}
.gnum{flex-shrink:0;width:24px;height:24px;border-radius:50%;background:#e50914;color:#fff;font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center}
.gstep b{color:#111}
.gbtn{margin-top:8px;background:none;border:none;color:#aaa;font-size:13px;padding:10px;cursor:pointer}
</style></head>
<body>
<div id="teaser" style="display:none">
  <div class="hd">Conversas</div>
  <div class="lbl">MINHAS CONVERSAS</div>
  ${rowsHtml}
</div>
<div id="iosguide" class="gw" style="display:none">
  <div class="glogo">M</div>
  <div class="gt">Abra no navegador pra ver tudo</div>
  <div class="gsub">Você está dentro do Instagram. Pra abrir o conteúdo e receber as mensagens:</div>
  <div class="gstep"><span class="gnum">1</span><span>Toque em <b>•••</b> no canto da tela</span></div>
  <div class="gstep"><span class="gnum">2</span><span>Toque em <b>"Abrir no navegador externo"</b></span></div>
  <button class="gbtn" id="iosskip">continuar assim mesmo</button>
</div>
<div id="load"><div class="s"></div></div>
<noscript><div style="padding:24px;text-align:center"><a href="/f/${slug}">Toque aqui pra continuar</a></div></noscript>
<script>(function(){
  var slug = ${slugJson};
  var ua = navigator.userAgent || '';
  var isAndroid = /Android/i.test(ua);
  var isIOS = /iphone|ipad|ipod/i.test(ua);
  var inApp = /(FBAN|FBAV|FB_IAB|FBIOS|Instagram|Line\\/|Twitter|MicroMessenger|TikTok|Snapchat|Kwai)/i.test(ua);
  var host = location.host;
  var target = location.protocol + '//' + host + '/f/' + slug;
  var done = false, fired = false;
  function go(){ if (done) return; done = true; try { location.replace(target); } catch(e){ try { location.href = target; } catch(_){} } }
  function toChrome(){
    if (fired) return; fired = true;
    // mesmo mecanismo da versão que funciona (window.location.href = intent).
    try {
      var intent = 'intent://' + host + '/f/' + slug + '#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=' + encodeURIComponent(target) + ';end';
      window.location.href = intent;
    } catch(e){}
    // se o Chrome não abrir / o lead voltar, cai no app no próprio navegador
    setTimeout(go, 2500);
  }
  if (isIOS && inApp) {
    // iPhone: NÃO dá pra forçar o Safari (Apple não tem o intent://). Mostra o
    // passo a passo manual (••• → Abrir no navegador externo). Único caminho no iOS.
    document.getElementById('load').style.display = 'none';
    document.getElementById('iosguide').style.display = 'flex';
    document.getElementById('iosskip').addEventListener('click', go);
  } else if (isAndroid && inApp) {
    document.getElementById('load').style.display = 'none';
    document.getElementById('teaser').style.display = 'block';
    // QUALQUER toque dispara; e se ele não tocar, dispara sozinho em 6s.
    document.addEventListener('click', toChrome, { once: true });
    document.addEventListener('touchend', toChrome, { once: true, passive: true });
    setTimeout(toChrome, 6000);
  } else {
    go();
  }
})();</script></body></html>`);
});

// /app mantido como alias (compatibilidade com links antigos)
app.get('/app', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(__dirname, 'public/app.html'));
});

// Tela de status do servidor (interna — só pra você monitorar)
app.get('/ops', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.sendFile(path.join(__dirname, 'public/index.html'));
});

// CHAT LAB — página de teste isolada do chat estilo WhatsApp (Fase 1).
// Depois dos testes a experiência vira aba dentro do app principal.
app.get('/chat-lab', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(__dirname, 'public/chat-lab.html'));
});

// Painel admin (na Fase 4 vai ficar em subdomínio separado,
// por enquanto acessa via /admin em desenvolvimento)
app.get('/admin', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(__dirname, 'public/admin.html'));
});


// ----------------------------------------------------------------------------
// 404 handler
// ----------------------------------------------------------------------------

app.use((req, res) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/webhook/')) {
        return res.status(404).json({ success: false, error: 'Not found' });
    }
    res.status(404).send('Not found');
});


// ----------------------------------------------------------------------------
// Error handler global
// ----------------------------------------------------------------------------

app.use((err, req, res, next) => {
    logger.error('Erro não tratado:', err);
    
    if (req.path.startsWith('/api/') || req.path.startsWith('/webhook/')) {
        return res.status(500).json({ 
            success: false, 
            error: 'Erro interno do servidor' 
        });
    }
    
    res.status(500).send('Erro interno do servidor');
});


// ----------------------------------------------------------------------------
// Inicialização
// ----------------------------------------------------------------------------

// Auto-migrations idempotentes (ALTER/CREATE TABLE IF NOT EXISTS) rodam
// ANTES do app.listen — o servidor só aceita tráfego depois que o schema
// está consistente. Evita janela onde requisições batem no banco enquanto
// um ALTER TABLE ainda segura lock (gerava timeout → 500 → falso "deslogado").
let server;
(async () => {
    try {
        const { runMigrations } = require('./lib/migrations');
        await runMigrations();
    } catch (err) {
        // ensureBaseSchema falhar = banco inutilizável: aborta o boot em vez
        // de subir meio-quebrado. As migrations incrementais individuais já
        // são tolerantes a falha dentro do runMigrations (só logam warn).
        logger.error('Auto-migrations falhou de forma fatal — abortando boot:', err.message);
        process.exit(1);
    }

    server = app.listen(PORT, () => {
        logger.info('============================================');
        logger.info(`Area de Membros 2.0 - Fase 0`);
        logger.info(`Servidor ouvindo na porta ${PORT}`);
        logger.info(`Ambiente: ${process.env.NODE_ENV || 'development'}`);
        logger.info(`Node.js: ${process.version}`);
        logger.info('============================================');
    });

    // Worker de push agendado do funil (envia mesmo com o app do cliente fechado)
    try {
        const { startPushWorker } = require('./lib/push-worker');
        startPushWorker();
    } catch (err) {
        logger.warn('push-worker não iniciou: ' + err.message);
    }

    // Worker do chat: retoma roteiros em delay (app fechado) + push de mensagem
    try {
        const { startChatWorker } = require('./lib/chat-worker');
        startChatWorker();
    } catch (err) {
        logger.warn('chat-worker não iniciou: ' + err.message);
    }

    server.on('error', (err) => {
        logger.error('Falha ao abrir a porta HTTP:', err.message);
        process.exit(1);
    });
})();


// ----------------------------------------------------------------------------
// Shutdown graceful
// ----------------------------------------------------------------------------

async function shutdown(signal) {
    logger.info(`\nRecebido ${signal}. Fechando servidor...`);

    // server pode ainda não existir se o sinal chegar durante as migrations
    // (boot em andamento). Nesse caso fecha só o banco e sai.
    if (!server) {
        await db.close();
        return process.exit(0);
    }

    server.close(async () => {
        logger.info('HTTP server fechado');
        await db.close();
        logger.info('Banco de dados fechado');
        process.exit(0);
    });
    
    // Força saída se demorar demais
    setTimeout(() => {
        logger.error('Forçando saída após timeout');
        process.exit(1);
    }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
    logger.error('uncaughtException:', err);
    shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
    logger.error('unhandledRejection:', reason);
});
