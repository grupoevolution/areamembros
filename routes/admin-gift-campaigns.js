/**
 * =============================================================================
 * routes/admin-gift-campaigns.js — Campanhas de brinde / "link mágico" (Fase K2)
 * =============================================================================
 *
 * Admin cria uma campanha. Sistema gera um código (slug) único. Link é:
 *   https://a.membrosvips.com/?campanha=<code>
 *
 * Qualquer cliente que abrir o link, salvar o código (frontend → localStorage)
 * e LOGAR com aquele código pendente, recebe automaticamente o brinde do
 * produto vinculado. Detalhes do resgate em lib/gift-campaigns.js.
 *
 * Endpoints:
 *   GET    /api/admin/gift-campaigns          lista (todas, ordenado por created_at)
 *   POST   /api/admin/gift-campaigns          cria { product_id, expires_in_hours?,
 *                                                     max_redemptions?, campaign_expires_at?,
 *                                                     label?, code? }
 *   PUT    /api/admin/gift-campaigns/:id      edita { active?, max_redemptions?,
 *                                                     campaign_expires_at?, label? }
 *   DELETE /api/admin/gift-campaigns/:id      desativa (soft: active=false)
 *
 * Decisões:
 *   - code é gerado server-side a partir de label (slugify) se admin não passar.
 *     Se colidir com existente, adiciona sufixo numérico (-2, -3, ...).
 *   - DELETE é SOFT (active=false). Mantém histórico de redemptions intacto.
 *     Pra apagar de verdade, o admin teria que dropar manualmente no banco.
 *   - Edição NÃO permite trocar product_id nem expires_in_hours dos brindes
 *     futuros — esses afetam contratos com clientes que clicaram. Quer mudar?
 *     Cria nova campanha, desativa a antiga.
 * =============================================================================
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAdmin } = require('../lib/auth');
const { logger } = require('../lib/logger');


// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Slugify simples: minúscula, sem acento, hífen no lugar de espaço, max 40.
 * Suficiente pra URL. Não precisa ser canônico — só não pode quebrar a URL.
 */
