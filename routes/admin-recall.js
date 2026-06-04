/**
 * =============================================================================
 * routes/admin-recall.js — CRUD de recall messages
 * =============================================================================
 *
 * Mensagens exibidas no acervo (GET /api/user/library) e no endpoint
 * /api/user/calls/:product_id/start quando o cliente ja consumiu a
 * video-chamada do produto.
 *
 * MODELO ATUAL (Fase C, mai/2026):
 *   - Pool global de mensagens ativas, ordenadas por display_order.
 *   - Bucket de tempo (system_settings.recall_rotation_interval_minutes,
 *     default 30) decide qual mensagem mostrar pra TODOS os clientes.
 *   - Mesma janela = mesma mensagem. Muda no proximo bucket.
 *
 * MODELO ANTIGO (descontinuado): janela em dias (min_days/max_days).
 *   Campos foram dropados da tabela pela migration. Backend ignora silenciosamente
 *   se vier no payload (compat legada).
 *
 * Endpoints:
 *   GET    /api/admin/recall-messages
 *   POST   /api/admin/recall-messages
 *   PUT    /api/admin/recall-messages/:id
 *   DELETE /api/admin/recall-messages/:id
 *   GET    /api/admin/recall-messages/settings/rotation
 *   PUT    /api/admin/recall-messages/settings/rotation   { interval_minutes }
 *   GET    /api/admin/recall-messages/now            (debug — qual ta tocando agora)
 * =============================================================================
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAdmin } = require('../lib/auth');
const { logger } = require('../lib/logger');


// ─── Helpers de validacao ────────────────────────────────────────────────────

function parseAndValidatePayload(body, { partial = false } = {}) {
    const errors = [];
    const data = {};

    // message
    if (body.message !== undefined) {
        if (typeof body.message !== 'string') {
            errors.push('message deve ser string');
        } else {
            const trimmed = body.message.trim();
            if (!trimmed) errors.push('message não pode ser vazia');
            else if (trimmed.length > 2000) errors.push('message muito longa (máx 2000)');
            else data.message = trimmed;
        }
    } else if (!partial) {
        errors.push('message é obrigatória');
    }

    // priority (mantido por compatibilidade legada — display_order e' o canal novo)
    if (body.priority !== undefined) {
        const v = parseInt(body.priority, 10);
        if (isNaN(v)) errors.push('priority deve ser inteiro');
        else data.priority = v;
    } else if (!partial) {
        data.priority = 0;
    }

    // display_order
    if (body.display_order !== undefined) {
        const v = parseInt(body.display_order, 10);
        if (isNaN(v) || v < 0) errors.push('display_order deve ser inteiro >= 0');
        else data.display_order = v;
    } else if (!partial) {
        data.display_order = 0;
    }

    // active
    if (body.active !== undefined) {
        data.active = body.active === true || body.active === 'true' || body.active === 1;
    } else if (!partial) {
        data.active = true;
    }

    // min_days/max_days: IGNORADOS silenciosamente se vierem (compat legada).
    // Nao retornamos erro pra nao quebrar admin antigo cacheado no navegador.

    return { data, errors };
}

function parseInterval(raw) {
    if (raw == null) return null;
    const v = parseInt(raw, 10);
    if (isNaN(v) || v < 1 || v > 60 * 24 * 30) return null; // 1 min ate 30 dias
    return v;
}


// ─── Settings da rotacao ─────────────────────────────────────────────────────
//
// Definidos ANTES dos /:id pra evitar match acidental ("settings" virar id).

router.get('/settings/rotation', requireAdmin, async (req, res) => {
    try {
        const { rows: [s] } = await db.query(
            `SELECT value FROM system_settings WHERE key = 'recall_rotation_interval_minutes'`
        );
        let interval = 30;
        if (s && s.value != null) {
            const raw = (typeof s.value === 'string') ? s.value.replace(/"/g, '') : s.value;
            const parsed = parseInt(raw, 10);
            if (!isNaN(parsed) && parsed > 0) interval = parsed;
        }
        return res.json({ success: true, interval_minutes: interval });
    } catch (err) {
        logger.error('Erro lendo recall_rotation_interval_minutes:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

router.put('/settings/rotation', requireAdmin, async (req, res) => {
    const interval = parseInterval(req.body?.interval_minutes);
    if (interval == null) {
        return res.status(400).json({ success: false, error: 'interval_minutes deve ser inteiro entre 1 e 43200' });
    }
    try {
        // Upsert por (key) — system_settings tem PK em key.
        await db.query(`
            INSERT INTO system_settings (key, value, description, updated_at)
            VALUES ('recall_rotation_interval_minutes', $1::jsonb,
                    'Intervalo (em minutos) entre as mensagens de recompra no acervo.',
                    NOW())
            ON CONFLICT (key) DO UPDATE
                SET value = EXCLUDED.value,
                    updated_at = NOW()
        `, [JSON.stringify(interval)]);
        logger.info(`recall_rotation_interval_minutes atualizado para ${interval}`);
        return res.json({ success: true, interval_minutes: interval });
    } catch (err) {
        logger.error('Erro atualizando recall_rotation_interval_minutes:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// ─── "Tocando agora" (debug pra admin ver qual msg ta na janela atual) ──────

router.get('/now', requireAdmin, async (req, res) => {
    try {
        const { rows: [s] } = await db.query(
            `SELECT value FROM system_settings WHERE key = 'recall_rotation_interval_minutes'`
        );
        let interval = 30;
        if (s && s.value != null) {
            const raw = (typeof s.value === 'string') ? s.value.replace(/"/g, '') : s.value;
            const parsed = parseInt(raw, 10);
            if (!isNaN(parsed) && parsed > 0) interval = parsed;
        }
        const { rows: msgs } = await db.query(`
            SELECT id, message, display_order
            FROM recall_messages
            WHERE active = true
            ORDER BY display_order ASC, id ASC
        `);
        if (!msgs.length) {
            return res.json({ success: true, current: null, interval_minutes: interval, total: 0 });
        }
        const bucket = Math.floor(Date.now() / (interval * 60 * 1000));
        const idx = ((bucket % msgs.length) + msgs.length) % msgs.length;
        const current = msgs[idx];
        // Quanto tempo falta pra mudar (em ms)
        const nextBucketStart = (bucket + 1) * interval * 60 * 1000;
        const msUntilNext = nextBucketStart - Date.now();
        return res.json({
            success: true,
            current_id: current.id,
            current_message: current.message,
            interval_minutes: interval,
            total: msgs.length,
            ms_until_next: msUntilNext,
        });
    } catch (err) {
        logger.error('Erro em /recall-messages/now:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// ─── CRUD principal ─────────────────────────────────────────────────────────

/**
 * GET /api/admin/recall-messages
 * Lista ordenada por display_order ASC, id ASC (mesma ordem da rotacao).
 */
