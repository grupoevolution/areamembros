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
const { listCollectionVideos, bunnyHlsUrl, bunnyThumbUrl, resolveStreamCollection } = require('../lib/bunny');

// Nomes fictícios femininos pras lives (o título do vídeo no Bunny é nome de
// arquivo — nunca aparece pro lead). Estável por vídeo via hash do guid.
const LIVE_NAMES = ['Aline', 'Manu', 'Bia', 'Carol', 'Duda', 'Rafa', 'Nat', 'Lari',
    'Bruna', 'Gabi', 'Isa', 'Jé', 'Kel', 'Lud', 'Mari', 'Nanda', 'Paola', 'Rafaela',
    'Sabrina', 'Tati', 'Vivi', 'Yara', 'Amanda', 'Bianca', 'Camila', 'Dani', 'Elisa',
    'Fernanda', 'Giovana', 'Helena', 'Ingrid', 'Júlia', 'Karol', 'Letícia', 'Marina',
    'Priscila', 'Renata', 'Sofia', 'Thais', 'Valentina', 'Bella', 'Lorena', 'Malu',
    'Mel', 'Pati', 'Raissa', 'Sté', 'Vic'];

// A coleção pode vir como NOME ("Lives", "18") ou como GUID — resolve pro guid.
// "*" / "todas" / vazio = TODOS os vídeos da library (sem sub-pasta).
const _colResolve = new Map();
async function resolveCollection(libId, raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    if (s === '*' || /^todas?$/i.test(s)) return '*';
    const key = libId + '|' + s.toLowerCase();
    const c = _colResolve.get(key);
    if (c && Date.now() - c.at < 10 * 60000) return c.guid;
    let guid = null;
    try { guid = await resolveStreamCollection(libId, s); } catch (_) {}
    _colResolve.set(key, { at: Date.now(), guid });
    return guid;
}

// Reusa as checagens de posse dos vídeos (mesma regra: avulso OU Premium).
// require LAZY (dentro da função) pra não depender da ordem de carga dos módulos.
function exploreAccess(email) { return require('./user').exploreAccess(email); }

// ── config ───────────────────────────────────────────────────────────────────
const DEFAULT_LIVES = {
    enabled: false,
    lib_id: null,            // Library ID do Bunny (mesma das duas coleções)
    free_collection: null,   // coleção das lives LIBERADAS
    vip_collection: null,    // coleção das lives +18 TRAVADAS
    auto: true,              // RITMO AUTOMÁTICO: no ar + ciclo derivados do
                             // tamanho da pasta (o dono só alimenta o Bunny)
    cycle_days: 7,           // (modo manual) ciclo: giram por N dias e recomeçam
    free_on_air: 2,          // (modo manual) lives LIBERADAS no ar
    vip_on_air: 1,           // (modo manual) lives +18 no ar ao mesmo tempo
    free_seconds: 180,       // tempo grátis por dia na faixa liberada (3 min)
    creator_names: null,     // nomes opcionais por vídeo (fallback = título)
};

// ── RITMO AUTOMÁTICO ─────────────────────────────────────────────────────────
// O dono só alimenta a pasta; o sistema decide sozinho:
//   - QUANTAS no ar: cresce com a pasta (free: 1 a cada ~10 vídeos, 2–8;
//     +18: 1 a cada ~6 vídeos, 1–3). Ex.: 57 free → 5 no ar; 70 → 7; 80+ → 8.
//   - RITMO: cada live fica ~T horas "ao vivo" (free 3,5h; +18 5h) — o ciclo
//     vira consequência (cycleMs = T×N/C) e ALONGA sozinho conforme a pasta
//     cresce: 70 free ≈ repete só depois de ~35h; 170 ≈ 3 dias; 300 ≈ 5,5 dias.
//     Cada ciclo re-embaralha (dia/horário mudam), então repetição não "cara".
const AUTO_TARGET_H = { free: 3.5, vip: 5 };
function autoOnAir(kind, n) {
    if (kind === 'vip') return Math.max(1, Math.min(3, Math.floor(n / 6)));
    return Math.max(2, Math.min(8, Math.floor(n / 10)));
}
function livesAuto(cfg) { return cfg.auto === true || cfg.free_on_air === 'auto'; }
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

