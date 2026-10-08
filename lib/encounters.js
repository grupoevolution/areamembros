/**
 * =============================================================================
 * lib/encounters.js — ENCONTROS (estilo Tinder) — out/2026
 * =============================================================================
 *
 * Cada "perfil" é um CHAT existente (foto = avatar do chat) marcado com
 * enc_enabled no painel, com idade e etiqueta. O lead desliza (curte/passa),
 * tem um limite de curtidas grátis (trava com espera crescente), as modelos
 * curtem de volta no tempo (parte vira MATCH), e ver quem curtiu / mandar
 * mensagem direta é Premium. Match abre a conversa do chat daquela modelo.
 *
 * Config no painel (gamification_config → 'encounters'):
 *   enabled, free_likes, lock_hours, lock_mult, profile_after, first_like_min,
 *   next_like_min, match_pct, free_msgs, dist_min, dist_max, quiet_start,
 *   quiet_end (madrugada sem curtida de volta), peak_hours (lista)
 *
 * Identidade do lead = e-mail (logado) ou 'v:<visitor_id>' (anônimo).
 * =============================================================================
 */

const db = require('../db');
const { logger } = require('./logger');

const DEFAULTS = {
    enabled: false,
    free_likes: 25,
    lock_hours: 3,
    lock_mult: 2,
    profile_after: 3,
    first_like_min: 3,
    next_like_min: 25,
    match_pct: 30,
    free_msgs: 2,
    dist_min: 1,
    dist_max: 15,
    quiet_start: 1,     // 01h → 08h: curtida de volta espera o dia nascer
    quiet_end: 8,
    online_min: 28,
    online_max: 46,
    intro_title: 'Elas estão perto de você agora',
    intro_text: 'mulheres online na sua região querem conversar. Curte quem você gostar — se ela curtir de volta, dá match.',
};

let _cache = { at: 0, cfg: null };
const num = (v, d, lo, hi) => { const n = parseFloat(v); return isNaN(n) ? d : Math.max(lo, Math.min(hi, n)); };

async function loadConfig() {
    if (_cache.cfg && Date.now() - _cache.at < 30000) return _cache.cfg;
    let v = {};
    try {
        const { rows } = await db.query(`SELECT value FROM gamification_config WHERE key = 'encounters'`);
        v = (rows[0] && rows[0].value) || {};
    } catch (_) {}
    const cfg = {
        enabled: v.enabled === true,
        free_likes: num(v.free_likes, DEFAULTS.free_likes, 1, 500),
        lock_hours: num(v.lock_hours, DEFAULTS.lock_hours, 0.1, 168),
        lock_mult: num(v.lock_mult, DEFAULTS.lock_mult, 1, 10),
        profile_after: num(v.profile_after, DEFAULTS.profile_after, 1, 50),
        first_like_min: num(v.first_like_min, DEFAULTS.first_like_min, 0, 1440),
        next_like_min: num(v.next_like_min, DEFAULTS.next_like_min, 1, 1440),
        match_pct: num(v.match_pct, DEFAULTS.match_pct, 0, 100),
        free_msgs: num(v.free_msgs, DEFAULTS.free_msgs, 0, 20),
        dist_min: num(v.dist_min, DEFAULTS.dist_min, 0, 500),
        dist_max: num(v.dist_max, DEFAULTS.dist_max, 1, 500),
        quiet_start: num(v.quiet_start, DEFAULTS.quiet_start, 0, 23),
        quiet_end: num(v.quiet_end, DEFAULTS.quiet_end, 0, 23),
        online_min: num(v.online_min, DEFAULTS.online_min, 1, 999),
        online_max: num(v.online_max, DEFAULTS.online_max, 1, 999),
        intro_title: String(v.intro_title || DEFAULTS.intro_title).slice(0, 120),
        intro_text: String(v.intro_text || DEFAULTS.intro_text).slice(0, 300),
    };
    _cache = { at: Date.now(), cfg };
    return cfg;
}
function clearCache() { _cache = { at: 0, cfg: null }; }

// identidade do lead (e-mail logado > visitante)
function identityOf(req) {
    const email = (req.user && req.user.email && !req.user.anonymous) ? String(req.user.email).toLowerCase() : null;
    const raw = (req.body && req.body.visitor_id) || (req.query && req.query.visitor_id) || '';
    const vid = String(raw).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || null;
    return { email, vid, key: email || (vid ? 'v:' + vid : null) };
}

// Distância FIXA por lead × modelo (não muda entre aberturas): hash simples.
function distanceKm(identity, chatId, cfg) {
    const s = String(identity) + '|' + chatId;
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    const span = Math.max(1, cfg.dist_max - cfg.dist_min + 1);
    return cfg.dist_min + (h % span);
}

// Hora de Brasília (0–23)
function hourBR(d) {
    const dt = d || new Date();
    return parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false }).format(dt), 10) % 24;
}

