/**
 * =============================================================================
 * routes/admin-roulette.js — NÚMEROS DA ROLETA VIP (painel)
 * =============================================================================
 *
 * Só leitura. Mostra pro dono, em português de gente, quanto a roleta girou:
 * quantos giros, o que saiu de prêmio, quantas chamadas ele já mandou o
 * cliente escolher (resgatadas) e quantos giros vieram de convite.
 *
 * Tudo em UMA ida ao banco por bloco, sem varrer tabela grande — as consultas
 * usam os índices que já existem (email/created_at).
 * =============================================================================
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const { logger } = require('../lib/logger');
const { requireAdmin } = require('../lib/auth');

// "Hoje" e "7 dias" sempre no fuso de Brasília (igual ao resto do sistema)
const TODAY_BR = `(NOW() AT TIME ZONE 'America/Sao_Paulo')::date`;
const DAY_BR = `(created_at AT TIME ZONE 'America/Sao_Paulo')::date`;

router.get('/stats', requireAdmin, async (req, res) => {
    try {
        const { rows: [p] } = await db.query(`
            SELECT
                COUNT(*)::int                                                     AS total,
                COUNT(*) FILTER (WHERE ${DAY_BR} = ${TODAY_BR})::int              AS today,
                COUNT(*) FILTER (WHERE ${DAY_BR} > ${TODAY_BR} - 7)::int          AS last7,
                COUNT(*) FILTER (WHERE kind = 'call')::int                        AS call_total,
                COUNT(*) FILTER (WHERE kind = 'call' AND claimed = true)::int     AS call_claimed,
                COUNT(*) FILTER (WHERE kind = 'content')::int                     AS content_total,
                COUNT(*) FILTER (WHERE kind = 'spin')::int                        AS spin_total,
                COUNT(DISTINCT LOWER(email))::int                                 AS people
            FROM roulette_prizes
        `);

        // Só visitas que VIRARAM giro (credited) — visita com teto do dia
        // estourado não credita e não pode inflar o "giros por convite".
        const { rows: [r] } = await db.query(`
            SELECT
                COUNT(*) FILTER (WHERE credited = true)::int         AS total,
                COUNT(*) FILTER (WHERE credited = true
                                 AND ${DAY_BR} = ${TODAY_BR})::int   AS today
            FROM roulette_ref_visits
        `);

        return res.json({
            success: true,
            stats: {
                spins_total: p?.total || 0,
                spins_today: p?.today || 0,
                spins_7d: p?.last7 || 0,
                prize_call: p?.call_total || 0,
                prize_call_claimed: p?.call_claimed || 0,
                prize_content: p?.content_total || 0,
                prize_spin: p?.spin_total || 0,
                people: p?.people || 0,
                ref_total: r?.total || 0,
                ref_today: r?.today || 0,
            },
        });
    } catch (err) {
        // Tabela ainda não existe (deploy antigo) → devolve zeros em vez de erro.
        if (err.code === '42P01') {
            return res.json({ success: true, stats: null, pending: true });
        }
        logger.error('[roleta/stats]', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

module.exports = router;