// Cache das listas do Bunny "assadas" por CICLO (embaralhadas 1x por ciclo).
const _bakeCache = new Map();

// A coleção é embaralhada UMA vez por ciclo e as lives entram no ar em fila —
// uma NOVA a cada `slot` (= ciclo ÷ nº de lives), e cada uma fica no ar por
// `count` slots. Sempre há `count` no ar; a rotação é contínua (uma entra, a
// mais antiga sai); no fim do ciclo, re-embaralha e recomeça.
// No modo AUTOMÁTICO, `count` e o ciclo saem do TAMANHO da pasta (ver acima);
// no manual, dos números do painel. Zero worker — tudo derivado do relógio.
async function livesOnAir(cfg, collectionId, kind, nowMs) {
    if (!cfg.lib_id || !collectionId) return [];
    // lista 1x pra saber N (o lib/bunny cacheia ~10min — não pesa)
    let vids = await listCollectionVideos(cfg.lib_id, collectionId);
    vids = (vids || []).filter(v => (v.status == null || v.status >= 4) && v.lengthSec > 0);
    const N = vids.length;
    if (!N) return [];

    let count, cycleMs;
    if (livesAuto(cfg)) {
        count = autoOnAir(kind, N);
        // cada live fica ~T horas no ar → ciclo = T×N÷count (alonga com a pasta)
        cycleMs = Math.max(3600e3, AUTO_TARGET_H[kind] * 3600e3 * N / count);
    } else {
        count = Math.max(0, Math.min(30, (kind === 'vip' ? cfg.vip_on_air : cfg.free_on_air) | 0));
        const cycleDays = Math.max(1, Math.min(60, cfg.cycle_days | 0 || 7));
        cycleMs = cycleDays * 86400 * 1000;
    }
    if (count <= 0) return [];

    const cycleIdx = Math.floor(nowMs / cycleMs);
    const posMs = nowMs - cycleIdx * cycleMs; // ms decorridos no ciclo atual
    // N na seed: dono adicionou vídeos → re-embaralha limpo (muda a "grade")
    const key = collectionId + ':cyc:' + cycleIdx + ':' + N;

    let baked = _bakeCache.get(key);
    if (!baked || Date.now() - baked.at > 30 * 60000) {
        baked = { at: Date.now(), vids: shuffleSeeded(vids, hashStr(key)) };
        _bakeCache.set(key, baked);
        if (_bakeCache.size > 64) { const k = _bakeCache.keys().next().value; _bakeCache.delete(k); }
    }

    const slotMs = cycleMs / N;                 // intervalo entre entradas de live
    const head = Math.floor(posMs / slotMs);    // índice da live que ENTROU por último
    const nowSec = Math.floor(nowMs / 1000);
    // Nome FICTÍCIO feminino, estável por vídeo (nunca o título/arquivo do Bunny)
    const nameOf = (vid) => LIVE_NAMES[hashStr('nm' + vid.guid) % LIVE_NAMES.length];
    const take = Math.min(count, N);
    const out = [];
    for (let k = 0; k < take; k++) {
        // as `count` lives no ar = a que entrou por último e as anteriores
        const idx = ((head - k) % N + N) % N;
        const v = baked.vids[idx];
        const pos = nowSec % v.lengthSec;         // relógio + loop → sempre "ao vivo"
        const eyeSeed = mulberry32(hashStr(v.guid) + Math.floor(nowMs / 60000));
        out.push({
            guid: v.guid,
            kind,
            name: nameOf(v),
            hls_url: bunnyHlsUrl(v.guid),
            poster: bunnyThumbUrl(v.guid, v.thumbnailFileName),
            offset_sec: pos,
            length_sec: v.lengthSec,
            viewers: 28 + Math.floor(eyeSeed() * 190),
        });
    }
    return out;
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

        // VÁRIAS lives no ar (quantas = automático pela pasta, ou manual).
        // A coleção pode estar salva como NOME ou GUID → resolve pro guid aqui.
        const freeCol = await resolveCollection(cfg.lib_id, cfg.free_collection);
        const vipCol = await resolveCollection(cfg.lib_id, cfg.vip_collection);
        const freeLives = await livesOnAir(cfg, freeCol, 'free', now);
        const vipLives = await livesOnAir(cfg, vipCol, 'vip', now);

        // tempo grátis restante na faixa liberada (por dia)
        const { dayKey } = brasiliaParts(now);
        let freeLeft = cfg.free_seconds;
        if (!hasAccess) {
            const used = await secondsUsedToday(ident(req), dayKey);
            freeLeft = Math.max(0, (cfg.free_seconds | 0) - used);
        }

        // INTERCALA no rolo (pedido do dono): a cada 2–3 liberadas entra uma
        // +18 no meio — o lead desliza: normal, normal, +18 travada, normal...
        // (+18 toca embaçada de teaser; sobras de +18 vão pro fim da fila)
        const freeArr = freeLives.map(l => ({ ...l, locked: false }));
        const vipArr = vipLives.map(l => ({ ...l, locked: !hasAccess }));
        const lives = [];
        if (freeArr.length && vipArr.length) {
            const chunk = Math.max(2, Math.min(3, Math.round(freeArr.length / vipArr.length)));
            let vi = 0;
            freeArr.forEach((l, i) => {
                lives.push(l);
                if ((i + 1) % chunk === 0 && vi < vipArr.length) lives.push(vipArr[vi++]);
            });
            while (vi < vipArr.length) lives.push(vipArr[vi++]);
        } else {
            lives.push(...freeArr, ...vipArr);
        }

        // Info do popup (o MESMO da aba Vídeos: oferta 19,90 + Premium) — mandada
        // junto pra Lives abrir o popup SEM navegar pra outra tela.
        let paywall = null, unlock = null, premiumPlan = null;
        if (!hasAccess) {
            try {
                const userApi = require('./user');
                const cfgRow = await db.query(`SELECT value FROM gamification_config WHERE key = 'explore_config'`).catch(() => ({ rows: [] }));
                const ex = cfgRow.rows[0]?.value || {};
                let pid = ex.product_id ? parseInt(ex.product_id, 10) : null;
                if (pid) {
                    const { rows: [pp] } = await db.query(`SELECT 1 FROM products WHERE id = $1 AND (COALESCE(is_chat_plan,false)=true OR COALESCE(is_story_plan,false)=true)`, [pid]);
                    if (pp) pid = null;
                }
                paywall = {
                    offer_price: ex.offer_price != null ? ex.offer_price : 19.90,
                    offer_original_price: ex.offer_original_price != null ? ex.offer_original_price : 49.90,
                    offer_note: ex.offer_note || 'liberação imediata após o pagamento',
                    cta: ex.paywall_cta || 'QUERO ACESSO VIP',
                    title: 'Essa é +18 sem censura 🔥',
                    text: 'Libera as lives sem censura e todos os vídeos — sem limite.',
                };
                unlock = await userApi.loadExploreUnlock(pid, ex.checkout_url || null);
                premiumPlan = await userApi.loadPremiumPlan();
            } catch (_) {}
        }

        return res.json({
            success: true,
            enabled: true,
            has_access: hasAccess,
            free_seconds: cfg.free_seconds,
            free_left: freeLeft,
            server_now: new Date(now).toISOString(),
            paywall, unlock, premium_plan: premiumPlan,
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
