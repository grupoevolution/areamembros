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
 * RAIO-X (nov/2026): cada minuto vira 1 linha em ops_minutes (rotas, painel, notificações
 * saindo, carga da máquina). Quando a fila do banco enche, pergunta ao banco o que ele está
 * rodando naquele instante (pg_stat_activity). O Argos lê e mostra a causa de cada alarme.
 * Custo: só contadores em memória + 1 gravação por minuto.
 */
const os = require('os');
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
const PROBE_AT_WAITING = 5;   // a partir de 5 na fila, pergunta ao banco o que está rodando
const PROBE_GAP_MS = 15000;   // no máx. 1 pergunta a cada 15s
const KEEP_DAYS = 14;

let win = newWindow();
let history = [];           // últimos 60 minutos (pro painel)
let badStreak = 0, goodStreak = 0, alerting = false, alertStart = null, lastAlertAt = 0;
let started = false;

function newWindow() {
    return { durs: [], chats: [], errors: 0, poolMax: 0, lagMax: 0, reqs: 0, routes: {}, admin: {}, pushes: 0, db: null };
}

// chamado pelo middleware de log do server.js
function record(path, status, ms) {
    if (!path || path.indexOf('/api/') !== 0) return;
    // Painel não entra no tempo do app, mas fica anotado: relatório pesado também enche o banco
    if (path.indexOf('/api/admin') === 0) {
        const k = path.replace(/\/\d+(?=\/|$)/g, '/:id').slice(0, 80);
        const a = win.admin[k] || (Object.keys(win.admin).length < 100 ? (win.admin[k] = { n: 0, ms: 0, max: 0 }) : null);
        if (a) { a.n++; a.ms += ms; if (ms > a.max) a.max = ms; }
        return;
    }
    if (path.indexOf('/api/user/push/ack') === 0) return;
    win.reqs++;
    if (win.durs.length < 5000) win.durs.push(ms);
    if (path === '/api/user/chats' && win.chats.length < 2000) win.chats.push(ms);
    if (status >= 500) win.errors++;
    // RAIO-X: soma por rota (números viram :id) pra saber QUAL tela pesou
    const key = path.split('?')[0].replace(/\/\d+(?=\/|$)/g, '/:id').slice(0, 80);
    const r = win.routes[key] || (Object.keys(win.routes).length < 300 ? (win.routes[key] = { n: 0, ms: 0, max: 0 }) : null);
    if (r) { r.n++; r.ms += ms; if (ms > r.max) r.max = ms; }
}

// quantas notificações saíram (a rotina avisa aqui): liga pico de acesso com envio em massa
function notePushes(n) { win.pushes += n; }

// O que o banco está rodando AGORA. Roda fora da fila principal; se falhar, só fica sem o dado.
let probing = false, lastProbe = 0;
async function probeDb(waiting) {
    if (probing || Date.now() - lastProbe < PROBE_GAP_MS) return;
    probing = true; lastProbe = Date.now();
    const target = win; // o minuto em que a fila encheu, mesmo que a resposta chegue depois
    try {
        const { rows } = await db.probeQuery(`
            SELECT application_name AS app, state, wait_event_type AS wait,
                   ROUND(EXTRACT(EPOCH FROM NOW() - query_start) * 1000)::int AS ms,
                   LEFT(REGEXP_REPLACE(query, '\\s+', ' ', 'g'), 200) AS sql
              FROM pg_stat_activity
             WHERE pid <> pg_backend_pid() AND state IS NOT NULL AND state <> 'idle'
             ORDER BY query_start LIMIT 40`);
        if (!target.db || waiting > target.db.waiting) {
            target.db = { at: new Date().toISOString(), waiting, active: rows.length, longest: rows.slice(0, 8) };
        }
    } catch (err) { logger.warn('[ops] raio-x do banco: ' + err.message); }
    finally { probing = false; }
}

function topRoutes(w, limit) {
    return Object.keys(w.routes).map(k => {
        const r = w.routes[k];
        return { rota: k, pedidos: r.n, media_ms: Math.round(r.ms / r.n), max_ms: r.max, total_s: Math.round(r.ms / 1000) };
    }).sort((a, b) => b.total_s - a.total_s || b.pedidos - a.pedidos).slice(0, limit);
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
        top: topRoutes(w, 8),
        admin: Object.keys(w.admin).map(k => ({ rota: k, pedidos: w.admin[k].n, media_ms: Math.round(w.admin[k].ms / w.admin[k].n), max_ms: w.admin[k].max }))
            .sort((a, b) => b.media_ms * b.pedidos - a.media_ms * a.pedidos).slice(0, 5),
        pushes: w.pushes,
        load1: Math.round(os.loadavg()[0] * 10) / 10,
        cpus: os.cpus().length,
        db: w.db,
    };
}

let lastPurge = 0;
async function saveMinute(s) {
    // conexão própria: com a fila lotada, a fila principal perderia justamente os minutos ruins
    await db.probeQuery(
        `INSERT INTO ops_minutes (at, reqs, p90, chats_avg, errors, pool_waiting, loop_lag, load1, pushes, top, admin, db_running)
         VALUES (DATE_TRUNC('minute', NOW()), $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb)
         ON CONFLICT (at) DO NOTHING`,
        [s.reqs, s.p90, s.chats_avg, s.errors, s.pool_waiting, s.loop_lag, s.load1, s.pushes,
            JSON.stringify(s.top.slice(0, 5)), JSON.stringify(s.admin), s.db ? JSON.stringify(s.db) : null]);
    if (Date.now() - lastPurge > 3600000) {
        lastPurge = Date.now();
        await db.probeQuery(`DELETE FROM ops_minutes WHERE at < NOW() - make_interval(days => $1)`, [KEEP_DAYS]);
    }
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
        await db.probeQuery(
            `INSERT INTO ops_alerts (kind, title, body, stats) VALUES ($1, $2, $3, $4::jsonb)`,
            [kind, title.slice(0, 120), body.slice(0, 500), JSON.stringify(snap || {})]);
        return 1;
    } catch (err) { logger.warn('[ops] gravar alerta: ' + err.message); return 0; }
}

async function evaluate() {
    const w = win; win = newWindow();
    const s = snapshot(w);
    history.push(s); if (history.length > 60) history.shift();
    saveMinute(s).catch(err => logger.warn('[ops] gravar minuto: ' + err.message));
    const probs = problems(s);
    if (probs.length) { badStreak++; goodStreak = 0; } else { goodStreak++; badStreak = 0; }

    if (!alerting && badStreak >= 2 && Date.now() - lastAlertAt > 30 * 60000) {
        alerting = true; alertStart = Date.now(); lastAlertAt = Date.now();
        logger.error('[ops] ALERTA: ' + probs.join(' · '));
        // raio-x vai junto: rotas mais pesadas + os últimos 10 minutos
        await notify('slow', '⚠️ App lento agora', probs.join(' · '), { ...s, ultimos_min: history.slice(-10) });
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
            if (p && p.waitingCount >= PROBE_AT_WAITING) probeDb(p.waitingCount);
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

module.exports = { start, record, notePushes, status, notify, _evaluate: evaluate, _problems: problems };
