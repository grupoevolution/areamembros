/**
 * /api/admin/referral — gestão de indicações virais.
 *
 * Endpoints:
 *   GET  /list                 — lista de indicações
 *   POST /confirm              — confirma uma indicação (manual)
 *   POST /webhook/telegram     — bot Telegram chama quando alguém compra
 *                                via link de indicação. Body:
 *                                { code, referred_email|referred_telegram_id, product_id?, secret? }
 *
 * O bot precisa enviar `secret` igual a system_settings.referral_webhook_secret
 * (se configurado). Se não houver secret salvo, aceita qualquer chamada (dev).
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAdmin } = require('../lib/auth');
const { logger } = require('../lib/logger');

router.get('/list', requireAdmin, async (req, res) => {
    try {
        const { rows } = await db.query(`
            SELECT r.*, p.name AS product_name
            FROM referrals r
            LEFT JOIN products p ON p.id = r.product_id
            ORDER BY r.created_at DESC
            LIMIT 200
        `);
        const stats = await db.query(`
            SELECT
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
              COUNT(*) FILTER (WHERE status = 'converted')::int AS converted,
              COUNT(*) FILTER (WHERE status = 'rewarded')::int AS rewarded,
              COALESCE(SUM(reward_desejos), 0)::int AS total_desejos
            FROM referrals
        `);
        return res.json({ success: true, referrals: rows, stats: stats.rows[0] });
    } catch (err) {
        logger.error('referral/list falhou:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

router.post('/reward/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });

    try {
        await db.query(`
            UPDATE referrals SET status = 'rewarded', rewarded_at = NOW() WHERE id = $1
        `, [id]);
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// Endpoint público — chamado pelo bot Telegram quando alguém comprar via link de indicação.
// Não exige requireAdmin — usa secret compartilhado.
router.post('/webhook/telegram', async (req, res) => {
    try {
        const { code, referred_email, referred_telegram_id, product_id, secret, reward_desejos } = req.body || {};

        // Validação de secret (se configurado)
        const { rows: secretRow } = await db.query(`SELECT value FROM system_settings WHERE key = 'referral_webhook_secret'`);
        const expected = secretRow[0]?.value;
        const expectedClean = expected && (typeof expected === 'string' ? expected.replace(/^"|"$/g, '') : expected);
        if (expectedClean && expectedClean !== secret) {
            return res.status(401).json({ success: false, error: 'secret inválido' });
        }

        if (!code || !/^ref_[a-f0-9]+$/.test(code)) {
            return res.status(400).json({ success: false, error: 'code inválido' });
        }

        // Procura referrer pelo code (como o code é hash do email, busca por igualdade exata seria via tabela auxiliar, mas o app gera dinamicamente. Salva o registro e o referrer_email vem inferido)
        // Como o code é determinístico, o admin pode resolver o email depois.
        // Pra simplificar: aceita o code e marca como pending até admin confirmar manual,
        // OU se o body trouxer referrer_email, usa direto.
        const referrer_email = (req.body.referrer_email || '').toLowerCase() || null;
        if (!referrer_email) {
            return res.status(400).json({ success: false, error: 'referrer_email obrigatório no payload' });
        }

        const pid = product_id ? parseInt(product_id, 10) : null;
        const desejos = parseInt(reward_desejos, 10) || 100;

        await db.query(`
            INSERT INTO referrals (referrer_email, referrer_code, referred_email, referred_telegram_id, product_id, status, reward_desejos, converted_at)
            VALUES ($1, $2, $3, $4, $5, 'converted', $6, NOW())
        `, [referrer_email, code, referred_email || null, referred_telegram_id || null, pid, desejos]);

        // Premia o referrer com Desejos no gami_state (best-effort)
        try {
            const { rows: cr } = await db.query(`SELECT metadata FROM customers WHERE LOWER(email) = $1`, [referrer_email]);
            if (cr[0]) {
                const meta = cr[0].metadata || {};
                const gami = meta.gami_state || {};
                gami.wishes = (gami.wishes || 0) + desejos;
                gami.xp = (gami.xp || 0) + 50;
                meta.gami_state = gami;
                await db.query(`UPDATE customers SET metadata = $1 WHERE LOWER(email) = $2`, [meta, referrer_email]);
                await db.query(`UPDATE referrals SET status = 'rewarded', reward_xp = 50, rewarded_at = NOW()
                                WHERE referrer_email = $1 AND created_at > NOW() - interval '1 minute'`, [referrer_email]);
            }
        } catch (e) {
            logger.warn('referral reward best-effort falhou:', e.message);
        }

        return res.json({ success: true });
    } catch (err) {
        logger.error('referral webhook telegram falhou:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

module.exports = router;
