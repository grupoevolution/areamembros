/**
 * =============================================================================
 * routes/admin-preview.js — CRUD de e-mails premium (preview mode)
 * =============================================================================
 *
 * E-mails cadastrados aqui entram no app como se tivessem comprado TODOS
 * os produtos publicados. Sem gravar consumo, sem aparecer em metricas.
 *
 * Endpoints:
 *   GET    /api/admin/preview-emails
 *   POST   /api/admin/preview-emails       { email, label? }
 *   DELETE /api/admin/preview-emails/:id
 * =============================================================================
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAdmin } = require('../lib/auth');
const { logger } = require('../lib/logger');
const { invalidatePreviewCache } = require('../lib/preview');


// Regex basico de email (mesma do login do cliente — mantem consistente)
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(raw) {
    return String(raw || '').toLowerCase().trim();
}


// ─── GET — lista ─────────────────────────────────────────────────────────────

router.get('/', requireAdmin, async (req, res) => {
    try {
        const { rows } = await db.query(`
            SELECT id, email, label, created_at
            FROM preview_emails
            ORDER BY created_at DESC, id DESC
        `);
        return res.json({ success: true, preview_emails: rows });
    } catch (err) {
        logger.error('Erro listando preview_emails:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// ─── POST — cria ─────────────────────────────────────────────────────────────

router.post('/', requireAdmin, async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const label = String(req.body?.label || '').trim().slice(0, 120) || null;

    if (!email) {
        return res.status(400).json({ success: false, error: 'Email obrigatório' });
    }
    if (email.length > 254 || !EMAIL_RE.test(email)) {
        return res.status(400).json({ success: false, error: 'Email inválido' });
    }

    try {
        // Idempotencia: se ja existe, retorna 409 com o registro existente
        // (assim o admin sabe que ja estava la, em vez de erro generico).
        const { rows: existing } = await db.query(
            `SELECT id, email, label, created_at FROM preview_emails WHERE LOWER(email) = $1`,
            [email]
        );
        if (existing.length) {
            return res.status(409).json({
                success: false,
                error: 'E-mail já cadastrado',
                preview_email: existing[0],
            });
        }

        const { rows: [created] } = await db.query(`
            INSERT INTO preview_emails (email, label)
            VALUES ($1, $2)
            RETURNING id, email, label, created_at
        `, [email, label]);

        invalidatePreviewCache();
        logger.info(`preview_email criado: ${email}${label ? ' ('+label+')' : ''}`);
        return res.status(201).json({ success: true, preview_email: created });
    } catch (err) {
        // Race: pode ter sido inserido entre o SELECT e o INSERT.
        if (err.code === '23505') {
            return res.status(409).json({ success: false, error: 'E-mail já cadastrado' });
        }
        logger.error('Erro criando preview_email:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// ─── DELETE — remove ─────────────────────────────────────────────────────────

router.delete('/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) {
        return res.status(400).json({ success: false, error: 'ID inválido' });
    }
    try {
        const { rowCount } = await db.query(`DELETE FROM preview_emails WHERE id = $1`, [id]);
        if (!rowCount) {
            return res.status(404).json({ success: false, error: 'Não encontrado' });
        }
        invalidatePreviewCache();
        logger.info(`preview_email removido: id=${id}`);
        return res.json({ success: true, deleted: true });
    } catch (err) {
        logger.error('Erro removendo preview_email:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


module.exports = router;
