/**
 * lib/ops-monitor.js — ALARME DE LENTIDÃO (out/2026, após o travamento de 27/10)
 *
 * O próprio servidor se mede a cada minuto e, se o app ficar lento ou o banco
 * engasgar, grava um aviso em ops_alerts — o ARGOS lê e manda a notificação
 * no celular do dono. Avisa de novo quando normaliza.
 *
 * Mede (janela de 1 min):
 *   - tempo das rotas do app (/api/user/*) — média, p90 e só da lista de conversas
 *   - fila do banco (pedidos esperando conexão no pool)
 *   - erros 5xx
 *   - atraso do event loop (servidor "engasgado" em CPU)
 * Regra: 2 minutos RUINS seguidos → alerta (evita falso alarme de 1 pico);
 * 3 minutos BONS seguidos → "normalizado". No máx. 1 alerta a cada 30 min.
 * Custo: só contadores em memória + 1 consulta de config/minuto.
 */
const db = require('../db');
const { logger } = require('./logger');

const LIMITS = {
    p90Ms: 2500,        // 90% dos pedidos do app abaixo de 2,5s
    chatsAvgMs: 3000,   // lista de conversas: média abaixo de 3s
    poolWaiting: 12,    // até 12 pedidos na fila do banco
    errors5xx: 30,      // até 30 erros de servidor/min
    loopLagMs: 1500,    // event loop travado por mais de 1,5s
    minReqs: 20,        // só julga tempo com volume mínimo na janela
};

let win = newWindow();
let history = [];           // últimos 60 minutos (pro painel)
let badStreak = 0, goodStreak = 0, alerting = false, alertStart = null, lastAlertAt = 0;
let started = false;

function newWindow() {
    return { durs: [], chats: [], errors: 0, poolMax: 0, lagMax: 0, reqs: 0 };
}

// chamado pelo middleware de log do server.js
function record(path, status, ms) {
    if (!path || path.indexOf('/api/') !== 0) return;
    if (path.indexOf('/api/admin') === 0 || path.indexOf('/api/user/push/ack') === 0) return;
    win.reqs++;
    if (win.durs.length < 5000) win.durs.push(ms);
    if (path === '/api/user/chats' && win.chats.length < 2000) win.chats.push(ms);
    if (status >= 500) win.errors++;
}

function pct(arr, p) {
    if (!arr.length) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}
const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;

function snapshot(w) {
    return {
        at: new Date().toISOString(),
        reqs: w.reqs,
        p90: pct(w.durs, 0.9),
        avg: avg(w.durs),
        chats_avg: avg(w.chats),
        chats_n: w.chats.length,
        errors: w.errors,
        pool_waiting: w.poolMax,
        loop_lag: w.lagMax,
    };
}

function problems(s) {
    const out = [];
    if (s.reqs >= LIMITS.minReqs && s.p90 > LIMITS.p90Ms) out.push(`app respondendo em ${(s.p90 / 1000).toFixed(1)}s (normal: menos de 1s)`);
    if (s.chats_n >= 5 && s.chats_avg > LIMITS.chatsAvgMs) out.push(`conversas levando ${(s.chats_avg / 1000).toFixed(1)}s pra abrir`);
    if (s.pool_waiting > LIMITS.poolWaiting) out.push(`banco com ${s.pool_waiting} pedidos na fila`);
    if (s.errors > LIMITS.errors5xx) out.push(`${s.errors} erros de servidor no último minuto`);
    if (s.loop_lag > LIMITS.loopLagMs) out.push(`servidor engasgado (${(s.loop_lag / 1000).toFixed(1)}s de atraso)`);
    return out;
}

// O AVISO CHEGA PELO ARGOS (decisão do dono): aqui só grava na tabela
// ops_alerts; o Argos lê (conexão só leitura) a cada minuto e manda a
// notificação no celular dele. Sem e-mail/login específico no app.
async function notify(kind, title, body, snap) {
    try {
        await db.query(
            `INSERT INTO ops_alerts (kind, title, body, stats) VALUES ($1, $2, $3, $4::jsonb)`,
            [kind, title.slice(0, 120), body.slice(0, 500), JSON.stringify(snap || {})]);
        return 1;
    } catch (err) { logger.warn('[ops] gravar alerta: ' + err.message); return 0; }
}

async function evaluate() {
    const w = win; win = newWindow();
    const s = snapshot(w);
    history.push(s); if (history.length > 60) history.shift();
    const probs = problems(s);
    if (probs.length) { badStreak++; goodStreak = 0; } else { goodStreak++; badStreak = 0; }

    if (!alerting && badStreak >= 2 && Date.now() - lastAlertAt > 30 * 60000) {
        alerting = true; alertStart = Date.now(); lastAlertAt = Date.now();
        logger.error('[ops] ALERTA: ' + probs.join(' · '));
        await notify('slow', '⚠️ App lento agora', probs.join(' · '), s);
    } else if (alerting && goodStreak >= 3) {
        alerting = false;
        const mins = Math.max(1, Math.round((Date.now() - alertStart) / 60000));
        logger.info(`[ops] normalizado após ${mins} min`);
        await notify('ok', '✅ App normalizado', `Tudo respondendo rápido de novo (lento por ${mins} min).`, s);
    }
}

function start() {
    if (started) return;
    started = true;
    // fila do banco: amostra a cada 5s (guarda o pior do minuto)
    setInterval(() => {
        try {
            const p = db.pool;
            if (p && typeof p.waitingCount === 'number' && p.waitingCount > win.poolMax) win.poolMax = p.waitingCount;
        } catch (_) {}
    }, 5000).unref();
    // atraso do event loop: timer de 500ms que deveria disparar no tempo
    let last = Date.now();
    setInterval(() => {
        const now = Date.now();
        const lag = Math.max(0, now - last - 500);
        if (lag > win.lagMax) win.lagMax = lag;
        last = now;
    }, 500).unref();
    setInterval(() => { evaluate().catch(err => logger.warn('[ops] avaliar: ' + err.message)); }, 60000).unref();
    logger.info('[ops] alarme de lentidão ligado (avalia a cada 1 min)');
}

function status() {
    return { alerting, limits: LIMITS, current: snapshot(win), history };
}

module.exports = { start, record, status, notify, _evaluate: evaluate, _problems: problems };
