/**
 * =============================================================================
 * lib/bunny.js — Helpers de Bunny Stream
 * =============================================================================
 *
 * Detecta links do Bunny Stream (mediadelivery.net) e extrai libraryId/GUID
 * pra montar a URL HLS (que tocamos com hls.js no front, sem usar o player
 * visual do Bunny — controle total do UX).
 *
 * Também conversa com a API do Bunny pra puxar a lista de vídeos de uma
 * Collection (pasta) — usado quando o produto "content" tem uma library
 * inteira ao invés de URLs coladas uma por uma.
 *
 * REQUISITOS DE ENV (CRÍTICO):
 *   BUNNY_HLS_HOST   = vz-XXXXXX-XXX.b-cdn.net  (Pull Zone da Video Library)
 *   BUNNY_API_KEY    = AccessKey da Video Library (NÃO é a global da conta)
 *
 * Se nenhum dos dois estiver setado:
 *   - parseBunnyUrl continua funcionando (só faz regex)
 *   - bunnyHlsUrl() retorna null → frontend cai no <video src> MP4 cru
 *   - listCollectionVideos() retorna [] com warn → galeria fica só com
 *     o que foi colado manualmente
 * =============================================================================
 */

const { logger } = require('./logger');

// libraryId = só dígitos. guid = UUID v4 padrão.
// Funciona p/ player.mediadelivery.net/play/LIB/GUID e
// iframe.mediadelivery.net/embed/LIB/GUID.
const BUNNY_RE = /\/(\d+)\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/;

function parseBunnyUrl(url) {
    if (!url || typeof url !== 'string') return null;
    if (url.indexOf('mediadelivery.net') === -1) return null;
    const m = url.match(BUNNY_RE);
    if (!m) return null;
    return { libraryId: m[1], guid: m[2] };
}

function isBunnyUrl(url) {
    return !!parseBunnyUrl(url);
}

function bunnyHlsUrl(guid) {
    const host = process.env.BUNNY_HLS_HOST;
    if (!host || !guid) return null;
    return `https://${host}/${guid}/playlist.m3u8`;
}

// Embed iframe (player oficial do Bunny). Usamos pra galeria do produto
// onde renderizar vários vídeos com hls.js custaria caro (N instâncias).
function bunnyEmbedUrl(libraryId, guid) {
    if (!libraryId || !guid) return null;
    return `https://iframe.mediadelivery.net/embed/${libraryId}/${guid}`;
}

// Thumbnail servida pelo CDN da Video Library (mesma origem do HLS).
// Se thumbnailFileName vier nulo, devolve null pro frontend não quebrar img.
function bunnyThumbUrl(guid, thumbnailFileName) {
    const host = process.env.BUNNY_HLS_HOST;
    if (!host || !guid || !thumbnailFileName) return null;
    return `https://${host}/${guid}/${thumbnailFileName}`;
}


// ─── COLLECTION LOOKUP ───────────────────────────────────────────────────────
//
// Cache em memória pra evitar bater na API do Bunny a cada /library.
// 5 min de TTL. Map<chave, { expiresAt, videos }>.
//
// Não usamos Redis aqui porque o servidor é monolito de 1 instância no
// EasyPanel. Se um dia escalar pra N réplicas, troca pra Redis (a interface
// fica idêntica).

const COLLECTION_CACHE_TTL_MS = 5 * 60 * 1000;
const collectionCache = new Map();

function cacheKey(libraryId, collectionId) {
    return `${libraryId}::${collectionId}`;
}

function readCache(libraryId, collectionId) {
    const key = cacheKey(libraryId, collectionId);
    const entry = collectionCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
        collectionCache.delete(key);
        return null;
    }
    return entry.videos;
}

function writeCache(libraryId, collectionId, videos) {
    const key = cacheKey(libraryId, collectionId);
    collectionCache.set(key, {
        videos,
        expiresAt: Date.now() + COLLECTION_CACHE_TTL_MS,
    });
}

function clearCollectionCache() {
    collectionCache.clear();
}

/**
 * Lista vídeos de uma Collection (pasta) da Video Library.
 *
 * Retorna array de objetos no nosso formato interno (não o do Bunny):
 *   [{ guid, title, lengthSec, thumbnailFileName }, ...]
 *
 * Edge cases:
 *   - BUNNY_API_KEY ausente → log warn e retorna [].
 *   - libraryId/collectionId inválidos → retorna [].
 *   - Bunny responde !=200 → log warn e retorna [] (NÃO joga exceção — não
 *     queremos derrubar o /library do cliente se a API do Bunny estiver
 *     instável).
 *   - JSON malformado → retorna [].
 *
 * @param {string|number} libraryId
 * @param {string} collectionId
 * @returns {Promise<Array<{guid:string,title:string,lengthSec:number,thumbnailFileName:string|null}>>}
 */
