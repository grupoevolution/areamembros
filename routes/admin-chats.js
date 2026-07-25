/**
 * =============================================================================
 * routes/admin-chats.js — gestão dos CHATS (personas + roteiros + conversas)
 * =============================================================================
 *
 * CRUD das personas (chats), dos blocos do roteiro (chat_steps) e leitura
 * das conversas recebidas dos leads (chat_sessions/chat_messages).
 * Mesmo padrão do admin-funnels.
 * =============================================================================
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAdmin } = require('../lib/auth');
const { logger } = require('../lib/logger');

const STEP_TYPES = ['text', 'audio', 'image', 'video', 'view_once_image', 'view_once_video', 'buttons', 'wait_input', 'cta', 'delay', 'call', 'paywall'];
const REPLY_MODES = ['vip', 'all', 'none'];
const INPUT_MODES = ['always', 'gated'];
// Fluxos por gatilho (cada modelo tem um roteiro independente por fluxo)
// 'vip' = 💎 VIP respondeu: dispara na 1ª mensagem livre que o lead manda
// DEPOIS de pagar (com o roteiro parado) — a continuação pós-venda.
const FLOWS = ['open', 'status_reply', 'call', 'inactive', 'vip'];
const cleanFlow = (f) => FLOWS.includes(f) ? f : 'open';

// ── CHATS (personas) ─────────────────────────────────────────────────────────

router.get('/', requireAdmin, async (req, res) => {
    try {
        const { rows } = await db.query(`
            SELECT c.*,
                   p.name AS product_name,
                   (SELECT COUNT(*)::int FROM chat_steps cs WHERE cs.chat_id = c.id AND cs.active = true) AS steps_count,
                   (SELECT COUNT(*)::int FROM chat_sessions s WHERE s.chat_id = c.id) AS sessions_count
            FROM chats c
            LEFT JOIN products p ON p.id = c.product_id
            ORDER BY c.display_order, c.id
        `);
        return res.json({ success: true, chats: rows });
    } catch (err) {
        logger.error('Erro listando chats:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// ── PRODUTOS ÚNICOS DO CHAT ("Assinatura do Chat" + "Status VIP") ────────────
// Dois produtos ocultos do catálogo, configurados de forma SIMPLES na tela de
// Chats (preço + link de checkout + código da oferta — nada de editor completo):
//   is_chat_plan  → paywall das conversas (planos VIP e PREMIUM; qualquer um
//                   comprado libera todas as conversas VIP)
//   is_story_plan → destrava os stories VIP de todas as modelos (fallback
//                   quando o chat não tem produto de story próprio)
// O código da oferta é o offer_id do gateway: o webhook casa a venda por ele
// (product_offers) e libera o acesso sozinho.

// Garante que um produto interno existe; devolve { id, name }
async function ensureInternalProduct(flagCol, name, description, defaultPrice) {
    let { rows } = await db.query(
        `SELECT id, name FROM products WHERE ${flagCol} = true ORDER BY id LIMIT 1`
    );
    if (rows.length) return rows[0];
    const { rows: created } = await db.query(
        `INSERT INTO products (name, description, is_published, is_active, ${flagCol}, price)
         VALUES ($1, $2, false, true, true, $3) RETURNING id, name`,
        [name, description, defaultPrice]
    );
    logger.info(`Produto interno criado: ${name} (id ${created[0].id})`);
    return created[0];
}

async function loadPaywallState() {
    const chatProd = await ensureInternalProduct(
        'is_chat_plan', 'Assinatura do Chat 🔥',
        'Produto interno do paywall das conversas — não aparece no catálogo. Configurado na tela de Chats.', 29.90
    );
    // planos padrão na 1ª vez
    const { rows: existing } = await db.query(
        `SELECT id FROM product_plans WHERE product_id = $1 LIMIT 1`, [chatProd.id]
    );
    if (!existing.length) {
        await db.query(
            `INSERT INTO product_plans (product_id, name, price, original_price, benefits, is_recommended, display_order)
             VALUES ($1, 'VIP', 29.90, 49.90, $2, false, 0),
                    ($1, 'PREMIUM', 49.90, 97.90, $3, true, 1)`,
            [chatProd.id,
             'Converse sem limite com todas as modelos\nFotos e vídeos exclusivos no chat\nRespostas prioritárias',
             'Tudo do VIP\nStories VIP liberados\nConteúdos exclusivos toda semana']
        );
    }
    const storyProd = await ensureInternalProduct(
        'is_story_plan', 'Status VIP 🔥',
        'Produto interno que destrava os stories VIP de todas as modelos — não aparece no catálogo. Configurado na tela de Chats.', 19.90
    );
    const { rows: storyPlanRows } = await db.query(
        `SELECT id FROM product_plans WHERE product_id = $1 LIMIT 1`, [storyProd.id]
    );
    if (!storyPlanRows.length) {
        await db.query(
            `INSERT INTO product_plans (product_id, name, price, original_price, benefits, is_recommended, display_order)
             VALUES ($1, 'STATUS VIP', 19.90, 39.90, 'Veja todos os status VIP das modelos\nConteúdo novo toda semana', true, 0)`,
            [storyProd.id]
        );
    }
    const { rows: plans } = await db.query(
        `SELECT id, name, price, original_price, checkout_url, is_recommended
         FROM product_plans WHERE product_id = $1 AND active = true ORDER BY display_order, id`, [chatProd.id]
    );
    const { rows: storyPlans } = await db.query(
        `SELECT id, name, price, original_price, checkout_url, is_recommended
         FROM product_plans WHERE product_id = $1 AND active = true ORDER BY display_order, id`, [storyProd.id]
    );
    const { rows: offers } = await db.query(
        `SELECT product_id, gateway, offer_id, offer_name FROM product_offers
         WHERE product_id = ANY($1::int[]) AND is_active = true ORDER BY id`,
        [[chatProd.id, storyProd.id]]
    );
    // casa o código com o plano pelo offer_name (gravado no PUT = nome do plano)
    const codeFor = (productId, planName) => {
        const o = offers.find(x => x.product_id === productId && (x.offer_name || '').toLowerCase() === String(planName).toLowerCase());
        return o ? o.offer_id : '';
    };
    const gateway = offers.length ? offers[0].gateway : 'kirvano';
    return {
        gateway,
        chat: {
            product_id: chatProd.id,
            plans: plans.map(p => ({ ...p, offer_code: codeFor(chatProd.id, p.name) })),
        },
        story: {
            product_id: storyProd.id,
            plan: storyPlans[0] ? { ...storyPlans[0], offer_code: codeFor(storyProd.id, storyPlans[0].name) } : null,
        },
    };
}

router.get('/paywall-product', requireAdmin, async (req, res) => {
    try {
        const state = await loadPaywallState();
        return res.json({ success: true, ...state });
    } catch (err) {
        logger.error('Erro no produto do chat (paywall):', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// PUT /paywall-product — salva a config simples (preço + link + código por plano).
// body: { gateway, plans: [{id, price, original_price, checkout_url, offer_code}],
//         story: {price, original_price, checkout_url, offer_code} }
router.put('/paywall-product', requireAdmin, async (req, res) => {
    try {
        const state = await loadPaywallState();
        const gateway = ['kirvano', 'perfectpay'].includes(req.body?.gateway) ? req.body.gateway : 'kirvano';
        const money = (v) => {
            if (v == null || v === '') return null;
            const n = parseFloat(String(v).replace(',', '.'));
            return isNaN(n) ? null : n;
        };
        // Atualiza um plano + sincroniza a oferta do gateway (código → webhook)
        async function savePlan(productId, planId, planName, input) {
            const price = money(input.price);
            const orig = money(input.original_price);
            const url = (input.checkout_url || '').trim().slice(0, 1000) || null;
            // O slot "PREMIUM" deste card É a fonte da verdade do plano Premium:
            // o código colocado nele libera automaticamente status + vídeos +
            // grupo VIP (7 dias) na venda. O dono controla tudo por aqui.
            const isPremium = /premium/i.test(String(planName || ''));
            await db.query(
                `UPDATE product_plans SET price = COALESCE($2, price), original_price = $3, checkout_url = $4,
                        is_premium = $6
                 WHERE id = $1 AND product_id = $5`,
                [planId, price, orig, url, productId, isPremium]
            );
            const code = (input.offer_code || '').trim().slice(0, 100);
            // desativa ofertas ANTIGAS deste produto/plano que não são mais o código atual
            await db.query(
                `UPDATE product_offers SET is_active = false, updated_at = NOW()
                 WHERE product_id = $1 AND LOWER(offer_name) = LOWER($2) AND ($3 = '' OR offer_id <> $3)`,
                [productId, planName, code]
            );
            if (code) {
                await db.query(
                    `INSERT INTO product_offers (product_id, gateway, offer_id, offer_name, checkout_url, price, is_active, is_premium)
                     VALUES ($1, $2, $3, $4, $5, $6, true, $7)
                     ON CONFLICT (gateway, offer_id) DO UPDATE SET
                        product_id = EXCLUDED.product_id, offer_name = EXCLUDED.offer_name,
                        checkout_url = EXCLUDED.checkout_url, price = EXCLUDED.price,
                        is_active = true, is_premium = EXCLUDED.is_premium, updated_at = NOW()`,
                    [productId, gateway, code, planName, url, price, isPremium]
                );
            }
        }
        const plansIn = Array.isArray(req.body?.plans) ? req.body.plans : [];
        for (const p of state.chat.plans) {
            const input = plansIn.find(x => parseInt(x.id, 10) === p.id);
            if (input) await savePlan(state.chat.product_id, p.id, p.name, input);
        }
        if (req.body?.story && state.story.plan) {
            await savePlan(state.story.product_id, state.story.plan.id, state.story.plan.name, req.body.story);
        }
        const fresh = await loadPaywallState();
        return res.json({ success: true, ...fresh });
    } catch (err) {
        logger.error('Erro salvando paywall do chat:', err);
        return res.status(500).json({ success: false, error: err.message || 'Erro interno' });
    }
});

// =============================================================================
// CENTRAL DE SUPORTE — config editável (system_settings 'support_config')
// =============================================================================
// IMPORTANTE: registrado ANTES das rotas /:id (senão PUT /support-config
// casaria com PUT /:id).

router.get('/support-config', requireAdmin, async (req, res) => {
    try {
        const chatsApi = require('./user-chats');
        const { rows } = await db.query(`SELECT value FROM system_settings WHERE key = 'support_config'`);
        const saved = rows[0]?.value || {};
        // devolve saved + defaults resolvidos (pro painel mostrar o que vale)
        const { rows: sc } = await db.query(`SELECT id, name, avatar_url FROM chats WHERE is_support = true AND active = true ORDER BY id LIMIT 1`);
        return res.json({
            success: true,
            config: saved,
            support_chat: sc[0] || null,
            defaults: {
                pix_template: 'Oi {nome}! Vi aqui que você gerou o Pix{valor} pra garantir {produto} 👀 Ele fica reservado por pouco tempo — paga agora pra não perder!',
                purchase_template: 'Parabéns, {nome}! 🎉 Sua compra de {produto} foi APROVADA e o acesso JÁ TÁ liberado em Minhas Compras. Corre lá 😈 Qualquer dúvida, me chama aqui!',
                welcome_template: '{saudacao}, {nome}! 👋 Eu sou o suporte oficial do app. Qualquer dúvida, pagamento ou problema, me chama AQUI nessa conversa que eu resolvo rapidinho. Bom proveito 🔥',
            },
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

router.put('/support-config', requireAdmin, async (req, res) => {
    try {
        const b = req.body || {};
        const cfg = {
            whatsapp_link: String(b.whatsapp_link || '').trim().slice(0, 500),
            pix_template: String(b.pix_template || '').trim().slice(0, 1000),
            purchase_template: String(b.purchase_template || '').trim().slice(0, 1000),
            welcome_enabled: b.welcome_enabled === true,
            welcome_template: String(b.welcome_template || '').trim().slice(0, 1000),
            default_offer_ids: (Array.isArray(b.default_offer_ids) ? b.default_offer_ids : [])
                .map(x => parseInt(x, 10)).filter(Boolean).slice(0, 3),
        };
        await db.query(
            `INSERT INTO system_settings (key, value, description)
             VALUES ('support_config', $1::jsonb, 'Central de Suporte (templates + WhatsApp + ofertas padrão)')
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
            [JSON.stringify(cfg)]
        );
        try { require('./user-chats').invalidateSupportConfig(); } catch (_) {}
        return res.json({ success: true, config: cfg });
    } catch (err) {
        logger.error('Erro salvando support-config:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// POST /support-broadcast — aviso manual pelo chat de Suporte: injeta a
// mensagem na conversa de suporte de todo mundo que JÁ tem essa conversa
// (audience 'buyers' = só quem tem compra) + dispara push.
router.post('/support-broadcast', requireAdmin, async (req, res) => {
    try {
        const message = String(req.body?.message || '').trim().slice(0, 1000);
        if (!message) return res.status(400).json({ success: false, error: 'Mensagem obrigatória' });
        const audience = req.body?.audience === 'buyers' ? 'buyers' : 'all';
        const { rows: sc } = await db.query(`SELECT * FROM chats WHERE active = true AND is_support = true ORDER BY id LIMIT 1`);
        if (!sc.length) return res.status(400).json({ success: false, error: 'Nenhum chat marcado como Suporte' });
        const chat = sc[0];

        const { rows: sessions } = await db.query(
            audience === 'buyers'
                ? `SELECT s.id, s.customer_email FROM chat_sessions s
                   JOIN customers c ON LOWER(c.email) = LOWER(s.customer_email) AND c.total_purchases > 0
                   WHERE s.chat_id = $1 AND s.customer_email IS NOT NULL`
                : `SELECT s.id, s.customer_email FROM chat_sessions s
                   WHERE s.chat_id = $1 AND s.customer_email IS NOT NULL`,
            [chat.id]
        );

        let delivered = 0;
        for (const s of sessions) {
            try {
                await db.query(
                    `INSERT INTO chat_messages (session_id, sender, type, content, meta)
                     VALUES ($1, 'bot', 'text', $2, '{"typing_ms":0}'::jsonb)`,
                    [s.id, message]
                );
                await db.query(`UPDATE chat_sessions SET last_seen_at = NULL, updated_at = NOW() WHERE id = $1`, [s.id]);
                delivered++;
            } catch (_) {}
        }

        // push pro mesmo público (foto/nome do suporte, clique abre a conversa)
        let pushed = 0;
        try {
            const { sendChatPush } = require('../lib/chat-worker');
            if (typeof sendChatPush === 'function') {
                for (const s of sessions) {
                    try {
                        const ok = await sendChatPush(s.customer_email, chat, { type: 'text', content: message });
                        if (ok) pushed++;
                    } catch (_) {}
                }
            }
        } catch (_) {}

        return res.json({ success: true, delivered, pushed, total: sessions.length });
    } catch (err) {
        logger.error('Erro no broadcast do suporte:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// POST /:id/duplicate — duplica a MODELO inteira (persona + roteiro de todos
// os fluxos). Sessões/mensagens de leads não vão. Nasce INATIVA pra ajustar.
router.post('/:id/duplicate', requireAdmin, async (req, res) => {
    const chatId = parseInt(req.params.id, 10);
    if (!chatId) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { rows: [src] } = await db.query(`SELECT * FROM chats WHERE id = $1`, [chatId]);
        if (!src) return res.status(404).json({ success: false, error: 'Chat não encontrado' });
        // cópia genérica de colunas: objetos/arrays são JSONB → stringify
        const SKIP = new Set(['id', 'created_at', 'updated_at', 'name', 'active']);
        const cols = Object.keys(src).filter(k => !SKIP.has(k));
        const vals = cols.map(k => {
            const v = src[k];
            return (v !== null && typeof v === 'object') ? JSON.stringify(v) : v;
        });
        cols.push('name', 'active');
        vals.push((src.name + ' (cópia)').slice(0, 80), false);
        const ph = cols.map((_, i) => '$' + (i + 1)).join(', ');
        const { rows: [copy] } = await db.query(
            `INSERT INTO chats (${cols.join(', ')}) VALUES (${ph}) RETURNING *`, vals
        );
        // roteiro completo (todos os fluxos: open, status_reply, call, inactive)
        const { rows: steps } = await db.query(
            `SELECT * FROM chat_steps WHERE chat_id = $1 ORDER BY step_order, id`, [chatId]
        );
        for (const s of steps) {
            const sSkip = new Set(['id', 'created_at', 'updated_at', 'chat_id']);
            const sCols = Object.keys(s).filter(k => !sSkip.has(k));
            const sVals = sCols.map(k => {
                const v = s[k];
                return (v !== null && typeof v === 'object') ? JSON.stringify(v) : v;
            });
            sCols.push('chat_id'); sVals.push(copy.id);
            const sPh = sCols.map((_, i) => '$' + (i + 1)).join(', ');
            await db.query(`INSERT INTO chat_steps (${sCols.join(', ')}) VALUES (${sPh})`, sVals);
        }
        logger.info(`Chat ${chatId} duplicado → ${copy.id} (${steps.length} blocos)`);
        return res.json({ success: true, chat: copy, steps_copied: steps.length });
    } catch (err) {
        logger.error('Erro duplicando chat:', err);
        return res.status(500).json({ success: false, error: err.message || 'Erro interno' });
    }
});

router.post('/', requireAdmin, async (req, res) => {
    try {
        const { name, avatar_url, section, status_label, show_online, access,
                product_id, checkout_url, reply_mode, allow_photo, display_order, active,
                city_fallback, gate_media, call_video_call_id, trigger_product_ids, input_mode, call_goto_key, tag, auto_start_minutes, listed, is_support,
                story_vip_product_id, story_vip_checkout_url, hide_when_member, teaser_locked, in_rotation } = req.body || {};
        if (!name || !String(name).trim()) return res.status(400).json({ success: false, error: 'Nome obrigatório' });
        const { rows } = await db.query(`
            INSERT INTO chats (name, avatar_url, section, status_label, show_online, access,
                               product_id, checkout_url, reply_mode, allow_photo, display_order, active,
                               city_fallback, gate_media, call_video_call_id, trigger_product_ids, input_mode, call_goto_key, tag, auto_start_minutes, listed, is_support,
                               story_vip_product_id, story_vip_checkout_url, hide_when_member, teaser_locked, in_rotation)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27) RETURNING *
        `, [
            String(name).trim().slice(0, 80),
            (avatar_url || '').trim().slice(0, 1000) || null,
            (section || 'Minhas conversas').trim().slice(0, 60),
            (status_label || 'online').trim().slice(0, 40),
            show_online !== false,
            access === 'vip' ? 'vip' : 'free',
            product_id ? parseInt(product_id, 10) : null,
            (checkout_url || '').trim().slice(0, 1000) || null,
            REPLY_MODES.includes(reply_mode) ? reply_mode : 'vip',
            allow_photo === true,
            parseInt(display_order, 10) || 0,
            active !== false,
            (city_fallback || 'sua região').trim().slice(0, 60),
            gate_media === true,
            call_video_call_id ? parseInt(call_video_call_id, 10) : null,
            cleanTriggerIds(trigger_product_ids),
            INPUT_MODES.includes(input_mode) ? input_mode : 'gated',
            (call_goto_key || '').trim().slice(0, 40) || null,
            (tag || '').trim().slice(0, 30) || null,
            Math.max(0, Math.min(10080, parseInt(auto_start_minutes, 10) || 0)),
            listed !== false,
            is_support === true,
            story_vip_product_id ? parseInt(story_vip_product_id, 10) : null,
            (story_vip_checkout_url || '').trim().slice(0, 1000) || null,
            hide_when_member === true,
            teaser_locked === true,
            in_rotation === true,
        ]);
        // Só um chat de Suporte por vez.
        if (is_support === true) {
            await db.query(`UPDATE chats SET is_support = false WHERE id <> $1`, [rows[0].id]);
        }
        return res.json({ success: true, chat: rows[0] });
    } catch (err) {
        logger.error('Erro criando chat:', err);
        return res.status(500).json({ success: false, error: err.message || 'Erro interno' });
    }
});

router.put('/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const b = req.body || {};
        const updates = []; const values = []; let p = 1;
        const set = (col, val) => { updates.push(`${col} = $${p++}`); values.push(val); };
        if (b.name !== undefined) set('name', String(b.name).trim().slice(0, 80));
        if (b.avatar_url !== undefined) set('avatar_url', (b.avatar_url || '').trim().slice(0, 1000) || null);
        if (b.section !== undefined) set('section', (b.section || 'Minhas conversas').trim().slice(0, 60));
        if (b.status_label !== undefined) set('status_label', (b.status_label || 'online').trim().slice(0, 40));
        if (b.show_online !== undefined) set('show_online', !!b.show_online);
        if (b.access !== undefined) set('access', b.access === 'vip' ? 'vip' : 'free');
        if (b.product_id !== undefined) set('product_id', b.product_id ? parseInt(b.product_id, 10) : null);
        if (b.checkout_url !== undefined) set('checkout_url', (b.checkout_url || '').trim().slice(0, 1000) || null);
        if (b.reply_mode !== undefined) set('reply_mode', REPLY_MODES.includes(b.reply_mode) ? b.reply_mode : 'vip');
        if (b.allow_photo !== undefined) set('allow_photo', !!b.allow_photo);
        if (b.display_order !== undefined) set('display_order', parseInt(b.display_order, 10) || 0);
        if (b.active !== undefined) set('active', !!b.active);
        if (b.city_fallback !== undefined) set('city_fallback', (b.city_fallback || 'sua região').trim().slice(0, 60));
        if (b.gate_media !== undefined) set('gate_media', !!b.gate_media);
        if (b.call_video_call_id !== undefined) set('call_video_call_id', b.call_video_call_id ? parseInt(b.call_video_call_id, 10) : null);
        if (b.trigger_product_ids !== undefined) set('trigger_product_ids', cleanTriggerIds(b.trigger_product_ids));
        if (b.input_mode !== undefined) set('input_mode', INPUT_MODES.includes(b.input_mode) ? b.input_mode : 'gated');
        if (b.call_goto_key !== undefined) set('call_goto_key', (b.call_goto_key || '').trim().slice(0, 40) || null);
        if (b.tag !== undefined) set('tag', (b.tag || '').trim().slice(0, 30) || null);
        if (b.auto_start_minutes !== undefined) set('auto_start_minutes', Math.max(0, Math.min(10080, parseInt(b.auto_start_minutes, 10) || 0)));
        if (b.listed !== undefined) set('listed', !!b.listed);
        if (b.is_support !== undefined) set('is_support', !!b.is_support);
        if (b.story_vip_product_id !== undefined) set('story_vip_product_id', b.story_vip_product_id ? parseInt(b.story_vip_product_id, 10) : null);
        if (b.story_vip_checkout_url !== undefined) set('story_vip_checkout_url', (b.story_vip_checkout_url || '').trim().slice(0, 1000) || null);
        if (b.hide_when_member !== undefined) set('hide_when_member', !!b.hide_when_member);
        if (b.teaser_locked !== undefined) set('teaser_locked', !!b.teaser_locked);
        if (b.in_rotation !== undefined) set('in_rotation', !!b.in_rotation);
        if (b.graph !== undefined) set('graph', b.graph ? JSON.stringify(b.graph) : null);
        if (!updates.length) return res.status(400).json({ success: false, error: 'Nada pra atualizar' });
        values.push(id);
        const { rows } = await db.query(`UPDATE chats SET ${updates.join(', ')} WHERE id = $${p} RETURNING *`, values);
        if (!rows.length) return res.status(404).json({ success: false, error: 'Não encontrado' });
        // Só um chat de Suporte por vez.
        if (b.is_support === true) {
            await db.query(`UPDATE chats SET is_support = false WHERE id <> $1`, [id]);
        }
        return res.json({ success: true, chat: rows[0] });
    } catch (err) {
        logger.error('Erro atualizando chat:', err);
        return res.status(500).json({ success: false, error: err.message || 'Erro interno' });
    }
});

// RANKING dos chats — abertura (sessões), conclusão (chegou ao fim do roteiro)
// e conversão (virou comprador). Pra saber quais conversas convertem mais.
router.get('/ranking', requireAdmin, async (req, res) => {
    try {
        const { rows } = await db.query(`
            WITH steps_count AS (
                SELECT chat_id, COUNT(*)::int AS total
                FROM chat_steps WHERE active = true AND COALESCE(flow,'open') = 'open'
                GROUP BY chat_id
            )
            SELECT ch.id, ch.name, ch.access,
                   COALESCE(sc.total, 0)::int AS total_steps,
                   COUNT(s.id)::int AS opens,
                   COUNT(s.id) FILTER (WHERE sc.total > 0 AND s.current_order >= sc.total - 1)::int AS completions,
                   COUNT(DISTINCT LOWER(s.customer_email)) FILTER (
                       WHERE s.customer_email IS NOT NULL AND EXISTS(
                           SELECT 1 FROM user_access ua
                           WHERE LOWER(ua.email) = LOWER(s.customer_email) AND ua.status = 'active'
                       )
                   )::int AS conversions
            FROM chats ch
            LEFT JOIN steps_count sc ON sc.chat_id = ch.id
            LEFT JOIN chat_sessions s ON s.chat_id = ch.id
            GROUP BY ch.id, ch.name, ch.access, sc.total
            ORDER BY opens DESC
        `);
        return res.json({ success: true, ranking: rows });
    } catch (err) {
        logger.error('Erro no ranking de chats:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// VIP ÚNICO: aplica o MESMO produto (e checkout) em TODAS as conversas VIP, e
// marca como VIP as conversas escolhidas. Assim quem compra esse 1 produto vira
// VIP em todas elas de uma vez.
router.post('/apply-vip-product', requireAdmin, async (req, res) => {
    const productId = req.body?.product_id ? parseInt(req.body.product_id, 10) : null;
    const checkoutUrl = (req.body?.checkout_url || '').trim().slice(0, 1000) || null;
    const alsoMarkAll = req.body?.mark_all_vip === true; // marca TODAS as conversas como VIP
    if (!productId) return res.status(400).json({ success: false, error: 'Escolha o produto' });
    try {
        if (alsoMarkAll) {
            await db.query(`UPDATE chats SET access = 'vip'`);
        }
        const { rowCount } = await db.query(
            `UPDATE chats SET product_id = $1, checkout_url = COALESCE($2, checkout_url) WHERE access = 'vip'`,
            [productId, checkoutUrl]
        );
        return res.json({ success: true, updated: rowCount });
    } catch (err) {
        logger.error('Erro aplicando VIP único:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

router.delete('/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { rowCount } = await db.query(`DELETE FROM chats WHERE id = $1`, [id]);
        if (!rowCount) return res.status(404).json({ success: false, error: 'Não encontrado' });
        return res.json({ success: true, deleted: true });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// ── BLOCOS DO ROTEIRO ────────────────────────────────────────────────────────

router.get('/:id/steps', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { rows } = await db.query(
            `SELECT * FROM chat_steps WHERE chat_id = $1 ORDER BY step_order, id`, [id]
        );
        return res.json({ success: true, steps: rows });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// Normaliza a lista de produtos-gatilho do pós-compra (array de IDs → JSONB)
function cleanTriggerIds(raw) {
    if (!Array.isArray(raw)) return null;
    const ids = raw.map(x => parseInt(x, 10)).filter(x => x > 0).slice(0, 50);
    return ids.length ? JSON.stringify(ids) : null;
}

function parseButtons(raw) {
    if (!Array.isArray(raw)) return null;
    const out = raw
        .map(b => ({ label: String(b?.label || '').trim().slice(0, 60), goto: String(b?.goto || '').trim().slice(0, 40) || null }))
        .filter(b => b.label)
        .slice(0, 4);
    return out.length ? JSON.stringify(out) : null;
}

// "Ordem" no painel é POSIÇÃO (1 = primeiro bloco). Vazio/0 = fim da fila.
// Reposiciona o bloco dentro do fluxo e renumera todos (10, 20, 30...) — assim
// o número digitado SEMPRE vale, sem depender da numeração interna antiga.
async function repositionStep(chatId, flow, stepId, position) {
    const { rows } = await db.query(
        `SELECT id FROM chat_steps
         WHERE chat_id = $1 AND COALESCE(flow, 'open') = $2 AND active = true
         ORDER BY step_order, id`,
        [chatId, flow || 'open']
    );
    const ids = rows.map(r => r.id).filter(i => i !== stepId);
    const pos = (position && position > 0) ? Math.min(position - 1, ids.length) : ids.length;
    ids.splice(pos, 0, stepId);
    for (let i = 0; i < ids.length; i++) {
        await db.query(`UPDATE chat_steps SET step_order = $2 WHERE id = $1`, [ids[i], (i + 1) * 10]);
    }
}

router.post('/:id/steps', requireAdmin, async (req, res) => {
    const chatId = parseInt(req.params.id, 10);
    if (!chatId) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const b = req.body || {};
        const type = STEP_TYPES.includes(b.type) ? b.type : 'text';
        const { rows } = await db.query(`
            INSERT INTO chat_steps (chat_id, step_order, step_key, type, content, media_url, buttons, link_url, product_id, typing_ms, goto_key, delay_seconds, active, allow_input, view_seconds, flow, gate, cta_color, wait_open)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *
        `, [
            chatId,
            parseInt(b.step_order, 10) || 0,
            (b.step_key || '').trim().slice(0, 40) || null,
            type,
            (b.content || '').trim().slice(0, 2000) || null,
            (b.media_url || '').trim().slice(0, 1000) || null,
            parseButtons(b.buttons),
            (b.link_url || '').trim().slice(0, 1000) || null,
            b.product_id ? parseInt(b.product_id, 10) : null,
            Math.max(0, Math.min(10000, parseInt(b.typing_ms, 10) || 3000)),
            (b.goto_key || '').trim().slice(0, 40) || null,
            Math.max(0, Math.min(7 * 24 * 3600, parseInt(b.delay_seconds, 10) || 0)),
            b.active !== false,
            b.allow_input === true,
            Math.max(0, Math.min(120, parseInt(b.view_seconds, 10) || 0)),
            cleanFlow(b.flow),
            b.gate === true,
            (b.cta_color || '').trim().slice(0, 20) || null,
            b.wait_open === true,
        ]);
        // aplica a POSIÇÃO escolhida (vazio = fim) e renumera o fluxo inteiro
        await repositionStep(chatId, cleanFlow(b.flow), rows[0].id, parseInt(b.step_order, 10) || 0);
        return res.json({ success: true, step: rows[0] });
    } catch (err) {
        logger.error('Erro criando bloco do chat:', err);
        return res.status(500).json({ success: false, error: err.message || 'Erro interno' });
    }
});

router.put('/:id/steps/:stepId', requireAdmin, async (req, res) => {
    const stepId = parseInt(req.params.stepId, 10);
    if (!stepId) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const b = req.body || {};
        const updates = []; const values = []; let p = 1;
        const set = (col, val) => { updates.push(`${col} = $${p++}`); values.push(val); };
        // step_order NÃO entra no UPDATE direto: a posição é aplicada pelo
        // repositionStep no final — e SÓ quando um número > 0 foi digitado.
        // (Sem isso, editar um bloco sem mexer na posição jogava ele pro fim.)
        if (b.step_key !== undefined) set('step_key', (b.step_key || '').trim().slice(0, 40) || null);
        if (b.type !== undefined) set('type', STEP_TYPES.includes(b.type) ? b.type : 'text');
        if (b.content !== undefined) set('content', (b.content || '').trim().slice(0, 2000) || null);
        if (b.media_url !== undefined) set('media_url', (b.media_url || '').trim().slice(0, 1000) || null);
        if (b.buttons !== undefined) set('buttons', parseButtons(b.buttons));
        if (b.link_url !== undefined) set('link_url', (b.link_url || '').trim().slice(0, 1000) || null);
        if (b.product_id !== undefined) set('product_id', b.product_id ? parseInt(b.product_id, 10) : null);
        if (b.typing_ms !== undefined) set('typing_ms', Math.max(0, Math.min(10000, parseInt(b.typing_ms, 10) || 3000)));
        if (b.goto_key !== undefined) set('goto_key', (b.goto_key || '').trim().slice(0, 40) || null);
        if (b.delay_seconds !== undefined) set('delay_seconds', Math.max(0, Math.min(7 * 24 * 3600, parseInt(b.delay_seconds, 10) || 0)));
        if (b.allow_input !== undefined) set('allow_input', !!b.allow_input);
        if (b.view_seconds !== undefined) set('view_seconds', Math.max(0, Math.min(120, parseInt(b.view_seconds, 10) || 0)));
        if (b.flow !== undefined) set('flow', cleanFlow(b.flow));
        if (b.gate !== undefined) set('gate', !!b.gate);
        if (b.cta_color !== undefined) set('cta_color', (b.cta_color || '').trim().slice(0, 20) || null);
        if (b.wait_open !== undefined) set('wait_open', !!b.wait_open);
        if (b.active !== undefined) set('active', !!b.active);
        const wantsMove = parseInt(b.step_order, 10) > 0;
        if (!updates.length && !wantsMove) return res.status(400).json({ success: false, error: 'Nada pra atualizar' });
        let row;
        if (updates.length) {
            values.push(stepId);
            const { rows } = await db.query(`UPDATE chat_steps SET ${updates.join(', ')} WHERE id = $${p} RETURNING *`, values);
            if (!rows.length) return res.status(404).json({ success: false, error: 'Não encontrado' });
            row = rows[0];
        } else {
            const { rows } = await db.query(`SELECT * FROM chat_steps WHERE id = $1`, [stepId]);
            if (!rows.length) return res.status(404).json({ success: false, error: 'Não encontrado' });
            row = rows[0];
        }
        // POSIÇÃO digitada (> 0) → move pra lá e renumera o fluxo (10, 20, 30...).
        // Campo vazio/0 = NÃO mexe na ordem.
        if (wantsMove) {
            await repositionStep(row.chat_id, row.flow || 'open', stepId, parseInt(b.step_order, 10));
        }
        return res.json({ success: true, step: row });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message || 'Erro interno' });
    }
});

router.delete('/:id/steps/:stepId', requireAdmin, async (req, res) => {
    const stepId = parseInt(req.params.stepId, 10);
    if (!stepId) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { rowCount } = await db.query(`DELETE FROM chat_steps WHERE id = $1`, [stepId]);
        if (!rowCount) return res.status(404).json({ success: false, error: 'Não encontrado' });
        return res.json({ success: true, deleted: true });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// ── EXPORTAR / IMPORTAR roteiro completo (JSON) ──────────────────────────────

// GET /:id/export — persona + todos os blocos num JSON (backup/replicação)
router.get('/:id/export', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { rows: cr } = await db.query(`SELECT * FROM chats WHERE id = $1`, [id]);
        if (!cr.length) return res.status(404).json({ success: false, error: 'Não encontrado' });
        const c = cr[0];
        const { rows: steps } = await db.query(
            `SELECT step_order, step_key, type, content, media_url, buttons, link_url, product_id, typing_ms, goto_key, delay_seconds, active, allow_input, view_seconds, flow, gate, cta_color, wait_open
             FROM chat_steps WHERE chat_id = $1 ORDER BY flow, step_order, id`, [id]
        );
        const payload = {
            format: 'mvchat',
            version: 1,
            exported_at: new Date().toISOString(),
            chat: {
                name: c.name, avatar_url: c.avatar_url, section: c.section,
                status_label: c.status_label, show_online: c.show_online,
                access: c.access, product_id: c.product_id, checkout_url: c.checkout_url,
                reply_mode: c.reply_mode, allow_photo: c.allow_photo, display_order: c.display_order,
                input_mode: c.input_mode,
            },
            steps,
        };
        const fname = 'chat-' + String(c.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) + '.json';
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
        return res.send(JSON.stringify(payload, null, 2));
    } catch (err) {
        logger.error('Erro exportando chat:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// POST /import — cria um chat NOVO a partir do JSON exportado
router.post('/import', requireAdmin, async (req, res) => {
    try {
        const data = req.body || {};
        if (data.format !== 'mvchat' || !data.chat || !Array.isArray(data.steps)) {
            return res.status(400).json({ success: false, error: 'Arquivo inválido — exporte um chat pelo painel pra ver o formato.' });
        }
        const c = data.chat;
        const { rows: created } = await db.query(`
            INSERT INTO chats (name, avatar_url, section, status_label, show_online, access,
                               product_id, checkout_url, reply_mode, allow_photo, display_order, active, input_mode)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,$12) RETURNING *
        `, [
            String(c.name || 'Chat importado').trim().slice(0, 80),
            (c.avatar_url || '').trim().slice(0, 1000) || null,
            (c.section || 'Minhas conversas').trim().slice(0, 60),
            (c.status_label || 'online').trim().slice(0, 40),
            c.show_online !== false,
            c.access === 'vip' ? 'vip' : 'free',
            c.product_id ? parseInt(c.product_id, 10) : null,
            (c.checkout_url || '').trim().slice(0, 1000) || null,
            REPLY_MODES.includes(c.reply_mode) ? c.reply_mode : 'vip',
            c.allow_photo === true,
            parseInt(c.display_order, 10) || 0,
            // default 'gated' (igual ao criar) — importar sem o campo não deve
            // virar digitação livre e furar o gating do paywall
            INPUT_MODES.includes(c.input_mode) ? c.input_mode : 'gated',
        ]);
        const chat = created[0];
        let imported = 0;
        for (const s of data.steps.slice(0, 200)) {
            const type = STEP_TYPES.includes(s.type) ? s.type : 'text';
            await db.query(`
                INSERT INTO chat_steps (chat_id, step_order, step_key, type, content, media_url, buttons, link_url, product_id, typing_ms, goto_key, delay_seconds, active, allow_input, view_seconds, flow, gate, cta_color, wait_open)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
            `, [
                chat.id,
                parseInt(s.step_order, 10) || 0,
                (s.step_key || '').trim().slice(0, 40) || null,
                type,
                (s.content || '').trim().slice(0, 2000) || null,
                (s.media_url || '').trim().slice(0, 1000) || null,
                parseButtons(s.buttons),
                (s.link_url || '').trim().slice(0, 1000) || null,
                s.product_id ? parseInt(s.product_id, 10) : null,
                Math.max(0, Math.min(10000, parseInt(s.typing_ms, 10) || 3000)),
                (s.goto_key || '').trim().slice(0, 40) || null,
                Math.max(0, Math.min(7 * 24 * 3600, parseInt(s.delay_seconds, 10) || 0)),
                s.active !== false,
                s.allow_input === true,
                Math.max(0, Math.min(120, parseInt(s.view_seconds, 10) || 0)),
                cleanFlow(s.flow),
                s.gate === true,
                (s.cta_color || '').trim().slice(0, 20) || null,
                s.wait_open === true,
            ]);
            imported++;
        }
        return res.json({ success: true, chat, steps_imported: imported });
    } catch (err) {
        logger.error('Erro importando chat:', err);
        return res.status(500).json({ success: false, error: err.message || 'Erro interno' });
    }
});

// ── CONVERSAS RECEBIDAS (leitura) ────────────────────────────────────────────

router.get('/:id/sessions', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { rows } = await db.query(`
            SELECT s.id, s.customer_email, s.visitor_id, s.created_at, s.updated_at,
                   (SELECT COUNT(*)::int FROM chat_messages m WHERE m.session_id = s.id AND m.sender = 'user') AS user_messages,
                   (SELECT content FROM chat_messages m WHERE m.session_id = s.id AND m.sender = 'user' ORDER BY m.id DESC LIMIT 1) AS last_user_message
            FROM chat_sessions s
            WHERE s.chat_id = $1
            ORDER BY s.updated_at DESC
            LIMIT 200
        `, [id]);
        return res.json({ success: true, sessions: rows });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

router.get('/sessions/:sid/messages', requireAdmin, async (req, res) => {
    const sid = parseInt(req.params.sid, 10);
    if (!sid) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { rows } = await db.query(
            `SELECT id, sender, type, content, media_url, meta, viewed_at, created_at
             FROM chat_messages WHERE session_id = $1 ORDER BY id LIMIT 500`, [sid]
        );
        return res.json({ success: true, messages: rows });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// ── STATUS (stories) ─────────────────────────────────────────────────────────
const STATUS_TYPES = ['image', 'video', 'text'];

// Lista status de um chat (inclui expirados, marcados como tal — admin vê tudo)
router.get('/:id/status', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { rows } = await db.query(`
            SELECT s.*, (s.expires_at <= NOW()) AS expired,
                   (SELECT COUNT(*)::int FROM chat_status_views v WHERE v.status_id = s.id) AS views
            FROM chat_status s WHERE s.chat_id = $1 ORDER BY s.created_at DESC LIMIT 100
        `, [id]);
        return res.json({ success: true, status: rows });
    } catch (err) {
        logger.error('Erro listando status:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

router.post('/:id/status', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const b = req.body || {};
        const type = STATUS_TYPES.includes(b.type) ? b.type : 'image';
        const mediaUrl = (b.media_url || '').trim().slice(0, 1000) || null;
        if ((type === 'image' || type === 'video') && !mediaUrl) {
            return res.status(400).json({ success: false, error: 'Mídia obrigatória pra status de foto/vídeo' });
        }
        // duração configurável: padrão 24h, aceita horas custom (1..168)
        const hours = Math.max(1, Math.min(168, parseInt(b.expires_hours, 10) || 24));
        const { rows } = await db.query(`
            INSERT INTO chat_status (chat_id, type, media_url, caption, bg_color, reply_goto_key, is_vip, expires_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7, NOW() + make_interval(hours => $8)) RETURNING *
        `, [
            id, type, mediaUrl,
            (b.caption || '').trim().slice(0, 300) || null,
            (b.bg_color || '').trim().slice(0, 20) || null,
            (b.reply_goto_key || '').trim().slice(0, 40) || null,
            b.is_vip === true,
            hours,
        ]);
        return res.json({ success: true, status: rows[0] });
    } catch (err) {
        logger.error('Erro criando status:', err);
        return res.status(500).json({ success: false, error: err.message || 'Erro interno' });
    }
});

router.delete('/:id/status/:sid', requireAdmin, async (req, res) => {
    const sid = parseInt(req.params.sid, 10);
    if (!sid) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { rowCount } = await db.query(`DELETE FROM chat_status WHERE id = $1`, [sid]);
        if (!rowCount) return res.status(404).json({ success: false, error: 'Não encontrado' });
        return res.json({ success: true, deleted: true });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// ── ROTINA DE STATUS (agenda semanal) ────────────────────────────────────────
function cleanWeekdays(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [...new Set(raw.map(x => parseInt(x, 10)).filter(x => x >= 0 && x <= 6))].sort();
    return out;
}
function cleanTime(raw) {
    const m = String(raw || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return '09:00';
    const h = Math.max(0, Math.min(23, parseInt(m[1], 10)));
    const mm = Math.max(0, Math.min(59, parseInt(m[2], 10)));
    return String(h).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}

// Lista todos os agendamentos (com nome da modelo)
router.get('/status-schedule', requireAdmin, async (req, res) => {
    try {
        const { rows } = await db.query(`
            SELECT s.*, c.name AS chat_name, c.avatar_url
            FROM chat_status_schedule s JOIN chats c ON c.id = s.chat_id
            ORDER BY s.post_time, s.id
        `);
        return res.json({ success: true, schedule: rows });
    } catch (err) {
        logger.error('Erro listando rotina de status:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

router.post('/status-schedule', requireAdmin, async (req, res) => {
    try {
        const b = req.body || {};
        const chatId = parseInt(b.chat_id, 10);
        if (!chatId) return res.status(400).json({ success: false, error: 'Escolha a modelo' });
        const type = STATUS_TYPES.includes(b.type) ? b.type : 'image';
        const mediaUrl = (b.media_url || '').trim().slice(0, 1000) || null;
        if ((type === 'image' || type === 'video') && !mediaUrl) {
            return res.status(400).json({ success: false, error: 'Mídia obrigatória pra foto/vídeo' });
        }
        const weekdays = cleanWeekdays(b.weekdays);
        if (!weekdays.length) return res.status(400).json({ success: false, error: 'Escolha pelo menos 1 dia da semana' });
        const { rows } = await db.query(`
            INSERT INTO chat_status_schedule (chat_id, weekdays, post_time, type, media_url, caption, bg_color, reply_goto_key, expires_hours, active, is_vip)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *
        `, [
            chatId, JSON.stringify(weekdays), cleanTime(b.post_time), type, mediaUrl,
            (b.caption || '').trim().slice(0, 300) || null,
            (b.bg_color || '').trim().slice(0, 20) || null,
            (b.reply_goto_key || '').trim().slice(0, 40) || null,
            Math.max(1, Math.min(168, parseInt(b.expires_hours, 10) || 24)),
            b.active !== false,
            b.is_vip === true,
        ]);
        return res.json({ success: true, schedule: rows[0] });
    } catch (err) {
        logger.error('Erro criando rotina de status:', err);
        return res.status(500).json({ success: false, error: err.message || 'Erro interno' });
    }
});

router.put('/status-schedule/:sid', requireAdmin, async (req, res) => {
    const sid = parseInt(req.params.sid, 10);
    if (!sid) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const b = req.body || {};
        const updates = []; const values = []; let p = 1;
        const set = (col, val) => { updates.push(`${col} = $${p++}`); values.push(val); };
        if (b.weekdays !== undefined) set('weekdays', JSON.stringify(cleanWeekdays(b.weekdays)));
        if (b.post_time !== undefined) set('post_time', cleanTime(b.post_time));
        if (b.caption !== undefined) set('caption', (b.caption || '').trim().slice(0, 300) || null);
        if (b.active !== undefined) set('active', !!b.active);
        if (b.is_vip !== undefined) set('is_vip', !!b.is_vip);
        if (!updates.length) return res.status(400).json({ success: false, error: 'Nada pra atualizar' });
        values.push(sid);
        const { rows } = await db.query(`UPDATE chat_status_schedule SET ${updates.join(', ')} WHERE id = $${p} RETURNING *`, values);
        if (!rows.length) return res.status(404).json({ success: false, error: 'Não encontrado' });
        return res.json({ success: true, schedule: rows[0] });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

router.delete('/status-schedule/:sid', requireAdmin, async (req, res) => {
    const sid = parseInt(req.params.sid, 10);
    if (!sid) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { rowCount } = await db.query(`DELETE FROM chat_status_schedule WHERE id = $1`, [sid]);
        if (!rowCount) return res.status(404).json({ success: false, error: 'Não encontrado' });
        return res.json({ success: true, deleted: true });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// VENDAS POR CHAT (origem UTM 'chat_<id>' devolvida pela Kirvano). Mostra qual
// dos chats de funil está vendendo mais, pra rotacionar/escolher o melhor.
router.get('/sales-by-source', requireAdmin, async (req, res) => {
    // período: hoje / ontem / 7 / 30 / total (fuso Brasília, igual ao resto do painel)
    const TZ = 'America/Sao_Paulo';
    const period = String(req.query.period || (req.query.days ? req.query.days : '7'));
    // Janela por created_at (data da 1ª venda), NÃO granted_at: a renovação
    // de assinatura atualiza granted_at = NOW() e fazia a venda ANTIGA
    // reaparecer como "venda de hoje" do chat a cada ciclo.
    let where;
    if (period === 'today') {
        where = `ua.created_at >= (((NOW() AT TIME ZONE '${TZ}')::date)::timestamp AT TIME ZONE '${TZ}')`;
    } else if (period === 'yesterday') {
        where = `ua.created_at >= ((((NOW() AT TIME ZONE '${TZ}')::date - 1))::timestamp AT TIME ZONE '${TZ}')
                 AND ua.created_at < (((NOW() AT TIME ZONE '${TZ}')::date)::timestamp AT TIME ZONE '${TZ}')`;
    } else if (period === 'total') {
        where = `TRUE`;
    } else {
        const days = Math.max(1, Math.min(365, parseInt(period, 10) || 7));
        where = `ua.created_at > NOW() - INTERVAL '${days} days'`;
    }
    try {
        const { rows } = await db.query(`
            SELECT ua.utm_content,
                   COUNT(*)::int AS sales,
                   COALESCE(SUM(ua.sale_amount), 0)::float AS revenue,
                   COALESCE(SUM(ua.net_amount), 0)::float AS net
            FROM user_access ua
            WHERE ua.granted_by = 'webhook'
              AND ua.status = 'active'
              AND ua.utm_content ~ '^chat_[0-9]+$'
              AND ${where}
            GROUP BY ua.utm_content
            ORDER BY sales DESC, revenue DESC`);
        const ids = rows.map(r => parseInt(String(r.utm_content).replace('chat_', ''), 10)).filter(Boolean);
        const names = {};
        if (ids.length) {
            const { rows: cr } = await db.query(`SELECT id, name FROM chats WHERE id = ANY($1)`, [ids]);
            cr.forEach(c => { names[c.id] = c.name; });
        }
        const sources = rows.map(r => {
            const cid = parseInt(String(r.utm_content).replace('chat_', ''), 10);
            return { chat_id: cid, name: names[cid] || ('Chat ' + cid), sales: r.sales, revenue: r.revenue, net: r.net };
        });
        return res.json({ success: true, period, sources });
    } catch (err) {
        logger.error('[admin-chats] sales-by-source:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

module.exports = router;
