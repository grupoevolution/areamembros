// =============================================================================
// Service Worker — Membros VIP
// =============================================================================
// Estratégia AGRESSIVA contra cache velho (NÃO trava em versão antiga):
//   - HTML: SEMPRE network (sem cache nenhum) — garante app sempre atualizado
//   - Assets estáticos: cache-first com revalidação
//   - API: NUNCA cacheia
//   - Em cada novo deploy, BUILD muda → cache antigo é deletado automaticamente
// =============================================================================

const BUILD = '__BUILD__'; // substituído pelo server.js em runtime
const CACHE_VERSION = 'mvip-' + BUILD;
const RUNTIME_CACHE = 'mvip-runtime-' + BUILD;

// Cache DEDICADO de imagens — nome FIXO, NÃO leva BUILD, NÃO é apagado no activate.
// Motivo: arquivos em /uploads têm nome único e imutável (timestamp+hash .webp).
// O conteúdo nunca muda → cachear permanentemente entre deploys.
const IMAGE_CACHE = 'mvip-images-v1';
const IMAGE_CACHE_MAX = 200; // LRU simples: mantém ~200 imagens, descarta as mais antigas

// Detecta se uma request é de imagem (por path /uploads/ ou extensão)
function isImageRequest(url, req) {
    if (url.pathname.startsWith('/uploads/')) return true;
    if (/\.(webp|png|jpe?g|gif|svg|avif|ico)$/i.test(url.pathname)) return true;
    const accept = (req.headers.get('accept') || '');
    return accept.startsWith('image/');
}

// LRU: como Cache API não expõe ordem temporal, removemos as N primeiras
// entradas (FIFO). keys() preserva a ordem de inserção → mais antigas saem.
async function trimImageCache() {
    try {
        const cache = await caches.open(IMAGE_CACHE);
        const keys = await cache.keys();
        if (keys.length <= IMAGE_CACHE_MAX) return;
        const excess = keys.length - IMAGE_CACHE_MAX;
        for (let i = 0; i < excess; i++) {
            await cache.delete(keys[i]);
        }
    } catch (e) { /* silencioso */ }
}

// IMPORTANTE: não pré-cacheia HTML mais (causa o problema "site não atualiza")
const CORE_ASSETS = [
    '/manifest.json',
];

self.addEventListener('install', (event) => {
    // Ativa o SW novo IMEDIATAMENTE, sem esperar aba antiga fechar
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_VERSION).then((cache) => cache.addAll(CORE_ASSETS).catch(() => null))
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        Promise.all([
            // Deleta TODOS os caches antigos (que não são desta versão).
            // EXCEÇÃO: IMAGE_CACHE é preservado entre deploys (nome fixo, conteúdo imutável).
            caches.keys().then((keys) => Promise.all(
                keys.filter((k) => k !== CACHE_VERSION && k !== RUNTIME_CACHE && k !== IMAGE_CACHE)
                    .map((k) => caches.delete(k))
            )),
            // Toma controle de todas as abas abertas IMEDIATAMENTE
            self.clients.claim(),
        ]).then(() => {
            // Avisa todas as abas que tem versão nova rolando
            return self.clients.matchAll({ type: 'window' }).then((clients) => {
                clients.forEach((c) => {
                    try { c.postMessage({ type: 'SW_UPDATED', build: BUILD }); } catch(e) {}
                });
            });
        })
    );
});

// Permite que a página force ativação imediata via postMessage
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);

    // Mesmo origin apenas
    if (url.origin !== self.location.origin) return;

    // API, webhooks e service worker: NUNCA cacheia
    if (url.pathname.startsWith('/api/') ||
        url.pathname.startsWith('/webhook/') ||
        url.pathname === '/sw.js' ||
        url.pathname === '/manifest.json') {
        return;
    }

    // HTML (navegação): SEMPRE busca da rede, NUNCA usa cache.
    // Só usa cache se a rede falhar completamente (offline).
    if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
        event.respondWith(
            fetch(req, { cache: 'no-store' })
                .then((res) => res)
                .catch(() => caches.match(req).then((r) => r || caches.match('/')))
        );
        return;
    }

    // IMAGENS: cache-first PURO. Se está no cache, serve do cache e NÃO revalida.
    // Os arquivos em /uploads têm nome único+imutável → revalidar é desperdício de rede.
    if (isImageRequest(url, req)) {
        event.respondWith(
            caches.open(IMAGE_CACHE).then((cache) =>
                cache.match(req).then((cached) => {
                    if (cached) return cached; // hit: zero rede
                    return fetch(req).then((res) => {
                        if (res && res.status === 200) {
                            const copy = res.clone();
                            cache.put(req, copy).then(() => trimImageCache()).catch(() => null);
                        }
                        return res;
                    });
                })
            )
        );
        return;
    }

    // Assets estáticos (JS, CSS): cache-first com revalidação em background
    event.respondWith(
        caches.match(req).then((cached) => {
            const fetchPromise = fetch(req).then((res) => {
                // Só cacheia asset estático real. Nunca cacheia HTML aqui —
                // se a rede devolver HTML (ex.: rota de fallback / erro), descarta.
                const ct = res && res.headers ? (res.headers.get('content-type') || '') : '';
                if (res && res.status === 200 && !ct.includes('text/html')) {
                    const copy = res.clone();
                    caches.open(RUNTIME_CACHE).then((c) => c.put(req, copy)).catch(() => null);
                }
                return res;
            }).catch(() => cached);
            return cached || fetchPromise;
        })
    );
});

// Push notifications (handler — usado quando admin disparar campanhas)
self.addEventListener('push', (event) => {
    if (!event.data) return;
    let payload = {};
    try { payload = event.data.json(); }
    catch (e) { payload = { title: 'Membros VIP', body: event.data.text() }; }

    const options = {
        body: payload.body || '',
        icon: '/assets/icon.svg',
        badge: '/assets/icon.svg',
        tag: payload.tag || 'mvip-default',
        vibrate: [200, 80, 200],
        data: { url: payload.url || '/', type: payload.type },
        actions: payload.actions || [],
    };
    event.waitUntil(self.registration.showNotification(payload.title || 'Membros VIP', options));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = event.notification.data?.url || '/';
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
            for (const w of wins) {
                if (w.url.includes(self.location.origin) && 'focus' in w) {
                    w.navigate(url);
                    return w.focus();
                }
            }
            if (self.clients.openWindow) return self.clients.openWindow(url);
        })
    );
});
