/**
 * =============================================================================
 * routes/admin-calls.js — CRUD de chamadas de vídeo simuladas
 * =============================================================================
 *
 * Replica em PostgreSQL + JSON API a feature original do projeto
 * `conteudo-main` (SQLite + EJS).
 *
 * Endpoints:
 *   GET    /api/admin/calls               Lista todas
 *   GET    /api/admin/calls/:id           Detalhe de 1
 *   POST   /api/admin/calls               Cria nova
 *   PUT    /api/admin/calls/:id           Edita
 *   POST   /api/admin/calls/:id/toggle    Ativa/desativa
 *   DELETE /api/admin/calls/:id           Exclui
 *
 * Tabela: video_calls (criada por migration em lib/migrations.js).
 * =============================================================================
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const { logger } = require('../lib/logger');
const { requireAdmin } = require('../lib/auth');


// ─── Helpers ─────────────────────────────────────────────────────────────────

function sanitizeSlug(input) {
    return String(input || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')      // remove acentos
        .replace(/[^a-z0-9]+/g, '-')          // tudo que não é alfanumérico vira '-'
        .replace(/^-+|-+$/g, '')              // tira hifens das pontas
        .slice(0, 80);
}

function validateCategory(c) {
    return c === 'vip' ? 'vip' : 'amostra';
}

function validateTrigger(t) {
    if (t === 'on_login') return 'on_login';
    if (t === 'scheduled') return 'scheduled';
    return 'manual';
}


// ─── GET /api/admin/calls — lista todas ──────────────────────────────────────

router.get('/', requireAdmin, async (req, res) => {
    try {
        const { rows } = await db.query(`
            SELECT id, name, slug, category, model_name, model_photo,
                   video_url, redirect_link, cta_text,
                   cta_type, cta_target_id,
                   trigger_type, trigger_delay_sec, active,
                   created_at, updated_at
            FROM video_calls
            ORDER BY created_at DESC
        `);
        return res.json({ success: true, calls: rows });
    } catch (err) {
        logger.error('Erro listando chamadas:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// ─── GET /api/admin/calls/:id — detalhe ──────────────────────────────────────

router.get('/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { rows } = await db.query(`SELECT * FROM video_calls WHERE id = $1`, [id]);
        if (!rows.length) return res.status(404).json({ success: false, error: 'Não encontrado' });
        return res.json({ success: true, call: rows[0] });
    } catch (err) {
        logger.error('Erro buscando chamada:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// ─── POST /api/admin/calls — cria nova ───────────────────────────────────────

router.post('/', requireAdmin, async (req, res) => {
    try {
        const {
            name, slug, category, model_name, model_photo, video_url,
            redirect_link, cta_text, trigger_type, trigger_delay_sec, active,
            cta_type, cta_target_id,
        } = req.body || {};

        if (!model_name || typeof model_name !== 'string' || model_name.trim().length < 1) {
            return res.status(400).json({ success: false, error: 'Nome da modelo obrigatório' });
        }
        const cleanSlug = sanitizeSlug(slug || model_name);
        if (!cleanSlug) {
            return res.status(400).json({ success: false, error: 'Slug inválido' });
        }

        // Garante que slug é único
        const { rows: dup } = await db.query('SELECT id FROM video_calls WHERE slug = $1', [cleanSlug]);
        if (dup.length) {
            return res.status(400).json({ success: false, error: 'Slug já existe — escolha outro' });
        }

        const delaySec = Math.max(0, Math.min(120, parseInt(trigger_delay_sec, 10) || 5));
        const validCtaTypes = ['home', 'calls_catalog', 'product', 'category', 'external'];
        const ctaT = validCtaTypes.includes(cta_type) ? cta_type : 'home';
        const ctaTarget = cta_target_id ? parseInt(cta_target_id, 10) || null : null;

        const { rows } = await db.query(`
            INSERT INTO video_calls (
                name, slug, category, model_name, model_photo, video_url,
                redirect_link, cta_text, trigger_type, trigger_delay_sec, active,
                cta_type, cta_target_id
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            RETURNING *
        `, [
            (name || model_name).trim().slice(0, 120),
            cleanSlug,
            validateCategory(category),
            model_name.trim().slice(0, 120),
            (model_photo || '').trim().slice(0, 1000) || null,
            (video_url || '').trim().slice(0, 1000) || null,
            (redirect_link || '').trim().slice(0, 1000) || null,
            (cta_text || '').trim().slice(0, 60) || null,
            validateTrigger(trigger_type),
            delaySec,
            active !== false,
            ctaT,
            ctaTarget,
        ]);

        return res.json({ success: true, call: rows[0] });
    } catch (err) {
        logger.error('Erro criando chamada:', err);
        return res.status(500).json({ success: false, error: err.message || 'Erro interno' });
    }
});


// ─── PUT /api/admin/calls/:id — edita ────────────────────────────────────────

router.put('/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const {
            name, slug, category, model_name, model_photo, video_url,
            redirect_link, cta_text, trigger_type, trigger_delay_sec, active,
            cta_type, cta_target_id,
        } = req.body || {};

        const updates = [];
        const values = [];
        let p = 1;

        if (name !== undefined) { updates.push(`name = $${p++}`); values.push(String(name).trim().slice(0, 120)); }
        if (slug !== undefined) {
            const clean = sanitizeSlug(slug);
            if (!clean) return res.status(400).json({ success: false, error: 'Slug inválido' });
            // valida unicidade exceto self
            const { rows: dup } = await db.query('SELECT id FROM video_calls WHERE slug = $1 AND id <> $2', [clean, id]);
            if (dup.length) return res.status(400).json({ success: false, error: 'Slug já existe' });
            updates.push(`slug = $${p++}`); values.push(clean);
        }
        if (category !== undefined)      { updates.push(`category = $${p++}`); values.push(validateCategory(category)); }
        if (model_name !== undefined)    { updates.push(`model_name = $${p++}`); values.push(String(model_name).trim().slice(0, 120)); }
        if (model_photo !== undefined)   { updates.push(`model_photo = $${p++}`); values.push((model_photo || '').trim().slice(0, 1000) || null); }
        if (video_url !== undefined)     { updates.push(`video_url = $${p++}`); values.push((video_url || '').trim().slice(0, 1000) || null); }
        if (redirect_link !== undefined) { updates.push(`redirect_link = $${p++}`); values.push((redirect_link || '').trim().slice(0, 1000) || null); }
        if (cta_text !== undefined)      { updates.push(`cta_text = $${p++}`); values.push((cta_text || '').trim().slice(0, 60) || null); }
        if (trigger_type !== undefined)  { updates.push(`trigger_type = $${p++}`); values.push(validateTrigger(trigger_type)); }
        if (trigger_delay_sec !== undefined) {
            const d = Math.max(0, Math.min(120, parseInt(trigger_delay_sec, 10) || 0));
            updates.push(`trigger_delay_sec = $${p++}`); values.push(d);
        }
        if (active !== undefined) { updates.push(`active = $${p++}`); values.push(!!active); }
        if (cta_type !== undefined) {
            const valid = ['home', 'calls_catalog', 'product', 'category', 'external'];
            updates.push(`cta_type = $${p++}`); values.push(valid.includes(cta_type) ? cta_type : 'home');
        }
        if (cta_target_id !== undefined) {
            updates.push(`cta_target_id = $${p++}`); values.push(cta_target_id ? parseInt(cta_target_id, 10) || null : null);
        }

        if (!updates.length) return res.status(400).json({ success: false, error: 'Nada pra atualizar' });

        updates.push('updated_at = NOW()');
        values.push(id);

        const { rows } = await db.query(
            `UPDATE video_calls SET ${updates.join(', ')} WHERE id = $${p} RETURNING *`,
            values
        );
        if (!rows.length) return res.status(404).json({ success: false, error: 'Não encontrada' });
        return res.json({ success: true, call: rows[0] });
    } catch (err) {
        logger.error('Erro atualizando chamada:', err);
        return res.status(500).json({ success: false, error: err.message || 'Erro interno' });
    }
});


// ─── POST /api/admin/calls/:id/toggle ────────────────────────────────────────

router.post('/:id/toggle', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { rows } = await db.query(
            `UPDATE video_calls SET active = NOT active, updated_at = NOW()
             WHERE id = $1 RETURNING active`,
            [id]
        );
        if (!rows.length) return res.status(404).json({ success: false, error: 'Não encontrada' });
        return res.json({ success: true, active: rows[0].active });
    } catch (err) {
        logger.error('Erro toggle chamada:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// ─── DELETE /api/admin/calls/:id ─────────────────────────────────────────────

router.delete('/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { rowCount } = await db.query(`DELETE FROM video_calls WHERE id = $1`, [id]);
        if (!rowCount) return res.status(404).json({ success: false, error: 'Não encontrada' });
        return res.json({ success: true, deleted: true });
    } catch (err) {
        logger.error('Erro deletando chamada:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


module.exports = router;
