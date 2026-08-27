/**
 * =============================================================================
 * routes/quiz.js — QUIZ DE ENTRADA (lado do lead)
 * =============================================================================
 *
 * Três funções:
 *   POST /api/quiz/track            — métricas do quiz (view/step/complete/cta)
 *   GET  /api/quiz/call-options     — modelos da chamada grátis (público: o
 *                                     lead ainda é anônimo quando escolhe)
 *   POST /api/quiz/claim-call       — entrega a chamada grátis (exige e-mail;
 *                                     mesma entrega da roleta, granted_by='quiz')
 *
 * REGRA DE OURO: 1 chamada grátis POR E-MAIL POR QUIZ. Quem decide o produto
 * válido é a config do quiz no banco — nada que o lead envia decide prêmio.
 * =============================================================================
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const { logger } = require('../lib/logger');
const { requireUser } = require('../lib/user-auth');

const EVENTS = ['view', 'step', 'complete', 'cta'];

// ─────────────────────────────────────────────────────────────────────────────
// POST /track { slug, event, step?, vid? } — fire-and-forget, sem login
// ─────────────────────────────────────────────────────────────────────────────
router.post('/track', async (req, res) => {
    try {
        const slug = String(req.body?.slug || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 80);
        const event = String(req.body?.event || '');
        if (!slug || !EVENTS.includes(event)) return res.json({ success: true });
        const meta = {
            quiz: slug,
            vid: String(req.body?.vid || '').slice(0, 80) || null,
        };
        if (event === 'step') meta.step = parseInt(req.body?.step, 10) || 0;
        if (event === 'cta') meta.result = String(req.body?.result || '').slice(0, 30) || null;
        await db.query(
            `INSERT INTO tracking_events (event_type, metadata) VALUES ($1, $2::jsonb)`,
            ['quiz_' + event, JSON.stringify(meta)]
        );
        res.json({ success: true });
    } catch (_) { res.json({ success: true }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Config da chamada grátis de um resultado (produto válido vem DAQUI)
// ─────────────────────────────────────────────────────────────────────────────
async function freeCallResult(slug, resultId) {
    const { rows } = await db.query(
        `SELECT config FROM quizzes WHERE slug = $1 AND active = true`, [slug]
    );
    if (!rows.length) return null;
    const results = Array.isArray(rows[0].config?.results) ? rows[0].config.results : [];
    const r = results.find(x => x.id === resultId && x.dest_type === 'free_call');
    if (!r || !Array.isArray(r.call_product_ids) || !r.call_product_ids.length) return null;
    return r;
}

// Mesma regra da roleta: o que conta como produto de chamadinha
const CALL_PRODUCT_SQL = `(
    product_type = 'video_call'
    OR video_call_id IS NOT NULL
    OR NULLIF(TRIM(COALESCE(direct_call_video_url, '')), '') IS NOT NULL
)`;

// ─────────────────────────────────────────────────────────────────────────────
// GET /call-options?slug=&result= — modelos pro lead escolher (SEM login:
// ele escolhe primeiro, o e-mail é pedido no clique — decisão do dono)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/call-options', async (req, res) => {
    try {
        const slug = String(req.query?.slug || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 80);
        const resultId = String(req.query?.result || '').slice(0, 30);
        const r = await freeCallResult(slug, resultId);
        if (!r) return res.json({ success: false, error: 'Chamada indisponível' });
        const { rows } = await db.query(
            `SELECT id, name,
                    COALESCE(NULLIF(call_photo_url, ''), NULLIF(banner_url, '')) AS photo
               FROM products
              WHERE id = ANY($1::int[]) AND is_active = true AND ${CALL_PRODUCT_SQL}
              ORDER BY array_position($1::int[], id)`,
            [r.call_product_ids]
        );
        if (!rows.length) return res.json({ success: false, error: 'Chamada indisponível' });
        res.json({
            success: true,
            options: rows.map(p => ({ id: p.id, name: p.name, photo: p.photo || null })),
        });
    } catch (err) {
        logger.error('[quiz] call-options:', err);
        res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /claim-call { slug, result, product_id } — entrega (exige e-mail real).
// Entrega IGUAL a roleta: acesso ativo intacto reaproveita; usado abre slot
// novo; cai em Minhas Compras pronto pra ligar. Dedup: 1 por e-mail por quiz.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/claim-call', requireUser, async (req, res) => {
    try {
        if (req.user.anonymous) {
            return res.status(403).json({ success: false, error: 'Confirma seu e-mail pra liberar a chamada.' });
        }
        const email = String(req.user.email || '').toLowerCase();
        const slug = String(req.body?.slug || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 80);
        const resultId = String(req.body?.result || '').slice(0, 30);
        const productId = parseInt(req.body?.product_id, 10) || 0;

        const r = await freeCallResult(slug, resultId);
        if (!r || !r.call_product_ids.includes(productId)) {
            return res.status(400).json({ success: false, error: 'Essa opção não está disponível.' });
        }

        // 1 chamada grátis por e-mail POR QUIZ (mesmo trocando de modelo)
        const { rows: already } = await db.query(
            `SELECT 1 FROM user_access
              WHERE LOWER(email) = $1 AND granted_by = 'quiz'
                AND metadata->>'quiz' = $2 LIMIT 1`,
            [email, slug]
        );
        if (already.length) {
            return res.status(400).json({ success: false, error: 'Você já usou sua chamada grátis — ela está em Minhas Compras.' });
        }

        const { rows: [product] } = await db.query(
            `SELECT id, name FROM products WHERE id = $1 AND is_active = true AND ${CALL_PRODUCT_SQL}`,
            [productId]
        );
        if (!product) return res.status(400).json({ success: false, error: 'Essa opção não está disponível.' });

        const granted = await db.transaction(async (client) => {
            // Acesso ativo INTACTO ao mesmo produto? Reaproveita (igual a roleta)
            const { rows: [existing] } = await client.query(
                `SELECT id FROM user_access
                  WHERE LOWER(email) = $1 AND product_id = $2 AND status = 'active'
                    AND (expires_at IS NULL OR expires_at > NOW())
                  FOR UPDATE`,
                [email, productId]
            );
            if (existing) {
                const { rows: used } = await client.query(
                    `SELECT 1 FROM customer_call_history
                      WHERE LOWER(customer_email) = $1 AND user_access_id = $2
                     UNION ALL
                     SELECT 1 FROM product_call_history
                      WHERE LOWER(customer_email) = $1 AND user_access_id = $2
                     LIMIT 1`,
                    [email, existing.id]
                );
                if (!used.length) return { access_id: existing.id, reused: true };
                await client.query(
                    `UPDATE user_access
                        SET status = 'replaced', revoked_at = NOW(), revoke_reason = 'Chamada grátis do Quiz (slot novo)'
                      WHERE id = $1`,
                    [existing.id]
                );
            }
            const { rows: [ins] } = await client.query(
                `INSERT INTO user_access (email, product_id, status, granted_by, metadata)
                 VALUES ($1, $2, 'active', 'quiz', $3::jsonb)
                 RETURNING id`,
                [email, productId, JSON.stringify({ quiz: slug, result: resultId })]
            );
            return { access_id: ins.id, reused: false };
        });

        try {
            await db.query(
                `INSERT INTO tracking_events (event_type, metadata) VALUES ('quiz_call_claimed', $1::jsonb)`,
                [JSON.stringify({ quiz: slug, product_id: productId, email })]
            );
        } catch (_) {}

        logger.info(`[quiz] chamada grátis entregue: ${email} → produto ${productId} (quiz ${slug}${granted.reused ? ', reaproveitada' : ''})`);
        return res.json({ success: true, product_name: product.name, product_id: productId });
    } catch (err) {
        logger.error('[quiz] claim-call:', err);
        res.status(500).json({ success: false, error: 'Não consegui liberar agora. Tenta de novo.' });
    }
});

module.exports = router;
