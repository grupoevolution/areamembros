/**
 * =============================================================================
 * routes/admin-quiz.js — QUIZ DE ENTRADA (painel)
 * =============================================================================
 *
 * O QUE É: o quiz é uma "pressel elaborada" — página /q/:slug com perguntas
 * visuais (uma por tela) que filtra o lead e joga ele no funil certo. O dono
 * monta TUDO aqui no painel: perguntas, opções (com foto ou ícone), pra onde
 * cada resposta leva, e os resultados finais (que usam a {cidade} do lead).
 *
 * MODELO MENTAL (igual aos blocos do chat): cada OPÇÃO aponta pra próxima
 * pergunta OU pra um resultado. Opção pode guardar uma variável (ex.:
 * perfil=casadas) que entra nos textos seguintes como {perfil}.
 *
 * DESTINOS do resultado:
 *   - 'funnel'    → CTA leva pro /f/<slug> de um funil existente (auto-login,
 *                   destino do funil, tudo que já funciona).
 *   - 'free_call' → igual, MAS credita 1 chamada grátis (estilo roleta): o app
 *                   abre a escolha de modelo (até 3 produtos-chamada), pede o
 *                   e-mail no clique e entrega o acesso como a roleta entrega.
 * =============================================================================
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const { logger } = require('../lib/logger');
const { requireAdmin } = require('../lib/auth');

// Ícones permitidos nas opções "discretas" (whitelist — o app só desenha esses)
const ICONS = ['pin', 'group', 'wifi', 'play', 'video', 'chat', 'user', 'heart', 'fire', 'star'];

const slugify = (s) => String(s || '').toLowerCase().trim()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

// ─────────────────────────────────────────────────────────────────────────────
// Sanitização da config (whitelist de campos — nada cru entra no banco)
// ─────────────────────────────────────────────────────────────────────────────
function cleanText(v, max) { return String(v ?? '').slice(0, max); }

function sanitizeConfig(raw) {
    const cfg = raw && typeof raw === 'object' ? raw : {};
    const out = {};

    const questions = Array.isArray(cfg.questions) ? cfg.questions.slice(0, 12) : [];
    out.questions = questions.map((q, qi) => {
        const opts = Array.isArray(q.options) ? q.options.slice(0, 8) : [];
        return {
            id: cleanText(q.id || ('q' + (qi + 1)), 24),
            type: q.type === 'photos' ? 'photos' : 'list',
            title: cleanText(q.title, 200),
            sub: cleanText(q.sub, 200),
            options: opts.map(o => ({
                label: cleanText(o.label, 80),
                icon: ICONS.includes(o.icon) ? o.icon : 'user',
                image: cleanText(o.image, 500),
                next: cleanText(o.next, 30), // id de pergunta OU "r:<id do resultado>"
                var_name: cleanText(o.var_name, 30).replace(/[^a-z0-9_]/gi, ''),
                var_value: cleanText(o.var_value, 60),
            })),
        };
    });

    const results = Array.isArray(cfg.results) ? cfg.results.slice(0, 12) : [];
    out.results = results.map((r, ri) => ({
        id: cleanText(r.id || ('res' + (ri + 1)), 24),
        name: cleanText(r.name, 80),
        badge: cleanText(r.badge, 120),
        title: cleanText(r.title, 200),
        sub: cleanText(r.sub, 300),
        cta: cleanText(r.cta, 60) || 'LIBERAR MEU ACESSO GRÁTIS',
        dest_type: r.dest_type === 'free_call' ? 'free_call' : 'funnel',
        funnel_slug: slugify(r.funnel_slug),
        call_product_ids: (Array.isArray(r.call_product_ids) ? r.call_product_ids : [])
            .map(n => parseInt(n, 10)).filter(n => n > 0).slice(0, 3),
        card_title: cleanText(r.card_title, 80),
        card_sub: cleanText(r.card_sub, 200),
    }));

    out.start = cleanText(cfg.start || (out.questions[0] && out.questions[0].id) || '', 24);
    out.city_fallback = cleanText(cfg.city_fallback, 40) || 'sua região';
    out.analyzing = (Array.isArray(cfg.analyzing) ? cfg.analyzing : [])
        .map(s => cleanText(s, 120)).filter(Boolean).slice(0, 5);
    return out;
}

// Erros de montagem que quebrariam o quiz no ar (mostrados no painel ao salvar)
function validateConfig(cfg) {
    const errs = [];
    if (!cfg.questions.length) errs.push('O quiz precisa de pelo menos 1 pergunta.');
    if (!cfg.results.length) errs.push('O quiz precisa de pelo menos 1 resultado final.');
    const qids = new Set(cfg.questions.map(q => q.id));
    const rids = new Set(cfg.results.map(r => r.id));
    if (cfg.start && !qids.has(cfg.start)) errs.push('A pergunta inicial não existe.');
    for (const q of cfg.questions) {
        if (!q.title) errs.push(`Pergunta "${q.id}" está sem título.`);
        if (!q.options.length) errs.push(`Pergunta "${q.id}" está sem opções.`);
        for (const o of q.options) {
            if (!o.label) { errs.push(`Pergunta "${q.id}" tem opção sem texto.`); continue; }
            const n = o.next || '';
            if (n.startsWith('r:')) {
                if (!rids.has(n.slice(2))) errs.push(`Opção "${o.label}" aponta pra um resultado que não existe.`);
            } else if (!qids.has(n)) {
                errs.push(`Opção "${o.label}" não aponta pra lugar nenhum (escolha "Leva pra").`);
            }
        }
    }
    for (const r of cfg.results) {
        if (!r.title) errs.push(`Resultado "${r.name || r.id}" está sem título.`);
        if (!r.funnel_slug) errs.push(`Resultado "${r.name || r.id}" está sem funil de destino.`);
        if (r.dest_type === 'free_call' && !r.call_product_ids.length) {
            errs.push(`Resultado "${r.name || r.id}" é chamada grátis mas não tem nenhuma modelo escolhida.`);
        }
    }
    return errs;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET / — lista com métricas (visitas, completos, cliques no CTA)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', requireAdmin, async (req, res) => {
    try {
        const { rows } = await db.query(`SELECT id, slug, name, active, created_at FROM quizzes ORDER BY id DESC`);
        const { rows: ev } = await db.query(
            `SELECT metadata->>'quiz' AS slug, event_type, COUNT(*)::int AS n
               FROM tracking_events
              WHERE event_type IN ('quiz_view', 'quiz_complete', 'quiz_cta')
                AND created_at > NOW() - INTERVAL '30 days'
              GROUP BY 1, 2`
        );
        const stats = {};
        for (const e of ev) {
            if (!e.slug) continue;
            stats[e.slug] = stats[e.slug] || { views: 0, completes: 0, ctas: 0 };
            if (e.event_type === 'quiz_view') stats[e.slug].views = e.n;
            if (e.event_type === 'quiz_complete') stats[e.slug].completes = e.n;
            if (e.event_type === 'quiz_cta') stats[e.slug].ctas = e.n;
        }
        res.json({ success: true, quizzes: rows.map(q => ({ ...q, stats: stats[q.slug] || { views: 0, completes: 0, ctas: 0 } })) });
    } catch (err) {
        logger.error('[admin-quiz] list:', err);
        res.status(500).json({ success: false, error: 'Erro ao listar quizzes' });
    }
});

// GET /:id — quiz completo pro editor
router.get('/:id', requireAdmin, async (req, res) => {
    try {
        const { rows } = await db.query(`SELECT * FROM quizzes WHERE id = $1`, [parseInt(req.params.id, 10) || 0]);
        if (!rows.length) return res.status(404).json({ success: false, error: 'Quiz não encontrado' });
        res.json({ success: true, quiz: rows[0] });
    } catch (err) {
        logger.error('[admin-quiz] get:', err);
        res.status(500).json({ success: false, error: 'Erro ao carregar quiz' });
    }
});

// POST / — cria
router.post('/', requireAdmin, async (req, res) => {
    try {
        const name = cleanText(req.body?.name, 120).trim();
        const slug = slugify(req.body?.slug || name);
        if (!name || !slug) return res.status(400).json({ success: false, error: 'Nome e slug são obrigatórios' });
        const config = sanitizeConfig(req.body?.config);
        const { rows } = await db.query(
            `INSERT INTO quizzes (slug, name, config) VALUES ($1, $2, $3::jsonb) RETURNING *`,
            [slug, name, JSON.stringify(config)]
        );
        res.json({ success: true, quiz: rows[0], warnings: validateConfig(config) });
    } catch (err) {
        if (String(err.message).includes('duplicate key')) {
            return res.status(400).json({ success: false, error: 'Já existe um quiz com esse slug' });
        }
        logger.error('[admin-quiz] create:', err);
        res.status(500).json({ success: false, error: 'Erro ao criar quiz' });
    }
});

// PUT /:id — salva tudo (nome, slug, config)
router.put('/:id', requireAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10) || 0;
        const name = cleanText(req.body?.name, 120).trim();
        const slug = slugify(req.body?.slug);
        if (!name || !slug) return res.status(400).json({ success: false, error: 'Nome e slug são obrigatórios' });
        const config = sanitizeConfig(req.body?.config);
        const { rows } = await db.query(
            `UPDATE quizzes SET name = $2, slug = $3, config = $4::jsonb, updated_at = NOW()
              WHERE id = $1 RETURNING *`,
            [id, name, slug, JSON.stringify(config)]
        );
        if (!rows.length) return res.status(404).json({ success: false, error: 'Quiz não encontrado' });
        res.json({ success: true, quiz: rows[0], warnings: validateConfig(config) });
    } catch (err) {
        if (String(err.message).includes('duplicate key')) {
            return res.status(400).json({ success: false, error: 'Já existe um quiz com esse slug' });
        }
        logger.error('[admin-quiz] update:', err);
        res.status(500).json({ success: false, error: 'Erro ao salvar quiz' });
    }
});

// POST /:id/toggle — liga/desliga
router.post('/:id/toggle', requireAdmin, async (req, res) => {
    try {
        const { rows } = await db.query(
            `UPDATE quizzes SET active = NOT active, updated_at = NOW() WHERE id = $1 RETURNING id, active`,
            [parseInt(req.params.id, 10) || 0]
        );
        if (!rows.length) return res.status(404).json({ success: false, error: 'Quiz não encontrado' });
        res.json({ success: true, active: rows[0].active });
    } catch (err) {
        logger.error('[admin-quiz] toggle:', err);
        res.status(500).json({ success: false, error: 'Erro ao alterar quiz' });
    }
});

// DELETE /:id — exclui de vez
router.delete('/:id', requireAdmin, async (req, res) => {
    try {
        const { rows } = await db.query(`DELETE FROM quizzes WHERE id = $1 RETURNING id`, [parseInt(req.params.id, 10) || 0]);
        if (!rows.length) return res.status(404).json({ success: false, error: 'Quiz não encontrado' });
        res.json({ success: true });
    } catch (err) {
        logger.error('[admin-quiz] delete:', err);
        res.status(500).json({ success: false, error: 'Erro ao excluir quiz' });
    }
});

// GET /helpers/options — listas pro editor: funis ativos + produtos-chamada
router.get('/helpers/options', requireAdmin, async (req, res) => {
    try {
        const { rows: funnels } = await db.query(
            `SELECT slug, name FROM funnels WHERE active = true ORDER BY name`
        );
        const { rows: callProducts } = await db.query(
            `SELECT id, name FROM products
              WHERE is_active = true
                AND (product_type = 'video_call' OR video_call_id IS NOT NULL
                     OR NULLIF(TRIM(COALESCE(direct_call_video_url, '')), '') IS NOT NULL)
              ORDER BY name`
        );
        res.json({ success: true, funnels, call_products: callProducts });
    } catch (err) {
        logger.error('[admin-quiz] helpers:', err);
        res.status(500).json({ success: false, error: 'Erro ao carregar opções' });
    }
});

module.exports = router;