function slugify(input) {
    // ̀-ͯ = "Combining Diacritical Marks". Depois do NFD decompose,
    // todos os acentos viram esses caracteres separados — removendo, sobra
    // letra ASCII sem acento. Escape Unicode pra evitar problemas de encoding
    // do arquivo fonte.
    const cleaned = String(input || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
    return cleaned || ('promo-' + Date.now().toString(36));
}

/**
 * Gera um code único. Se o `base` já existe, tenta `base-2`, `base-3`, ...
 * Limita a 10 tentativas pra não loopar — se isso acontecer, anexa random.
 */
async function ensureUniqueCode(base) {
    let code = base;
    for (let i = 2; i <= 10; i++) {
        const { rows } = await db.query(
            `SELECT 1 FROM gift_campaigns WHERE code = $1`,
            [code]
        );
        if (!rows.length) return code;
        code = `${base}-${i}`.slice(0, 40);
    }
    // Fallback: adiciona random 4-hex
    return (base.slice(0, 35) + '-' + require('crypto').randomBytes(2).toString('hex')).slice(0, 40);
}


// ─── GET /api/admin/gift-campaigns ───────────────────────────────────────────

router.get('/', requireAdmin, async (req, res) => {
    try {
        const { rows } = await db.query(`
            SELECT
                gc.id, gc.code, gc.product_id, gc.expires_in_hours,
                gc.campaign_expires_at, gc.max_redemptions, gc.redemptions_count,
                gc.label, gc.active, gc.created_at, gc.created_by,
                p.name AS product_name,
                p.banner_url AS product_banner,
                COALESCE(p.product_type, 'content') AS product_type
            FROM gift_campaigns gc
            INNER JOIN products p ON p.id = gc.product_id
            ORDER BY gc.active DESC, gc.created_at DESC, gc.id DESC
            LIMIT 500
        `);
        return res.json({ success: true, campaigns: rows });
    } catch (err) {
        logger.error('Erro listando gift_campaigns:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// ─── POST /api/admin/gift-campaigns ──────────────────────────────────────────

router.post('/', requireAdmin, async (req, res) => {
    const body = req.body || {};
    const productId = parseInt(body.product_id, 10);
    if (!productId || isNaN(productId)) {
        return res.status(400).json({ success: false, error: 'product_id obrigatório' });
    }

    const label = String(body.label || '').trim().slice(0, 120) || null;
    const grantedBy = (req.admin && req.admin.username) || null;

    // expires_in_hours (0/null = vitalício)
    let expiresInHours = null;
    if (body.expires_in_hours !== undefined && body.expires_in_hours !== null && body.expires_in_hours !== '') {
        const h = parseInt(body.expires_in_hours, 10);
        if (isNaN(h) || h < 0) {
            return res.status(400).json({ success: false, error: 'expires_in_hours inválido' });
        }
        if (h > 24 * 365 * 5) {
            return res.status(400).json({ success: false, error: 'expires_in_hours muito alto (máx 5 anos)' });
        }
        expiresInHours = h > 0 ? h : null;
    }

    // max_redemptions (null = ilimitado)
    let maxRedemptions = null;
    if (body.max_redemptions !== undefined && body.max_redemptions !== null && body.max_redemptions !== '') {
        const m = parseInt(body.max_redemptions, 10);
        if (isNaN(m) || m < 0) {
            return res.status(400).json({ success: false, error: 'max_redemptions inválido' });
        }
        maxRedemptions = m > 0 ? m : null;
    }

    // campaign_expires_at (null = link nunca expira)
    let campaignExpiresAt = null;
    if (body.campaign_expires_at) {
        const d = new Date(body.campaign_expires_at);
        if (isNaN(d.getTime())) {
            return res.status(400).json({ success: false, error: 'campaign_expires_at inválido (ISO 8601)' });
        }
        if (d.getTime() < Date.now() - 60 * 1000) {
            return res.status(400).json({ success: false, error: 'campaign_expires_at já passou' });
        }
        campaignExpiresAt = d;
    }

    try {
        // Confirma produto existe e está publicado
        const { rows: [prod] } = await db.query(
            `SELECT id, name, is_active, is_published FROM products WHERE id = $1`,
            [productId]
        );
        if (!prod) return res.status(404).json({ success: false, error: 'produto não encontrado' });
        if (!prod.is_active || !prod.is_published) {
            return res.status(400).json({
                success: false,
                error: 'produto não está publicado — publique antes de criar campanha',
            });
        }

        // Decide o code. Admin pode passar um manual ou geramos do label.
        let rawCode = String(body.code || '').trim();
        if (!rawCode) rawCode = label || prod.name;
        const baseCode = slugify(rawCode);
        const code = await ensureUniqueCode(baseCode);

        const { rows: [created] } = await db.query(`
            INSERT INTO gift_campaigns
                (code, product_id, expires_in_hours, campaign_expires_at,
                 max_redemptions, label, active, created_by)
            VALUES ($1, $2, $3, $4, $5, $6, true, $7)
            RETURNING id, code, product_id, expires_in_hours, campaign_expires_at,
                      max_redemptions, redemptions_count, label, active, created_at, created_by
        `, [code, productId, expiresInHours, campaignExpiresAt, maxRedemptions, label, grantedBy]);

        logger.info(`[gift-campaign] criada code=${code} product=${productId}` +
                    (grantedBy ? ` by=${grantedBy}` : ''));

        return res.status(201).json({
            success: true,
            campaign: {
                ...created,
                product_name: prod.name,
            },
        });
    } catch (err) {
        logger.error('Erro criando gift_campaign:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// ─── PUT /api/admin/gift-campaigns/:id ───────────────────────────────────────
// Edita: active, max_redemptions, campaign_expires_at, label.
// NÃO permite mudar product_id nem expires_in_hours (afetariam brindes futuros).

router.put('/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) {
        return res.status(400).json({ success: false, error: 'ID inválido' });
    }
    const body = req.body || {};
    const updates = [];
    const values = [];
    let p = 1;

    if (body.active !== undefined) {
        updates.push(`active = $${p++}`); values.push(!!body.active);
    }
    if (body.label !== undefined) {
        const lbl = String(body.label || '').trim().slice(0, 120) || null;
        updates.push(`label = $${p++}`); values.push(lbl);
    }
    if (body.max_redemptions !== undefined) {
        if (body.max_redemptions === null || body.max_redemptions === '') {
            updates.push(`max_redemptions = NULL`);
        } else {
            const m = parseInt(body.max_redemptions, 10);
            if (isNaN(m) || m < 0) {
                return res.status(400).json({ success: false, error: 'max_redemptions inválido' });
            }
            updates.push(`max_redemptions = $${p++}`); values.push(m > 0 ? m : null);
        }
    }
    if (body.campaign_expires_at !== undefined) {
        if (body.campaign_expires_at === null || body.campaign_expires_at === '') {
            updates.push(`campaign_expires_at = NULL`);
        } else {
            const d = new Date(body.campaign_expires_at);
            if (isNaN(d.getTime())) {
                return res.status(400).json({ success: false, error: 'campaign_expires_at inválido' });
            }
            updates.push(`campaign_expires_at = $${p++}`); values.push(d);
        }
    }

    if (!updates.length) {
        return res.status(400).json({ success: false, error: 'Nada pra atualizar' });
    }

    values.push(id);
    try {
        const { rows } = await db.query(`
            UPDATE gift_campaigns
            SET ${updates.join(', ')}
            WHERE id = $${p}
            RETURNING id, code, product_id, expires_in_hours, campaign_expires_at,
                      max_redemptions, redemptions_count, label, active, created_at, created_by
        `, values);
        if (!rows.length) {
            return res.status(404).json({ success: false, error: 'Campanha não encontrada' });
        }
        logger.info(`[gift-campaign] atualizada id=${id} fields=${updates.join(',')}`);
        return res.json({ success: true, campaign: rows[0] });
    } catch (err) {
        logger.error('Erro editando gift_campaign:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// ─── DELETE /api/admin/gift-campaigns/:id ────────────────────────────────────
// Soft-delete: marca active=false. Link para de funcionar imediatamente
// (lib/gift-campaigns.js checa active no SELECT). Histórico fica intacto.

router.delete('/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) {
        return res.status(400).json({ success: false, error: 'ID inválido' });
    }
    try {
        const { rows } = await db.query(`
            UPDATE gift_campaigns
            SET active = false
            WHERE id = $1
            RETURNING id
        `, [id]);
        if (!rows.length) {
            return res.status(404).json({ success: false, error: 'Campanha não encontrada' });
        }
        logger.info(`[gift-campaign] desativada id=${id}`);
        return res.json({ success: true, deactivated: true });
    } catch (err) {
        logger.error('Erro desativando gift_campaign:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


module.exports = router;
