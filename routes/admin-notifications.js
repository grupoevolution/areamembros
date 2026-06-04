/**
 * =============================================================================
 * routes/admin-notifications.js
 * =============================================================================
 * CRUD de notificações que o admin envia aos clientes.
 * =============================================================================
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const { logger } = require('../lib/logger');
const { requireAdmin } = require('../lib/auth');

// =============================================================================
// GET /api/admin/notifications — lista notificações
// =============================================================================
router.get('/', requireAdmin, async (req, res) => {
    try {
        const { status, limit = 50 } = req.query;
        const conditions = [];
        const params = [];
        
        if (status) {
            params.push(status);
            conditions.push(`status = $${params.length}`);
        }
        
        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        params.push(parseInt(limit, 10) || 50);
        
        const { rows } = await db.query(`
            SELECT id, title, body, type, target_type, target_value,
                   cta_text, cta_url, icon, scheduled_at, sent_at,
                   sent_count, read_count, status, created_at
            FROM notifications
            ${where}
            ORDER BY created_at DESC
            LIMIT $${params.length}
        `, params);
        
        return res.json({ success: true, notifications: rows });
    } catch (err) {
        logger.error('Erro listando notificações:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// =============================================================================
// POST /api/admin/notifications — cria nova
// =============================================================================
router.post('/', requireAdmin, async (req, res) => {
    try {
        const {
            title, body, type, target_type, target_value,
            cta_text, cta_url, icon, scheduled_at, send_now
        } = req.body || {};
        
        if (!title || typeof title !== 'string' || title.trim().length < 2) {
            return res.status(400).json({ success: false, error: 'Título inválido' });
        }
        if (!body || typeof body !== 'string' || body.trim().length < 2) {
            return res.status(400).json({ success: false, error: 'Mensagem inválida' });
        }
        
        const validTypes = ['in_app', 'email', 'push'];
        const finalType = validTypes.includes(type) ? type : 'in_app';
        
        const validTargets = ['all', 'has_purchased', 'no_purchase', 'by_level', 'by_email'];
        const finalTarget = validTargets.includes(target_type) ? target_type : 'all';
        
        // Determina status
        let status = 'draft';
        let finalScheduledAt = null;
        let finalSentAt = null;
        
        if (send_now) {
            status = 'sent';
            finalSentAt = new Date();
        } else if (scheduled_at) {
            const dt = new Date(scheduled_at);
            if (isNaN(dt.getTime())) {
                return res.status(400).json({ success: false, error: 'Data agendada inválida' });
            }
            if (dt > new Date()) {
                status = 'scheduled';
                finalScheduledAt = dt;
            } else {
                status = 'sent';
                finalSentAt = dt;
            }
        }
        
        const adminUser = req.admin?.username || 'admin';
        
        const { rows } = await db.query(`
            INSERT INTO notifications (
                title, body, type, target_type, target_value,
                cta_text, cta_url, icon, scheduled_at, sent_at,
                status, created_by
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            RETURNING *
        `, [
            title.trim().slice(0, 200),
            body.trim(),
            finalType,
            finalTarget,
            target_value ? JSON.stringify(target_value) : null,
            (cta_text || '').trim().slice(0, 50) || null,
            (cta_url || '').trim() || null,
            (icon || '').trim().slice(0, 10) || null,
            finalScheduledAt,
            finalSentAt,
            status,
            adminUser,
        ]);
        
        // Se foi marcada como "sent", calcular target count (best-effort, pode falhar silenciosamente)
        if (status === 'sent') {
            try {
                const targetCount = await calculateTargetCount(finalTarget, target_value);
                await db.query(
                    'UPDATE notifications SET sent_count = $1 WHERE id = $2',
                    [targetCount, rows[0].id]
                );
                rows[0].sent_count = targetCount;
            } catch (e) {
                logger.warn('Erro calculando sent_count:', e.message);
            }
        }
        
        return res.json({ success: true, notification: rows[0] });
    } catch (err) {
        logger.error('Erro criando notificação:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// =============================================================================
// PUT /api/admin/notifications/:id — atualiza (só drafts/scheduled)
// =============================================================================
router.put('/:id', requireAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
        
        // Verifica se existe e está editável
        const { rows: existing } = await db.query(
            'SELECT status FROM notifications WHERE id = $1',
            [id]
        );
        if (existing.length === 0) {
            return res.status(404).json({ success: false, error: 'Notificação não encontrada' });
        }
        if (existing[0].status === 'sent') {
            return res.status(400).json({ success: false, error: 'Notificação já enviada não pode ser editada' });
        }
        
        const {
            title, body, type, target_type, target_value,
            cta_text, cta_url, icon, scheduled_at
        } = req.body || {};
        
        const updates = [];
        const params = [];
        let p = 1;
        
        if (title !== undefined) { updates.push(`title = $${p++}`); params.push(title.trim().slice(0, 200)); }
        if (body !== undefined) { updates.push(`body = $${p++}`); params.push(body.trim()); }
        if (type !== undefined) { updates.push(`type = $${p++}`); params.push(type); }
        if (target_type !== undefined) { updates.push(`target_type = $${p++}`); params.push(target_type); }
        if (target_value !== undefined) { updates.push(`target_value = $${p++}::jsonb`); params.push(target_value ? JSON.stringify(target_value) : null); }
        if (cta_text !== undefined) { updates.push(`cta_text = $${p++}`); params.push((cta_text || '').trim().slice(0, 50) || null); }
        if (cta_url !== undefined) { updates.push(`cta_url = $${p++}`); params.push((cta_url || '').trim() || null); }
        if (icon !== undefined) { updates.push(`icon = $${p++}`); params.push((icon || '').trim().slice(0, 10) || null); }
        if (scheduled_at !== undefined) {
            updates.push(`scheduled_at = $${p++}`);
            params.push(scheduled_at ? new Date(scheduled_at) : null);
        }
        
        if (updates.length === 0) {
            return res.status(400).json({ success: false, error: 'Nada pra atualizar' });
        }
        
        updates.push(`updated_at = NOW()`);
        params.push(id);
        
        const { rows } = await db.query(
            `UPDATE notifications SET ${updates.join(', ')} WHERE id = $${p} RETURNING *`,
            params
        );
        
        return res.json({ success: true, notification: rows[0] });
    } catch (err) {
        logger.error('Erro atualizando notificação:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// =============================================================================
// POST /api/admin/notifications/:id/send — envia agora
// =============================================================================
router.post('/:id/send', requireAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
        
        const { rows: existing } = await db.query(
            'SELECT * FROM notifications WHERE id = $1',
            [id]
        );
        if (existing.length === 0) {
            return res.status(404).json({ success: false, error: 'Não encontrada' });
        }
        if (existing[0].status === 'sent') {
            return res.status(400).json({ success: false, error: 'Já foi enviada' });
        }
        
        const targetCount = await calculateTargetCount(existing[0].target_type, existing[0].target_value);
        
        await db.query(`
            UPDATE notifications SET
                status = 'sent',
                sent_at = NOW(),
                sent_count = $1,
                updated_at = NOW()
            WHERE id = $2
        `, [targetCount, id]);
        
        return res.json({ success: true, sent_count: targetCount });
    } catch (err) {
        logger.error('Erro enviando notificação:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// =============================================================================
// DELETE /api/admin/notifications/:id
// =============================================================================
router.delete('/:id', requireAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
        
        const { rowCount } = await db.query('DELETE FROM notifications WHERE id = $1', [id]);
        if (rowCount === 0) {
            return res.status(404).json({ success: false, error: 'Não encontrada' });
        }
        return res.json({ success: true, deleted: true });
    } catch (err) {
        logger.error('Erro deletando notificação:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// =============================================================================
// HELPER: calcula quantos clientes vão receber
// =============================================================================
async function calculateTargetCount(targetType, targetValue) {
    try {
        if (targetType === 'all') {
            const { rows } = await db.query('SELECT COUNT(*)::int as c FROM customers');
            return rows[0]?.c || 0;
        }
        if (targetType === 'has_purchased') {
            const { rows } = await db.query(`
                SELECT COUNT(DISTINCT email)::int as c FROM customers
                WHERE total_purchases > 0
            `);
            return rows[0]?.c || 0;
        }
        if (targetType === 'no_purchase') {
            const { rows } = await db.query(`
                SELECT COUNT(*)::int as c FROM customers
                WHERE total_purchases = 0 OR total_purchases IS NULL
            `);
            return rows[0]?.c || 0;
        }
        if (targetType === 'by_email' && targetValue?.emails) {
            const emails = Array.isArray(targetValue.emails) ? targetValue.emails : [];
            return emails.length;
        }
        if (targetType === 'by_level') {
            // não temos lookup de elo no banco ainda, retorna estimativa
            const { rows } = await db.query('SELECT COUNT(*)::int as c FROM customers');
            return Math.floor((rows[0]?.c || 0) * 0.3); // estimativa
        }
        return 0;
    } catch (e) {
        return 0;
    }
}

module.exports = router;