async function listCollectionVideos(libraryId, collectionId) {
    if (!libraryId || !collectionId) return [];
    const apiKey = process.env.BUNNY_API_KEY;
    if (!apiKey) {
        logger.warn('[bunny] BUNNY_API_KEY ausente — listCollectionVideos retornando []');
        return [];
    }

    // Cache hit?
    const cached = readCache(libraryId, collectionId);
    if (cached) return cached;

    // Bunny paginação: itemsPerPage máx 1000. Praticamente nenhuma collection
    // de modelo passa disso. Se passar, pegamos os 1000 primeiros (é o caso
    // real esperado — mais que isso, o admin reorganiza).
    const url = `https://video.bunnycdn.com/library/${encodeURIComponent(libraryId)}/videos?page=1&itemsPerPage=1000&orderBy=date&collection=${encodeURIComponent(collectionId)}`;

    try {
        const ctrl = new AbortController();
        const timeoutId = setTimeout(() => ctrl.abort(), 6000);

        const resp = await fetch(url, {
            method: 'GET',
            headers: {
                'AccessKey': apiKey,
                'accept': 'application/json',
            },
            signal: ctrl.signal,
        });
        clearTimeout(timeoutId);

        if (!resp.ok) {
            logger.warn(`[bunny] collection ${libraryId}/${collectionId} respondeu ${resp.status}`);
            return [];
        }

        const data = await resp.json().catch(() => null);
        if (!data || !Array.isArray(data.items)) {
            logger.warn(`[bunny] collection ${libraryId}/${collectionId} JSON inesperado`);
            return [];
        }

        const videos = data.items
            .filter(v => v && v.guid)
            .map(v => ({
                guid: String(v.guid),
                title: String(v.title || '').slice(0, 200),
                lengthSec: Number(v.length || 0),
                thumbnailFileName: v.thumbnailFileName || null,
                // Status do encoding — 4 = "finished" (pronto pra streaming).
                // Outros estados (0=created, 1=uploaded, 2=processing, 3=transcoding,
                // 5=failed, 6=presigned upload) ainda não tocam direito. Mantemos
                // todos no array mas marcamos pro front decidir.
                status: Number.isFinite(v.status) ? v.status : null,
            }));

        writeCache(libraryId, collectionId, videos);
        return videos;
    } catch (err) {
        const msg = err && err.name === 'AbortError' ? 'timeout' : (err.message || 'erro desconhecido');
        logger.warn(`[bunny] falha listando collection ${libraryId}/${collectionId}: ${msg}`);
        return [];
    }
}

// ─── COLLECTIONS DA LIBRARY (lista/resolve por NOME) ─────────────────────────
// Usado pelo mapeamento "stream:NOME1,NOME2" dos grupos: o dono aponta as
// collections do Stream pelo nome (PRIVE, MDC...) e o motor resolve o guid.
const _collListCache = new Map(); // libraryId -> { expiresAt, items }
async function listStreamCollections(libraryId) {
    if (!libraryId) return [];
    const apiKey = process.env.BUNNY_API_KEY;
    if (!apiKey) return [];
    const c = _collListCache.get(String(libraryId));
    if (c && c.expiresAt > Date.now()) return c.items;
    try {
        const resp = await fetch(
            `https://video.bunnycdn.com/library/${encodeURIComponent(libraryId)}/collections?page=1&itemsPerPage=100&orderBy=date`,
            { headers: { AccessKey: apiKey, accept: 'application/json' }, signal: AbortSignal.timeout(6000) }
        );
        if (!resp.ok) { logger.warn(`[bunny] collections da library ${libraryId}: ${resp.status}`); return c ? c.items : []; }
        const data = await resp.json().catch(() => null);
        const items = (data && Array.isArray(data.items) ? data.items : [])
            .filter(x => x && x.guid)
            .map(x => ({ guid: String(x.guid), name: String(x.name || '') }));
        _collListCache.set(String(libraryId), { expiresAt: Date.now() + 10 * 60000, items });
        return items;
    } catch (e) {
        logger.warn(`[bunny] falha listando collections ${libraryId}: ${e.message}`);
        return c ? c.items : [];
    }
}
// aceita o guid direto OU o nome (case-insensitive)
async function resolveStreamCollection(libraryId, nameOrGuid) {
    const s2 = String(nameOrGuid || '').trim();
    if (!s2) return null;
    if (/^[0-9a-f-]{32,36}$/i.test(s2)) return s2;
    const items = await listStreamCollections(libraryId);
    const hit = items.find(x => x.name.toLowerCase() === s2.toLowerCase());
    return hit ? hit.guid : null;
}

