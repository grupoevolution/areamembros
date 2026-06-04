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
    // em requests cross-origin: o Bunny ve "https://a.membrosvips.com" e
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
app.use('/api/admin/gamification', require('./routes/admin-gamification'));
app.use('/api/admin/notifications', require('./routes/admin-notifications'));
app.use('/api/admin/home', require('./routes/admin-home'));
app.use('/api/admin/upload', require('./routes/admin-upload'));
app.use('/api/admin/tracking', require('./routes/admin-tracking'));
app.use('/api/admin/push', require('./routes/admin-push'));
app.use('/api/admin/referral', require('./routes/admin-referral'));
app.use('/api/admin/calls', require('./routes/admin-calls'));
app.use('/api/admin/funnels', require('./routes/admin-funnels'));
app.use('/api/admin/recall-messages', require('./routes/admin-recall'));
app.use('/api/admin/preview-emails', require('./routes/admin-preview'));
app.use('/api/admin/gifts', require('./routes/admin-gifts'));
app.use('/api/admin/gift-campaigns', require('./routes/admin-gift-campaigns'));
app.use('/api/admin/sales-analytics', require('./routes/admin-sales-analytics'));
app.use('/api/admin/engagement', require('./routes/admin-engagement'));
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
    res.setHeader('Cache-Control', 'public, max-age=3600');
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


// ----------------------------------------------------------------------------
// HTML principal (Fase 0 — tela de status; Fase 3 — app Netflix)
// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------
// HTML principal
// Cliente → a.membrosvips.com/       (app cinematográfico)
// Interno → a.membrosvips.com/ops    (tela de status do servidor)
// Admin   → a.membrosvips.com/admin  (painel administrativo)
// ----------------------------------------------------------------------------

// App cliente (tela principal — login email-only, catálogo, acervo)
app.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(__dirname, 'public/app.html'));
});

// Rota de fun\u00edl \u2014 serve o app.html normal, mas seta cookie de "preview".
// O frontend detecta o cookie, faz login an\u00f4nimo autom\u00e1tico e mostra o app
// completo como preview. Qualquer a\u00e7\u00e3o real abre modal de login por cima.
app.get('/f/:slug', (req, res) => {
    const slug = String(req.params.slug || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 80);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    if (slug) {
        res.cookie('mv_funnel', slug, { maxAge: 7*24*60*60*1000, path: '/', httpOnly: false, sameSite: 'lax' });
    }
    res.sendFile(path.join(__dirname, 'public/app.html'));
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
