/**
 * =============================================================================
 * lib/chat-rotation.js — Rodízio de "online" dos chats (esteira, igual Lives)
 * =============================================================================
 *
 * Com 100 conversas, definir horário fixo pra cada uma é inviável. Aqui o
 * sistema mantém ~N conversas ONLINE por vez e vai rodando o rodízio pela lista
 * toda pelo RELÓGIO (zero worker, zero estado): cada conversa pega turnos
 * espalhados no dia. Quando não está online, ela não responde (o worker segura)
 * e mostra "visto há X".
 *
 * OPT-IN: só entram no rodízio as conversas marcadas (in_rotation). As demais
 * ficam SEMPRE online (comportamento atual) — inclusive as de funil/tráfego,
 * pra nunca dar "lead mandou mensagem e nada aconteceu".
 * =============================================================================
 */
const db = require('../db');

let _cfg = { at: 0, val: null };
async function loadRotationConfig() {
    if (_cfg.val && Date.now() - _cfg.at < 60000) return _cfg.val;
    let cfg = { enabled: false, online_count: 18, shift_hours: 3 };
    try {
        const { rows } = await db.query(`SELECT value FROM gamification_config WHERE key = 'chat_rotation'`);
        if (rows[0] && rows[0].value) cfg = { ...cfg, ...rows[0].value };
    } catch (_) {}
    _cfg = { at: Date.now(), val: cfg };
    return cfg;
}

// PRNG determinístico (mesmo dos grupos/lives): mesmo seed → mesma ordem
function hashStr(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function shuffleSeeded(arr, seed) { const out = arr.slice(); const rnd = mulberry32(seed); for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; } return out; }

/**
 * Dado o conjunto de IDs em rodízio, calcula quem está online AGORA.
 * Retorna Map(id → { online: bool, mins_offline: number }).
 * Modelo esteira: N online por vez, cada um fica `shift_hours` no ar; um novo
 * entra a cada slot (= shift/N); a ordem re-embaralha a cada ciclo (todos passam).
 */
function computeOnline(ids, cfg, nowMs) {
    const res = new Map();
    const M = ids.length;
    if (!M) return res;
    const N = Math.max(1, Math.min(M, (cfg.online_count | 0) || 1));
    const shiftMs = Math.max(0.25, cfg.shift_hours || 3) * 3600e3;
    const slotMs = shiftMs / N;
    const cycleMs = M * slotMs;
    const cycleIdx = Math.floor(nowMs / cycleMs);
    const pos = nowMs - cycleIdx * cycleMs;
    const head = Math.floor(pos / slotMs);             // índice que entrou por último
    const order = shuffleSeeded(ids.slice().sort((a, b) => a - b), hashStr('chatrot:' + cycleIdx));
    order.forEach((id, oi) => {
        const d = ((head - oi) % M + M) % M;           // distância (em slots) do topo
        const online = d < N;
        let mins = 0;
        if (!online) {
            // ele saiu do ar quando d passou de N-1. Tempo offline ≈ slots
            // inteiros fora (d-N) + o que já correu no slot atual.
            const elapsedInSlot = pos - head * slotMs;
            mins = Math.round(((d - N) * slotMs + elapsedInSlot) / 60000);
        }
        res.set(id, { online, mins_offline: Math.max(0, mins) });
    });
    return res;
}

// "visto há X" a partir dos minutos offline (fuso não importa — é relativo).
function lastSeenLabel(mins) {
    if (mins < 2) return 'visto agora';
    if (mins < 60) return `visto há ${mins} min`;
    const h = Math.round(mins / 60);
    if (h < 24) return `visto há ${h}h`;
    const dd = Math.round(h / 24);
    return dd <= 1 ? 'visto ontem' : `visto há ${dd} dias`;
}

module.exports = { loadRotationConfig, computeOnline, lastSeenLabel };
