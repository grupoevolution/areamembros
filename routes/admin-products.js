/**
 * =============================================================================
 * routes/admin-products.js — Gestão de produtos no admin
 * =============================================================================
 *
 * Endpoints pra criar, listar, editar e deletar produtos.
 * Cada produto pode ter várias "ofertas" (uma por gateway).
 *
 * Nota: na Fase 1, versão simplificada pra você cadastrar produtos de teste.
 * Na Fase 4, essa funcionalidade ganha visual bonito e features avançadas
 * (preview, upload de imagens, etc).
 *
 * =============================================================================
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAdmin } = require('../lib/auth');
const { logger } = require('../lib/logger');
const { listCollectionVideos, bunnyEmbedUrl, bunnyThumbUrl } = require('../lib/bunny');


// Helper: valida URL direta de chamada (Fase E). Aceita só http/https e
// faz cap de tamanho (Bunny URLs ficam por volta de 100 chars, dou folga
// pra query strings). Qualquer outro esquema (javascript:, data:, etc) vira
// null — defesa contra XSS caso esse campo seja renderizado sem escape.
function sanitizeDirectCallUrl(raw) {
    const s = String(raw || '').trim().slice(0, 500);
    if (!s) return null;
    if (!/^https?:\/\//i.test(s)) return null;
    return s;
}


// Fase F: sanitiza o texto "chamando" do overlay. Trim + cap de 120 chars
// (banco já limita via VARCHAR(120) — fazemos cap aqui pra erro amigável
// em vez de falhar a query). Vazio vira null pra cair no default do frontend.
function sanitizeCallRingingText(raw) {
    const s = String(raw || '').trim().slice(0, 120);
    return s || null;
}


// Helper: normaliza e valida os 2 campos Bunny vindos do payload.
// libraryId só dígitos (até 20). collectionId é GUID-ish (até 60 chars).
// Strings vazias viram null pra não poluir o banco.
function sanitizeBunnyFields(body) {
    const lib = String(body.bunny_library_id || '').trim().slice(0, 20);
    const col = String(body.bunny_collection_id || '').trim().slice(0, 60);
    // libraryId tem que ser só dígitos. Qualquer porcaria → null.
    const safeLib = /^\d+$/.test(lib) ? lib : null;
    // collectionId aceita hex/dash/alfa (a chave do Bunny é GUID, mas
    // ele nem sempre formata bonito). Reject só se tiver caractere
    // claramente fora de um identificador.
    const safeCol = /^[a-zA-Z0-9\-_]+$/.test(col) ? col : null;
    return {
        bunny_library_id: safeLib,
        bunny_collection_id: safeCol,
    };
}


// =============================================================================
// LISTAR PRODUTOS
// =============================================================================

router.get('/', requireAdmin, async (req, res) => {
    try {
        // ?include_plans=1 → inclui os produtos OCULTOS (assinatura de chat /
        // stories) pra aparecerem no dropdown "Produto vinculado" do chat. O
        // catálogo normal (sem o param) segue escondendo eles.
        const includePlans = req.query.include_plans === '1';
        const planFilter = includePlans ? '' :
            `WHERE COALESCE(p.is_chat_plan, false) = false
              AND COALESCE(p.is_story_plan, false) = false`;
        const { rows: products } = await db.query(`
            SELECT p.*,
                   c.name as category_name,
                   c.slug as category_slug,
                   (
                       SELECT json_agg(
                           json_build_object(
                               'id', po.id,
                               'gateway', po.gateway,
                               'offer_id', po.offer_id,
                               'offer_name', po.offer_name,
                               'checkout_url', po.checkout_url,
                               'price', po.price,
                               'is_active', po.is_active,
                               'is_acquisition', po.is_acquisition,
                               'acquisition_role', po.acquisition_role
                           )
                           ORDER BY po.gateway
                       )
                       FROM product_offers po WHERE po.product_id = p.id
                   ) as offers,
                   (
                       SELECT COUNT(*)::int FROM user_access ua 
                       WHERE ua.product_id = p.id AND ua.status = 'active'
                   ) as active_access_count
            FROM products p
            LEFT JOIN categories c ON c.id = p.category_id
            ${planFilter}
            ORDER BY p.display_order, p.created_at DESC
        `);
        
        return res.json({ success: true, products });
    } catch (err) {
        logger.error('Erro listando produtos:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// =============================================================================
// OBTER 1 PRODUTO
// =============================================================================

router.get('/:id', requireAdmin, async (req, res) => {
    try {
        const { rows: [product] } = await db.query(`
            SELECT p.*, c.name as category_name
            FROM products p
            LEFT JOIN categories c ON c.id = p.category_id
            WHERE p.id = $1
        `, [req.params.id]);
        
        if (!product) {
            return res.status(404).json({ success: false, error: 'Produto não encontrado' });
        }
        
        const { rows: offers } = await db.query(
            'SELECT * FROM product_offers WHERE product_id = $1 ORDER BY gateway',
            [product.id]
        );
        
        const { rows: media } = await db.query(
            'SELECT * FROM product_media WHERE product_id = $1 ORDER BY display_order',
            [product.id]
        );
        
        return res.json({
            success: true,
            product: { ...product, offers, media }
        });
    } catch (err) {
        logger.error('Erro buscando produto:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// =============================================================================
// CRIAR PRODUTO
// =============================================================================

router.post('/', requireAdmin, async (req, res) => {
    const {
        name,
        description,
        category_id,
        banner_url,
        main_video_url,
        access_url,
        price,
        is_active,
        is_featured,
        is_published,
        preview_enabled,
        badge_text,
        badge_color,
        extra_data,
        offers,
        media,
        audio_url,
        audio_enabled,
        audio_title,
        audio_autoplay,
        chat_button_enabled,
        chat_button_chat_id,
        chat_button_label,
        chat_notify_on_open,
        post_purchase_message,
        post_purchase_link,
        post_purchase_recommended_ids,
        video_call_id,
        product_type,
        direct_call_video_url,
        call_photo_url,
        call_ringing_text,
        call_ringtone_url,
    } = req.body || {};

    if (!name) {
        return res.status(400).json({ success: false, error: 'Nome é obrigatório' });
    }

    // Resolve product_type:
    //   - se vier explícito ('content' ou 'video_call') → valida e usa
    //   - se não vier → infere pelo video_call_id (backward-compat)
    let resolvedProductType;
    if (product_type !== undefined && product_type !== null && product_type !== '') {
        if (product_type !== 'content' && product_type !== 'video_call') {
            return res.status(400).json({
                success: false,
                error: "product_type inválido (use 'content' ou 'video_call')",
            });
        }
        resolvedProductType = product_type;
    } else {
        resolvedProductType = (video_call_id && parseInt(video_call_id, 10)) ? 'video_call' : 'content';
    }

    // Fase E: produto-chamada pode ter direct_call_video_url (link Bunny direto)
    // OU video_call_id (reusa chamada do Remarketing). Pelo menos UM dos dois.
    const parsedCallId = parseInt(video_call_id, 10);
    const isCallProduct = resolvedProductType === 'video_call';
    const safeDirectCallUrl = sanitizeDirectCallUrl(direct_call_video_url);
    const hasDirectUrl = !!safeDirectCallUrl;
    const hasCallId = !!(parsedCallId && !isNaN(parsedCallId));

    if (isCallProduct && !hasDirectUrl && !hasCallId) {
        return res.status(400).json({
            success: false,
            error: "Produto do tipo 'video_call' exige direct_call_video_url ou video_call_id",
        });
    }
    // Em produto content, zera ambos os campos de chamada pra não poluir o banco.
    const effectiveCallId = isCallProduct ? (hasCallId ? parsedCallId : null) : null;
    const effectiveDirectUrl = isCallProduct ? safeDirectCallUrl : null;

    // Fase F: 3 campos opcionais pra cinematografia do overlay.
    // Só persistem em produto-chamada (isCallProduct). Em produto content,
    // zera tudo. Reusa sanitizeDirectCallUrl pra URLs (rejeita javascript:/data:).
    const safeCallPhoto = sanitizeDirectCallUrl(call_photo_url);
    const safeCallRingtone = sanitizeDirectCallUrl(call_ringtone_url);
    const safeCallRingingText = sanitizeCallRingingText(call_ringing_text);
    const effectiveCallPhoto = isCallProduct ? safeCallPhoto : null;
    const effectiveCallRingingText = isCallProduct ? safeCallRingingText : null;
    const effectiveCallRingtone = isCallProduct ? safeCallRingtone : null;

    // Bunny Collection: opcional, só vale pra produtos 'content'. Em produto
    // do tipo 'video_call' não tem galeria — então ignoramos pra não confundir.
    const bunnyFields = sanitizeBunnyFields(req.body || {});
    const effectiveBunnyLib = isCallProduct ? null : bunnyFields.bunny_library_id;
    const effectiveBunnyCol = isCallProduct ? null : bunnyFields.bunny_collection_id;

    // Botão "Enviar mensagem" → abre uma conversa. Só faz sentido em produto
    // 'content'. chat_button_chat_id é o chat de destino (pode ser um oculto).
    const chatBtnChatId = parseInt(chat_button_chat_id, 10);
    const effChatBtnChatId = (chatBtnChatId && !isNaN(chatBtnChatId)) ? chatBtnChatId : null;
    const effChatBtnEnabled = chat_button_enabled === true && !!effChatBtnChatId;
    const effChatBtnLabel = (chat_button_label || '').trim().slice(0, 60) || null;
    const effChatNotifyOnOpen = chat_notify_on_open === true && !!effChatBtnChatId;
    const effPostMsg = (post_purchase_message || '').trim().slice(0, 2000) || null;
    const effPostLink = (post_purchase_link || '').trim().slice(0, 1000) || null;
    const effPostRec = (Array.isArray(post_purchase_recommended_ids)
        ? post_purchase_recommended_ids.map(x => parseInt(x, 10)).filter(Boolean).slice(0, 10) : []);
    const effPostRecJson = effPostRec.length ? JSON.stringify(effPostRec) : null;
    const effAudioAutoplay = audio_autoplay === true;

    // Regra de segurança server-side: só pode publicar se vier ao menos 1 oferta válida.
    // Mesmo que o frontend mande is_published=true sem gateway, o backend força false.
    // EXCEÇÃO: produto-chamada (product_type='video_call') não exige oferta.
    const hasValidOffer = Array.isArray(offers)
        && offers.some(o => o && o.gateway && o.offer_id);
    const finalIsPublished = is_published === true && (hasValidOffer || isCallProduct);

    try {
        const product = await db.transaction(async (client) => {
            const safeExtra = (extra_data && typeof extra_data === 'object') ? extra_data : {};
            let created;
            try {
                const r = await client.query(`
                    INSERT INTO products (
                        name, description, category_id, banner_url, main_video_url,
                        access_url, price, is_active, is_featured, badge_text, badge_color, extra_data, is_published,
                        audio_url, audio_enabled, audio_title, video_call_id, product_type,
                        bunny_library_id, bunny_collection_id, direct_call_video_url,
                        call_photo_url, call_ringing_text, call_ringtone_url,
                        preview_enabled,
                        chat_button_enabled, chat_button_chat_id, chat_button_label, chat_notify_on_open,
                        post_purchase_message, post_purchase_link, post_purchase_recommended_ids,
                        audio_autoplay
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33)
                    RETURNING *
                `, [
                    name, description || null, category_id || null,
                    banner_url || null, main_video_url || null, access_url || null,
                    parseFloat(price) || 0,
                    is_active !== false,
                    is_featured === true,
                    (badge_text || '').trim().slice(0, 40) || null,
                    (badge_color || '').trim().slice(0, 20) || null,
                    safeExtra,
                    finalIsPublished,
                    (audio_url || '').trim().slice(0, 1000) || null,
                    audio_enabled === true,
                    (audio_title || '').trim().slice(0, 120) || null,
                    effectiveCallId,
                    resolvedProductType,
                    effectiveBunnyLib,
                    effectiveBunnyCol,
                    effectiveDirectUrl,
                    effectiveCallPhoto,
                    effectiveCallRingingText,
                    effectiveCallRingtone,
                    preview_enabled === true,
                    effChatBtnEnabled,
                    effChatBtnChatId,
                    effChatBtnLabel,
                    effChatNotifyOnOpen,
                    effPostMsg,
                    effPostLink,
                    effPostRecJson,
                    effAudioAutoplay,
                ]);
                created = r.rows[0];
            } catch (e) {
                logger.warn('insert produto sem campos novos (fallback):', e.message);
                const r = await client.query(`
                    INSERT INTO products (
                        name, description, category_id, banner_url, main_video_url,
                        access_url, price, is_active, is_featured
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    RETURNING *
                `, [
                    name, description || null, category_id || null,
                    banner_url || null, main_video_url || null, access_url || null,
                    parseFloat(price) || 0,
                    is_active !== false,
                    is_featured === true,
                ]);
                created = r.rows[0];
            }
            
            // Cria ofertas
            if (Array.isArray(offers)) {
                for (const offer of offers) {
                    if (!offer.gateway || !offer.offer_id) continue;
                    // L13.2: aceita is_acquisition + acquisition_role. Defensivo:
                    // role so eh persistido se is_acquisition=true (mantem consistencia).
                    const isAcq = !!offer.is_acquisition;
                    const acqRole = isAcq && ['frontend','bump'].includes(offer.acquisition_role)
                        ? offer.acquisition_role : null;
                    await client.query(`
                        INSERT INTO product_offers
                        (product_id, gateway, offer_id, offer_name, checkout_url, price, is_acquisition, acquisition_role, duration_days)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    `, [
                        created.id, offer.gateway, offer.offer_id,
                        offer.offer_name || null, offer.checkout_url || null,
                        parseFloat(offer.price) || null,
                        isAcq, acqRole,
                        offer.duration_days ? parseInt(offer.duration_days, 10) : null,
                    ]);
                }
            }
            
            // Cria mídia
            if (Array.isArray(media)) {
                for (let i = 0; i < media.length; i++) {
                    const m = media[i];
                    if (!m.url || !m.media_type) continue;
                    await client.query(`
                        INSERT INTO product_media
                        (product_id, media_type, url, display_order, is_locked)
                        VALUES ($1, $2, $3, $4, $5)
                    `, [created.id, m.media_type, m.url, m.display_order ?? i, m.is_locked !== false]);
                }
            }
            
            return created;
        });
        
        // Passe Vitalício dos GRUPOS: flag simples fora do transaction principal
        if (req.body.is_group_pass !== undefined) {
            try { await db.query(`UPDATE products SET is_group_pass = $1 WHERE id = $2`, [req.body.is_group_pass === true, product.id]); } catch (_) {}
        }
        // Link de checkout com DESCONTO (usado no cross-sell do Suporte)
        if (req.body.discount_checkout_url !== undefined) {
            const disc = (req.body.discount_checkout_url || '').toString().trim().slice(0, 1000) || null;
            try { await db.query(`UPDATE products SET discount_checkout_url = $1 WHERE id = $2`, [disc, product.id]); } catch (_) {}
        }
        logger.info(`Produto criado: ${product.name} (ID ${product.id})`);
        return res.status(201).json({ success: true, product });
    } catch (err) {
        logger.error('Erro criando produto:', err);
        
        // Tratar violação de unique constraint na tabela offers
        if (err.code === '23505' && err.constraint?.includes('offers')) {
            return res.status(409).json({
                success: false,
                error: 'Já existe um produto com esse offer_id no gateway informado',
            });
        }
        
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// =============================================================================
// EDITAR PRODUTO
// =============================================================================

router.put('/:id', requireAdmin, async (req, res) => {
    const productId = parseInt(req.params.id, 10);
    if (isNaN(productId)) {
        return res.status(400).json({ success: false, error: 'ID inválido' });
    }
    
    const {
        name,
        description,
        category_id,
        banner_url,
        main_video_url,
        access_url,
        price,
        is_active,
        is_featured,
        is_published,
        preview_enabled,
        badge_text,
        badge_color,
        extra_data,
        offers,
        media,
        audio_url,
        audio_enabled,
        audio_title,
        audio_autoplay,
        chat_button_enabled,
        chat_button_chat_id,
        chat_button_label,
        chat_notify_on_open,
        post_purchase_message,
        post_purchase_link,
        post_purchase_recommended_ids,
        video_call_id,
        product_type,
        direct_call_video_url,
        call_photo_url,
        call_ringing_text,
        call_ringtone_url,
    } = req.body || {};

    if (!name) {
        return res.status(400).json({ success: false, error: 'Nome é obrigatório' });
    }

    // Resolve product_type (idêntico ao POST)
    let resolvedProductType;
    if (product_type !== undefined && product_type !== null && product_type !== '') {
        if (product_type !== 'content' && product_type !== 'video_call') {
            return res.status(400).json({
                success: false,
                error: "product_type inválido (use 'content' ou 'video_call')",
            });
        }
        resolvedProductType = product_type;
    } else {
        resolvedProductType = (video_call_id && parseInt(video_call_id, 10)) ? 'video_call' : 'content';
    }

    // Fase E: aceita direct_call_video_url OR video_call_id (mesma regra do POST).
    const parsedCallId = parseInt(video_call_id, 10);
    const isCallProduct = resolvedProductType === 'video_call';
    const safeDirectCallUrl = sanitizeDirectCallUrl(direct_call_video_url);
    const hasDirectUrl = !!safeDirectCallUrl;
    const hasCallId = !!(parsedCallId && !isNaN(parsedCallId));

    if (isCallProduct && !hasDirectUrl && !hasCallId) {
        return res.status(400).json({
            success: false,
            error: "Produto do tipo 'video_call' exige direct_call_video_url ou video_call_id",
        });
    }
    const effectiveCallId = isCallProduct ? (hasCallId ? parsedCallId : null) : null;
    const effectiveDirectUrl = isCallProduct ? safeDirectCallUrl : null;

    // Fase F (idêntico ao POST): 3 campos opcionais pra cinematografia.
    const safeCallPhoto = sanitizeDirectCallUrl(call_photo_url);
    const safeCallRingtone = sanitizeDirectCallUrl(call_ringtone_url);
    const safeCallRingingText = sanitizeCallRingingText(call_ringing_text);
    const effectiveCallPhoto = isCallProduct ? safeCallPhoto : null;
    const effectiveCallRingingText = isCallProduct ? safeCallRingingText : null;
    const effectiveCallRingtone = isCallProduct ? safeCallRingtone : null;

    // Bunny Collection (mesma regra do POST — só em 'content').
    const bunnyFields = sanitizeBunnyFields(req.body || {});
    const effectiveBunnyLib = isCallProduct ? null : bunnyFields.bunny_library_id;
    const effectiveBunnyCol = isCallProduct ? null : bunnyFields.bunny_collection_id;

    // Botão "Enviar mensagem" (mesma regra do POST).
    const chatBtnChatId = parseInt(chat_button_chat_id, 10);
    const effChatBtnChatId = (chatBtnChatId && !isNaN(chatBtnChatId)) ? chatBtnChatId : null;
    const effChatBtnEnabled = chat_button_enabled === true && !!effChatBtnChatId;
    const effChatBtnLabel = (chat_button_label || '').trim().slice(0, 60) || null;
    const effChatNotifyOnOpen = chat_notify_on_open === true && !!effChatBtnChatId;
    const effPostMsg = (post_purchase_message || '').trim().slice(0, 2000) || null;
    const effPostLink = (post_purchase_link || '').trim().slice(0, 1000) || null;
    const effPostRec = (Array.isArray(post_purchase_recommended_ids)
        ? post_purchase_recommended_ids.map(x => parseInt(x, 10)).filter(Boolean).slice(0, 10) : []);
    const effPostRecJson = effPostRec.length ? JSON.stringify(effPostRec) : null;
    const effAudioAutoplay = audio_autoplay === true;

    // Regra de segurança server-side (idêntica ao POST): só publica se houver
    // pelo menos 1 oferta válida no payload (ou for produto-chamada).
    const hasValidOffer = Array.isArray(offers)
        && offers.some(o => o && o.gateway && o.offer_id);
    const finalIsPublished = is_published === true && (hasValidOffer || isCallProduct);

    try {
        const product = await db.transaction(async (client) => {
            const safeExtra = (extra_data && typeof extra_data === 'object') ? extra_data : {};
            let updated, rowCount;
            try {
                const r = await client.query(`
                    UPDATE products SET
                        name = $1, description = $2, category_id = $3,
                        banner_url = $4, main_video_url = $5, access_url = $6,
                        price = $7, is_active = $8, is_featured = $9,
                        badge_text = $10, badge_color = $11, extra_data = $12,
                        is_published = $13,
                        audio_url = $14, audio_enabled = $15, audio_title = $16,
                        video_call_id = $17,
                        product_type = $18,
                        bunny_library_id = $19,
                        bunny_collection_id = $20,
                        direct_call_video_url = $21,
                        call_photo_url = $22,
                        call_ringing_text = $23,
                        call_ringtone_url = $24,
                        preview_enabled = $25,
                        chat_button_enabled = $27,
                        chat_button_chat_id = $28,
                        chat_button_label = $29,
                        chat_notify_on_open = $30,
                        post_purchase_message = $31,
                        post_purchase_link = $32,
                        post_purchase_recommended_ids = $33,
                        audio_autoplay = $34
                    WHERE id = $26
                    RETURNING *
                `, [
                    name, description || null, category_id || null,
                    banner_url || null, main_video_url || null, access_url || null,
                    parseFloat(price) || 0,
                    is_active !== false,
                    is_featured === true,
                    (badge_text || '').trim().slice(0, 40) || null,
                    (badge_color || '').trim().slice(0, 20) || null,
                    safeExtra,
                    finalIsPublished,
                    (audio_url || '').trim().slice(0, 1000) || null,
                    audio_enabled === true,
                    (audio_title || '').trim().slice(0, 120) || null,
                    effectiveCallId,
                    resolvedProductType,
                    effectiveBunnyLib,
                    effectiveBunnyCol,
                    effectiveDirectUrl,
                    effectiveCallPhoto,
                    effectiveCallRingingText,
                    effectiveCallRingtone,
                    preview_enabled === true,
                    productId,
                    effChatBtnEnabled,
                    effChatBtnChatId,
                    effChatBtnLabel,
                    effChatNotifyOnOpen,
                    effPostMsg,
                    effPostLink,
                    effPostRecJson,
                    effAudioAutoplay,
                ]);
                updated = r.rows[0];
                rowCount = r.rowCount;
            } catch (e) {
                logger.warn('update produto sem campos novos (fallback):', e.message);
                const r = await client.query(`
                    UPDATE products SET
                        name = $1, description = $2, category_id = $3,
                        banner_url = $4, main_video_url = $5, access_url = $6,
                        price = $7, is_active = $8, is_featured = $9
                    WHERE id = $10
                    RETURNING *
                `, [
                    name, description || null, category_id || null,
                    banner_url || null, main_video_url || null, access_url || null,
                    parseFloat(price) || 0,
                    is_active !== false,
                    is_featured === true,
                    productId,
                ]);
                updated = r.rows[0];
                rowCount = r.rowCount;
            }
            
            if (rowCount === 0) {
                throw new Error('NOT_FOUND');
            }
            
            // Atualiza ofertas: deleta todas e recria (mais simples que sincronizar)
            if (Array.isArray(offers)) {
                await client.query('DELETE FROM product_offers WHERE product_id = $1', [productId]);
                for (const offer of offers) {
                    if (!offer.gateway || !offer.offer_id) continue;
                    const isAcq = !!offer.is_acquisition;
                    const acqRole = isAcq && ['frontend','bump'].includes(offer.acquisition_role)
                        ? offer.acquisition_role : null;
                    await client.query(`
                        INSERT INTO product_offers
                        (product_id, gateway, offer_id, offer_name, checkout_url, price, is_acquisition, acquisition_role, duration_days)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    `, [
                        productId, offer.gateway, offer.offer_id,
                        offer.offer_name || null, offer.checkout_url || null,
                        parseFloat(offer.price) || null,
                        isAcq, acqRole,
                        offer.duration_days ? parseInt(offer.duration_days, 10) : null,
                    ]);
                }
            }
            
            // Idem pra media
            if (Array.isArray(media)) {
                await client.query('DELETE FROM product_media WHERE product_id = $1', [productId]);
                for (let i = 0; i < media.length; i++) {
                    const m = media[i];
                    if (!m.url || !m.media_type) continue;
                    await client.query(`
                        INSERT INTO product_media
                        (product_id, media_type, url, display_order, is_locked)
                        VALUES ($1, $2, $3, $4, $5)
                    `, [productId, m.media_type, m.url, m.display_order ?? i, m.is_locked !== false]);
                }
            }
            
            return updated;
        });
        
        // Passe Vitalício dos GRUPOS: flag simples fora do transaction principal
        if (req.body.is_group_pass !== undefined) {
            try { await db.query(`UPDATE products SET is_group_pass = $1 WHERE id = $2`, [req.body.is_group_pass === true, productId]); } catch (_) {}
        }
        // Link de checkout com DESCONTO (usado no cross-sell do Suporte)
        if (req.body.discount_checkout_url !== undefined) {
            const disc = (req.body.discount_checkout_url || '').toString().trim().slice(0, 1000) || null;
            try { await db.query(`UPDATE products SET discount_checkout_url = $1 WHERE id = $2`, [disc, productId]); } catch (_) {}
        }
        logger.info(`Produto editado: ${product.name} (ID ${productId})`);
        return res.json({ success: true, product });
    } catch (err) {
        if (err.message === 'NOT_FOUND') {
            return res.status(404).json({ success: false, error: 'Produto não encontrado' });
        }
        if (err.code === '23505' && err.constraint?.includes('offers')) {
            return res.status(409).json({
                success: false,
                error: 'Já existe outro produto com esse offer_id no gateway informado',
            });
        }
        logger.error('Erro editando produto:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// =============================================================================
// PLANOS DO PRODUTO (Basic, VIP, Premium...)
// =============================================================================

// GET /:id/plans — lista planos
router.get('/:id/plans', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { rows } = await db.query(
            `SELECT * FROM product_plans WHERE product_id = $1 ORDER BY display_order, id`,
            [id]
        );
        return res.json({ success: true, plans: rows });
    } catch (err) {
        logger.error('Erro listando planos:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// POST /:id/plans — cria plano
router.post('/:id/plans', requireAdmin, async (req, res) => {
    const productId = parseInt(req.params.id, 10);
    if (!productId) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { name, price, original_price, badge, benefits, checkout_url, is_recommended, display_order, active } = req.body || {};
        if (!name) return res.status(400).json({ success: false, error: 'Nome obrigatório' });
        const { rows } = await db.query(`
            INSERT INTO product_plans (product_id, name, price, original_price, badge, benefits, checkout_url, is_recommended, display_order, active)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *
        `, [
            productId, String(name).trim().slice(0, 80),
            parseFloat(price) || 0,
            original_price ? parseFloat(original_price) : null,
            (badge || '').trim().slice(0, 40) || null,
            (benefits || '').trim().slice(0, 2000) || null,
            (checkout_url || '').trim().slice(0, 1000) || null,
            is_recommended === true,
            parseInt(display_order, 10) || 0,
            active !== false,
        ]);
        return res.json({ success: true, plan: rows[0] });
    } catch (err) {
        logger.error('Erro criando plano:', err);
        return res.status(500).json({ success: false, error: err.message || 'Erro interno' });
    }
});

// PUT /:id/plans/:planId
router.put('/:id/plans/:planId', requireAdmin, async (req, res) => {
    const planId = parseInt(req.params.planId, 10);
    if (!planId) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { name, price, original_price, badge, benefits, checkout_url, is_recommended, display_order, active } = req.body || {};
        const updates = []; const values = []; let p = 1;
        if (name !== undefined) { updates.push(`name = $${p++}`); values.push(String(name).trim().slice(0, 80)); }
        if (price !== undefined) { updates.push(`price = $${p++}`); values.push(parseFloat(price) || 0); }
        if (original_price !== undefined) { updates.push(`original_price = $${p++}`); values.push(original_price ? parseFloat(original_price) : null); }
        if (badge !== undefined) { updates.push(`badge = $${p++}`); values.push((badge || '').trim().slice(0, 40) || null); }
        if (benefits !== undefined) { updates.push(`benefits = $${p++}`); values.push((benefits || '').trim().slice(0, 2000) || null); }
        if (checkout_url !== undefined) { updates.push(`checkout_url = $${p++}`); values.push((checkout_url || '').trim().slice(0, 1000) || null); }
        if (is_recommended !== undefined) { updates.push(`is_recommended = $${p++}`); values.push(!!is_recommended); }
        if (display_order !== undefined) { updates.push(`display_order = $${p++}`); values.push(parseInt(display_order, 10) || 0); }
        if (active !== undefined) { updates.push(`active = $${p++}`); values.push(!!active); }
        if (!updates.length) return res.status(400).json({ success: false, error: 'Nada pra atualizar' });
        values.push(planId);
        const { rows } = await db.query(`UPDATE product_plans SET ${updates.join(', ')} WHERE id = $${p} RETURNING *`, values);
        if (!rows.length) return res.status(404).json({ success: false, error: 'Não encontrado' });
        return res.json({ success: true, plan: rows[0] });
    } catch (err) {
        logger.error('Erro atualizando plano:', err);
        return res.status(500).json({ success: false, error: err.message || 'Erro interno' });
    }
});

// DELETE /:id/plans/:planId
router.delete('/:id/plans/:planId', requireAdmin, async (req, res) => {
    const planId = parseInt(req.params.planId, 10);
    if (!planId) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const { rowCount } = await db.query(`DELETE FROM product_plans WHERE id = $1`, [planId]);
        if (!rowCount) return res.status(404).json({ success: false, error: 'Não encontrado' });
        return res.json({ success: true, deleted: true });
    } catch (err) {
        logger.error('Erro deletando plano:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// =============================================================================
// EXPORTAR PRODUTOS (JSON) — backup completo
// =============================================================================

router.get('/export/all', requireAdmin, async (req, res) => {
    try {
        const { rows: products } = await db.query(`
            SELECT p.*, c.name as category_name, c.slug as category_slug
            FROM products p
            LEFT JOIN categories c ON c.id = p.category_id
            ORDER BY p.id
        `);
        const { rows: offers } = await db.query(`SELECT * FROM product_offers ORDER BY product_id, id`);
        const { rows: media } = await db.query(`SELECT * FROM product_media ORDER BY product_id, display_order`);

        const offersByProduct = {};
        const mediaByProduct = {};
        for (const o of offers) { (offersByProduct[o.product_id] ||= []).push(o); }
        for (const m of media)  { (mediaByProduct[m.product_id]  ||= []).push(m); }

        const payload = {
            exported_at: new Date().toISOString(),
            version: 1,
            products: products.map(p => ({
                ...p,
                offers: offersByProduct[p.id] || [],
                media: mediaByProduct[p.id] || [],
            })),
        };

        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="produtos-${new Date().toISOString().slice(0,10)}.json"`);
        return res.send(JSON.stringify(payload, null, 2));
    } catch (err) {
        logger.error('Erro exportando produtos:', err);
        return res.status(500).json({ success: false, error: 'Erro ao exportar' });
    }
});


// =============================================================================
// IMPORTAR PRODUTOS (JSON) — restaura backup ou migra de outro painel
// =============================================================================

router.post('/import', requireAdmin, async (req, res) => {
    const { products, mode } = req.body || {};
    if (!Array.isArray(products)) {
        return res.status(400).json({ success: false, error: 'Payload inválido: products[] esperado' });
    }
    const replaceMode = mode === 'replace'; // se 'merge', tenta atualizar por nome/slug

    const stats = { created: 0, updated: 0, skipped: 0, errors: [] };
    try {
        for (const p of products) {
            try {
                if (!p.name) { stats.skipped++; continue; }
                // Cada produto roda numa TRANSAÇÃO própria: se falhar no meio
                // (ex.: oferta inválida), NADA daquele produto é aplicado —
                // antes, o replace podia deletar e não recriar (produto sumia).
                await db.transaction(async (client) => {
                    // Detecta produto existente por nome
                    const { rows: existing } = await client.query('SELECT id FROM products WHERE name = $1 LIMIT 1', [p.name]);
                    const productId = existing[0]?.id;

                    const safeExtra = (p.extra_data && typeof p.extra_data === 'object') ? p.extra_data : {};
                    const fields = [
                        p.name,
                        p.description || null,
                        p.category_id || null,
                        p.banner_url || null,
                        p.main_video_url || null,
                        p.access_url || null,
                        parseFloat(p.price) || 0,
                        p.is_active !== false,
                        p.is_featured === true,
                        p.badge_text || null,
                        p.badge_color || null,
                        safeExtra,
                        p.is_published === true,
                        p.audio_url || null,
                        p.audio_enabled === true,
                        p.audio_title || null,
                        p.video_call_id || null,
                    ];

                    let pid;
                    if (productId && !replaceMode) {
                        // UPDATE
                        await client.query(`
                            UPDATE products SET name=$1, description=$2, category_id=$3, banner_url=$4,
                                main_video_url=$5, access_url=$6, price=$7, is_active=$8, is_featured=$9,
                                badge_text=$10, badge_color=$11, extra_data=$12, is_published=$13,
                                audio_url=$14, audio_enabled=$15, audio_title=$16, video_call_id=$17
                            WHERE id=$18
                        `, [...fields, productId]);
                        pid = productId;
                        stats.updated++;
                    } else {
                        if (productId && replaceMode) {
                            await client.query('DELETE FROM product_offers WHERE product_id = $1', [productId]);
                            await client.query('DELETE FROM product_media WHERE product_id = $1', [productId]);
                            await client.query('DELETE FROM products WHERE id = $1', [productId]);
                        }
                        const { rows: ins } = await client.query(`
                            INSERT INTO products (name, description, category_id, banner_url, main_video_url,
                                access_url, price, is_active, is_featured, badge_text, badge_color, extra_data,
                                is_published, audio_url, audio_enabled, audio_title, video_call_id)
                            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id
                        `, fields);
                        pid = ins[0].id;
                        stats.created++;
                    }

                    // Ofertas
                    if (Array.isArray(p.offers)) {
                        await client.query('DELETE FROM product_offers WHERE product_id = $1', [pid]);
                        for (const o of p.offers) {
                            if (!o.gateway || !o.offer_id) continue;
                            const isAcq = !!o.is_acquisition;
                            const acqRole = isAcq && ['frontend','bump'].includes(o.acquisition_role) ? o.acquisition_role : null;
                            await client.query(`
                                INSERT INTO product_offers (product_id, gateway, offer_id, offer_name, checkout_url, price, is_active, is_acquisition, acquisition_role)
                                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                            `, [pid, o.gateway, o.offer_id, o.offer_name || null, o.checkout_url || null, parseFloat(o.price) || null, o.is_active !== false, isAcq, acqRole]);
                        }
                    }

                    // Mídia
                    if (Array.isArray(p.media)) {
                        await client.query('DELETE FROM product_media WHERE product_id = $1', [pid]);
                        for (let i = 0; i < p.media.length; i++) {
                            const m = p.media[i];
                            if (!m.url || !m.media_type) continue;
                            await client.query(`
                                INSERT INTO product_media (product_id, media_type, url, thumbnail_url, display_order)
                                VALUES ($1,$2,$3,$4,$5)
                            `, [pid, m.media_type, m.url, m.thumbnail_url || null, m.display_order ?? i]);
                        }
                    }
                });
            } catch (e) {
                stats.errors.push({ product: p?.name || 'desconhecido', error: e.message });
            }
        }

        logger.info(`Import produtos: ${JSON.stringify(stats)}`);
        return res.json({ success: true, stats });
    } catch (err) {
        logger.error('Erro importando produtos:', err);
        return res.status(500).json({ success: false, error: err.message || 'Erro interno' });
    }
});


// =============================================================================
// DELETAR PRODUTO
// =============================================================================

router.delete('/:id', requireAdmin, async (req, res) => {
    const productId = parseInt(req.params.id, 10);
    if (isNaN(productId)) {
        return res.status(400).json({ success: false, error: 'ID inválido' });
    }
    
    try {
        const { rowCount } = await db.query('DELETE FROM products WHERE id = $1', [productId]);
        if (rowCount === 0) {
            return res.status(404).json({ success: false, error: 'Produto não encontrado' });
        }
        
        logger.info(`Produto deletado: ID ${productId}`);
        return res.json({ success: true });
    } catch (err) {
        logger.error('Erro deletando produto:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// =============================================================================
// LISTAR CATEGORIAS (pra dropdown no formulário)
// =============================================================================

router.get('/meta/categories', requireAdmin, async (req, res) => {
    try {
        const includeInactive = req.query.all === '1' || req.query.all === 'true';
        const sql = includeInactive
            ? 'SELECT * FROM categories ORDER BY display_order, name'
            : 'SELECT * FROM categories WHERE is_active = true ORDER BY display_order, name';
        const { rows } = await db.query(sql);
        return res.json({ success: true, categories: rows });
    } catch (err) {
        logger.error('Erro listando categorias:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// Helpers
function slugify(str) {
    return String(str || '')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/(^_|_$)/g, '')
        .slice(0, 50);
}

router.post('/meta/categories', requireAdmin, async (req, res) => {
    try {
        const { name, description, icon, display_order } = req.body || {};
        if (!name || typeof name !== 'string' || name.trim().length < 2) {
            return res.status(400).json({ success: false, error: 'Nome inválido' });
        }
        const trimmedName = name.trim().slice(0, 100);
        let slug = slugify(trimmedName);
        if (!slug) slug = 'cat_' + Date.now();
        
        // Verifica se slug já existe e adiciona sufixo numérico
        const { rows: existing } = await db.query(
            'SELECT id FROM categories WHERE slug = $1', [slug]
        );
        if (existing.length > 0) {
            slug = slug + '_' + Date.now().toString(36);
        }
        
        const order = parseInt(display_order, 10) || 99;
        
        const { rows } = await db.query(
            `INSERT INTO categories (slug, name, description, icon, display_order, is_active)
             VALUES ($1, $2, $3, $4, $5, true)
             RETURNING *`,
            [slug, trimmedName, description || null, icon || null, order]
        );
        return res.json({ success: true, category: rows[0] });
    } catch (err) {
        logger.error('Erro criando categoria:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

router.put('/meta/categories/:id', requireAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
        
        const { name, description, icon, display_order, is_active } = req.body || {};
        const updates = [];
        const values = [];
        let p = 1;
        
        if (name !== undefined) {
            if (typeof name !== 'string' || name.trim().length < 2) {
                return res.status(400).json({ success: false, error: 'Nome inválido' });
            }
            updates.push(`name = $${p++}`);
            values.push(name.trim().slice(0, 100));
        }
        if (description !== undefined) {
            updates.push(`description = $${p++}`);
            values.push(description || null);
        }
        if (icon !== undefined) {
            updates.push(`icon = $${p++}`);
            values.push(icon || null);
        }
        if (display_order !== undefined) {
            updates.push(`display_order = $${p++}`);
            values.push(parseInt(display_order, 10) || 0);
        }
        if (is_active !== undefined) {
            updates.push(`is_active = $${p++}`);
            values.push(!!is_active);
        }
        
        if (updates.length === 0) {
            return res.status(400).json({ success: false, error: 'Nada pra atualizar' });
        }
        
        updates.push(`updated_at = NOW()`);
        values.push(id);
        
        const { rows } = await db.query(
            `UPDATE categories SET ${updates.join(', ')} WHERE id = $${p} RETURNING *`,
            values
        );
        if (rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Categoria não encontrada' });
        }
        return res.json({ success: true, category: rows[0] });
    } catch (err) {
        logger.error('Erro atualizando categoria:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

router.delete('/meta/categories/:id', requireAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
        
        // Verifica se há produtos usando essa categoria
        const { rows: usingProducts } = await db.query(
            'SELECT COUNT(*)::int as count FROM products WHERE category_id = $1',
            [id]
        );
        const productCount = usingProducts[0]?.count || 0;
        
        if (productCount > 0) {
            // Em vez de deletar, desativa
            await db.query(
                'UPDATE categories SET is_active = false, updated_at = NOW() WHERE id = $1',
                [id]
            );
            return res.json({
                success: true,
                deactivated: true,
                message: `Categoria desativada (${productCount} produto(s) ainda usam ela)`
            });
        }
        
        const { rowCount } = await db.query('DELETE FROM categories WHERE id = $1', [id]);
        if (rowCount === 0) {
            return res.status(404).json({ success: false, error: 'Categoria não encontrada' });
        }
        return res.json({ success: true, deleted: true });
    } catch (err) {
        logger.error('Erro deletando categoria:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// =============================================================================
// BUNNY STREAM — Preview de Collection (testar do admin antes de salvar)
// =============================================================================
//
// GET /api/admin/products/meta/bunny/collection?library=X&collection=Y
//
// Retorna a lista de vídeos da Collection (puxa direto da Bunny API).
// Útil pra confirmar se o admin colou os IDs certos antes de salvar o produto.
//
// Response:
//   { success: true, count: N, videos: [{ guid, title, length, embed_url, thumb_url, status }] }
//
// Errors:
//   400 — parâmetros faltando
//   503 — BUNNY_API_KEY não configurada
//
// Cache: 5min in-memory (compartilhado com listCollectionVideos do /library).
// =============================================================================
router.get('/meta/bunny/collection', requireAdmin, async (req, res) => {
    const libraryId = String(req.query.library || '').trim();
    const collectionId = String(req.query.collection || '').trim();

    if (!libraryId || !collectionId) {
        return res.status(400).json({
            success: false,
            error: 'library e collection são obrigatórios',
        });
    }
    if (!/^\d+$/.test(libraryId)) {
        return res.status(400).json({
            success: false,
            error: 'library deve ser numérico (ex: 123456)',
        });
    }
    if (!process.env.BUNNY_API_KEY) {
        return res.status(503).json({
            success: false,
            error: 'BUNNY_API_KEY não configurado no servidor (.env)',
        });
    }

    try {
        const videos = await listCollectionVideos(libraryId, collectionId);
        const enriched = videos.map(v => ({
            guid: v.guid,
            title: v.title,
            length_sec: v.lengthSec,
            embed_url: bunnyEmbedUrl(libraryId, v.guid),
            thumb_url: bunnyThumbUrl(v.guid, v.thumbnailFileName),
            status: v.status,
            // status: 4 = pronto pra tocar. Front mostra warning se !=4.
            ready: v.status === 4,
        }));
        return res.json({
            success: true,
            count: enriched.length,
            videos: enriched,
        });
    } catch (err) {
        logger.error('Erro consultando Bunny collection:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


module.exports = router;
