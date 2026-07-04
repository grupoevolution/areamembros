/**
 * =============================================================================
 * lib/group-worker.js — Worker de cenas dos GRUPOS
 * =============================================================================
 *
 * Mantém os grupos VIVOS mesmo com o app fechado: a cada 60s materializa as
 * cenas vencidas (group_sessions.next_scene_at) dos leads que abriram o grupo
 * nos últimos 3 dias. Quando o lead volta, encontra o histórico acumulado —
 * o grupo parece real, não um cenário que congela quando ele sai.
 *
 * A lógica de cena mora em routes/user-groups.js (runBackgroundScenes) — aqui
 * é só o relógio, no mesmo padrão do push-worker/chat-worker.
 * =============================================================================
 */

const { logger } = require('./logger');

let timer = null;

function startGroupWorker() {
    if (timer) return;
    timer = setInterval(async () => {
        try {
            const { runBackgroundScenes } = require('../routes/user-groups');
            const ran = await runBackgroundScenes();
            if (ran > 0) logger.info(`[group-worker] ${ran} sessão(ões) de grupo avançada(s)`);
        } catch (err) {
            logger.warn('[group-worker] erro: ' + err.message);
        }
    }, 60 * 1000);
    logger.info('[group-worker] iniciado — cenas de grupo a cada 60s');
}

module.exports = { startGroupWorker };
