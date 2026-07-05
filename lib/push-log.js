/**
 * =============================================================================
 * lib/push-log.js — Relatório de notificações (funil de entrega)
 * =============================================================================
 *
 * Cada push que sai do sistema vira (ou soma numa) linha da push_log:
 *   targets   — aparelhos alvo (tentativas de envio)
 *   accepted  — aceitos pelo serviço de push (Google/Apple devolveu 201)
 *   delivered — EXIBIDOS no aparelho (o service worker manda um beacon na
 *               hora que mostra a notificação — inclui o banner in-app)
 *   opened    — ABERTOS (beacon no clique da notificação)
 *
 * O `pid` (id da linha) viaja dentro do payload do push; o sw.js devolve os
 * beacons pra POST /api/user/push/ack.
 *
 * Fontes com ref_id (rotina/boas-vindas/funil/chat) agregam POR DIA no bucket
 * (source, ref_id, day). Manual/broadcast: ref_id NULL = 1 linha por disparo.
 * =============================================================================
 */

const db = require('../db');

// Abre (ou reaproveita, no caso dos buckets diários) a linha do disparo.
// Retorna o id (pid) ou null se a tabela ainda não existir — nunca lança.
async function openPushLog({ source, refId = null, title = null }) {
    try {
        const t = title ? String(title).slice(0, 160) : null;
        if (refId != null) {
            const { rows } = await db.query(
                `INSERT INTO push_log (source, ref_id, title)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (source, ref_id, day) WHERE ref_id IS NOT NULL
                 DO UPDATE SET title = COALESCE(EXCLUDED.title, push_log.title)
                 RETURNING id`,
                [source, refId, t]
            );
            return rows[0]?.id || null;
        }
        const { rows } = await db.query(
            `INSERT INTO push_log (source, title) VALUES ($1, $2) RETURNING id`,
            [source, t]
        );
        return rows[0]?.id || null;
    } catch (_) { return null; }
}

// Soma alvos/aceitos depois do lote de envio.
async function bumpPushLog(id, { targets = 0, accepted = 0 } = {}) {
    if (!id) return;
    try {
        await db.query(
            `UPDATE push_log SET targets = targets + $2, accepted = accepted + $3 WHERE id = $1`,
            [id, targets | 0, accepted | 0]
        );
    } catch (_) {}
}

module.exports = { openPushLog, bumpPushLog };
