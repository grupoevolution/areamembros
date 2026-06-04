/**
 * =============================================================================
 * routes/admin-gifts.js — CRUD de brindes (presentes ao cliente)
 * =============================================================================
 *
 * Brindes são acessos virtuais que o admin concede manualmente. NÃO geram
 * user_access (não contam em métricas, não viram refund/chargeback). Aparecem
 * no /library do cliente como produto com badge "BRINDE" + countdown opcional.
 *
 * Casos de uso:
 *   - Cliente comprou produto X e o admin dá Y de bônus pra fidelizar.
 *   - Lançamento: dar 1 chamada-amostra de graça pra leads selecionados.
 *   - Compensar refund/erro de processamento: dar acesso vitalício na mão.
 *
 * Endpoints:
 *   GET    /api/admin/gifts                 lista (filtros: email, status, product_id)
 *   GET    /api/admin/gifts/products        produtos publicados (dropdown do form)
 *   POST   /api/admin/gifts                 cria { email, product_id, expires_in_hours?, expires_at?, label? }
 *   PUT    /api/admin/gifts/:id             edita { expires_at?, label?, status? }
 *   DELETE /api/admin/gifts/:id             soft-delete (status='revoked')
 *
 * Idempotência: 1 brinde ATIVO por (email, product_id). Se admin tentar
 * conceder o mesmo brinde 2x, retorna 409 com o brinde existente.
 * =============================================================================
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAdmin } = require('../lib/auth');
const { logger } = require('../lib/logger');


// ─── Helpers ─────────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(raw) {
    return String(raw || '').toLowerCase().trim();
}

// Aceita expires_in_hours (int, 0 ou null = vitalício) OU expires_at (ISO 8601).
// expires_in_hours tem prioridade quando os 2 vêm preenchidos.
function resolveExpiresAt(body) {
    const hoursRaw = body.expires_in_hours;
    if (hoursRaw !== undefined && hoursRaw !== null && hoursRaw !== '') {
        const h = parseInt(hoursRaw, 10);
        if (isNaN(h) || h < 0) return { error: 'expires_in_hours inválido (use inteiro >= 0, ou 0 pra vitalício)' };
        if (h === 0) return { value: null };          // 0 horas = vitalício
        if (h > 24 * 365 * 5) return { error: 'expires_in_hours muito alto (máx 5 anos)' };
        return { value: new Date(Date.now() + h * 3600 * 1000) };
    }
    if (body.expires_at) {
        const d = new Date(body.expires_at);
        if (isNaN(d.getTime())) return { error: 'expires_at inválido (use ISO 8601)' };
        if (d.getTime() < Date.now() - 60 * 1000) return { error: 'expires_at já passou' };
        return { value: d };
    }
    return { value: null };                            // default: vitalício
}


// ─── Helpers de filtro temporal (Fase K2 — bulk gifts) ──────────────────────
//
// audienceFilterSql(filter, fromDate?, toDate?) -> { sql, params } |  { error }
// Monta o WHERE de customers.first_seen_at baseado em:
//   - 'all'       : sem filtro (todos os customers)
//   - 'today'     : first_seen_at::date = CURRENT_DATE (timezone do server)
//   - 'yesterday' : first_seen_at::date = CURRENT_DATE - 1
//   - 'range'     : first_seen_at::date BETWEEN $1 AND $2 (parâmetros)
//
// Retorna { error } se o filtro for inválido (mensagem pro admin).
//
// IMPORTANTE: ::date usa a timezone do servidor. Em produção (UTC), "hoje"
// na visão do admin (BRT) começa às 03:00 UTC. Quem cadastrou às 23h em
// BRT vira "amanhã" na query. Pra brinde isso é aceitável (margem de 3h),
// e evita complexidade de carregar TZ por request. Se virar problema, basta
// ler timezone de system_settings.
function audienceFilterSql(filter, fromDate, toDate) {
    const f = String(filter || '').toLowerCase().trim();
    if (f === 'all') {
        return { sql: '', params: [] };
    }
    if (f === 'today') {
        return { sql: `AND first_seen_at::date = CURRENT_DATE`, params: [] };
    }
    if (f === 'yesterday') {
        return { sql: `AND first_seen_at::date = (CURRENT_DATE - INTERVAL '1 day')::date`, params: [] };
    }
    if (f === 'range') {
        // Aceita YYYY-MM-DD. Postgres faz o cast — qualquer string inválida
        // explode no query e retorna 500. Pra blindar, valida regex aqui.
        const dateRe = /^\d{4}-\d{2}-\d{2}$/;
        if (!fromDate || !dateRe.test(fromDate)) {
            return { error: 'from_date inválido (use YYYY-MM-DD)' };
        }
        if (!toDate || !dateRe.test(toDate)) {
            return { error: 'to_date inválido (use YYYY-MM-DD)' };
        }
        if (new Date(toDate) < new Date(fromDate)) {
            return { error: 'to_date deve ser >= from_date' };
        }
        return {
            sql: `AND first_seen_at::date BETWEEN $1::date AND $2::date`,
            params: [fromDate, toDate],
        };
    }
    return { error: `filter inválido: "${filter}" (use all|today|yesterday|range)` };
}


// ─── GET /api/admin/gifts/products ───────────────────────────────────────────
// Lista produtos publicados pra dropdown do form. Definida ANTES do /:id pra
// evitar match acidental ("products" virar id).

// ─── POST /api/admin/gifts/bulk/preview ──────────────────────────────────────
// Fase K2 — retorna SÓ a contagem de quantos brindes vão ser criados/pulados.
// Sem efeitos colaterais. Admin vê o número antes de confirmar o disparo.
//
// Body igual ao /bulk: { filter, from_date?, to_date?, product_id }
//
// Resposta:
//   { audience_total, already_have, will_create }
//
// Definida ANTES do /:id pra não casar acidentalmente.

router.post('/bulk/preview', requireAdmin, async (req, res) => {
    const body = req.body || {};
    const productId = parseInt(body.product_id, 10);
    if (!productId || isNaN(productId)) {
        return res.status(400).json({ success: false, error: 'product_id obrigatório' });
    }
    const filterRes = audienceFilterSql(body.filter, body.from_date, body.to_date);
    if (filterRes.error) {
        return res.status(400).json({ success: false, error: filterRes.error });
    }

    try {
        // 1) Total de emails no filtro temporal de customers.
        const { rows: audRows } = await db.query(`
            SELECT COUNT(*)::int AS total
            FROM customers
            WHERE email IS NOT NULL
              ${filterRes.sql}
        `, filterRes.params);
        const audienceTotal = audRows[0]?.total || 0;

        // 2) Quantos desses já têm brinde NÃO-revogado pro mesmo produto.
        //    Usa o índice gifts_unique_active_per_email_product (status != 'revoked').
        //    Os params do filtro vêm antes do productId (param shift).
        const paramsAlready = [...filterRes.params, productId];
        const productParamIdx = paramsAlready.length; // último
        const { rows: alreadyRows } = await db.query(`
            SELECT COUNT(*)::int AS total
            FROM customers c
            WHERE c.email IS NOT NULL
              ${filterRes.sql}
              AND EXISTS (
                  SELECT 1 FROM gifts g
                  WHERE LOWER(g.email) = LOWER(c.email)
                    AND g.product_id = $${productParamIdx}
                    AND g.status != 'revoked'
              )
        `, paramsAlready);
        const alreadyHave = alreadyRows[0]?.total || 0;

        return res.json({
            success: true,
            audience_total: audienceTotal,
            already_have: alreadyHave,
            will_create: Math.max(0, audienceTotal - alreadyHave),
        });
    } catch (err) {
        logger.error('Erro em /gifts/bulk/preview:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// ─── POST /api/admin/gifts/bulk ──────────────────────────────────────────────
// Fase K2 — concede o brinde a TODOS os emails que casam com o filtro temporal.
// Usa ON CONFLICT DO NOTHING + UNIQUE INDEX PARCIAL (gifts_unique_active_per_email_product)
// pra pular silenciosamente quem já tem o brinde não-revogado.
//
// Body: {
//   filter: 'all'|'today'|'yesterday'|'range',
//   from_date?: 'YYYY-MM-DD', to_date?: 'YYYY-MM-DD' (só pra range),
//   product_id: int,
//   expires_in_hours?: int (0 = vitalício),
//   label?: string
// }
//
// Resposta: { total_emails, gifts_created, gifts_skipped }
//
// Operação cara potencialmente (milhares de inserts). Single query INSERT...
// SELECT FROM customers WHERE filter — Postgres paraleliza. Não precisa de
// loop por email no Node. Em 10k customers, executa em <2s.

router.post('/bulk', requireAdmin, async (req, res) => {
    const body = req.body || {};
    const productId = parseInt(body.product_id, 10);
    if (!productId || isNaN(productId)) {
        return res.status(400).json({ success: false, error: 'product_id obrigatório' });
    }

    const label = String(body.label || '').trim().slice(0, 120) || null;
    const grantedBy = (req.admin && req.admin.username) || null;

    const filterRes = audienceFilterSql(body.filter, body.from_date, body.to_date);
    if (filterRes.error) {
        return res.status(400).json({ success: false, error: filterRes.error });
    }

    // expires_in_hours (0 = vitalício)
    let expiresAt = null;
    if (body.expires_in_hours !== undefined && body.expires_in_hours !== null && body.expires_in_hours !== '') {
        const h = parseInt(body.expires_in_hours, 10);
        if (isNaN(h) || h < 0) {
            return res.status(400).json({ success: false, error: 'expires_in_hours inválido' });
        }
        if (h > 24 * 365 * 5) {
            return res.status(400).json({ success: false, error: 'expires_in_hours muito alto (máx 5 anos)' });
        }
        if (h > 0) expiresAt = new Date(Date.now() + h * 3600 * 1000);
    }

    try {
        // Confirma produto existe + publicado
        const { rows: [prod] } = await db.query(
            `SELECT id, name, is_active, is_published FROM products WHERE id = $1`,
            [productId]
        );
        if (!prod) return res.status(404).json({ success: false, error: 'produto não encontrado' });
        if (!prod.is_active || !prod.is_published) {
            return res.status(400).json({
                success: false,
                error: 'produto não está publicado — publique antes de dar em massa',
            });
        }

        // Conta primeiro a audience pra reportar `total_emails` (mesmo
        // se 0 brindes forem criados por todos já terem).
        const { rows: audRows } = await db.query(`
            SELECT COUNT(*)::int AS total
            FROM customers
            WHERE email IS NOT NULL
              ${filterRes.sql}
        `, filterRes.params);
        const totalEmails = audRows[0]?.total || 0;

        if (totalEmails === 0) {
            return res.json({
                success: true,
                total_emails: 0,
                gifts_created: 0,
                gifts_skipped: 0,
            });
        }

        // INSERT em massa. Params: [...filter, productId, label, expiresAt, grantedBy]
        const insParams = [
            ...filterRes.params,
            productId,
            label,
            expiresAt,
            grantedBy,
        ];
        const base = filterRes.params.length; // últimos 4 são os 4 finais
        const pProd = base + 1, pLabel = base + 2, pExp = base + 3, pBy = base + 4;

        // INSERT ... SELECT FROM customers WHERE filter, ON CONFLICT DO NOTHING.
        // O UNIQUE PARCIAL (gifts_unique_active_per_email_product) pula
        // quem já tem brinde não-revogado pro mesmo produto. RETURNING id
        // pra contar quantos realmente entraram.
        const { rows: created } = await db.query(`
            INSERT INTO gifts (email, product_id, label, expires_at, granted_by, status)
            SELECT
                LOWER(c.email), $${pProd}, $${pLabel}, $${pExp}, $${pBy}, 'active'
            FROM customers c
            WHERE c.email IS NOT NULL
              ${filterRes.sql}
            ON CONFLICT DO NOTHING
            RETURNING id
        `, insParams);

        const giftsCreated = created.length;
        const giftsSkipped = Math.max(0, totalEmails - giftsCreated);

        logger.info(
            `[bulk-gift] filter=${body.filter} product=${productId} ` +
            `total=${totalEmails} created=${giftsCreated} skipped=${giftsSkipped}` +
            (grantedBy ? ` by=${grantedBy}` : '')
        );

        return res.json({
            success: true,
            total_emails: totalEmails,
            gifts_created: giftsCreated,
            gifts_skipped: giftsSkipped,
        });
    } catch (err) {
        logger.error('Erro em /gifts/bulk:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


router.get('/products', requireAdmin, async (req, res) => {
    try {
        const { rows } = await db.query(`
            SELECT id, name, banner_url, COALESCE(product_type, 'content') AS product_type
            FROM products
            WHERE is_active = true AND is_published = true
            ORDER BY name ASC
        `);
        return res.json({ success: true, products: rows });
    } catch (err) {
        logger.error('Erro listando produtos pra gifts:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// ─── GET /api/admin/gifts ────────────────────────────────────────────────────

router.get('/', requireAdmin, async (req, res) => {
    const filters = [];
    const params = [];
    let p = 1;

    if (req.query.email) {
        filters.push(`LOWER(g.email) LIKE $${p++}`);
        params.push('%' + normalizeEmail(req.query.email) + '%');
    }
    if (req.query.product_id) {
        const pid = parseInt(req.query.product_id, 10);
        if (!isNaN(pid)) {
            filters.push(`g.product_id = $${p++}`);
            params.push(pid);
        }
    }
    // status: 'active' (default), 'all', 'expired', 'revoked'
    const statusFilter = String(req.query.status || 'active').toLowerCase();
    if (statusFilter === 'active') {
        // Active = status='active' E não expirou ainda. Lazy check.
        filters.push(`g.status = 'active'`);
        filters.push(`(g.expires_at IS NULL OR g.expires_at > NOW())`);
    } else if (statusFilter !== 'all') {
        filters.push(`g.status = $${p++}`);
        params.push(statusFilter);
    }

    const where = filters.length ? 'WHERE ' + filters.join(' AND ') : '';

    try {
        const { rows } = await db.query(`
            SELECT
                g.id, g.email, g.product_id, g.label,
                g.expires_at, g.granted_at, g.granted_by,
                g.status, g.revoked_at, g.metadata,
                p.name AS product_name,
                p.banner_url AS product_banner,
                COALESCE(p.product_type, 'content') AS product_type
            FROM gifts g
            INNER JOIN products p ON p.id = g.product_id
            ${where}
            ORDER BY g.granted_at DESC, g.id DESC
            LIMIT 500
        `, params);
        return res.json({ success: true, gifts: rows });
    } catch (err) {
        logger.error('Erro listando gifts:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// ─── POST /api/admin/gifts ───────────────────────────────────────────────────

router.post('/', requireAdmin, async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const productId = parseInt(req.body?.product_id, 10);
    const label = String(req.body?.label || '').trim().slice(0, 120) || null;
    const grantedBy = (req.admin && req.admin.username) || null;

    // Validações
    if (!email) return res.status(400).json({ success: false, error: 'email obrigatório' });
    if (email.length > 254 || !EMAIL_RE.test(email)) {
        return res.status(400).json({ success: false, error: 'email inválido' });
    }
    if (!productId || isNaN(productId)) {
        return res.status(400).json({ success: false, error: 'product_id obrigatório' });
    }

    const exp = resolveExpiresAt(req.body || {});
    if (exp.error) return res.status(400).json({ success: false, error: exp.error });

    try {
        // Confirma produto existe e está ativo+publicado
        const { rows: [prod] } = await db.query(
            `SELECT id, name, is_active, is_published FROM products WHERE id = $1`,
            [productId]
        );
        if (!prod) return res.status(404).json({ success: false, error: 'produto não encontrado' });
        if (!prod.is_active || !prod.is_published) {
            return res.status(400).json({
                success: false,
                error: 'produto não está publicado — publique antes de dar de brinde',
            });
        }

        // Idempotência (Fase K2): a regra final é IMPOSTA pelo índice UNIQUE PARCIAL
        // gifts_unique_active_per_email_product (qualquer status != 'revoked' conta).
        // A query JS abaixo é só pra dar uma resposta amigável (409 + gift atual)
        // ANTES de tentar o INSERT — admins esperam ver o brinde que conflita,
        // não só "unique violation".
        //
        // Se a query JS NÃO retornar nada mas o INSERT bater no índice (caso de
        // brinde 'expired' que a query exclui mas o índice inclui), capturamos
        // o 23505 no catch e devolvemos 409 mesmo assim. Sem 500 escondendo
        // conflito real.
        const { rows: existing } = await db.query(`
            SELECT id, email, product_id, label, expires_at, granted_at, status
            FROM gifts
            WHERE LOWER(email) = $1
              AND product_id = $2
              AND status != 'revoked'
            ORDER BY (status = 'active') DESC, granted_at DESC
            LIMIT 1
        `, [email, productId]);
        if (existing.length) {
            return res.status(409).json({
                success: false,
                error: 'Esse email já tem brinde desse produto. Revogue antes de criar um novo, ou edite o atual.',
                gift: existing[0],
            });
        }

        const { rows: [created] } = await db.query(`
            INSERT INTO gifts (email, product_id, label, expires_at, granted_by, status)
            VALUES ($1, $2, $3, $4, $5, 'active')
            RETURNING id, email, product_id, label, expires_at, granted_at,
                      granted_by, status, revoked_at, metadata
        `, [email, productId, label, exp.value, grantedBy]);

        logger.info(`gift criado: id=${created.id} email=${email} product=${productId}` +
                    (exp.value ? ` expira=${exp.value.toISOString()}` : ' (vitalício)') +
                    (grantedBy ? ` by=${grantedBy}` : ''));

        // Anexa info do produto pra UI exibir sem nova request
        return res.status(201).json({
            success: true,
            gift: {
                ...created,
                product_name: prod.name,
            },
        });
    } catch (err) {
        // 23505 = unique_violation. Acontece se o índice UNIQUE pegar entre
        // a query de check e o INSERT (race) ou se o JS errou na checagem
        // (ex: brinde 'expired' que a query antiga ignorava). Tratamos como
        // 409 amigável em vez de 500.
        if (err.code === '23505') {
            logger.warn(`gift insert race: email=${email} product=${productId}`);
            return res.status(409).json({
                success: false,
                error: 'Esse email já tem brinde desse produto. Revogue antes de criar um novo.',
            });
        }
        logger.error('Erro criando gift:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// ─── PUT /api/admin/gifts/:id ────────────────────────────────────────────────
// Edita parcialmente: expires_at (ou expires_in_hours), label, status.

router.put('/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) {
        return res.status(400).json({ success: false, error: 'ID inválido' });
    }

    const updates = [];
    const values = [];
    let p = 1;

    // label
    if (req.body && req.body.label !== undefined) {
        const label = String(req.body.label || '').trim().slice(0, 120) || null;
        updates.push(`label = $${p++}`); values.push(label);
    }

    // status
    if (req.body && req.body.status !== undefined) {
        const s = String(req.body.status).toLowerCase();
        if (!['active', 'expired', 'revoked'].includes(s)) {
            return res.status(400).json({ success: false, error: 'status inválido' });
        }
        updates.push(`status = $${p++}`); values.push(s);
        if (s === 'revoked') {
            updates.push(`revoked_at = NOW()`);
        }
    }

    // expires_at via helper (aceita expires_in_hours ou expires_at)
    if (req.body && (req.body.expires_in_hours !== undefined || req.body.expires_at !== undefined)) {
        const exp = resolveExpiresAt(req.body);
        if (exp.error) return res.status(400).json({ success: false, error: exp.error });
        updates.push(`expires_at = $${p++}`); values.push(exp.value);
    }

    if (!updates.length) {
        return res.status(400).json({ success: false, error: 'Nada pra atualizar' });
    }

    values.push(id);
    try {
        const { rows } = await db.query(`
            UPDATE gifts
            SET ${updates.join(', ')}
            WHERE id = $${p}
            RETURNING id, email, product_id, label, expires_at, granted_at,
                      granted_by, status, revoked_at, metadata
        `, values);

        if (!rows.length) {
            return res.status(404).json({ success: false, error: 'Brinde não encontrado' });
        }
        logger.info(`gift atualizado: id=${id} fields=${updates.join(',')}`);
        return res.json({ success: true, gift: rows[0] });
    } catch (err) {
        logger.error('Erro editando gift:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// ─── DELETE /api/admin/gifts/:id ─────────────────────────────────────────────
// Soft-delete: marca status='revoked'. Mantém histórico pra auditoria.

router.delete('/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) {
        return res.status(400).json({ success: false, error: 'ID inválido' });
    }
    try {
        const { rows } = await db.query(`
            UPDATE gifts
            SET status = 'revoked', revoked_at = NOW()
            WHERE id = $1 AND status != 'revoked'
            RETURNING id
        `, [id]);
        if (!rows.length) {
            // Pode ser que já estava revogado OU não existe — devolvemos 404 só
            // se não existir. Idempotência: revogar 2x não é erro.
            const { rows: check } = await db.query(`SELECT id FROM gifts WHERE id = $1`, [id]);
            if (!check.length) {
                return res.status(404).json({ success: false, error: 'Brinde não encontrado' });
            }
            return res.json({ success: true, revoked: true, idempotent: true });
        }
        logger.info(`gift revogado: id=${id}`);
        return res.json({ success: true, revoked: true });
    } catch (err) {
        logger.error('Erro revogando gift:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


module.exports = router;