// ─── BUNNY STORAGE (mídia por PASTA) ─────────────────────────────────────────
// Lista os arquivos de uma pasta da Storage Zone e devolve as URLs públicas
// do CDN — usado nas galerias/apresentações/agendas dos grupos ("aponta a
// pasta" em vez de colar link por link). Cache de 10 min por pasta. Requer:
//   BUNNY_STORAGE_ZONE = nome da storage zone
//   BUNNY_STORAGE_KEY  = AccessKey (senha) DA STORAGE ZONE (não a da conta)
//   BUNNY_STORAGE_CDN  = host público que serve os arquivos (ex: a.arquivosvip.site)
//   BUNNY_STORAGE_HOST = endpoint da API (default br.storage.bunnycdn.com)
const MEDIA_KIND_RE = [
    ['image', /\.(jpe?g|png|webp|gif|avif)$/i],
    ['video', /\.(mp4|webm|mov|m4v)$/i],
    ['audio', /\.(mp3|ogg|m4a|aac|wav|opus)$/i],
];
function storageMediaKind(name) {
    for (const [kind, re] of MEDIA_KIND_RE) if (re.test(name || '')) return kind;
    return null;
}

// Listagem CRUA da pasta (arquivos + sub-pastas), com cache. Tudo abaixo
// deriva daqui — 1 chamada à API do Bunny por pasta a cada 10 min, no máximo.
const _storageCache = new Map();
async function listStorageEntries(folder) {
    const zone = process.env.BUNNY_STORAGE_ZONE;
    const key = process.env.BUNNY_STORAGE_KEY;
    const cdn = process.env.BUNNY_STORAGE_CDN;
    if (!zone || !key || !cdn || !folder) {
        if (folder && (!zone || !key || !cdn)) {
            logger.warn('[bunny] pasta configurada mas faltam BUNNY_STORAGE_ZONE/KEY/CDN no env');
        }
        return { files: [], dirs: [] };
    }
    const path = String(folder).trim().replace(/^\/+|\/+$/g, '');
    if (!path) return { files: [], dirs: [] };
    const cached = _storageCache.get(path);
    if (cached && cached.expiresAt > Date.now()) return cached.data;
    try {
        const host = process.env.BUNNY_STORAGE_HOST || 'br.storage.bunnycdn.com';
        const resp = await fetch(`https://${host}/${zone}/${encodeURI(path)}/`, {
            headers: { AccessKey: key },
            signal: AbortSignal.timeout(8000),
        });
        if (!resp.ok) {
            logger.warn(`[bunny] storage ${path} respondeu ${resp.status}`);
            // CACHE NEGATIVO (90s): sem isso, config errada faz TODA request de
            // grupo bater no Bunny de novo (com timeout de 8s por pasta) e o
            // servidor afoga — o site inteiro cai em cascata.
            const empty = { files: [], dirs: [] };
            if (!cached) _storageCache.set(path, { expiresAt: Date.now() + 90000, data: empty });
            return cached ? cached.data : empty;
        }
        const items = await resp.json();
        const files = [];
        const dirs = [];
        for (const it of (Array.isArray(items) ? items : [])) {
            const name = it.ObjectName || '';
            if (it.IsDirectory) { if (name) dirs.push(name); continue; }
            const kind = storageMediaKind(name);
            if (!kind) continue;
            // ordena estável por nome — o sorteio determinístico da agenda
            // depende de a lista ser igual em qualquer servidor/momento.
            // encodeURI no path: pasta com espaço/acento ("IAGO GRUPOS/...")
            // vira URL válida em qualquer navegador/webview
            files.push({ name, kind, url: `https://${cdn}/${encodeURI(path)}/${encodeURIComponent(name)}` });
        }
        files.sort((a, b) => a.name.localeCompare(b.name));
        dirs.sort();
        const data = { files, dirs };
        _storageCache.set(path, { expiresAt: Date.now() + 10 * 60000, data });
        return data;
    } catch (e) {
        logger.warn(`[bunny] falha listando storage ${path}: ${e.message}`);
        const empty = { files: [], dirs: [] };
        if (!cached) _storageCache.set(path, { expiresAt: Date.now() + 90000, data: empty });
        return cached ? cached.data : empty;
    }
}

// Mídia da pasta: [{url, kind:'image'|'video'|'audio', name}]
async function listStorageMedia(folder) {
    return (await listStorageEntries(folder)).files;
}

// Sub-pastas (usado nas faixas etárias das pastas de apresentação)
async function listStorageSubfolders(folder) {
    return (await listStorageEntries(folder)).dirs;
}

// Compat: só as URLs de IMAGEM (comportamento original)
async function listStorageFolder(folder) {
    return (await listStorageMedia(folder)).filter(f => f.kind === 'image').map(f => f.url);
}

module.exports = {
    parseBunnyUrl,
    isBunnyUrl,
    bunnyHlsUrl,
    bunnyEmbedUrl,
    bunnyThumbUrl,
    listCollectionVideos,
    clearCollectionCache,
    listStreamCollections,
    resolveStreamCollection,
    listStorageFolder,
    listStorageMedia,
    listStorageSubfolders,
};