// Etiqueta por horário: "dia|noite" no painel → escolhe; sem "|" usa a mesma.
function tagFor(chat) {
    const raw = String(chat.enc_tag || '').trim();
    if (!raw) return null;
    const parts = raw.split('|').map(s => s.trim()).filter(Boolean);
    if (parts.length < 2) return parts[0] || null;
    const h = hourBR();
    return (h >= 18 || h < 6) ? parts[1] : parts[0];
}

// "Online perto de você": número vivo, estável por ~10 min, mais alto à noite.
function onlineCount(cfg) {
    const h = hourBR();
    const slot = Math.floor(Date.now() / 600000);
    const base = cfg.online_min + ((slot * 7919) % Math.max(1, cfg.online_max - cfg.online_min + 1));
    const boost = (h >= 19 && h <= 23) ? 6 : (h >= 1 && h < 7) ? -8 : 0;
    return Math.max(cfg.online_min, base + boost);
}

// Quando a curtida de volta deve chegar: N minutos à frente, mas nunca na
// madrugada (empurra pra quiet_end). O worker entrega no horário.
function likeBackDue(cfg, nth) {
    const mins = nth === 0 ? cfg.first_like_min : cfg.next_like_min * (0.7 + Math.random() * 0.8) * (1 + nth * 0.25);
    const due = new Date(Date.now() + mins * 60000);
    const h = hourBR(due);
    if (cfg.quiet_start <= cfg.quiet_end ? (h >= cfg.quiet_start && h < cfg.quiet_end) : (h >= cfg.quiet_start || h < cfg.quiet_end)) {
        // empurra pra quiet_end do mesmo dia (BR), com uns minutos aleatórios
        const push = ((cfg.quiet_end - h + 24) % 24) * 60 + Math.floor(Math.random() * 40);
        return new Date(due.getTime() + push * 60000);
    }
    return due;
}

// Estado de curtidas (limite + trava)
async function getState(identity) {
    const { rows } = await db.query(
        `INSERT INTO encounter_state (identity) VALUES ($1) ON CONFLICT (identity) DO UPDATE SET identity = EXCLUDED.identity RETURNING *`,
        [identity]);
    return rows[0];
}

async function getProfile(identity) {
    const { rows } = await db.query(`SELECT * FROM encounter_profiles WHERE identity = $1`, [identity]);
    return rows[0] || null;
}

// Perfil pelo e-mail OU pelo visitante (fusão quando ele loga depois)
async function profileFor(id) {
    if (!id.key) return null;
    let p = await getProfile(id.key);
    if (!p && id.email && id.vid) {
        p = await getProfile('v:' + id.vid);
        if (p) {
            // migra tudo do visitante pro e-mail (perfil, estado, swipes, curtidas)
            await mergeIdentity('v:' + id.vid, id.email).catch(() => {});
            p = await getProfile(id.key);
        }
    }
    return p;
}

async function mergeIdentity(fromKey, toKey) {
    if (!fromKey || !toKey || fromKey === toKey) return;
    await db.query(`UPDATE encounter_profiles SET identity = $2, email = $2 WHERE identity = $1 AND NOT EXISTS (SELECT 1 FROM encounter_profiles WHERE identity = $2)`, [fromKey, toKey]);
    await db.query(`UPDATE encounter_state SET identity = $2 WHERE identity = $1 AND NOT EXISTS (SELECT 1 FROM encounter_state WHERE identity = $2)`, [fromKey, toKey]);
    await db.query(`UPDATE encounter_swipes SET identity = $2 WHERE identity = $1 AND NOT EXISTS (SELECT 1 FROM encounter_swipes s2 WHERE s2.identity = $2 AND s2.chat_id = encounter_swipes.chat_id)`, [fromKey, toKey]);
    await db.query(`UPDATE encounter_likes SET identity = $2, email = $2 WHERE identity = $1 AND NOT EXISTS (SELECT 1 FROM encounter_likes l2 WHERE l2.identity = $2 AND l2.chat_id = encounter_likes.chat_id)`, [fromKey, toKey]);
    await db.query(`DELETE FROM encounter_profiles WHERE identity = $1`, [fromKey]);
    await db.query(`DELETE FROM encounter_state WHERE identity = $1`, [fromKey]);
    await db.query(`DELETE FROM encounter_swipes WHERE identity = $1`, [fromKey]);
    await db.query(`DELETE FROM encounter_likes WHERE identity = $1`, [fromKey]);
}

// Curtidas de volta que venceram e ainda não foram "entregues" (notificadas).
// Usado pelo worker (push) e pelo app (toast). Marca delivered_at.
async function popDueLikes(limit) {
    const { rows } = await db.query(
        `UPDATE encounter_likes SET delivered_at = NOW()
          WHERE id IN (SELECT id FROM encounter_likes WHERE delivered_at IS NULL AND due_at <= NOW() ORDER BY due_at LIMIT $1 FOR UPDATE SKIP LOCKED)
          RETURNING *`, [limit || 50]);
    return rows;
}

module.exports = { DEFAULTS, loadConfig, clearCache, identityOf, distanceKm, hourBR, tagFor, onlineCount, likeBackDue, getState, getProfile, profileFor, mergeIdentity, popDueLikes };
