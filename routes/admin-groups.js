/**
 * =============================================================================
 * routes/admin-groups.js — gestão dos GRUPOS (grupos-bot estilo WhatsApp)
 * =============================================================================
 * CRUD dos grupos e import de cenas por JSON (v3 — elenco automático).
 * Formato das cenas (gerado fora e colado no painel):
 *   [{ "category": "papo|pesado|apresentacao|midia|cta|reacao|bomdia|boanoite|entrada",
 *      "period": "any|manha|tarde|noite|madrugada", "weight": 1,
 *      "messages": [{ "p": 1, "g": "f", "t": "text|image|presentation|cta",
 *                     "text": "...", "gap_s": 8, "link": "...", "pid": 12,
 *                     "folder": "academia", "admin": true }] }]
 * v3: o texto usa {nome} (o sistema escolhe o nome do elenco e o remetente É
 * esse nome) e {nome2} (nome da pessoa do slot 2 — referência cruzada);
 * "folder" pega foto da pasta nomeada do grupo (media_folders);
 * "admin": true = mensagem do administrador (canal free); "entrada" = roteiro
 * que roda NA ORDEM no primeiro acesso do lead.
 * =============================================================================
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAdmin } = require('../lib/auth');
const { logger } = require('../lib/logger');

const CATEGORIES = ['papo', 'pesado', 'apresentacao', 'midia', 'cta', 'reacao', 'novato', 'bomdia', 'boanoite', 'entrada'];
const PERIODS = ['any', 'manha', 'tarde', 'noite', 'madrugada'];
// tipos aceitos nos blocos de mensagem (cenas pessoais E itens da agenda)
const MSG_TYPES = ['text', 'image', 'video', 'audio', 'presentation', 'cta', 'vonce', 'album'];

const urlList = (v) => {
    if (Array.isArray(v)) return v.map(s => String(s).trim()).filter(Boolean).slice(0, 500);
    if (typeof v === 'string') return v.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 500);
    return null;
};
const intOr = (v, d, min, max) => {
    const n = parseInt(v, 10);
    if (isNaN(n)) return d;
    return Math.max(min, Math.min(max, n));
};
const rand = (n) => Math.floor(Math.random() * n);

// Pastas de mídia v2: { chave: { path, label, hidden } }. Aceita também o
// legado (valor string / texto "chave = pasta" por linha).
function parseMediaFolders(v) {
    let obj = null;
    if (v && typeof v === 'object' && !Array.isArray(v)) obj = v;
    else if (typeof v === 'string') {
        obj = {};
        v.split('\n').forEach(line => {
            const i = line.indexOf('=');
            if (i > 0) obj[line.slice(0, i)] = line.slice(i + 1);
        });
    }
    if (!obj) return {};
    const out = {};
    for (const k of Object.keys(obj).slice(0, 30)) {
        const key = String(k).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
        if (!key) continue;
        const raw = obj[k];
        let path = '', label = key, hidden = false;
        if (raw && typeof raw === 'object') {
            path = String(raw.path || '');
            label = String(raw.label || key).slice(0, 60);
            hidden = raw.hidden === true;
        } else {
            path = String(raw || '');
        }
        path = path.trim().replace(/^\/+|\/+$/g, '').slice(0, 200);
        if (path) out[key] = { path, label, hidden };
    }
    return out;
}

// Normaliza um bloco de mensagens (formato compartilhado entre cenas e agenda)
function cleanMessages(list) {
    return (Array.isArray(list) ? list : []).slice(0, 40).map(m => ({
        p: intOr(m.p, 1, 1, 12),
        g: m.g === 'm' || m.g === 'f' ? m.g : undefined,
        t: MSG_TYPES.includes(m.t) ? m.t : 'text',
        kind: m.kind === 'foto' ? 'foto' : (m.kind === 'video' ? 'video' : undefined),
        text: (m.text || '').toString().slice(0, 1000) || undefined,
        label: (m.label || '').toString().slice(0, 60) || undefined,
        gap_s: m.gap_s !== undefined ? intOr(m.gap_s, 8, 2, 600) : undefined,
        link: (m.link || '').toString().slice(0, 1000) || undefined,
        pid: m.pid ? parseInt(m.pid, 10) : undefined,
        color: (m.color || '').toString().slice(0, 20) || undefined,
        folder: (m.folder || '').toString().trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || undefined,
        vfolder: (m.vfolder || '').toString().trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || undefined, // álbum: pasta separada dos vídeos
        fotos: m.fotos !== undefined ? intOr(m.fotos, 0, 0, 6) : undefined,   // só no album
        videos: m.videos !== undefined ? intOr(m.videos, 0, 0, 6) : undefined, // só no album
        admin: m.admin === true ? true : undefined,
    })).filter(m => m.text || m.label || ['image', 'video', 'audio', 'presentation', 'vonce', 'album'].includes(m.t));
}

function invalidateAgendaCache(groupId) {
    try { require('./user-groups').invalidateAgenda(groupId); } catch (_) {}
}

function groupPayload(b) {
    return {
        name: (b.name || '').trim().slice(0, 120),
        avatar_url: (b.avatar_url || '').trim().slice(0, 1000) || null,
        description: (b.description || '').trim().slice(0, 1000) || null,
        is_free: b.is_free === true,
        pinned: b.pinned === true,
        product_id: b.product_id ? parseInt(b.product_id, 10) : null,
        telegram_url: (b.telegram_url || '').trim().slice(0, 500) || null,
        cta_label: (b.cta_label || '').trim().slice(0, 120) || null,
        cta_link: (b.cta_link || '').trim().slice(0, 1000) || null,
        media_video_library_id: (b.media_video_library_id || '').trim().slice(0, 20) || null,
        media_video_collection_id: (b.media_video_collection_id || '').trim().slice(0, 60) || null,
        media_image_urls: urlList(b.media_image_urls),
        presentation_male_urls: urlList(b.presentation_male_urls),
        presentation_female_urls: urlList(b.presentation_female_urls),
        media_image_folder: (b.media_image_folder || '').trim().replace(/^\/+|\/+$/g, '').slice(0, 200) || null,
        presentation_male_folder: (b.presentation_male_folder || '').trim().replace(/^\/+|\/+$/g, '').slice(0, 200) || null,
        presentation_female_folder: (b.presentation_female_folder || '').trim().replace(/^\/+|\/+$/g, '').slice(0, 200) || null,
        media_folders: parseMediaFolders(b.media_folders),
        female_ratio: intOr(b.female_ratio, 80, 0, 100),
        msgs_per_hour: intOr(b.msgs_per_hour, 60, 10, 600),
        retention_hours: intOr(b.retention_hours, 24, 1, 720),
        cycle_days: intOr(b.cycle_days, 7, 1, 60),
        window_hours: intOr(b.window_hours, 72, 6, 720),
        trial_end_chat_id: b.trial_end_chat_id ? parseInt(b.trial_end_chat_id, 10) : null,
        trial_seconds: intOr(b.trial_seconds, 60, 15, 3600),
        members_count: intOr(b.members_count, 248, 2, 99999),
        online_count: intOr(b.online_count, 25, 1, 9999),
        invite_chat_ids: Array.isArray(b.invite_chat_ids)
            ? b.invite_chat_ids.map(x => parseInt(x, 10)).filter(Boolean).slice(0, 3)
            : null,
        invite_delay_seconds: intOr(b.invite_delay_seconds, 120, 5, 86400),
        display_order: intOr(b.display_order, 0, 0, 9999),
        active: b.active !== false,
    };
}

// ═════════════════════════════════════════════════════════════════════════════
// MÉTRICAS — dashboard dos grupos (funil entrou → prévia → PV → comprou)
// Fontes: group_sessions (leads), tracking_events com metadata.group_id
// (opens/paywall), user_access do produto do grupo (compras/receita).
// ═════════════════════════════════════════════════════════════════════════════
router.get('/metrics', requireAdmin, async (req, res) => {
    try {
        const to = req.query.to ? new Date(req.query.to + 'T23:59:59-03:00') : new Date();
        const from = req.query.from ? new Date(req.query.from + 'T00:00:00-03:00')
            : new Date(Date.now() - 30 * 86400000);
        const { rows: groups } = await db.query(
            `SELECT g.id, g.name, g.avatar_url, g.is_free, g.product_id, p.name AS product_name
             FROM groups g LEFT JOIN products p ON p.id = g.product_id
             WHERE g.active = true ORDER BY g.display_order, g.id`
        );
        // eventos de grupo no período, agregados por group_id + tipo
        const { rows: events } = await db.query(
            `SELECT metadata->>'group_id' AS gid, event_type, COUNT(*)::int AS n
             FROM tracking_events
             WHERE event_type IN ('group_open','group_paywall_open','group_paywall_click')
               AND created_at BETWEEN $1 AND $2
             GROUP BY 1, 2`, [from, to]
        );
        const ev = {};
        for (const e of events) {
            if (!e.gid) continue;
            ev[e.gid] = ev[e.gid] || {};
            ev[e.gid][e.event_type] = e.n;
        }
        const out = [];
        for (const g of groups) {
            const { rows: [{ n: leadsNew }] } = await db.query(
                `SELECT COUNT(*)::int AS n FROM group_sessions WHERE group_id = $1 AND created_at BETWEEN $2 AND $3`,
                [g.id, from, to]
            );
            const { rows: [{ n: leadsTotal }] } = await db.query(
                `SELECT COUNT(*)::int AS n FROM group_sessions WHERE group_id = $1`, [g.id]
            );
            let purchases = 0, revenue = 0, activeMembers = 0;
            if (g.product_id) {
                const { rows: [sales] } = await db.query(
                    `SELECT COUNT(*)::int AS n, COALESCE(SUM(COALESCE(net_amount, sale_amount)), 0) AS total
                     FROM user_access WHERE product_id = $1 AND granted_at BETWEEN $2 AND $3`,
                    [g.product_id, from, to]
                );
                purchases = sales.n; revenue = parseFloat(sales.total) || 0;
                const { rows: [{ n: act }] } = await db.query(
                    `SELECT COUNT(DISTINCT LOWER(email))::int AS n FROM user_access
                     WHERE product_id = $1 AND status = 'active' AND (expires_at IS NULL OR expires_at > NOW())`,
                    [g.product_id]
                );
                activeMembers = act;
            }
            const e = ev[String(g.id)] || {};
            out.push({
                id: g.id, name: g.name, avatar_url: g.avatar_url, is_free: g.is_free,
                product_id: g.product_id, product_name: g.product_name,
                leads_new: leadsNew, leads_total: leadsTotal,
                opens: e.group_open || 0,
                paywall_opens: e.group_paywall_open || 0,
                paywall_clicks: e.group_paywall_click || 0,
                purchases, revenue, active_members: activeMembers,
                conversion: leadsNew > 0 ? Math.round((purchases / leadsNew) * 1000) / 10 : 0,
            });
        }
        // Passe Vitalício entra como linha própria (receita não é de 1 grupo)
        let pass = null;
        try {
            const { rows: pp } = await db.query(
                `SELECT id, name FROM products WHERE is_group_pass = true AND is_active = true ORDER BY id LIMIT 1`
            );
            if (pp.length) {
                const { rows: [sales] } = await db.query(
                    `SELECT COUNT(*)::int AS n, COALESCE(SUM(COALESCE(net_amount, sale_amount)), 0) AS total
                     FROM user_access WHERE product_id = $1 AND granted_at BETWEEN $2 AND $3`,
                    [pp[0].id, from, to]
                );
                const { rows: [{ n: act }] } = await db.query(
                    `SELECT COUNT(DISTINCT LOWER(email))::int AS n FROM user_access
                     WHERE product_id = $1 AND status = 'active' AND (expires_at IS NULL OR expires_at > NOW())`,
                    [pp[0].id]
                );
                pass = { product_id: pp[0].id, name: pp[0].name, purchases: sales.n, revenue: parseFloat(sales.total) || 0, active_members: act };
            }
        } catch (_) {}
        return res.json({ success: true, groups: out, pass, from, to });
    } catch (err) {
        logger.error('Erro nas métricas de grupos:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// ═════════════════════════════════════════════════════════════════════════════
// BROADCAST — SEQUÊNCIA de mensagens na timeline de todos. Cada mensagem vira
// uma linha; o DELAY entre elas vira created_at no futuro (a janela computada
// só mostra o que já "aconteceu" → a sequência pinga sozinha, sem worker).
// Botão (cta) leva pra qualquer lugar do sistema (conversa/grupo/produto/aba)
// ou link externo. meta._batch agrupa a sequência no histórico.
// ═════════════════════════════════════════════════════════════════════════════
const BCAST_TYPES = ['text', 'image', 'video', 'audio', 'vonce', 'cta'];
router.post('/broadcast', requireAdmin, async (req, res) => {
    try {
        const b = req.body || {};
        // aceita sequência (messages[]) ou o formato antigo de 1 mensagem
        const rawMsgs = (Array.isArray(b.messages) && b.messages.length)
            ? b.messages
            : [{ type: b.type, content: b.content, media_url: b.media_url, kind: b.kind, delay_s: 0 }];
        const clean = [];
        for (const m of rawMsgs.slice(0, 12)) {
            const type = BCAST_TYPES.includes(m.type) ? m.type : 'text';
            let content = (m.content || '').toString().slice(0, 1000) || null;
            const media = (m.media_url || '').toString().trim().slice(0, 1000) || null;
            const meta = {};
            if (type === 'vonce') meta.kind = m.kind === 'video' ? 'video' : 'foto';
            if (type === 'cta') {
                const link = (m.link_url || '').toString().trim().slice(0, 1000) || null;
                const pid = m.product_id ? parseInt(m.product_id, 10) : null;
                if (!link && !pid) continue; // botão sem destino não vale
                meta.link_url = link;
                meta.product_id = pid;
                meta.cta_color = (m.cta_color || '').toString().slice(0, 20) || '#25a55f';
                // label = texto DO botão; content vira o texto em cima (opcional)
                const label = (m.label || '').toString().trim().slice(0, 60);
                meta.label = label || content || 'Ver agora';
                if (!label) content = null;
            }
            if (type === 'text' && !content) continue;
            if (['image', 'video', 'audio', 'vonce'].includes(type) && !media) continue;
            clean.push({
                type, content, media, meta,
                delay_s: Math.max(0, Math.min(3600, parseInt(m.delay_s, 10) || 0)),
            });
        }
        if (!clean.length) return res.status(400).json({ success: false, error: 'Nenhuma mensagem válida na sequência' });
        let groupIds = null; // NULL = todos os grupos
        if (Array.isArray(b.group_ids) && b.group_ids.length) {
            groupIds = b.group_ids.map(x => parseInt(x, 10)).filter(Boolean).slice(0, 100);
            if (!groupIds.length) groupIds = null;
        }
        const sender = (b.sender_name || '').toString().trim().slice(0, 80) || null;
        const batch = Date.now().toString(36);
        let offset = 0;
        const out = [];
        for (const m of clean) {
            offset += m.delay_s; // espera ANTES desta mensagem
            m.meta._batch = batch;
            const { rows } = await db.query(
                `INSERT INTO group_broadcasts (group_ids, sender_name, type, content, media_url, meta, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, NOW() + make_interval(secs => $7)) RETURNING *`,
                [groupIds ? JSON.stringify(groupIds) : null, sender, m.type, m.content, m.media,
                 JSON.stringify(m.meta), offset]
            );
            out.push(rows[0]);
        }
        return res.json({ success: true, broadcasts: out, batch });
    } catch (err) {
        logger.error('Erro no broadcast de grupos:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// DELETE /broadcasts/batch/:key — apaga a SEQUÊNCIA inteira (antes do /:bid)
router.delete('/broadcasts/batch/:key', requireAdmin, async (req, res) => {
    const key = String(req.params.key || '').replace(/[^a-z0-9]/g, '').slice(0, 20);
    if (!key) return res.status(400).json({ success: false, error: 'Batch inválido' });
    try {
        const { rowCount } = await db.query(
            `DELETE FROM group_broadcasts WHERE meta->>'_batch' = $1`, [key]
        );
        return res.json({ success: true, deleted: rowCount });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// GET /broadcasts — últimos 50 (pro histórico no painel)
router.get('/broadcasts', requireAdmin, async (req, res) => {
    try {
        const { rows } = await db.query(
            `SELECT * FROM group_broadcasts ORDER BY id DESC LIMIT 50`
        );
        return res.json({ success: true, broadcasts: rows });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// DELETE /broadcasts/:bid — apagar tira da timeline de todo mundo na hora
router.delete('/broadcasts/:bid', requireAdmin, async (req, res) => {
    const bid = parseInt(req.params.bid, 10);
    if (!bid) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { rowCount } = await db.query(`DELETE FROM group_broadcasts WHERE id = $1`, [bid]);
        return res.json({ success: true, deleted: rowCount });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// GET / — lista com contagens
router.get('/', requireAdmin, async (req, res) => {
    try {
        const { rows } = await db.query(`
            SELECT g.*, p.name AS product_name,
                   (SELECT COUNT(*)::int FROM group_personas gp WHERE gp.group_id = g.id AND gp.active = true) AS personas_count,
                   (SELECT COUNT(*)::int FROM group_scenes gs WHERE gs.group_id = g.id AND gs.active = true) AS scenes_count,
                   (SELECT COUNT(*)::int FROM group_schedule_items si WHERE si.group_id = g.id AND si.active = true) AS schedule_count,
                   (SELECT COUNT(*)::int FROM group_sessions s WHERE s.group_id = g.id) AS sessions_count
            FROM groups g
            LEFT JOIN products p ON p.id = g.product_id
            ORDER BY g.display_order, g.id
        `);
        return res.json({ success: true, groups: rows });
    } catch (err) {
        logger.error('Erro listando grupos (admin):', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// POST / — cria (âncora do ciclo = meia-noite de HOJE em Brasília: o "dia 1"
// da agenda começa no dia em que o grupo nasce)
router.post('/', requireAdmin, async (req, res) => {
    try {
        const p = groupPayload(req.body || {});
        if (!p.name) return res.status(400).json({ success: false, error: 'Nome obrigatório' });
        const cols = Object.keys(p);
        const vals = cols.map(k => {
            const v = p[k];
            return (v !== null && typeof v === 'object') ? JSON.stringify(v) : v;
        });
        const ph = cols.map((_, i) => '$' + (i + 1)).join(', ');
        const { rows } = await db.query(
            `INSERT INTO groups (${cols.join(', ')}) VALUES (${ph}) RETURNING *`, vals
        );
        // âncora do ciclo: meia-noite (Brasília) do dia da criação
        const { rows: anchored } = await db.query(
            `UPDATE groups SET cycle_anchor =
                date_trunc('day', created_at AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'
             WHERE id = $1 RETURNING *`, [rows[0].id]
        );
        return res.json({ success: true, group: anchored[0] || rows[0] });
    } catch (err) {
        logger.error('Erro criando grupo:', err);
        return res.status(500).json({ success: false, error: err.message || 'Erro interno' });
    }
});

// PUT /:id — edita (parcial)
router.put('/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const b = req.body || {};
        const full = groupPayload(b);
        const updates = []; const values = []; let p = 1;
        for (const k of Object.keys(full)) {
            if (b[k] === undefined) continue;
            updates.push(`${k} = $${p++}`);
            const v = full[k];
            values.push((v !== null && typeof v === 'object') ? JSON.stringify(v) : v);
        }
        if (!updates.length) return res.status(400).json({ success: false, error: 'Nada pra atualizar' });
        values.push(id);
        const { rows } = await db.query(
            `UPDATE groups SET ${updates.join(', ')} WHERE id = $${p} RETURNING *`, values
        );
        if (!rows.length) return res.status(404).json({ success: false, error: 'Não encontrado' });
        return res.json({ success: true, group: rows[0] });
    } catch (err) {
        logger.error('Erro atualizando grupo:', err);
        return res.status(500).json({ success: false, error: err.message || 'Erro interno' });
    }
});

// DELETE /:id
router.delete('/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { rowCount } = await db.query(`DELETE FROM groups WHERE id = $1`, [id]);
        if (!rowCount) return res.status(404).json({ success: false, error: 'Não encontrado' });
        return res.json({ success: true });
    } catch (err) {
        logger.error('Erro excluindo grupo:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// GET /:id/personas — elenco
router.get('/:id/personas', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { rows } = await db.query(
            `SELECT id, name, gender FROM group_personas WHERE group_id = $1 AND active = true ORDER BY id`, [id]
        );
        return res.json({ success: true, personas: rows });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// PUT /:id/personas — SUBSTITUI o elenco. body.lines = ["Amanda|f", "Marcos|m"]
router.put('/:id/personas', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const raw = Array.isArray(req.body?.lines) ? req.body.lines
            : String(req.body?.lines || '').split('\n');
        const personas = raw
            .map(l => String(l).trim())
            .filter(Boolean)
            .slice(0, 200)
            .map(l => {
                const [name, g] = l.split('|').map(s => (s || '').trim());
                return { name: name.slice(0, 60), gender: (g || 'f').toLowerCase() === 'm' ? 'm' : 'f' };
            })
            .filter(pp => pp.name);
        await db.query(`DELETE FROM group_personas WHERE group_id = $1`, [id]);
        for (const pp of personas) {
            await db.query(
                `INSERT INTO group_personas (group_id, name, gender) VALUES ($1, $2, $3)`,
                [id, pp.name, pp.gender]
            );
        }
        return res.json({ success: true, count: personas.length });
    } catch (err) {
        logger.error('Erro salvando personas:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// GET /:id/scenes — resumo por categoria
router.get('/:id/scenes', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { rows } = await db.query(
            `SELECT category, COUNT(*)::int AS n,
                    SUM(jsonb_array_length(messages))::int AS msgs
             FROM group_scenes WHERE group_id = $1 AND active = true
             GROUP BY category ORDER BY category`, [id]
        );
        return res.json({ success: true, summary: rows });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// POST /:id/scenes/import — body.scenes = array no formato do topo do arquivo
// (aceita também string JSON). replace=true limpa as cenas antes.
router.post('/:id/scenes/import', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        let scenes = req.body?.scenes;
        if (typeof scenes === 'string') {
            try { scenes = JSON.parse(scenes); } catch (e) {
                return res.status(400).json({ success: false, error: 'JSON inválido: ' + e.message });
            }
        }
        if (!Array.isArray(scenes) || !scenes.length) {
            return res.status(400).json({ success: false, error: 'Envie um array de cenas' });
        }
        if (scenes.length > 500) return res.status(400).json({ success: false, error: 'Máximo de 500 cenas por import' });
        // valida e normaliza
        const clean = [];
        for (let i = 0; i < scenes.length; i++) {
            const s = scenes[i] || {};
            const cat = CATEGORIES.includes(s.category) ? s.category : 'papo';
            const per = PERIODS.includes(s.period) ? s.period : 'any';
            const weight = intOr(s.weight, 1, 1, 100);
            const msgs = cleanMessages(s.messages);
            if (!msgs.length) continue;
            clean.push({ category: cat, period: per, weight, messages: msgs });
        }
        if (!clean.length) return res.status(400).json({ success: false, error: 'Nenhuma cena válida no JSON' });
        if (req.body?.replace === true) {
            await db.query(`DELETE FROM group_scenes WHERE group_id = $1`, [id]);
        }
        for (const s of clean) {
            await db.query(
                `INSERT INTO group_scenes (group_id, category, period, weight, messages)
                 VALUES ($1, $2, $3, $4, $5::jsonb)`,
                [id, s.category, s.period, s.weight, JSON.stringify(s.messages)]
            );
        }
        return res.json({ success: true, imported: clean.length });
    } catch (err) {
        logger.error('Erro importando cenas:', err);
        return res.status(500).json({ success: false, error: err.message || 'Erro interno' });
    }
});

// DELETE /:id/scenes — limpa todas as cenas do grupo
router.delete('/:id/scenes', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { rowCount } = await db.query(`DELETE FROM group_scenes WHERE group_id = $1`, [id]);
        return res.json({ success: true, deleted: rowCount });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// ═════════════════════════════════════════════════════════════════════════════
// AGENDA (linha do tempo compartilhada) — itens por dia do ciclo × horário
// ═════════════════════════════════════════════════════════════════════════════

// "HH:MM" → minutos do dia (aceita também número direto)
function toTimeMinutes(v) {
    if (typeof v === 'number' || /^\d+$/.test(String(v))) {
        return Math.max(0, Math.min(1439, parseInt(v, 10)));
    }
    const m = String(v || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return 540; // 09:00
    return Math.max(0, Math.min(1439, parseInt(m[1], 10) * 60 + parseInt(m[2], 10)));
}

// GET /:id/schedule — agenda completa (ordenada por dia × horário)
router.get('/:id/schedule', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { rows } = await db.query(
            `SELECT * FROM group_schedule_items WHERE group_id = $1 ORDER BY day, time_minutes, id`, [id]
        );
        return res.json({ success: true, items: rows });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// POST /:id/schedule — cria item { day, time ('HH:MM'|min), messages[] }
router.post('/:id/schedule', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const b = req.body || {};
        const day = intOr(b.day, 0, 0, 59);
        const time = toTimeMinutes(b.time !== undefined ? b.time : b.time_minutes);
        const msgs = cleanMessages(b.messages);
        if (!msgs.length) return res.status(400).json({ success: false, error: 'Item sem mensagens válidas' });
        const { rows } = await db.query(
            `INSERT INTO group_schedule_items (group_id, day, time_minutes, messages)
             VALUES ($1, $2, $3, $4::jsonb) RETURNING *`,
            [id, day, time, JSON.stringify(msgs)]
        );
        invalidateAgendaCache(id);
        return res.json({ success: true, item: rows[0] });
    } catch (err) {
        logger.error('Erro criando item de agenda:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// PUT /:id/schedule/:itemId — edita item
router.put('/:id/schedule/:itemId', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const itemId = parseInt(req.params.itemId, 10);
    if (!id || !itemId) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const b = req.body || {};
        const updates = []; const values = []; let p = 1;
        if (b.day !== undefined) { updates.push(`day = $${p++}`); values.push(intOr(b.day, 0, 0, 59)); }
        if (b.time !== undefined || b.time_minutes !== undefined) {
            updates.push(`time_minutes = $${p++}`);
            values.push(toTimeMinutes(b.time !== undefined ? b.time : b.time_minutes));
        }
        if (b.messages !== undefined) {
            const msgs = cleanMessages(b.messages);
            if (!msgs.length) return res.status(400).json({ success: false, error: 'Item sem mensagens válidas' });
            updates.push(`messages = $${p++}::jsonb`); values.push(JSON.stringify(msgs));
        }
        if (b.active !== undefined) { updates.push(`active = $${p++}`); values.push(b.active !== false); }
        if (!updates.length) return res.status(400).json({ success: false, error: 'Nada pra atualizar' });
        values.push(itemId, id);
        const { rows } = await db.query(
            `UPDATE group_schedule_items SET ${updates.join(', ')} WHERE id = $${p++} AND group_id = $${p} RETURNING *`,
            values
        );
        if (!rows.length) return res.status(404).json({ success: false, error: 'Não encontrado' });
        invalidateAgendaCache(id);
        return res.json({ success: true, item: rows[0] });
    } catch (err) {
        logger.error('Erro editando item de agenda:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// DELETE /:id/schedule/:itemId
router.delete('/:id/schedule/:itemId', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const itemId = parseInt(req.params.itemId, 10);
    if (!id || !itemId) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { rowCount } = await db.query(
            `DELETE FROM group_schedule_items WHERE id = $1 AND group_id = $2`, [itemId, id]
        );
        invalidateAgendaCache(id);
        if (!rowCount) return res.status(404).json({ success: false, error: 'Não encontrado' });
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// POST /:id/schedule/import — body.items = [{day, time, messages}] (aceita
// string JSON). replace=true limpa a agenda antes. Formato pra gerar fora.
router.post('/:id/schedule/import', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        let items = req.body?.items;
        if (typeof items === 'string') {
            try { items = JSON.parse(items); } catch (e) {
                return res.status(400).json({ success: false, error: 'JSON inválido: ' + e.message });
            }
        }
        if (!Array.isArray(items) || !items.length) {
            return res.status(400).json({ success: false, error: 'Envie um array de itens' });
        }
        if (items.length > 1000) return res.status(400).json({ success: false, error: 'Máximo de 1000 itens por import' });
        const clean = [];
        for (const it of items) {
            const msgs = cleanMessages(it?.messages);
            if (!msgs.length) continue;
            clean.push({
                day: intOr(it.day, 0, 0, 59),
                time: toTimeMinutes(it.time !== undefined ? it.time : it.time_minutes),
                messages: msgs,
            });
        }
        if (!clean.length) return res.status(400).json({ success: false, error: 'Nenhum item válido no JSON' });
        if (req.body?.replace === true) {
            await db.query(`DELETE FROM group_schedule_items WHERE group_id = $1`, [id]);
            // roteiro novo do zero → reinicia o ciclo pra HOJE (meia-noite
            // Brasília): o dia 0 importado começa a tocar imediatamente.
            // Sem isso, a âncora fica na criação do grupo e o dia 0 só
            // tocaria quando o ciclo desse a volta ("grupo vazio" no painel).
            await db.query(
                `UPDATE groups SET cycle_anchor =
                    date_trunc('day', NOW() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'
                 WHERE id = $1`, [id]
            );
        }
        for (const it of clean) {
            await db.query(
                `INSERT INTO group_schedule_items (group_id, day, time_minutes, messages)
                 VALUES ($1, $2, $3, $4::jsonb)`,
                [id, it.day, it.time, JSON.stringify(it.messages)]
            );
        }
        invalidateAgendaCache(id);
        return res.json({ success: true, imported: clean.length });
    } catch (err) {
        logger.error('Erro importando agenda:', err);
        return res.status(500).json({ success: false, error: err.message || 'Erro interno' });
    }
});

// POST /:id/schedule/distribute — converte as CENAS ambiente existentes
// (papo/pesado/apresentacao/midia/cta/bomdia/boanoite) em itens de agenda,
// espalhados pelos dias do ciclo respeitando o período de cada cena.
// As cenas originais ficam intactas (entrada/reacao/novato continuam pessoais).
const PERIOD_WINDOWS = {
    manha: [7 * 60, 11 * 60 + 30],
    tarde: [12 * 60 + 30, 17 * 60 + 30],
    noite: [18 * 60 + 30, 23 * 60 + 30],
    madrugada: [0, 5 * 60],
};
router.post('/:id/schedule/distribute', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { rows: gr } = await db.query(`SELECT cycle_days FROM groups WHERE id = $1`, [id]);
        if (!gr.length) return res.status(404).json({ success: false, error: 'Grupo não encontrado' });
        const cycleDays = Math.max(1, Math.min(60, gr[0].cycle_days || 7));
        const { rows: scenes } = await db.query(
            `SELECT * FROM group_scenes WHERE group_id = $1 AND active = true
               AND category NOT IN ('entrada', 'reacao', 'novato')
             ORDER BY id`, [id]
        );
        if (!scenes.length) return res.status(400).json({ success: false, error: 'Nenhuma cena ambiente pra distribuir' });
        if (req.body?.replace === true) {
            await db.query(`DELETE FROM group_schedule_items WHERE group_id = $1`, [id]);
        }
        // horários "orgânicos": espalha as cenas de cada período ao longo da
        // janela do período, rodando os dias do ciclo em sequência
        const byPeriod = {};
        for (const s of scenes) {
            // categoria manda no período quando a cena não restringe
            let per = s.period;
            if (per === 'any') {
                if (s.category === 'bomdia') per = 'manha';
                else if (s.category === 'boanoite') per = 'noite';
                else per = ['manha', 'tarde', 'noite'][rand(3)];
            }
            byPeriod[per] = byPeriod[per] || [];
            byPeriod[per].push(s);
        }
        let created = 0;
        for (const per of Object.keys(byPeriod)) {
            const win = PERIOD_WINDOWS[per] || PERIOD_WINDOWS.tarde;
            const list = byPeriod[per];
            for (let i = 0; i < list.length; i++) {
                const day = i % cycleDays;
                const slot = Math.floor(i / cycleDays); // quantos já caíram neste dia/período
                const span = win[1] - win[0];
                const base = win[0] + Math.round((span * (slot % 6)) / 6);
                const time = Math.max(0, Math.min(1439, base + rand(40)));
                await db.query(
                    `INSERT INTO group_schedule_items (group_id, day, time_minutes, messages)
                     VALUES ($1, $2, $3, $4::jsonb)`,
                    [id, day, time, JSON.stringify(list[i].messages)]
                );
                created++;
            }
        }
        invalidateAgendaCache(id);
        return res.json({ success: true, created });
    } catch (err) {
        logger.error('Erro distribuindo cenas na agenda:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

module.exports = router;
