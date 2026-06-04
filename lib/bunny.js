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

module.exports = {
    parseBunnyUrl,
    isBunnyUrl,
    bunnyHlsUrl,
    bunnyEmbedUrl,
    bunnyThumbUrl,
    listCollectionVideos,
    clearCollectionCache,
};
