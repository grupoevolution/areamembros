/**
 * =============================================================================
 * routes/user-lives.js — Aba "Lives" (dentro de Vídeos)
 * =============================================================================
 *
 * Uma "live" é um vídeo GRAVADO do Bunny tocando COMO SE FOSSE AO VIVO. O truque
 * é o mesmo dos grupos: todo mundo vê a mesma coisa no mesmo horário, decidido
 * pelo RELÓGIO — sem worker, sem estado por lead no servidor.
 *
 * Programação (zero recálculo por request, cacheada por janela):
 *   - o dia é dividido em JANELAS de `window_hours` (ex.: a cada 3h).
 *   - cada janela sorteia (seed = dia+janela+coleção) uma ordem estável dos
 *     vídeos da coleção → uma "grade". A posição atual dentro do vídeo é
 *     (agora - início da janela) dobrada pela soma das durações: quem entra
 *     no meio CAI NO MEIO da live (parece ao vivo). Vídeo acaba → o próximo
 *     da grade assume. Não repete no mesmo dia (percorre a grade inteira).
 *   - 2 faixas: LIVERADA (coleção `free`) e +18 TRAVADA (coleção `vip`).
 *
 * Acesso: reusa a posse dos VÍDEOS (mesmo popup). Premium vê tudo. O tempo
 * grátis da faixa liberada é contado POR E-MAIL/DIA no servidor (lives_watch).
 * =============================================================================
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const { logger } = require('../lib/logger');
const { optionalUser } = require('../lib/user-auth');
const { listCollectionVideos, bunnyHlsUrl, bunnyThumbUrl } = require('../lib/bunny');

// Reusa as checagens de posse dos vídeos (mesma regra: avulso OU Premium).
// require LAZY (dentro da função) pra não depender da ordem de carga dos módulos.
function exploreAccess(email) { return require('./user').exploreAccess(email); }

// ── config ───────────────────────────────────────────────────────────────────
const DEFAULT_LIVES = {
    enabled: false,
    lib_id: null,            // Library ID do Bunny (mesma das duas coleções)
    free_collection: null,   // coleção das lives LIBERADAS
    vip_collection: null,    // coleção das lives +18 TRAVADAS
    window_hours: 3,         // de quanto em quanto tempo a grade "vira"
    free_seconds: 180,       // tempo grátis por dia na faixa liberada (seg)
    creator_names: null,     // nomes opcionais por vídeo (fallback = título)
};
async function loadCfg() {
    try {
        const { rows } = await db.query(`SELECT value FROM gamification_config WHERE key = 'lives_config'`);
        return { ...DEFAULT_LIVES, ...(rows[0]?.value || {}) };
    } catch (_) { return { ...DEFAULT_LIVES }; }
}

// ── relógio de Brasília (UTC-3, igual push-worker) ───────────────────────────
function brasiliaParts(nowMs) {
    const d = new Date(nowMs - 3 * 3600 * 1000);
    return {
        dayKey: d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate(),
        // ms desde 00:00 Brasília
        msOfDay: ((d.getUTCHours() * 60 + d.getUTCMinutes()) * 60 + d.getUTCSeconds()) * 1000 + d.getUTCMilliseconds(),
    };
}

// PRNG determinístico (mesmo do grupo): mesmo seed → mesma ordem em todo lugar
function hashStr(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
}
function mulberry32(a) {
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function shuffleSeeded(arr, seed) {
    const out = arr.slice();
    const rnd = mulberry32(seed);
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

// Cache das listas do Bunny "assadas" por janela — 1 por (coleção, dia, janela).
// A própria listCollectionVideos já tem cache de 5min; aqui evitamos reordenar.
const _bakeCache = new Map();
function bakeKey(col, dayKey, win) { return col + ':' + dayKey + ':' + win; }

async function currentLive(cfg, collectionId, nowMs) {
    if (!cfg.lib_id || !collectionId) return null;
    const { dayKey, msOfDay } = brasiliaParts(nowMs);
    const winMs = Math.max(1, Math.min(24, cfg.window_hours | 0 || 3)) * 3600 * 1000;
    const winIdx = Math.floor(msOfDay / winMs);
    const key = bakeKey(collectionId, dayKey, winIdx);

    let grade = _bakeCache.get(key);
    if (!grade || Date.now() - grade.at > 5 * 60000) {
        let vids = await listCollectionVideos(cfg.lib_id, collectionId);
        vids = (vids || []).filter(v => (v.status == null || v.status >= 4) && v.lengthSec > 0);
        if (!vids.length) return null;
        const order = shuffleSeeded(vids, hashStr(key));
        grade = { at: Date.now(), vids: order, total: order.reduce((s, v) => s + v.lengthSec, 0) };
        _bakeCache.set(key, grade);
        // evicção simples: não deixa o Map crescer sem limite
        if (_bakeCache.size > 64) { const k = _bakeCache.keys().next().value; _bakeCache.delete(k); }
    }

    // posição dentro da janela (segundos), dobrada pela soma das durações →
    // quem entra no meio da janela cai no meio da programação (parece ao vivo)
    const winStartMs = winIdx * winMs;
    let pos = Math.floor((msOfDay - winStartMs) / 1000) % grade.total;
    let idx = 0;
    for (let i = 0; i < grade.vids.length; i++) {
        if (pos < grade.vids[i].lengthSec) { idx = i; break; }
        pos -= grade.vids[i].lengthSec;
    }
    const v = grade.vids[idx];
    const nextV = grade.vids[(idx + 1) % grade.vids.length];
    const nameOf = (vid, i) => {
        const nm = (cfg.creator_names && cfg.creator_names[vid.guid]) || vid.title || null;
        return (nm && nm.trim()) || ('Live ' + (i + 1));
    };
    // segundos até a próxima live entrar (pro contador "Próxima live")
    const secToNext = grade.vids[idx].lengthSec - pos;
    // espectadores: número estável por vídeo+minuto (oscila devagar, sem estado)
    const eyeSeed = mulberry32(hashStr(v.guid) + Math.floor(msOfDay / 60000));
    const viewers = 28 + Math.floor(eyeSeed() * 190);

    return {
        guid: v.guid,
        name: nameOf(v, idx),
        hls_url: bunnyHlsUrl(v.guid),
        poster: bunnyThumbUrl(v.guid, v.thumbnailFileName),
        offset_sec: pos,          // onde o player deve começar (segundos)
        length_sec: v.lengthSec,
        viewers,
        next_name: nameOf(nextV, (idx + 1) % grade.vids.length),
        next_in_sec: secToNext,
    };
}

// ── tempo grátis por e-mail/visitante POR DIA (faixa liberada) ───────────────
function ident(req) {
    const email = String(req.user?.email || '').toLowerCase().trim();
    if (email && !email.endsWith('@preview.local')) return email;
    const raw = String(req.query?.visitor_id || req.body?.visitor_id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    return raw ? 'v:' + raw : null;
}
async function secondsUsedToday(identity, dayKey) {
    if (!identity) return 0;
    try {
        const { rows } = await db.query(
            `SELECT seconds FROM lives_watch WHERE identity = $1 AND day_key = $2`, [identity, dayKey]
        );
        return rows[0] ? rows[0].seconds : 0;
    } catch (_) { return 0; }
}

// GET /api/user/lives — o que está "no ar" agora nas duas faixas + acesso
router.get('/lives', optionalUser, async (req, res) => {
    try {
        const cfg = await loadCfg();
        if (!cfg.enabled) return res.json({ success: true, enabled: false, lives: [] });

        const now = Date.now();
        const email = req.user?.email || null;
        const hasAccess = await exploreAccess(email);

        const free = await currentLive(cfg, cfg.free_collection, now);
        const vip = await currentLive(cfg, cfg.vip_collection, now);

        // tempo grátis restante na faixa liberada (por dia)
        const { dayKey } = brasiliaParts(now);
        let freeLeft = cfg.free_seconds;
        if (!hasAccess) {
            const used = await secondsUsedToday(ident(req), dayKey);
            freeLeft = Math.max(0, (cfg.free_seconds | 0) - used);
        }

        const lives = [];
        if (free) lives.push({ ...free, kind: 'free', locked: false });
        if (vip) {
            // +18: sem URL jogável pra quem não tem acesso (só poster borrado)
            const safe = hasAccess ? vip : { name: vip.name, poster: vip.poster, viewers: vip.viewers, next_name: vip.next_name, next_in_sec: vip.next_in_sec };
            lives.push({ ...safe, kind: 'vip', locked: !hasAccess });
        }

        return res.json({
            success: true,
            enabled: true,
            has_access: hasAccess,
            free_seconds: cfg.free_seconds,
            free_left: freeLeft,
            server_now: new Date(now).toISOString(),
            lives,
        });
    } catch (err) {
        logger.warn('[lives] falha: ' + (err && err.message));
        return res.json({ success: true, enabled: false, lives: [] });
    }
});

// POST /api/user/lives/watch {seconds} — acumula o tempo grátis do dia.
// Claim server-side: mesmo trocando de celular, a trava segue a pessoa.
router.post('/lives/watch', optionalUser, async (req, res) => {
    try {
        const identity = ident(req);
        if (!identity) return res.json({ success: true, free_left: 0 });
        const cfg = await loadCfg();
        const email = req.user?.email || null;
        if (await exploreAccess(email)) return res.json({ success: true, unlimited: true });

        const sec = Math.max(0, Math.min(30, parseInt(req.body?.seconds, 10) || 0));
        const { dayKey } = brasiliaParts(Date.now());
        const { rows } = await db.query(
            `INSERT INTO lives_watch (identity, day_key, seconds) VALUES ($1, $2, $3)
             ON CONFLICT (identity, day_key) DO UPDATE SET seconds = lives_watch.seconds + $3
             RETURNING seconds`,
            [identity, dayKey, sec]
        );
        const used = rows[0] ? rows[0].seconds : 0;
        return res.json({ success: true, free_left: Math.max(0, (cfg.free_seconds | 0) - used) });
    } catch (_) { return res.json({ success: true }); }
});

module.exports = router;