router.get('/', requireAdmin, async (req, res) => {
    try {
        const { rows } = await db.query(`
            SELECT id, message, active, priority, display_order,
                   created_at, updated_at
            FROM recall_messages
            ORDER BY display_order ASC, id ASC
        `);
        return res.json({ success: true, messages: rows });
    } catch (err) {
        logger.error('Erro listando recall_messages:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


/**
 * POST /api/admin/recall-messages
 * Body: { message, display_order?, priority?, active? }
 */
router.post('/', requireAdmin, async (req, res) => {
    const { data, errors } = parseAndValidatePayload(req.body || {}, { partial: false });
    if (errors.length) {
        return res.status(400).json({ success: false, error: errors.join('; ') });
    }

    try {
        const { rows: [created] } = await db.query(`
            INSERT INTO recall_messages (message, priority, display_order, active)
            VALUES ($1, $2, $3, $4)
            RETURNING id, message, active, priority, display_order, created_at, updated_at
        `, [data.message, data.priority, data.display_order, data.active]);

        logger.info(`recall_message criada: id=${created.id} order=${created.display_order}`);
        return res.status(201).json({ success: true, message: created });
    } catch (err) {
        logger.error('Erro criando recall_message:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


/**
 * PUT /api/admin/recall-messages/:id
 * Edita parcialmente. So atualiza os campos enviados.
 */
router.put('/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) {
        return res.status(400).json({ success: false, error: 'ID inválido' });
    }

    const { data, errors } = parseAndValidatePayload(req.body || {}, { partial: true });
    if (errors.length) {
        return res.status(400).json({ success: false, error: errors.join('; ') });
    }

    const updates = [];
    const values = [];
    let p = 1;

    if (data.message !== undefined)       { updates.push(`message       = $${p++}`); values.push(data.message);       }
    if (data.priority !== undefined)      { updates.push(`priority      = $${p++}`); values.push(data.priority);      }
    if (data.display_order !== undefined) { updates.push(`display_order = $${p++}`); values.push(data.display_order); }
    if (data.active !== undefined)        { updates.push(`active        = $${p++}`); values.push(data.active);        }

    if (!updates.length) {
        return res.status(400).json({ success: false, error: 'Nada pra atualizar' });
    }

    updates.push(`updated_at = NOW()`);
    values.push(id);

    try {
        const { rows } = await db.query(`
            UPDATE recall_messages
            SET ${updates.join(', ')}
            WHERE id = $${p}
            RETURNING id, message, active, priority, display_order, created_at, updated_at
        `, values);

        if (!rows.length) {
            return res.status(404).json({ success: false, error: 'Mensagem não encontrada' });
        }

        logger.info(`recall_message atualizada: id=${id}`);
        return res.json({ success: true, message: rows[0] });
    } catch (err) {
        logger.error('Erro editando recall_message:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


/**
 * DELETE /api/admin/recall-messages/:id
 */
router.delete('/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) {
        return res.status(400).json({ success: false, error: 'ID inválido' });
    }

    try {
        const { rowCount } = await db.query(`DELETE FROM recall_messages WHERE id = $1`, [id]);
        if (!rowCount) {
            return res.status(404).json({ success: false, error: 'Mensagem não encontrada' });
        }
        logger.info(`recall_message deletada: id=${id}`);
        return res.json({ success: true, deleted: true });
    } catch (err) {
        logger.error('Erro deletando recall_message:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


module.exports = router;
