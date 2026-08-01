/**
 * =============================================================================
 * routes/user.js — API do app do cliente
 * =============================================================================
 *
 * Rotas:
 *   POST   /api/user/login          Login email-only (com mailcheck)
 *   POST   /api/user/logout         Limpa sessão
 *   GET    /api/user/me             Dados do cliente logado + contagens
 *   GET    /api/user/catalog        Catálogo completo (funciona sem login)
 *   GET    /api/user/library        Produtos que o cliente tem acesso (exige login)
 *
 *
 * =============================================================================
 */

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const db = require('../db');
const { logger } = require('../lib/logger');
const {
    loginClient,
    requireUser,
    optionalUser,
    USER_COOKIE_NAME,
    USER_COOKIE_OPTIONS,
} = require('../lib/user-auth');
const { isPreviewEmail } = require('../lib/preview');
const { redeemCampaign, getCampaignPublicInfo } = require('../lib/gift-campaigns');
const {
    parseBunnyUrl,
    bunnyHlsUrl,
    bunnyEmbedUrl,
    bunnyThumbUrl,
    listCollectionVideos,
} = require('../lib/bunny');


// ─── BUNNY ENRICHMENT HELPERS ────────────────────────────────────────────────
//
// Toda chamada que sai do banco com `video_url` ganha 2 campos extras:
//   - is_bunny:        true se a URL é do mediadelivery.net
//   - bunny_hls_url:   URL HLS pra hls.js (Android/Chrome) ou nativo (iOS)
//
// Se a URL NÃO for Bunny ou BUNNY_HLS_HOST não estiver setado, ambos os
// campos ficam null/false e o frontend cai no <video src> direto (mp4 cru).

function enrichCallPayload(call) {
    if (!call) return call;
    const bunny = parseBunnyUrl(call.video_url);
    return {
        ...call,
        is_bunny: !!bunny,
        bunny_hls_url: bunny ? bunnyHlsUrl(bunny.guid) : null,
    };
}


// Fase E: monta um video_call "virtual" a partir do link Bunny direto colado
// no produto, sem precisar de entrada na tabela video_calls. Usado quando o
// admin escolhe a entrega "chamadinha" e cola só o link Bunny.
//
// Prioridade entre os 2 modos (resolvida pelo CALLER, não aqui):
//   - direct_call_video_url preenchido → este helper retorna o virtual.
//   - direct_call_video_url vazio + video_call_id → caller usa a tabela.
//
// O virtual emula o formato esperado pelo frontend: campos `model_name`,
// `model_photo`, `video_url`, etc. — só que sem `id`, `slug`, `redirect_link`,
// `cta_*`, porque não há entrada cadastrada. O frontend já trata esses
// campos como opcionais (testa truthy). A `id` virtual prefixada `direct-`
// serve só pra debug em logs — não é usada como FK em lugar nenhum.
function buildVirtualCallFromProduct(product) {
    if (!product || !product.direct_call_video_url) return null;
    return {
        id: `direct-${product.id}`,           // string proposital → nunca casa com vc.id (INT)
        slug: null,
        category: 'produto',
        model_name: product.name || 'Modelo',
        // Fase F: foto da CHAMADA (selfie íntima) tem prioridade sobre a capa
        // (imagem comercial do card de venda). Fallback pra capa quando o admin
        // não setou call_photo_url ainda — backward-compat com produtos da Fase E.
        model_photo: product.call_photo_url || product.banner_url || null,
        video_url: product.direct_call_video_url,
        // Fase F: texto custom de "chamando" + ringtone (ambos opcionais).
        // null = frontend usa default ("Chamada de vídeo recebida" / silêncio).
        ringing_text: product.call_ringing_text || null,
        ringtone_url: product.call_ringtone_url || null,
        redirect_link: null,
        cta_text: null,
        trigger_delay_sec: 0,
        cta_type: 'home',
        cta_target_id: null,
        _virtual: true,                       // flag interno, frontend ignora
    };
}

// Se o produto tem (bunny_library_id, bunny_collection_id), busca os vídeos
// da Collection na API do Bunny e APPENDA na galeria do produto.
//
// Resultado: cada vídeo da Collection vira { type:'video', url:embed, ... }
// — o frontend reconhece a URL iframe.mediadelivery.net e renderiza iframe
// (sem instanciar N hls.js, que estouraria CPU em galeria grande).
//
// IMPORTANTE: tolerante a falha. Se a API do Bunny der erro, retorna a
// galeria como ESTAVA (não derruba o /library). Cache de 5min já está
// dentro de listCollectionVideos.
async function appendBunnyCollectionToGallery(product) {
    if (!product || !product.bunny_library_id || !product.bunny_collection_id) {
        return product;
    }
    // Só pra produtos do tipo content. Em video_call não tem galeria.
    if (product.product_type === 'video_call') return product;

    const videos = await listCollectionVideos(
        product.bunny_library_id,
        product.bunny_collection_id
    );
    if (!videos.length) return product;

    const existing = Array.isArray(product.gallery) ? product.gallery : [];
    // Dedup por URL: se admin colou a mesma URL manualmente, não dupla.
    const seenUrls = new Set(existing.map(g => g && g.url).filter(Boolean));

    const bunnyItems = videos.map(v => {
        const embed = bunnyEmbedUrl(product.bunny_library_id, v.guid);
        const thumb = bunnyThumbUrl(v.guid, v.thumbnailFileName);
        return {
            type: 'video',
            media_type: 'video',
            url: embed,
            thumbnail_url: thumb,
            title: v.title || null,
            // Marca pro front saber que é Bunny iframe (não MP4 cru)
            is_bunny_embed: true,
            bunny_guid: v.guid,
            bunny_status: v.status,
            length_sec: v.lengthSec,
        };
    }).filter(item => item.url && !seenUrls.has(item.url));

    if (!bunnyItems.length) return product;
    return {
        ...product,
        gallery: [...existing, ...bunnyItems],
    };
}


// ----------------------------------------------------------------------------
// AUTH: Login, logout, me
// ----------------------------------------------------------------------------

/**
 * POST /api/user/login
 * Body: { email: string, skipSuggestion?: boolean }
 *
 * Se email tem typo comum (gmial → gmail), retorna:
 *   { success: false, needsConfirmation: true, suggestion: "user@gmail.com" }
 *
 * Cliente pode forçar login sem correção mandando { email, skipSuggestion: true }.
 *
 * Se sucesso: seta cookie httpOnly e retorna:
 *   { success: true, email, productsCount }
 */
router.post('/login', async (req, res) => {
    const { email, skipSuggestion, campanha } = req.body || {};

    // Se cliente pediu pra pular sugestão, força login direto
    if (skipSuggestion) {
        const forced = await forceLoginWithoutSuggestion(email);
        if (forced.success) {
            res.cookie(USER_COOKIE_NAME, forced.token, USER_COOKIE_OPTIONS);
            // Fase K2: resgata campanha (link mágico) se veio um código pendente.
            // Tolerante a falha: nunca derruba o login.
            const campaignResult = await tryRedeemCampaign(campanha, forced.email, req);
            return res.json({
                success: true,
                email: forced.email,
                productsCount: forced.productsCount,
                campaign: campaignResult,
            });
        }
        return res.status(400).json(forced);
    }

    const result = await loginClient(email);

    // Se tem sugestão, retorna pro frontend decidir
    if (result.needsConfirmation) {
        return res.json(result);
    }

    // Se falhou, retorna erro
    if (!result.success) {
        return res.status(400).json(result);
    }

    // Sucesso: seta cookie
    res.cookie(USER_COOKIE_NAME, result.token, USER_COOKIE_OPTIONS);

    // Fase K2: resgata campanha (link mágico) ANTES de retornar pro cliente.
    // Assim, quando o app chamar /library logo em seguida, o brinde já tá lá.
    const campaignResult = await tryRedeemCampaign(campanha, result.email, req);

    return res.json({
        success: true,
        email: result.email,
        productsCount: result.productsCount,
        campaign: campaignResult,
    });
});


// Fase K2 — helper de resgate de campanha pós-login (DRY entre /login e /login/promote).
// SEMPRE retorna um objeto plano ou null. NUNCA lança. O resultado é
// puramente informativo pro frontend (pode usar pra mostrar toast
// "Você ganhou um brinde!"). Login NÃO depende disso pra ter sucesso.
async function tryRedeemCampaign(rawCode, email, req) {
    if (!rawCode || typeof rawCode !== 'string') return null;
    try {
        const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
        const result = await redeemCampaign(rawCode, email, ip);
        return result; // { redeemed, skipped?, gift_id?, product_id?, reason? } | null
    } catch (err) {
        logger.warn(`[campaign] tryRedeem falhou (não-fatal): ${err.message}`);
        return null;
    }
}


/**
 * Helper pra forçar login sem checagem de mailcheck.
 * (Cliente disse "não, meu email é esse mesmo").
 */
async function forceLoginWithoutSuggestion(email) {
    const normalizedEmail = (email || '').toLowerCase().trim();
    
    // Regex básica
    if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
        return { success: false, error: 'Email inválido' };
    }
    
    if (normalizedEmail.length > 254) {
        return { success: false, error: 'Email muito longo' };
    }
    
    try {
        // Upsert customer
        await db.query(`
            INSERT INTO customers (email, first_seen_at, last_login_at)
            VALUES ($1, NOW(), NOW())
            ON CONFLICT (email) DO UPDATE SET last_login_at = NOW()
        `, [normalizedEmail]);
        
        const { rows: [{ count }] } = await db.query(`
            SELECT COUNT(*)::int as count
            FROM user_access 
            WHERE LOWER(email) = $1 AND status = 'active'
        `, [normalizedEmail]);
        
        const token = jwt.sign(
            { email: normalizedEmail, type: 'user' },
            process.env.JWT_SECRET + ':user',
            { expiresIn: '90d' }
        );
        
        logger.info(`Cliente '${normalizedEmail}' logou (skipSuggestion)`);
        
        return {
            success: true,
            token,
            email: normalizedEmail,
            productsCount: count,
        };
    } catch (err) {
        logger.error('Erro em forceLoginWithoutSuggestion:', err);
        return { success: false, error: 'Erro interno' };
    }
}


/**
 * POST /api/user/logout
 * Limpa o cookie de sessão.
 */
router.post('/logout', (req, res) => {
    res.clearCookie(USER_COOKIE_NAME, USER_COOKIE_OPTIONS);
    return res.json({ success: true });
});


/**
 * GET /api/user/me
 * Retorna dados do cliente logado.
 * Se não estiver logado, retorna 401.
 */
router.get('/me', requireUser, async (req, res) => {
    const email = req.user.email;
    const isAnon = !!req.user.anonymous;

    // Sessão anônima (preview de funíl): retorna user fake sem ler banco
    if (isAnon) {
        return res.json({
            success: true,
            user: {
                email: email,
                name: 'Visitante',
                anonymous: true,
                preview_mode: false,
                funnel: req.user.funnel || null,
                firstSeenAt: null,
                lastLoginAt: null,
                totalPurchases: 0,
                totalSpent: 0,
                activeAccessCount: 0,
            },
        });
    }

    // Checa preview cedo (cache 30s). Nao bloqueia se falhar — preview_mode=false
    // e' default seguro.
    let previewMode = false;
    try { previewMode = await isPreviewEmail(email); } catch (_) {}

    try {
        let { rows: [data] } = await db.query(`
            SELECT
                c.email,
                c.name,
                c.first_seen_at,
                c.last_login_at,
                c.total_purchases,
                c.total_spent,
                (
                    SELECT COUNT(*)::int
                    FROM user_access ua
                    WHERE LOWER(ua.email) = LOWER(c.email) AND ua.status = 'active'
                ) as active_access_count
            FROM customers c
            WHERE LOWER(c.email) = $1
        `, [email]);

        if (!data) {
            // Token é VÁLIDO mas o customer não existe no banco (ex: registro
            // perdido, banco recriado, ou token antigo). O email do token JÁ É
            // a identidade — não há motivo pra deslogar. Cria o customer
            // on-the-fly (idempotente, mesmo upsert do login) e segue normal.
            logger.warn(`/me: token válido sem customer no banco — criando on-the-fly: ${email}`);
            await db.query(`
                INSERT INTO customers (email, first_seen_at, last_login_at)
                VALUES ($1, NOW(), NOW())
                ON CONFLICT (email) DO UPDATE SET last_login_at = NOW()
            `, [email]);
            const accessRes = await db.query(`
                SELECT COUNT(*)::int AS count
                FROM user_access
                WHERE LOWER(email) = $1 AND status = 'active'
            `, [email]);
            return res.json({
                success: true,
                user: {
                    email: email,
                    name: null,
                    preview_mode: previewMode,
                    firstSeenAt: null,
                    lastLoginAt: null,
                    totalPurchases: 0,
                    totalSpent: 0,
                    activeAccessCount: accessRes.rows[0]?.count || 0,
                },
            });
        }

        return res.json({
            success: true,
            user: {
                email: data.email,
                name: data.name,
                preview_mode: previewMode,
                firstSeenAt: data.first_seen_at,
                lastLoginAt: data.last_login_at,
                totalPurchases: data.total_purchases,
                totalSpent: parseFloat(data.total_spent || 0),
                activeAccessCount: data.active_access_count,
            },
        });
    } catch (err) {
        logger.error('Erro em /me:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// ----------------------------------------------------------------------------
// HEARTBEAT (Fase L5) — atualiza last_seen_at do cliente
//
// Frontend bate a cada 60s enquanto o app esta visivel. Endpoint deve ser
// O MAIS BARATO POSSIVEL — um UPDATE soh. Sem retorno util alem de ack.
//
// Logica de session_count: incrementa se o ultimo heartbeat foi > 30 min atras
// (proxy pragmatico de "nova sessao", sem precisar de tabela sessions).
// ----------------------------------------------------------------------------

router.post('/heartbeat', requireUser, async (req, res) => {
    const email = req.user.email;
    if (req.user.anonymous) return res.json({ success: true, ignored: 'anonymous' });
    try {
        await db.query(`
            UPDATE customers
            SET session_count = session_count + (
                    CASE WHEN last_seen_at IS NULL
                          OR last_seen_at < NOW() - INTERVAL '30 minutes'
                         THEN 1 ELSE 0 END
                ),
                last_seen_at = NOW()
            WHERE LOWER(email) = $1
        `, [email]);
        return res.json({ success: true });
    } catch (err) {
        logger.warn('[heartbeat] erro:', err.message);
        return res.json({ success: false });
    }
});


// ----------------------------------------------------------------------------
// CATÁLOGO: produtos disponíveis (funciona sem login)
// ----------------------------------------------------------------------------

/**
 * GET /api/user/catalog
 * Retorna todos os produtos ATIVOS.
 * Se logado, marca quais o cliente já tem acesso.
 */
router.get('/catalog', optionalUser, async (req, res) => {
    try {
        const { rows: [gatewaySetting] } = await db.query(
            `SELECT value FROM system_settings WHERE key = 'active_gateway'`
        );
        const activeGateway = gatewaySetting?.value?.replace(/"/g, '') || 'kirvano';
        
        const { rows: catalog } = await db.query(`
            SELECT
                p.id,
                p.name,
                p.description,
                p.banner_url,
                p.main_video_url,
                p.price,
                p.is_featured,
                p.display_order,
                p.created_at,
                COALESCE(p.badge_text, NULL) as badge_text,
                COALESCE(p.badge_color, NULL) as badge_color,
                COALESCE(p.extra_data, '{}'::jsonb) as extra_data,
                p.audio_url,
                COALESCE(p.audio_enabled, false) as audio_enabled,
                p.audio_title,
                COALESCE(p.audio_autoplay, false) as audio_autoplay,
                COALESCE(p.chat_button_enabled, false) as chat_button_enabled,
                p.chat_button_chat_id,
                p.chat_button_label,
                COALESCE(p.chat_notify_on_open, false) as chat_notify_on_open,
                p.video_call_id,
                p.bunny_library_id,
                p.bunny_collection_id,
                COALESCE(p.preview_enabled, false) as preview_enabled,
                (
                    SELECT json_build_object(
                        'id', vc.id, 'slug', vc.slug, 'category', vc.category,
                        'model_name', vc.model_name, 'model_photo', vc.model_photo,
                        'video_url', vc.video_url, 'redirect_link', vc.redirect_link,
                        'cta_text', vc.cta_text, 'trigger_delay_sec', vc.trigger_delay_sec,
                        'cta_type', COALESCE(vc.cta_type, 'home'),
                        'cta_target_id', vc.cta_target_id
                    )
                    FROM video_calls vc WHERE vc.id = p.video_call_id AND vc.active = true
                ) as video_call,
                (
                    SELECT json_agg(
                        json_build_object(
                            'id', pp.id, 'name', pp.name, 'price', pp.price,
                            'original_price', pp.original_price, 'badge', pp.badge,
                            'benefits', pp.benefits, 'checkout_url', pp.checkout_url,
                            'is_recommended', pp.is_recommended,
                            'display_order', pp.display_order
                        ) ORDER BY pp.display_order, pp.id
                    )
                    FROM product_plans pp WHERE pp.product_id = p.id AND pp.active = true
                ) as plans,
                c.name as category_name,
                c.slug as category_slug,
                c.id as category_id,
                (
                    SELECT json_build_object(
                        'gateway', po.gateway,
                        'offer_id', po.offer_id,
                        'checkout_url', po.checkout_url,
                        'price', po.price
                    )
                    FROM product_offers po 
                    WHERE po.product_id = p.id 
                      AND po.gateway = $1 
                      AND po.is_active = true
                    ORDER BY po.priority DESC
                    LIMIT 1
                ) as checkout,
                (
                    SELECT json_agg(
                        json_build_object(
                            'type', pm.media_type,
                            'url', pm.url,
                            'thumbnail_url', pm.thumbnail_url,
                            'is_locked', COALESCE(pm.is_locked, true)
                        ) ORDER BY pm.display_order
                    )
                    FROM product_media pm
                    WHERE pm.product_id = p.id
                ) as gallery
            FROM products p
            LEFT JOIN categories c ON c.id = p.category_id
            WHERE p.is_active = true
              AND p.is_published = true
              AND COALESCE(p.catalog_hidden, false) = false
            ORDER BY p.is_featured DESC, p.display_order, p.created_at DESC
        `, [activeGateway]);
        
        // Se logado, marca quais produtos o cliente já tem
        let ownedIds = new Set();
        let isMaster = false; // e-mail Premium (preview) → libera TODO o catálogo
        if (req.user?.email) {
            try { isMaster = await isPreviewEmail(req.user.email); } catch (_) {}
            const { rows: owned } = await db.query(`
                SELECT DISTINCT product_id
                FROM user_access
                WHERE LOWER(email) = $1 AND status = 'active'
                  AND (expires_at IS NULL OR expires_at > NOW())
            `, [req.user.email]);
            ownedIds = new Set(owned.map(r => r.product_id));
        }
        
        // Enriquece com Bunny: gallery ganha vídeos da Collection + video_call
        // sub-objeto ganha is_bunny/bunny_hls_url. Em paralelo (Promise.all) pra
        // não somar latência das requests ao Bunny.
        // Transforma uma mídia bloqueada em "teaser" seguro pra quem não comprou:
        //   - amostra (is_locked=false) → passa inteira
        //   - imagem bloqueada → mantém a URL (o borrão é no front, escolha do dono)
        //   - vídeo bloqueado → só poster, sem URL tocável (protege o vídeo de verdade)
        const gateItem = (m) => {
            if (!m || m.is_locked === false) return m;
            if (m.type === 'video' || m.media_type === 'video') {
                return { type: 'video', media_type: 'video', is_locked: true,
                         thumbnail_url: m.thumbnail_url || m.thumb || null, url: null };
            }
            return { ...m, is_locked: true };
        };
        const gateList = (arr) => (Array.isArray(arr) ? arr.map(gateItem) : []);

        // Vídeo Bunny sem thumbnail na galeria: deriva a thumb padrão da pull
        // zone (https://HOST/{guid}/thumbnail.jpg) — a célula ganha capa em vez
        // do fundo escuro. Roda ANTES do gating (locked mantém a thumb borrada).
        const bunnyHost = process.env.BUNNY_HLS_HOST;
        const fillVideoThumb = (m) => {
            if (!m || typeof m !== 'object') return m;
            const isVideo = m.type === 'video' || m.media_type === 'video';
            if (!isVideo || m.thumbnail_url || !bunnyHost || !m.url) return m;
            const match = String(m.url).match(/mediadelivery\.net\/(?:play|embed)\/[^/]+\/([0-9a-f-]{20,})/i);
            if (!match) return m;
            return { ...m, thumbnail_url: `https://${bunnyHost}/${match[1]}/thumbnail.jpg` };
        };
        const fillThumbs = (arr) => (Array.isArray(arr) ? arr.map(fillVideoThumb) : arr);

        const catalogEnriched = await Promise.all(catalog.map(async (p) => {
            const owns = isMaster || ownedIds.has(p.id);
            const previewOn = p.preview_enabled === true;
            const extra = (p.extra_data && typeof p.extra_data === 'object') ? p.extra_data : {};
            if (Array.isArray(extra.gallery)) extra.gallery = fillThumbs(extra.gallery);
            if (Array.isArray(p.gallery)) p.gallery = fillThumbs(p.gallery);

            // A galeria real que o app usa fica em extra_data.gallery; product_media
            // é legado. Protegemos as DUAS. Dono vê tudo (+ acervo Bunny). Não-dono
            // só vê a prévia curada se preview_enabled; senão, galeria vazia (não vaza).
            let base, outExtra;
            if (owns) {
                base = await appendBunnyCollectionToGallery(p);
                outExtra = extra;
            } else if (previewOn) {
                base = { ...p, gallery: gateList(p.gallery) };
                outExtra = { ...extra, gallery: gateList(extra.gallery) };
            } else {
                base = { ...p, gallery: [] };
                outExtra = { ...extra, gallery: [] };
            }

            return {
                ...base,
                extra_data: outExtra,
                preview_enabled: previewOn,
                price: parseFloat(p.price || 0),
                hasAccess: owns,
                // Contagem TOTAL de mídias (antes do gating) — alimenta a stat
                // "Conteúdos" no app sem expor as mídias em si.
                gallery_count: (Array.isArray(extra.gallery) ? extra.gallery.length : 0)
                    + (Array.isArray(p.gallery) ? p.gallery.length : 0),
                // SEGURANÇA: vídeo principal é conteúdo pago — só pra quem comprou.
                main_video_url: owns ? (base.main_video_url ?? p.main_video_url ?? null) : null,
                video_call: enrichCallPayload(p.video_call),
            };
        }));

        return res.json({
            success: true,
            loggedIn: !!req.user,
            activeGateway,
            catalog: catalogEnriched,
        });
    } catch (err) {
        logger.error('Erro em /catalog:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


/**
 * GET /api/user/library
 * Produtos que o cliente TEM acesso ativo.
 * Exige login.
 *
 * Resposta enriquecida pra suportar produtos do tipo 'video_call':
 *   - product_type: 'content' | 'video_call'
 *   - model_name: nome da modelo (do video_calls vinculado)
 *   - consumed / consumed_at: se já assistiu a vídeo-chamada (1 vez só)
 *   - recall_message: mensagem de recompra (só quando consumed=true)
 *   - checkout_url: URL pra recomprar (de product_offers, gateway ativo)
 *
 * Backward-compatible: campos antigos (video_call, gallery, plans, etc) seguem
 * presentes. Frontend antigo continua funcionando sem alteração.
 */
// ── Planos ativos (VIP/Premium/Status) pro card do acervo ────────────────────
// A Assinatura do Chat e o Status VIP são produtos OCULTOS (não viram card de
// conteúdo). Aqui eles viram o card de PLANO em "Minhas Compras": Premium
// (dourado — a compra veio de uma oferta is_premium) ou VIP (prata), + Status
// comprado à parte. Inclui a validade do bônus de grupo VIP do Premium.
async function loadUserPlans(email) {
    const e = String(email || '').toLowerCase().trim();
    if (!e) return [];
    const plans = [];
    try {
        const { rows: [chatProd] } = await db.query(
            `SELECT id, name FROM products WHERE is_chat_plan = true AND is_active = true ORDER BY id LIMIT 1`
        );
        if (chatProd) {
            // Premium detectado pela OFERTA (is_premium) OU pelo SELO gravado
            // no acesso (metadata.premium) — o selo é o que segura quando o
            // painel recria as ofertas e o vínculo ua.offer_id se perde.
            const { rows: [acc] } = await db.query(
                `SELECT ua.expires_at,
                        (COALESCE(po.is_premium, false)
                         OR COALESCE(ua.metadata->>'premium', '') = 'true') AS is_premium
                 FROM user_access ua LEFT JOIN product_offers po ON po.id = ua.offer_id
                 WHERE LOWER(ua.email) = $1 AND ua.product_id = $2 AND ua.status = 'active'
                   AND (ua.expires_at IS NULL OR ua.expires_at > NOW())
                 ORDER BY ua.id DESC LIMIT 1`,
                [e, chatProd.id]
            );
            if (acc) {
                const plan = {
                    kind: acc.is_premium ? 'premium' : 'vip',
                    product_id: chatProd.id,
                    expires_at: acc.expires_at || null,
                    group_bonus_until: null,
                };
                if (acc.is_premium) {
                    const { rows: [gb] } = await db.query(
                        `SELECT expires_at FROM user_access
                         WHERE LOWER(email) = $1 AND status = 'active' AND expires_at > NOW()
                           AND metadata->>'premium_kind' = 'vip_group'
                         ORDER BY id DESC LIMIT 1`,
                        [e]
                    );
                    if (gb) plan.group_bonus_until = gb.expires_at;
                    // id do grupo VIP (fixado) — atalho clicável em Minhas Compras
                    try {
                        const { rows: [pg] } = await db.query(
                            `SELECT id FROM groups WHERE pinned = true AND active = true ORDER BY id LIMIT 1`
                        );
                        if (pg) plan.vip_group_id = pg.id;
                    } catch (_) {}
                } else {
                    // VIP: anexa o plano Premium pro CTA de upgrade no card prata
                    plan.upgrade = await loadPremiumPlan();
                }
                plans.push(plan);
            }
        }
        // Status VIP comprado À PARTE (o extra do Premium não vira card próprio —
        // já está explicado dentro do card dourado)
        const { rows: [storyProd] } = await db.query(
            `SELECT id FROM products WHERE is_story_plan = true AND is_active = true ORDER BY id LIMIT 1`
        );
        if (storyProd) {
            const { rows: [sacc] } = await db.query(
                `SELECT expires_at FROM user_access
                 WHERE LOWER(email) = $1 AND product_id = $2 AND status = 'active'
                   AND (expires_at IS NULL OR expires_at > NOW())
                   AND COALESCE(metadata->>'premium_extra', '') <> 'true'
                 ORDER BY id DESC LIMIT 1`,
                [e, storyProd.id]
            );
            if (sacc) plans.push({ kind: 'story', product_id: storyProd.id, expires_at: sacc.expires_at || null, group_bonus_until: null });
        }
    } catch (_) {}
    return plans;
}

router.get('/library', requireUser, async (req, res) => {
    const email = req.user.email;

    try {
        // Gateway ativo: pra escolher de qual product_offers tirar checkout_url
        const { rows: [gatewaySetting] } = await db.query(
            `SELECT value FROM system_settings WHERE key = 'active_gateway'`
        );
        const activeGateway = gatewaySetting?.value?.replace(/"/g, '') || 'kirvano';

        // ──────────────────────────────────────────────────────────
        // MODO PREVIEW: email premium ve todos os produtos publicados
        // como se tivesse acesso. Sem gravar consumo, sem recall.
        // Substitui inteiramente a query de user_access (mais simples
        // que UNION/dedup — preview SEMPRE ve o catalogo completo).
        // ──────────────────────────────────────────────────────────
        let previewMode = false;
        try { previewMode = await isPreviewEmail(email); } catch (_) {}

        if (previewMode) {
            const { rows: previewLib } = await db.query(`
                SELECT
                    p.id,
                    p.name,
                    p.description,
                    p.banner_url,
                    p.main_video_url,
                    p.access_url,
                    p.price,
                    p.audio_url,
                    COALESCE(p.audio_enabled, false) as audio_enabled,
                    p.audio_title,
                    p.video_call_id,
                    p.direct_call_video_url,
                    p.call_photo_url,
                    p.call_ringing_text,
                    p.call_ringtone_url,
                    p.bunny_library_id,
                    p.bunny_collection_id,
                    COALESCE(p.product_type, 'content') as product_type,
                    (
                        SELECT json_build_object(
                            'id', vc.id, 'slug', vc.slug, 'category', vc.category,
                            'model_name', vc.model_name, 'model_photo', vc.model_photo,
                            'video_url', vc.video_url, 'redirect_link', vc.redirect_link,
                            'cta_text', vc.cta_text, 'trigger_delay_sec', vc.trigger_delay_sec,
                            'cta_type', COALESCE(vc.cta_type, 'home'),
                            'cta_target_id', vc.cta_target_id
                        )
                        FROM video_calls vc WHERE vc.id = p.video_call_id AND vc.active = true
                    ) as video_call,
                    (
                        SELECT vc.model_name
                        FROM video_calls vc WHERE vc.id = p.video_call_id
                    ) as model_name,
                    (
                        SELECT json_agg(
                            json_build_object(
                                'id', pp.id, 'name', pp.name, 'price', pp.price,
                                'original_price', pp.original_price, 'badge', pp.badge,
                                'benefits', pp.benefits, 'checkout_url', pp.checkout_url,
                                'is_recommended', pp.is_recommended,
                                'display_order', pp.display_order
                            ) ORDER BY pp.display_order, pp.id
                        )
                        FROM product_plans pp WHERE pp.product_id = p.id AND pp.active = true
                    ) as plans,
                    c.name as category_name,
                    c.slug as category_slug,
                    NOW() as granted_at,
                    'active' as status,
                    'preview' as purchase_gateway,
                    0 as sale_amount,
                    (
                        SELECT json_agg(
                            json_build_object(
                                'type', pm.media_type,
                                'url', pm.url,
                                'thumbnail_url', pm.thumbnail_url
                            ) ORDER BY pm.display_order, pm.id
                        )
                        FROM product_media pm
                        WHERE pm.product_id = p.id
                    ) as gallery,
                    (
                        SELECT po.checkout_url
                        FROM product_offers po
                        WHERE po.product_id = p.id
                          AND po.gateway = $1
                          AND po.is_active = true
                        ORDER BY po.priority DESC, po.id ASC
                        LIMIT 1
                    ) as checkout_url
                FROM products p
                LEFT JOIN categories c ON c.id = p.category_id
                WHERE p.is_active = true
                  AND p.is_published = true
                  AND COALESCE(p.catalog_hidden, false) = false
                ORDER BY p.is_featured DESC, p.display_order, p.created_at DESC
            `, [activeGateway]);

            const enrichedPreview = await Promise.all(previewLib.map(async (p) => {
                const withBunnyGallery = await appendBunnyCollectionToGallery(p);
                // Fase E: link Bunny direto no produto tem prioridade sobre
                // o video_call_id vindo da tabela video_calls.
                const virtualCall = buildVirtualCallFromProduct(p);
                const resolvedCall = virtualCall || p.video_call;
                return {
                    ...withBunnyGallery,
                    price: parseFloat(p.price || 0),
                    saleAmount: 0,
                    product_type: p.product_type || 'content',
                    consumed: false,            // preview NUNCA marca como consumido
                    consumed_at: null,
                    recall_message: null,       // sem recompra em preview
                    checkout_url: p.checkout_url || null,
                    video_call: enrichCallPayload(resolvedCall),
                };
            }));

            return res.json({
                success: true,
                email,
                preview_mode: true,
                // Preview vê o card dourado pro dono conferir o visual
                plans: [{ kind: 'premium', product_id: null, expires_at: null, group_bonus_until: null }],
                library: enrichedPreview,
            });
        }

        // Query principal — 1 round-trip. Tudo aninhado por subselect (sem
        // N+1). Inclui consumed_at via LEFT JOIN em customer_call_history.
        //
        // ORDER BY (Fase J2): a ordenação final acontece em JS depois do merge
        // com gifts (regra: não-consumidos primeiro por granted_at DESC, depois
        // consumidos por consumed_at DESC). Aqui só puxa os dados — qualquer
        // ORDER BY no SQL seria descartado pelo sort do JS.
        const { rows: library } = await db.query(`
            SELECT
                p.id,
                p.name,
                p.description,
                p.banner_url,
                p.main_video_url,
                p.access_url,
                p.price,
                p.audio_url,
                COALESCE(p.audio_enabled, false) as audio_enabled,
                p.audio_title,
                COALESCE(p.audio_autoplay, false) as audio_autoplay,
                COALESCE(p.chat_button_enabled, false) as chat_button_enabled,
                p.chat_button_chat_id,
                p.chat_button_label,
                p.video_call_id,
                p.direct_call_video_url,
                p.call_photo_url,
                p.call_ringing_text,
                p.call_ringtone_url,
                p.bunny_library_id,
                p.bunny_collection_id,
                COALESCE(p.product_type, 'content') as product_type,
                (
                    SELECT json_build_object(
                        'id', vc.id, 'slug', vc.slug, 'category', vc.category,
                        'model_name', vc.model_name, 'model_photo', vc.model_photo,
                        'video_url', vc.video_url, 'redirect_link', vc.redirect_link,
                        'cta_text', vc.cta_text, 'trigger_delay_sec', vc.trigger_delay_sec,
                        'cta_type', COALESCE(vc.cta_type, 'home'),
                        'cta_target_id', vc.cta_target_id
                    )
                    FROM video_calls vc WHERE vc.id = p.video_call_id AND vc.active = true
                ) as video_call,
                (
                    SELECT vc.model_name
                    FROM video_calls vc WHERE vc.id = p.video_call_id
                ) as model_name,
                (
                    SELECT json_agg(
                        json_build_object(
                            'id', pp.id, 'name', pp.name, 'price', pp.price,
                            'original_price', pp.original_price, 'badge', pp.badge,
                            'benefits', pp.benefits, 'checkout_url', pp.checkout_url,
                            'is_recommended', pp.is_recommended,
                            'display_order', pp.display_order
                        ) ORDER BY pp.display_order, pp.id
                    )
                    FROM product_plans pp WHERE pp.product_id = p.id AND pp.active = true
                ) as plans,
                c.name as category_name,
                c.slug as category_slug,
                ua.id as user_access_id,
                ua.granted_at,
                ua.expires_at as access_expires_at,
                ua.status,
                ua.gateway as purchase_gateway,
                ua.sale_amount,
                (
                    SELECT json_agg(
                        json_build_object(
                            'type', pm.media_type,
                            'url', pm.url,
                            'thumbnail_url', pm.thumbnail_url
                        ) ORDER BY pm.display_order, pm.id
                    )
                    FROM product_media pm
                    WHERE pm.product_id = p.id
                ) as gallery,
                (
                    -- Consumido NESTA compra: amarrado ao user_access ativo.
                    -- Após recompra, ua.id é novo → ainda não tem history pra ele
                    -- → consumed_at = NULL → frontend mostra "Assistir agora".
                    SELECT cch.seen_at
                    FROM customer_call_history cch
                    WHERE LOWER(cch.customer_email) = $1
                      AND cch.video_call_id = p.video_call_id
                      AND cch.user_access_id = ua.id
                    LIMIT 1
                ) as consumed_at,
                (
                    -- Mesma ideia, mas pra CHAMADINHA DIRETA (link colado no
                    -- produto): o histórico é por produto + este user_access.
                    -- Prêmio novo da roleta = user_access novo = volta a valer.
                    SELECT pch.seen_at
                    FROM product_call_history pch
                    WHERE LOWER(pch.customer_email) = $1
                      AND pch.product_id = p.id
                      AND pch.user_access_id = ua.id
                    LIMIT 1
                ) as direct_consumed_at,
                (
                    SELECT po.checkout_url
                    FROM product_offers po
                    WHERE po.product_id = p.id
                      AND po.gateway = $2
                      AND po.is_active = true
                    ORDER BY po.priority DESC, po.id ASC
                    LIMIT 1
                ) as checkout_url,
                (
                    -- produto de GRUPO: botão de acesso cai DENTRO do grupo
                    SELECT g.id FROM groups g
                    WHERE g.product_id = p.id AND g.active = true
                    ORDER BY g.id LIMIT 1
                ) as group_id
            FROM user_access ua
            INNER JOIN products p ON p.id = ua.product_id
            LEFT JOIN categories c ON c.id = p.category_id
            WHERE LOWER(ua.email) = $1
              AND ua.status = 'active'
              AND (ua.expires_at IS NULL OR ua.expires_at > NOW())
              AND p.is_active = true
              -- Assinatura do Chat / Status VIP (produtos internos do paywall):
              -- não viram card na biblioteca — o "produto" é o chat destravado.
              AND COALESCE(p.is_chat_plan, false) = false
              AND COALESCE(p.is_story_plan, false) = false
              -- Extras do PREMIUM (vídeos/grupo VIP bônus) não viram card de
              -- conteúdo — o card dourado do plano já explica o que tá incluso.
              AND COALESCE(ua.metadata->>'premium_extra', '') <> 'true'
        `, [email, activeGateway]);

        // Produto vinculado a grupo sem access_url próprio: o "Acessar" leva
        // direto pra dentro do grupo (deep link já tratado no app)
        for (const r of library) {
            if (!r.access_url && r.group_id) r.access_url = '/?group=' + r.group_id;
        }

        // ──────────────────────────────────────────────────────────
        // GIFTS (Fase J2): brindes ativos não-expirados pro mesmo email.
        // Roda em paralelo seria mais rápido (Promise.all), mas o ganho
        // é marginal (mesmo banco, mesma conexão pool). Mantém serial
        // pra ler/debugar mais fácil. Tolerante a falha: se a tabela
        // gifts não existir ainda (migration pendente), cai em [].
        // ──────────────────────────────────────────────────────────
        let giftsRows = [];
        try {
            const giftRes = await db.query(`
                SELECT
                    g.id as gift_id,
                    g.email,
                    g.label as gift_label,
                    g.expires_at as gift_expires_at,
                    g.granted_at as gift_granted_at,
                    p.id,
                    p.name,
                    p.description,
                    p.banner_url,
                    p.main_video_url,
                    p.access_url,
                    p.price,
                    p.audio_url,
                    COALESCE(p.audio_enabled, false) as audio_enabled,
                    p.audio_title,
                    p.video_call_id,
                    p.direct_call_video_url,
                    p.call_photo_url,
                    p.call_ringing_text,
                    p.call_ringtone_url,
                    p.bunny_library_id,
                    p.bunny_collection_id,
                    COALESCE(p.product_type, 'content') as product_type,
                    (
                        SELECT json_build_object(
                            'id', vc.id, 'slug', vc.slug, 'category', vc.category,
                            'model_name', vc.model_name, 'model_photo', vc.model_photo,
                            'video_url', vc.video_url, 'redirect_link', vc.redirect_link,
                            'cta_text', vc.cta_text, 'trigger_delay_sec', vc.trigger_delay_sec,
                            'cta_type', COALESCE(vc.cta_type, 'home'),
                            'cta_target_id', vc.cta_target_id
                        )
                        FROM video_calls vc WHERE vc.id = p.video_call_id AND vc.active = true
                    ) as video_call,
                    (
                        SELECT vc.model_name
                        FROM video_calls vc WHERE vc.id = p.video_call_id
                    ) as model_name,
                    c.name as category_name,
                    c.slug as category_slug,
                    (
                        SELECT json_agg(
                            json_build_object(
                                'type', pm.media_type,
                                'url', pm.url,
                                'thumbnail_url', pm.thumbnail_url
                            ) ORDER BY pm.display_order, pm.id
                        )
                        FROM product_media pm
                        WHERE pm.product_id = p.id
                    ) as gallery,
                    (
                        -- Consumido ESTE brinde: amarrado ao gift.id (não ao user_access).
                        SELECT cch.seen_at
                        FROM customer_call_history cch
                        WHERE LOWER(cch.customer_email) = $1
                          AND cch.video_call_id = p.video_call_id
                          AND cch.gift_id = g.id
                        LIMIT 1
                    ) as consumed_at,
                    (
                        -- Chamadinha DIRETA ganha de brinde: histórico por
                        -- produto + este brinde.
                        SELECT pch.seen_at
                        FROM product_call_history pch
                        WHERE LOWER(pch.customer_email) = $1
                          AND pch.product_id = p.id
                          AND pch.gift_id = g.id
                        LIMIT 1
                    ) as direct_consumed_at
                FROM gifts g
                INNER JOIN products p ON p.id = g.product_id
                LEFT JOIN categories c ON c.id = p.category_id
                WHERE LOWER(g.email) = $1
                  AND g.status = 'active'
                  AND (g.expires_at IS NULL OR g.expires_at > NOW())
                  AND p.is_active = true
                  AND p.is_published = true
            `, [email]);
            giftsRows = giftRes.rows || [];
        } catch (giftErr) {
            // Migration pendente (tabela gifts não existe) → loga warn e segue.
            // Não derruba o /library — comportamento pré-J2 (só user_access).
            if (giftErr.code === '42P01') {
                logger.warn('[library] tabela gifts não existe ainda — pulando merge (migration pendente?)');
            } else {
                logger.error('[library] erro buscando gifts (não-fatal):', giftErr.message);
            }
        }

        // Dedup: se o cliente comprou E ganhou de brinde o mesmo produto, a
        // compra (user_access) tem prioridade — o brinde fica "escondido" e
        // o `metadata.has_gift` marca o flag pra log/debug. Razão: cliente
        // comprou (pagou), então mostrar como compra é coerente. Brinde fica
        // disponível pra usar caso a compra seja refundada no futuro.
        const purchasedProductIds = new Set(library.map(p => p.id));
        const giftsToShow = giftsRows.filter(g => !purchasedProductIds.has(g.id));

        // Recall por ROTACAO TEMPORAL (Fase C, mai/2026):
        //   - Pool global de mensagens ativas, ordenado por display_order.
        //   - Bucket = floor(now / intervalo). Mesma bucket = mesma mensagem
        //     pra TODOS os clientes (rotacao global, nao por cliente).
        //   - Intervalo configuravel em system_settings.recall_rotation_interval_minutes
        //     (default 30 min).
        //   - Substitui inteiramente a logica antiga de janela em dias (min/max).
        const chosenRecall = await pickGlobalRecallMessage();

        const enriched = await Promise.all(library.map(async (p) => {
            const productType = p.product_type || 'content';
            const isVideoCall = productType === 'video_call';

            // Fase E: link Bunny direto tem prioridade sobre o video_call_id legado.
            // Jul/2026: a chamadinha DIRETA também tem consumo — vem de
            // product_call_history (direct_consumed_at), amarrado a ESTE
            // user_access. Antes ela ficava disponível pra sempre.
            const virtualCall = buildVirtualCallFromProduct(p);
            const usingVirtual = !!virtualCall;
            const resolvedCall = virtualCall || p.video_call;
            const modelName = usingVirtual ? p.name : p.model_name;
            const consumedAt = usingVirtual ? (p.direct_consumed_at || null) : (p.consumed_at || null);
            const consumed = isVideoCall && !!consumedAt;

            // Bunny: galeria do produto recebe os vídeos da Collection (se houver),
            // e o sub-objeto video_call ganha bunny_hls_url/is_bunny.
            const withBunnyGallery = await appendBunnyCollectionToGallery(p);

            return {
                ...withBunnyGallery,
                price: parseFloat(p.price || 0),
                saleAmount: parseFloat(p.sale_amount || 0),
                product_type: productType,
                is_gift: false,
                gift_id: null,
                gift_expires_at: null,
                consumed: isVideoCall ? consumed : false,
                consumed_at: isVideoCall ? consumedAt : null,
                recall_message: (isVideoCall && consumed && chosenRecall)
                    ? applyModelName(chosenRecall, modelName)
                    : (isVideoCall && consumed ? applyModelName(null, modelName) : null),
                checkout_url: (isVideoCall && consumed) ? (p.checkout_url || null) : null,
                video_call: enrichCallPayload(resolvedCall),
            };
        }));

        // ──────────────────────────────────────────────────────────
        // Enriquece os brindes com a mesma forma do user_access (mesmo
        // contrato pro frontend renderizar como card normal + badge BRINDE).
        // Diferenças:
        //   - is_gift: true, gift_id: N, gift_expires_at: TS|null
        //   - granted_at = g.granted_at (pra ordenação ficar igual)
        //   - checkout_url null quando consumido (brinde NÃO vira CTA de
        //     recompra: cliente ganhou, não compra recompra). Frontend
        //     trata recall_message null + is_gift=true como "esgotado".
        //   - product_type='content' fluxo normal (galeria); video_call
        //     com brinde precisa só do video_call_id legado pra consumo
        //     (direct_call_video_url também funciona, mas sem tracking).
        // ──────────────────────────────────────────────────────────
        const enrichedGifts = await Promise.all(giftsToShow.map(async (p) => {
            const productType = p.product_type || 'content';
            const isVideoCall = productType === 'video_call';

            const virtualCall = buildVirtualCallFromProduct(p);
            const usingVirtual = !!virtualCall;
            const resolvedCall = virtualCall || p.video_call;
            const modelName = usingVirtual ? p.name : p.model_name;
            const consumedAt = usingVirtual ? (p.direct_consumed_at || null) : (p.consumed_at || null);
            const consumed = isVideoCall && !!consumedAt;

            const withBunnyGallery = await appendBunnyCollectionToGallery(p);

            return {
                ...withBunnyGallery,
                // Remove campos só-de-gift do payload do produto
                gift_id: undefined, gift_label: undefined,
                gift_expires_at: undefined, gift_granted_at: undefined,
                // E reinjeta no shape "library item"
                price: parseFloat(p.price || 0),
                saleAmount: 0,
                granted_at: p.gift_granted_at,
                purchase_gateway: 'gift',
                status: 'active',
                is_gift: true,
                gift_id: p.gift_id,
                gift_label: p.gift_label || null,
                gift_expires_at: p.gift_expires_at || null,
                product_type: productType,
                consumed: isVideoCall ? consumed : false,
                consumed_at: isVideoCall ? consumedAt : null,
                // Brinde consumido: mostra mensagem de "obrigado" sem CTA de
                // compra (cliente não compra recompra de brinde — usa de outra
                // forma). Mantém recall_message só pra ter o texto da modelo.
                recall_message: (isVideoCall && consumed)
                    ? applyModelName(chosenRecall, modelName)
                    : null,
                checkout_url: null,
                video_call: enrichCallPayload(resolvedCall),
            };
        }));

        // ──────────────────────────────────────────────────────────
        // Ordenação final (Fase J2):
        //   1) NÃO-consumidos primeiro, ordenados por granted_at DESC
        //      (mais recente no topo).
        //   2) Consumidos depois, ordenados por consumed_at DESC.
        // Brindes seguem a mesma regra (granted_at = gift.granted_at).
        // ──────────────────────────────────────────────────────────
        const merged = [...enriched, ...enrichedGifts];
        const tsOf = v => (v ? new Date(v).getTime() : 0);
        merged.sort((a, b) => {
            const aConsumed = !!a.consumed;
            const bConsumed = !!b.consumed;
            if (aConsumed !== bConsumed) return aConsumed ? 1 : -1;
            if (aConsumed && bConsumed) {
                // Consumidos: mais recente de consumo no topo do grupo.
                return tsOf(b.consumed_at) - tsOf(a.consumed_at);
            }
            // Não-consumidos: mais recente de compra/brinde no topo.
            return tsOf(b.granted_at) - tsOf(a.granted_at);
        });

        return res.json({
            success: true,
            email,
            preview_mode: false,
            plans: await loadUserPlans(email),
            library: merged,
        });
    } catch (err) {
        logger.error('Erro em /library:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// ─── Recall rotation helpers ──────────────────────────────────────────────────
//
// pickGlobalRecallMessage(): busca todas as mensagens ativas + intervalo, e
// escolhe UMA pela bucket de tempo atual. Mesma resposta pra TODOS os clientes
// dentro da mesma janela (rotacao global).
//
// applyModelName(template, modelName): substitui {modelo} no template. Se
// template for null, usa FALLBACK_RECALL_TEMPLATE.

const FALLBACK_RECALL_TEMPLATE = 'Quer outra vídeo chamada com a {modelo}? 🔥';

async function pickGlobalRecallMessage() {
    try {
        // Le intervalo do system_settings (JSONB).
        const { rows: [setting] } = await db.query(
            `SELECT value FROM system_settings WHERE key = 'recall_rotation_interval_minutes'`
        );
        let interval = 30;
        if (setting && setting.value != null) {
            // value e JSONB — pode vir como number, string "30", ou '"30"'.
            const raw = (typeof setting.value === 'string')
                ? setting.value.replace(/"/g, '')
                : setting.value;
            const parsed = parseInt(raw, 10);
            if (!isNaN(parsed) && parsed > 0) interval = parsed;
        }

        const { rows: msgs } = await db.query(`
            SELECT message
            FROM recall_messages
            WHERE active = true
            ORDER BY display_order ASC, id ASC
        `);
        if (!msgs.length) return null;

        const bucket = Math.floor(Date.now() / (interval * 60 * 1000));
        const idx = ((bucket % msgs.length) + msgs.length) % msgs.length; // safe mod
        return msgs[idx].message;
    } catch (err) {
        logger.warn('pickGlobalRecallMessage falhou (migration pendente?):', err.message);
        return null;
    }
}

function applyModelName(template, modelName) {
    const safeName = String(modelName || 'modelo');
    return String(template || FALLBACK_RECALL_TEMPLATE).split('{modelo}').join(safeName);
}


/**
 * POST /api/user/calls/:product_id/start
 * Marca produto-chamada como CONSUMIDO (1 vez só).
 *
 * Anti-race garantido por UNIQUE(customer_email, video_call_id) +
 * ON CONFLICT DO NOTHING — não dá pra dois requests simultâneos
 * conseguirem inserir. O que vier primeiro vence; o segundo recebe 409.
 *
 * Resposta:
 *   200 { ok: true, video_call: {...}, started_at }      → primeira vez
 *   409 { ok: false, error: 'already_consumed',          → já consumida
 *         recall_message, checkout_url, consumed_at }
 *   400 { ok: false, error: 'invalid_product' }          → id inválido
 *   403 { ok: false, error: 'no_access' }                → sem user_access ativo
 *   404 { ok: false, error: 'not_a_video_call' }         → produto não é video_call
 */
router.post('/calls/:product_id/start', requireUser, async (req, res) => {
    const productId = parseInt(req.params.product_id, 10);
    const email = req.user.email;

    if (!productId || isNaN(productId)) {
        return res.status(400).json({ ok: false, error: 'invalid_product' });
    }

    // Preview mode: NAO grava consumo, NAO checa user_access. So devolve
    // o payload da chamada pra abrir o overlay. Pode reabrir N vezes.
    let previewMode = false;
    try { previewMode = await isPreviewEmail(email); } catch (_) {}

    try {
        // 1) Carrega produto + checa que é video_call.
        //    Fase E: além do vínculo via video_call_id (legado), aceita
        //    direct_call_video_url (link Bunny colado direto). Quando os
        //    dois estão preenchidos, direct ganha — é o modo "rápido".
        const { rows: [product] } = await db.query(`
            SELECT
                p.id,
                p.name,
                p.banner_url,
                p.video_call_id,
                p.direct_call_video_url,
                p.call_photo_url,
                p.call_ringing_text,
                p.call_ringtone_url,
                COALESCE(p.product_type, 'content') as product_type,
                vc.id as vc_id,
                vc.slug as vc_slug,
                vc.category as vc_category,
                vc.model_name as vc_model_name,
                vc.model_photo as vc_model_photo,
                vc.video_url as vc_video_url,
                vc.redirect_link as vc_redirect_link,
                vc.cta_text as vc_cta_text,
                vc.trigger_delay_sec as vc_trigger_delay_sec,
                COALESCE(vc.cta_type, 'home') as vc_cta_type,
                vc.cta_target_id as vc_cta_target_id
            FROM products p
            LEFT JOIN video_calls vc ON vc.id = p.video_call_id AND vc.active = true
            WHERE p.id = $1 AND p.is_active = true
            LIMIT 1
        `, [productId]);

        if (!product) {
            return res.status(404).json({ ok: false, error: 'product_not_found' });
        }
        const hasDirect = !!product.direct_call_video_url;
        const hasLegacy = !!(product.video_call_id && product.vc_id);
        if (product.product_type !== 'video_call' || (!hasDirect && !hasLegacy)) {
            return res.status(404).json({ ok: false, error: 'not_a_video_call' });
        }

        // Monta o payload da chamada. Direct tem prioridade.
        const buildPayload = () => {
            if (hasDirect) {
                return {
                    id: `direct-${product.id}`,
                    slug: null,
                    category: 'produto',
                    model_name: product.name || 'Modelo',
                    // Fase F: call_photo_url (selfie íntima) > banner_url (capa do card).
                    model_photo: product.call_photo_url || product.banner_url || null,
                    video_url: product.direct_call_video_url,
                    // Fase F: texto custom de "chamando" + ringtone (ambos opcionais).
                    // null → frontend usa default ("Chamada de vídeo recebida" / silêncio).
                    ringing_text: product.call_ringing_text || null,
                    ringtone_url: product.call_ringtone_url || null,
                    redirect_link: null,
                    cta_text: null,
                    trigger_delay_sec: 0,
                    cta_type: 'home',
                    cta_target_id: null,
                };
            }
            // Modo legacy: chamada reusada do Remarketing (tabela video_calls).
            // Essa tabela NÃO tem ringing_text/ringtone_url — retornamos null
            // pra que o frontend caia no default. Se um dia o admin quiser
            // esses campos no Remarketing, vira outra migration (DLC futuro).
            return {
                id: product.vc_id,
                slug: product.vc_slug,
                category: product.vc_category,
                model_name: product.vc_model_name,
                model_photo: product.vc_model_photo,
                video_url: product.vc_video_url,
                ringing_text: null,
                ringtone_url: null,
                redirect_link: product.vc_redirect_link,
                cta_text: product.vc_cta_text,
                trigger_delay_sec: product.vc_trigger_delay_sec,
                cta_type: product.vc_cta_type,
                cta_target_id: product.vc_cta_target_id,
            };
        };

        // PREVIEW: libera o video direto sem gravar nada. Pode tocar N vezes.
        if (previewMode) {
            logger.info(`[preview] call start (no-record): ${email} -> product ${productId}`);
            return res.json({
                ok: true,
                preview_mode: true,
                video_call: enrichCallPayload(buildPayload()),
                started_at: new Date().toISOString(),
            });
        }

        // 2) Confirma acesso. Prioridade: user_access ativo > gift ativo (Fase J2).
        //    Se o cliente comprou E ganhou de brinde, a compra (ua) ganha — coerente
        //    com o /library, que esconde o brinde quando há compra do mesmo produto.
        const { rows: [access] } = await db.query(`
            SELECT id, granted_at, expires_at
            FROM user_access
            WHERE LOWER(email) = $1
              AND product_id = $2
              AND status = 'active'
              AND (expires_at IS NULL OR expires_at > NOW())
            LIMIT 1
        `, [email, productId]);

        let gift = null;
        if (!access) {
            // Sem user_access — tenta brinde ativo. Erro silencioso se a
            // tabela ainda não existir (migration pendente em deploys antigos).
            try {
                const giftRes = await db.query(`
                    SELECT id, granted_at, expires_at
                    FROM gifts
                    WHERE LOWER(email) = $1
                      AND product_id = $2
                      AND status = 'active'
                      AND (expires_at IS NULL OR expires_at > NOW())
                    LIMIT 1
                `, [email, productId]);
                if (giftRes.rows.length) gift = giftRes.rows[0];
            } catch (giftErr) {
                if (giftErr.code !== '42P01') {
                    logger.warn('[calls/start] erro buscando gift:', giftErr.message);
                }
            }
        }

        if (!access && !gift) {
            return res.status(403).json({ ok: false, error: 'no_access' });
        }

        // CHAMADINHA DIRETA (jul/2026) — agora COM marcação de consumo.
        //
        // Antes: produto-direct não gravava nada (customer_call_history exige FK
        // pra video_calls.id e o virtual usa id em texto 'direct-N') → o cliente
        // reabria a mesma chamada infinitas vezes. Como os produtos reais são
        // desse tipo (inclusive o prêmio da Roleta VIP), virou furo de verdade.
        //
        // Agora: grava em product_call_history ANTES de devolver o vídeo, no
        // mesmo conceito de "slot" do histórico legado — e-mail + produto + o
        // acesso que deu direito (compra/prêmio) OU o brinde. Um acesso NOVO
        // (recompra ou prêmio novo da roleta) nasce sem histórico → a chamada
        // volta a ficar disponível sozinha.
        if (hasDirect) {
            const via = gift ? 'gift' : 'purchase';
            const directAccessId = access ? access.id : null;
            const directGiftId = gift ? gift.id : null;

            const { rows: insDirect } = await db.query(`
                INSERT INTO product_call_history (customer_email, product_id, user_access_id, gift_id, seen_at)
                VALUES ($1, $2, $3, $4, NOW())
                ON CONFLICT DO NOTHING
                RETURNING id, seen_at
            `, [email, productId, directAccessId, directGiftId]);

            if (insDirect.length > 0) {
                logger.info(`call start (direct/${via}): ${email} -> product ${productId}`);
                return res.json({
                    ok: true,
                    via,
                    video_call: enrichCallPayload(buildPayload()),
                    started_at: insDirect[0].seen_at,
                });
            }

            // Já usou ESTE slot → não abre de novo. O card vira "chamada já
            // realizada" (e, quando é compra, com CTA de comprar de novo).
            const { rows: [prev] } = await db.query(`
                SELECT seen_at FROM product_call_history
                WHERE LOWER(customer_email) = $1
                  AND product_id = $2
                  AND COALESCE(user_access_id, 0) = COALESCE($3::int, 0)
                  AND COALESCE(gift_id, 0) = COALESCE($4::int, 0)
                LIMIT 1
            `, [email, productId, directAccessId, directGiftId]);

            let directCheckoutUrl = null;
            if (!gift) {
                const { rows: [gwRow] } = await db.query(
                    `SELECT value FROM system_settings WHERE key = 'active_gateway'`
                );
                const gw = gwRow?.value?.replace(/"/g, '') || 'kirvano';
                const { rows: [offer] } = await db.query(`
                    SELECT po.checkout_url
                    FROM product_offers po
                    WHERE po.product_id = $1
                      AND po.gateway = $2
                      AND po.is_active = true
                    ORDER BY po.priority DESC, po.id ASC
                    LIMIT 1
                `, [productId, gw]);
                directCheckoutUrl = offer?.checkout_url || null;
            }

            const recallDirect = applyModelName(await pickGlobalRecallMessage(), product.name);
            logger.info(`call start BLOQUEADO (direct/${via} já usado): ${email} -> product ${productId}`);
            return res.status(409).json({
                ok: false,
                error: 'already_used',
                via,
                consumed_at: prev?.seen_at || null,
                recall_message: recallDirect,
                checkout_url: directCheckoutUrl,
            });
        }

        // 3) INSERT (anti-race). UNIQUE da tabela cobre (email, vc_id, ua_id, gift_id) —
        //    como NULL não conflita no Postgres, compra e brinde têm slots independentes.
        //    Compra: gift_id=NULL, user_access_id=N.
        //    Brinde: user_access_id=NULL, gift_id=N.
        const userAccessId = access ? access.id : null;
        const giftId = gift ? gift.id : null;
        const { rows: ins } = await db.query(`
            INSERT INTO customer_call_history (customer_email, video_call_id, user_access_id, gift_id, seen_at)
            VALUES ($1, $2, $3, $4, NOW())
            ON CONFLICT ON CONSTRAINT customer_call_history_unique_per_slot DO NOTHING
            RETURNING id, seen_at
        `, [email, product.video_call_id, userAccessId, giftId]);

        const videoCallPayload = enrichCallPayload(buildPayload());

        if (ins.length > 0) {
            const via = gift ? 'gift' : 'purchase';
            logger.info(`call start (${via}): ${email} → product ${productId} / call ${product.video_call_id}`);
            return res.json({
                ok: true,
                via,
                video_call: videoCallPayload,
                started_at: ins[0].seen_at,
            });
        }

        // 4) Conflito: já consumiu NESTE slot (compra OU brinde — depende de qual está ativo).
        const { rows: [history] } = await db.query(`
            SELECT seen_at FROM customer_call_history
            WHERE LOWER(customer_email) = $1
              AND video_call_id = $2
              AND user_access_id IS NOT DISTINCT FROM $3
              AND gift_id IS NOT DISTINCT FROM $4
            LIMIT 1
        `, [email, product.video_call_id, userAccessId, giftId]);

        const { rows: [gatewaySetting] } = await db.query(
            `SELECT value FROM system_settings WHERE key = 'active_gateway'`
        );
        const activeGateway = gatewaySetting?.value?.replace(/"/g, '') || 'kirvano';
        // Brinde consumido: NÃO retorna checkout_url (cliente não recompra brinde).
        // Compra consumida: retorna URL pra recompra normal.
        let checkoutUrl = null;
        if (!gift) {
            const { rows: [offer] } = await db.query(`
                SELECT po.checkout_url
                FROM product_offers po
                WHERE po.product_id = $1
                  AND po.gateway = $2
                  AND po.is_active = true
                ORDER BY po.priority DESC, po.id ASC
                LIMIT 1
            `, [productId, activeGateway]);
            checkoutUrl = offer?.checkout_url || null;
        }

        // Recall: rotacao global por bucket de tempo (Fase C, mai/2026).
        const consumedAt = history?.seen_at || null;
        const chosenTemplate = await pickGlobalRecallMessage();
        const recallMessage = applyModelName(chosenTemplate, product.vc_model_name);

        return res.status(409).json({
            ok: false,
            error: 'already_consumed',
            via: gift ? 'gift' : 'purchase',
            consumed_at: consumedAt,
            recall_message: recallMessage,
            checkout_url: checkoutUrl,
        });
    } catch (err) {
        logger.error('Erro em /calls/:product_id/start:', err);
        return res.status(500).json({ ok: false, error: 'internal_error' });
    }
});


// =============================================================================
// GET /api/user/app-config
// Retorna TODAS as configurações públicas que o app cliente precisa pra
// renderizar a home, perfil, login, gamificação, etc.
// Não exige login (algumas coisas são exibidas pré-login).
// =============================================================================
/**
 * GET /api/user/recent-sales
 * Retorna últimas N vendas reais (com produto), pra alimentar o ticker
 * em modo real_only/hybrid. NÃO retorna email/identificador de cliente.
 */
router.get('/recent-sales', async (req, res) => {
    try {
        const { rows } = await db.query(`
            SELECT ua.granted_at, p.name AS product
            FROM user_access ua
            INNER JOIN products p ON p.id = ua.product_id
            WHERE ua.status = 'active'
            ORDER BY ua.granted_at DESC
            LIMIT 12
        `);
        const sales = rows.map(r => ({
            product: r.product,
            when: r.granted_at,
        }));
        return res.json({ success: true, sales });
    } catch (err) {
        logger.error('Erro em /recent-sales:', err);
        return res.json({ success: true, sales: [] });
    }
});


router.get('/app-config', async (req, res) => {
    try {
        // Busca cada parte separadamente — se uma query falhar (ex: coluna nova
        // ainda não migrada), não derruba o app inteiro. Cada catch retorna {rows: []}
        // pra deixar o frontend renderizar mockup hardcoded.
        const safe = (q, params) => db.query(q, params).catch(err => {
            logger.warn('app-config query falhou (usando default):', err.message);
            return { rows: [] };
        });

        // Tenta hero com novas colunas; se falhar, faz query antiga
        // Slides vinculados a produto rascunho (is_published=false) também ficam
        // ocultos — evita que admin "esqueça" um banner apontando pra produto incompleto.
        const heroQuery = safe(`
            SELECT
                hs.id, hs.thumb_url, hs.title, hs.subtitle, hs.badge_text,
                hs.cta_text, hs.product_id, hs.display_order,
                hs.variant_group, hs.variant_weight
            FROM hero_slides hs
            LEFT JOIN products p ON p.id = hs.product_id
            WHERE hs.is_active = true
              AND (hs.product_id IS NULL OR (p.is_active = true AND p.is_published = true))
            ORDER BY hs.display_order, hs.id
        `).then(r => {
            if (r.rows.length > 0 || !r.__failed) return r;
            return safe(`
                SELECT hs.id, hs.thumb_url, hs.title, hs.subtitle, hs.badge_text,
                       hs.cta_text, hs.product_id, hs.display_order
                FROM hero_slides hs
                LEFT JOIN products p ON p.id = hs.product_id
                WHERE hs.is_active = true
                  AND (hs.product_id IS NULL OR (p.is_active = true AND p.is_published = true))
                ORDER BY hs.display_order, hs.id
            `);
        }).catch(() => safe(`
            SELECT id, thumb_url, title, subtitle, badge_text, cta_text, product_id, display_order
            FROM hero_slides
            WHERE is_active = true
            ORDER BY display_order, id
        `));

        const [configsResult, categoriesResult, heroResult, carouselsResult, carouselProductsResult] = await Promise.all([
            safe(`
                SELECT key, value FROM gamification_config
                WHERE key IN (
                    'app_config', 'login_config', 'profile_config', 'home_layout',
                    'reviews_list', 'flash_offers', 'live_notifications',
                    'explore_config', 'pwa_gate_config', 'lives_config'
                )
            `),
            safe(`
                SELECT id, slug, name, description, icon, display_order
                FROM categories
                WHERE is_active = true
                ORDER BY display_order, name
            `),
            heroQuery,
            safe(`
                SELECT id, title, subtitle, display_order
                FROM home_carousels
                WHERE is_active = true
                ORDER BY display_order, id
            `),
            safe(`
                SELECT
                    cp.carousel_id, cp.product_id, cp.display_order,
                    p.name, p.banner_url, p.price, p.description,
                    p.access_url, p.main_video_url, p.category_id
                FROM carousel_products cp
                INNER JOIN products p ON p.id = cp.product_id
                WHERE p.is_active = true
                  AND p.is_published = true
                ORDER BY cp.carousel_id, cp.display_order, cp.id
            `),
        ]);
        
        const configs = {};
        for (const row of configsResult.rows) {
            configs[row.key] = row.value;
        }
        
        // Defaults se a key não existir no banco (caso init-db não tenha sido rodado)
        if (!configs.app_config) configs.app_config = {};
        // Garante defaults pra todas as chaves (sobrescrevem só se ausentes)
        configs.app_config = {
            app_name: 'Membros Vip',
            app_tagline: 'Sua coleção de conteúdo VIP',
            primary_color: '#e50914',
            maintenance_mode: false,
            maintenance_message: 'Estamos fazendo melhorias. Volte em breve!',
            bonus_delay_minutes: 3,   // tempo até o ticker/notificações aparecerem no 1º login
            show_continue_watching: false,
            // Esteiras auto-loop
            carousel_speed_seconds: 30,
            carousel_paused: false,
            // Hero — estilo do título
            hero_title_style: 'shimmer-all',  // shimmer-all | shimmer-words | glow-red | plain
            hero_shimmer_enabled: true,
            hero_shimmer_color: '',
            // Nudge ao SAIR de uma conversa: puxa o lead pra Vídeos/Lives
            // (1x por sessão). Desligado por padrão.
            chat_exit_nudge: {
                enabled: false,
                text: 'Tem live rolando agora — dá uma espiada 🔴',
                target: 'lives',   // 'lives' | 'videos'
                delay_sec: 2,
            },
            version: '1.0.0',
            ...configs.app_config,
        };
        if (!configs.live_notifications) configs.live_notifications = {
            enabled: false,           // default OFF — admin liga quando quiser
            mode: 'real_only',        // 'off' | 'fake' | 'real_only' | 'hybrid'
            visible_ms: 5000,
            gap_min_ms: 30000,
            gap_max_ms: 90000,
            initial_delay_ms: 8000,
            cities: ['SP', 'RJ', 'MG', 'BA', 'PR', 'RS', 'SC', 'GO', 'DF', 'CE', 'PE'],
            messages: [
                { template: '<strong>Alguém de {city}</strong> acabou de comprar', type: 'purchase' },
                { template: '<strong>{n} pessoas</strong> estão vendo isso agora', type: 'live' },
                { template: '<strong>{members}</strong> membros estão online', type: 'online' },
            ],
        };
        if (!configs.login_config) configs.login_config = {
            hero_title: 'Bem-vindo de volta',
            hero_subtitle: 'Entre com seu email pra acessar seus produtos',
            cta_text: 'Entrar',
            mailcheck_enabled: true,
            autologin_days: 90,
        };
        if (!configs.profile_config) configs.profile_config = {
            visible_cards: ['avatar', 'stats'],
            show_apelido_edit: true,
            show_avatar_upload: true,
            show_logout: true,
        };
        if (!configs.home_layout) configs.home_layout = { sections: [] };
        if (!configs.reviews_list) configs.reviews_list = { items: [] };
        if (!configs.flash_offers) configs.flash_offers = { items: [] };
        // Explorar/TikTok — só expõe o necessário pra montar a aba (sem segredos)
        configs.explore_config = {
            enabled: false, free_limit: 15, pwa_gate_after: 2,
            ...(configs.explore_config || {}),
        };
        configs.pwa_gate_config = {
            gate_stories: true, gate_view_once: true, gate_explore: true,
            title: 'Falta um passo',
            text: 'Instale o app na tela inicial pra ver esse conteúdo.',
            ...(configs.pwa_gate_config || {}),
        };
        
        // Filtra ofertas: só ativas e dentro do período
        const now = new Date();
        const activeOffers = (configs.flash_offers.items || []).filter(o => {
            if (o.active === false) return false;
            if (o.start_at && new Date(o.start_at) > now) return false;
            if (o.end_at && new Date(o.end_at) < now) return false;
            return true;
        });
        
        // Filtra reviews ativos
        const activeReviews = (configs.reviews_list.items || []).filter(r => r.active !== false);

        // Monta carousels com seus produtos aninhados
        const productsByCarousel = {};
        for (const p of carouselProductsResult.rows) {
            if (!productsByCarousel[p.carousel_id]) productsByCarousel[p.carousel_id] = [];
            productsByCarousel[p.carousel_id].push({
                id: p.product_id,
                name: p.name,
                banner_url: p.banner_url,
                price: p.price,
                description: p.description,
                // SEGURANÇA: /app-config é público (sem auth) — NUNCA enviar
                // access_url/main_video_url aqui (são os links do conteúdo pago).
                // Quem comprou recebe o link pelo /catalog (com ownership) e /library.
                category_id: p.category_id,
            });
        }
        const carouselsWithProducts = carouselsResult.rows.map(c => ({
            id: c.id,
            title: c.title,
            subtitle: c.subtitle,
            display_order: c.display_order,
            products: productsByCarousel[c.id] || [],
        })).filter(c => c.products.length > 0); // só esteiras com produtos
        
        return res.json({
            success: true,
            app: configs.app_config,
            login: configs.login_config,
            profile: configs.profile_config,
            home_layout: configs.home_layout.sections || [],
            hero_slides: heroResult.rows,
            carousels: carouselsWithProducts,
            reviews: activeReviews,
            flash_offers: activeOffers,
            categories: categoriesResult.rows,
            live_notifications: configs.live_notifications,
            // Explorar/TikTok: só flags pra montar a aba (enabled + gates). O feed
            // real (vídeos + acesso) vem autenticado de /api/user/explore/feed.
            explore: {
                enabled: configs.explore_config.enabled === true,
                free_limit: configs.explore_config.free_limit,
                pwa_gate_after: configs.explore_config.pwa_gate_after,
            },
            // Lives: só a flag pra mostrar a sub-aba (o resto vem de /api/user/lives)
            lives: { enabled: (configs.lives_config || {}).enabled === true },
            pwa_gate: configs.pwa_gate_config,
            // Pixel do Facebook (só a parte pública: id + quais eventos — o
            // token do CAPI NUNCA sai do servidor). null = desligado.
            meta_pixel: await require('../lib/meta-pixel').publicMetaConfig().catch(() => null),
            // Lista de produtos com progresso de visualização — vazia até ter player real
            continue_watching: [],
        });
    } catch (err) {
        logger.error('Erro em /app-config:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// =============================================================================
// EXPLORAR / TIKTOK — feed vertical de vídeos
// =============================================================================
// GET /api/user/explore/feed — vídeos publicados + config (limite grátis, gate
// de PWA, produto de desbloqueio). has_access = e-mail já pagou o produto VIP
// do Explorar (ou é e-mail premium/preview). Reaproveita Bunny pra HLS/thumb.

// Resolve as URLs de um vídeo do Explorar (Bunny HLS/thumb ou MP4 cru).
function resolveExploreVideo(v) {
    let hls = v.hls_url || null;
    let guid = v.bunny_video_id || null;
    let mp4 = null;
    if (!hls && v.video_url) {
        const b = parseBunnyUrl(v.video_url);
        if (b) { guid = guid || b.guid; hls = bunnyHlsUrl(b.guid); }
        else { mp4 = v.video_url; }
    }
    if (!hls && guid) hls = bunnyHlsUrl(guid);
    const poster = v.thumbnail_url || (guid ? bunnyThumbUrl(guid) : null);
    return {
        id: v.id,
        caption: v.caption || '',
        creator_name: v.creator_name || '',
        hls_url: hls,
        src: mp4,
        poster: poster,
        likes: v.likes_seed || 0,
    };
}

// Curtidas exibidas estáveis a partir do guid (cosmético; coleção não tem likes)
function likesFromGuid(g) {
    let h = 0; const s = String(g || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return 500 + (h % 9000);
}

// Resolve o feed a partir de uma PASTA (coleção) do Bunny — igual aos conteúdos
// do produto. Pega todos os vídeos prontos da coleção de uma vez.
async function resolveExploreCollection(cfg) {
    try {
        const list = await listCollectionVideos(cfg.collection_library_id, cfg.collection_id);
        return (list || [])
            .filter(v => v.status == null || v.status >= 4) // só os prontos pra streaming
            .map(v => ({
                id: 'col-' + v.guid,
                caption: '',
                creator_name: cfg.creator_name || '',
                hls_url: bunnyHlsUrl(v.guid),
                src: null,
                poster: bunnyThumbUrl(v.guid, v.thumbnailFileName),
                likes: likesFromGuid(v.guid),
            }));
    } catch (_) { return []; }
}

// Cliente tem acesso ilimitado ao Explorar? (pagou o produto OU é preview)
async function ownsExploreProduct(email, productId) {
    if (!email) return false;
    try { if (await isPreviewEmail(email)) return true; } catch (_) {}
    if (!productId) return false;
    const e = email.toLowerCase().trim();
    try {
        const { rows } = await db.query(
            `SELECT 1 FROM user_access WHERE LOWER(email) = $1 AND product_id = $2 AND status = 'active'
             AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1`, [e, productId]
        );
        if (rows.length) return true;
        const { rows: g } = await db.query(
            `SELECT 1 FROM gifts WHERE LOWER(email) = $1 AND product_id = $2 AND status = 'active'
             AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1`, [e, productId]
        );
        return g.length > 0;
    } catch (_) { return false; }
}

// Desbloqueio por CÓDIGOS DE OFERTA (igual produtos): o cliente comprou alguma
// das ofertas listadas → libera o feed. Casa pela venda já registrada
// (user_access.offer_id → product_offers.offer_id = código do gateway).
function parseOfferCodes(raw) {
    if (!raw) return [];
    return String(raw).split(',').map(s => s.trim()).filter(Boolean).slice(0, 50);
}
async function ownsExploreByOffers(email, rawCodes) {
    if (!email) return false;
    const codes = parseOfferCodes(rawCodes);
    if (!codes.length) return false;
    try {
        // Código que pertence ao produto INTERNO do chat só vale se for a
        // oferta PREMIUM. Sem esse filtro, listar o código do Premium aqui
        // fazia o VIP (mesmo produto do chat!) destravar os vídeos junto.
        const { rows } = await db.query(
            `SELECT 1 FROM user_access ua
             JOIN product_offers po ON po.id = ua.offer_id
             JOIN products p ON p.id = po.product_id
             WHERE LOWER(ua.email) = $1 AND ua.status = 'active'
               AND (ua.expires_at IS NULL OR ua.expires_at > NOW())
               AND po.offer_id = ANY($2::text[])
               AND ( (COALESCE(p.is_chat_plan, false) = false AND COALESCE(p.is_story_plan, false) = false)
                     OR COALESCE(po.is_premium, false) = true )
             LIMIT 1`,
            [email.toLowerCase().trim(), codes]
        );
        return rows.length > 0;
    } catch (_) { return false; }
}

// Cliente PREMIUM (produto do chat comprado pela oferta Premium, detectado
// pela oferta OU pelo selo metadata.premium). Premium inclui os vídeos por
// definição; VIP não — esta é a regra explícita, independente de config.
async function isPremiumCustomer(email) {
    if (!email) return false;
    try {
        const { rows } = await db.query(
            `SELECT 1 FROM user_access ua
             JOIN products p ON p.id = ua.product_id AND p.is_chat_plan = true
             LEFT JOIN product_offers po ON po.id = ua.offer_id
             WHERE LOWER(ua.email) = $1 AND ua.status = 'active'
               AND (ua.expires_at IS NULL OR ua.expires_at > NOW())
               AND (COALESCE(po.is_premium, false) = true OR ua.metadata->>'premium' = 'true')
             LIMIT 1`,
            [email.toLowerCase().trim()]
        );
        return rows.length > 0;
    } catch (_) { return false; }
}

// Posse dos VÍDEOS resolvida do zero (produto da config + códigos + Premium),
// com o MESMO guarda anti-produto-interno do feed. Reutilizada pela aba Lives
// (mesma regra de acesso e mesmo popup).
async function exploreAccess(email) {
    try {
        const cfgRow = await db.query(`SELECT value FROM gamification_config WHERE key = 'explore_config'`).catch(() => ({ rows: [] }));
        const cfg = cfgRow.rows[0]?.value || {};
        let productId = cfg.product_id ? parseInt(cfg.product_id, 10) : null;
        if (productId) {
            const { rows: [pp] } = await db.query(
                `SELECT 1 FROM products WHERE id = $1
                   AND (COALESCE(is_chat_plan, false) = true OR COALESCE(is_story_plan, false) = true)`,
                [productId]
            );
            if (pp) productId = null;
        }
        let has = await ownsExploreProduct(email, productId);
        if (!has) has = await ownsExploreByOffers(email, cfg.unlock_offer_codes);
        if (!has) has = await isPremiumCustomer(email);
        return has;
    } catch (_) { return false; }
}

// Info de desbloqueio (produto + planos) pro paywall do Explorar
async function loadExploreUnlock(productId, checkoutUrl) {
    const info = { product_id: productId || null, checkout_url: checkoutUrl || null, name: null, price: null, banner_url: null, plans: [] };
    if (productId) {
        try {
            const { rows } = await db.query(`SELECT id, name, price, banner_url FROM products WHERE id = $1 LIMIT 1`, [productId]);
            if (rows.length) { info.name = rows[0].name; info.price = rows[0].price; info.banner_url = rows[0].banner_url; }
            const { rows: plans } = await db.query(
                `SELECT name, price, original_price, badge, benefits, checkout_url, is_recommended
                 FROM product_plans WHERE product_id = $1 AND active = true ORDER BY display_order, id`, [productId]
            );
            info.plans = plans;
        } catch (_) {}
    }
    return info;
}

// Plano PREMIUM (product_plans.is_premium) — oferecido nos paywalls de
// vídeos/status como a opção "leve tudo" ao lado do preço avulso.
async function loadPremiumPlan() {
    try {
        const { rows } = await db.query(
            `SELECT pp.name, pp.price, pp.original_price, pp.badge, pp.benefits, pp.checkout_url,
                    pp.product_id
             FROM product_plans pp
             JOIN products p ON p.id = pp.product_id
             WHERE pp.is_premium = true AND pp.active = true AND p.is_active = true
             ORDER BY pp.id LIMIT 1`
        );
        const plan = rows.length ? rows[0] : null;
        // Sem link no plano → herda o da oferta Premium (product_offers.is_premium)
        if (plan && !plan.checkout_url) {
            try {
                const { rows: [off] } = await db.query(
                    `SELECT checkout_url FROM product_offers
                     WHERE product_id = $1 AND is_active = true AND COALESCE(is_premium, false) = true
                       AND checkout_url IS NOT NULL
                     ORDER BY priority DESC, id LIMIT 1`,
                    [plan.product_id]
                );
                if (off) plan.checkout_url = off.checkout_url;
            } catch (_) {}
        }
        if (plan && plan.checkout_url) return plan;
        // FALLBACK: nenhum plano marcado no painel — monta a opção Premium
        // direto da OFERTA marcada com * (nome/preço/link dela). Assim o dono
        // só precisa do * pra tudo funcionar; o plano refinado é opcional.
        try {
            const { rows: [off2] } = await db.query(
                `SELECT po.checkout_url, po.price, po.offer_name, po.product_id
                 FROM product_offers po
                 JOIN products p ON p.id = po.product_id
                 WHERE COALESCE(po.is_premium, false) = true AND po.is_active = true
                   AND po.checkout_url IS NOT NULL AND p.is_active = true
                 ORDER BY po.id LIMIT 1`
            );
            if (off2) {
                return {
                    name: off2.offer_name || 'PREMIUM',
                    price: off2.price,
                    original_price: null,
                    badge: null,
                    benefits: null,
                    checkout_url: off2.checkout_url,
                    product_id: off2.product_id,
                };
            }
        } catch (_) {}
        return null;
    } catch (_) { return null; }
}

// ── Status do plano + opções de upgrade (bloco "Seu plano" do Perfil) ────────
// current: 'free' | 'vip' | 'premium'. vip_plan/premium_plan = planos de venda
// do produto do chat (pro CTA de upgrade — free vê os dois, VIP só o Premium).
router.get('/plan-status', requireUser, async (req, res) => {
    const empty = { success: true, current: 'free', expires_at: null, group_bonus_until: null, vip_plan: null, premium_plan: null };
    try {
        const email = req.user.email;
        let current = 'free', expiresAt = null, bonusUntil = null;
        try {
            if (await isPreviewEmail(email)) current = 'premium';
        } catch (_) {}
        if (current === 'free') {
            const myPlans = await loadUserPlans(email);
            const chatPlan = myPlans.find(p => p.kind === 'premium' || p.kind === 'vip') || null;
            if (chatPlan) {
                current = chatPlan.kind;
                expiresAt = chatPlan.expires_at;
                bonusUntil = chatPlan.group_bonus_until;
            }
        }
        let vipPlan = null, premiumPlan = null;
        const { rows: [chatProd] } = await db.query(
            `SELECT id FROM products WHERE is_chat_plan = true AND is_active = true ORDER BY id LIMIT 1`
        );
        if (chatProd) {
            const { rows: pl } = await db.query(
                `SELECT name, price, original_price, badge, benefits, checkout_url, is_premium
                 FROM product_plans WHERE product_id = $1 AND active = true ORDER BY display_order, id`,
                [chatProd.id]
            );
            premiumPlan = pl.find(p => p.is_premium) || null;
            vipPlan = pl.find(p => !p.is_premium) || null;
            // Plano sem link próprio herda o link da OFERTA correspondente do
            // produto (a oferta Premium é a marcada com is_premium)
            try {
                const { rows: offs } = await db.query(
                    `SELECT checkout_url, COALESCE(is_premium, false) AS is_premium
                     FROM product_offers
                     WHERE product_id = $1 AND is_active = true AND checkout_url IS NOT NULL
                     ORDER BY priority DESC, id`,
                    [chatProd.id]
                );
                const premOff = offs.find(o => o.is_premium) || null;
                const vipOff = offs.find(o => !o.is_premium) || null;
                if (premiumPlan && !premiumPlan.checkout_url && premOff) premiumPlan.checkout_url = premOff.checkout_url;
                if (vipPlan && !vipPlan.checkout_url && vipOff) vipPlan.checkout_url = vipOff.checkout_url;
            } catch (_) {}
            if (premiumPlan && !premiumPlan.checkout_url) premiumPlan = null;
            if (vipPlan && !vipPlan.checkout_url) vipPlan = null;
            // FALLBACKS quando não há plano cadastrado/marcado: monta direto
            // das ofertas do produto (Premium = oferta com *, VIP = sem *)
            if (!premiumPlan) premiumPlan = await loadPremiumPlan();
            if (!vipPlan) {
                try {
                    const { rows: [voff] } = await db.query(
                        `SELECT checkout_url, price, offer_name FROM product_offers
                         WHERE product_id = $1 AND is_active = true
                           AND COALESCE(is_premium, false) = false AND checkout_url IS NOT NULL
                         ORDER BY priority DESC, id LIMIT 1`,
                        [chatProd.id]
                    );
                    if (voff) vipPlan = { name: voff.offer_name || 'VIP', price: voff.price, original_price: null, badge: null, benefits: null, checkout_url: voff.checkout_url, is_premium: false };
                } catch (_) {}
            }
        }
        return res.json({
            success: true,
            current,
            expires_at: expiresAt,
            group_bonus_until: bonusUntil,
            vip_plan: vipPlan,
            premium_plan: premiumPlan,
        });
    } catch (_) { return res.json(empty); }
});

// ── UPGRADE ENTRE PLANOS (pague só a diferença) ──────────────────────────────
// Regras no painel (gamification_config.upgrade_rules): [{ has_product_id,
// not_if_product_id, offer_label, offer_text, checkout_url, target_name }].
// Avalia NA ORDEM e devolve a PRIMEIRA regra em que o cliente TEM o produto
// has_product_id ativo E NÃO tem o not_if_product_id (o plano-alvo). O card
// aparece no topo de "Minhas Compras"; o checkout é o da DIFERENÇA, cadastrado
// como oferta extra do produto-alvo — o webhook entrega o plano novo sozinho.
router.get('/upgrade-offer', requireUser, async (req, res) => {
    try {
        const email = String(req.user.email || '').toLowerCase().trim();
        if (!email) return res.json({ success: true, offer: null });
        const { rows } = await db.query(`SELECT value FROM gamification_config WHERE key = 'upgrade_rules'`);
        const rules = Array.isArray(rows[0]?.value?.rules) ? rows[0].value.rules : [];
        if (!rules.length) return res.json({ success: true, offer: null });
        const { rows: acc } = await db.query(
            `SELECT DISTINCT product_id FROM user_access
             WHERE LOWER(email) = $1 AND status = 'active'
               AND (expires_at IS NULL OR expires_at > NOW())`,
            [email]
        );
        const owned = new Set(acc.map(r => r.product_id));
        for (const r of rules) {
            if (!r) continue;
            const has = parseInt(r.has_product_id, 10) || null;
            const notIf = parseInt(r.not_if_product_id, 10) || null;
            const checkout = String(r.checkout_url || '').trim();
            if (!has || !checkout) continue;
            if (!owned.has(has)) continue;
            if (notIf && owned.has(notIf)) continue;
            return res.json({
                success: true,
                offer: {
                    offer_label: String(r.offer_label || 'Suba de plano pagando só a diferença').slice(0, 120),
                    offer_text: String(r.offer_text || '').slice(0, 400),
                    checkout_url: checkout.slice(0, 1000),
                    target_name: r.target_name ? String(r.target_name).slice(0, 80) : null,
                },
            });
        }
        return res.json({ success: true, offer: null });
    } catch (_) { return res.json({ success: true, offer: null }); }
});

// PIX PENDENTE do cliente pra um produto: alimenta o popup "termina de pagar
// seu Pix" (em vez de oferecer checkout novo pra quem JÁ gerou o código).
// Validade de exibição: 30 minutos a partir do webhook de pendente.
const PIX_PENDING_MINUTES = 30;
// Compra confirmada? Checa a posse de UM produto (inclui os OCULTOS do
// catálogo, como o plano do chat/status). Usado pela tela de sucesso (?paid=)
// pra só afirmar "acesso liberado" quando o webhook realmente gravou o acesso.
router.get('/access/check', requireUser, async (req, res) => {
    const pid = parseInt(req.query.product_id, 10);
    if (!pid) return res.json({ success: true, owned: false });
    try {
        const e = String(req.user.email || '').toLowerCase().trim();
        const { rows } = await db.query(
            `SELECT 1 FROM user_access
              WHERE LOWER(email) = $1 AND product_id = $2 AND status = 'active'
                AND (expires_at IS NULL OR expires_at > NOW())
             UNION ALL
             SELECT 1 FROM gifts
              WHERE LOWER(email) = $1 AND product_id = $2 AND status = 'active'
                AND (expires_at IS NULL OR expires_at > NOW())
             LIMIT 1`,
            [e, pid]
        );
        return res.json({ success: true, owned: rows.length > 0 });
    } catch (_) { return res.json({ success: true, owned: false }); }
});

router.get('/pix/pending', optionalUser, async (req, res) => {
    try {
        const email = req.user?.email || null;
        const productId = parseInt(req.query.product_id, 10) || null;
        if (!email) return res.json({ success: true, pending: null });
        // Preferência: Pix do MESMO produto do popup. FALLBACK: o último Pix
        // pendente do cliente, seja de qual produto for — na prática o lead
        // só tem um por vez, e o produto do código da oferta pode não ser o
        // mesmo configurado na aba (ex.: Vídeos apontando pra outro produto).
        const { rows } = await db.query(
            `SELECT n.pix_code, n.amount, n.product_id, p.name AS product_name,
                    GREATEST(0, ${PIX_PENDING_MINUTES * 60} - EXTRACT(EPOCH FROM (NOW() - n.created_at)))::int AS expires_in_s
             FROM pix_pending_notices n
             LEFT JOIN products p ON p.id = n.product_id
             WHERE LOWER(n.customer_email) = $1
               AND n.pix_code IS NOT NULL
               AND n.created_at > NOW() - INTERVAL '${PIX_PENDING_MINUTES} minutes'
             ORDER BY (n.product_id = $2) DESC NULLS LAST, n.id DESC
             LIMIT 1`,
            [email.toLowerCase().trim(), productId]
        );
        if (!rows.length) return res.json({ success: true, pending: null });
        return res.json({
            success: true,
            pending: {
                pix_code: rows[0].pix_code,
                amount: rows[0].amount != null ? parseFloat(rows[0].amount) : null,
                product_name: rows[0].product_name || null,
                expires_in_s: rows[0].expires_in_s,
            },
        });
    } catch (err) {
        return res.json({ success: true, pending: null });
    }
});

// Checagem LEVE de acesso ao Explorar (sem montar o feed). O app consulta isso
// enquanto o paywall está aberto pra destravar SOZINHO assim que o webhook da
// compra liberar o acesso (sem o cliente precisar fechar/reabrir o app).
router.get('/explore/access', optionalUser, async (req, res) => {
    try {
        const cfgRow = await db.query(`SELECT value FROM gamification_config WHERE key = 'explore_config'`).catch(() => ({ rows: [] }));
        const cfg = cfgRow.rows[0]?.value || {};
        let productId = cfg.product_id ? parseInt(cfg.product_id, 10) : null;
        // Mesmo guarda do feed: produto interno do chat/status não conta
        if (productId) {
            try {
                const { rows: [pp] } = await db.query(
                    `SELECT 1 FROM products WHERE id = $1
                       AND (COALESCE(is_chat_plan, false) = true OR COALESCE(is_story_plan, false) = true)`,
                    [productId]
                );
                if (pp) productId = null;
            } catch (_) {}
        }
        const email = req.user?.email || null;
        let hasAccess = await ownsExploreProduct(email, productId);
        if (!hasAccess) hasAccess = await ownsExploreByOffers(email, cfg.unlock_offer_codes);
        if (!hasAccess) hasAccess = await isPremiumCustomer(email);
        return res.json({ success: true, has_access: hasAccess });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// Copy nova do paywall dos vídeos (jul/2026): sem "vitalício" (o acesso não
// é) e vendendo o que importa — tudo liberado + conteúdo novo todo dia.
// Config antiga salva no painel com os textos LEGADOS é migrada na leitura.
const EXPLORE_PW_TITLE = 'Isso foi só a amostra 🔥';
const EXPLORE_PW_TEXT = 'Acesso TOTAL a todos os vídeos, sem limite nenhum — com conteúdo novo entrando todo dia. Os mais quentes ficam do outro lado.';
const EXPLORE_PW_NOTE = 'liberação imediata após o pagamento';
const EXPLORE_LEGACY = {
    'Você já viu o grátis 🔥': EXPLORE_PW_TITLE,
    'Libera o feed completo agora — sem limite.': EXPLORE_PW_TEXT,
    'Libera o feed completo agora — sem limite. As que mais bombam tão te esperando do outro lado.': EXPLORE_PW_TEXT,
    'acesso vitalício · 1 pagamento': EXPLORE_PW_NOTE,
};
function explorePwCopy(saved, fallback) {
    const v = (saved == null ? '' : String(saved)).trim();
    if (!v) return fallback;
    return EXPLORE_LEGACY[v] || v;
}

// Identidade do Explorar: e-mail logado ou visitante anônimo (mv_chat_visitor)
function exploreIdentity(req) {
    const email = String(req.user?.email || '').toLowerCase().trim();
    if (email && !email.endsWith('@preview.local')) return email;
    const raw = String(req.query?.visitor_id || req.body?.visitor_id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    return raw ? 'v:' + raw : null;
}

// POST /explore/seen {ids:[...]} — marca vídeos assistidos NO SERVIDOR.
// O contador do grátis deixa de ser só localStorage: trocar de celular ou
// limpar o navegador não zera mais o limite (a trava segue a pessoa).
router.post('/explore/seen', optionalUser, async (req, res) => {
    try {
        const ident = exploreIdentity(req);
        if (!ident) return res.json({ success: true });
        let ids = Array.isArray(req.body?.ids) ? req.body.ids : (req.body?.id != null ? [req.body.id] : []);
        ids = ids.map(v => String(v).slice(0, 90)).filter(Boolean).slice(0, 300);
        if (!ids.length) return res.json({ success: true });
        await db.query(
            `INSERT INTO explore_seen (identity, video_id)
             SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
            [ident, ids]
        );
        return res.json({ success: true });
    } catch (_) { return res.json({ success: true }); }
});

router.get('/explore/feed', optionalUser, async (req, res) => {
    try {
        const cfgRow = await db.query(`SELECT value FROM gamification_config WHERE key = 'explore_config'`).catch(() => ({ rows: [] }));
        const cfg = cfgRow.rows[0]?.value || {};
        const freeLimit = Number.isFinite(+cfg.free_limit) ? Math.max(0, parseInt(cfg.free_limit, 10)) : 15;
        const pwaGateAfter = Number.isFinite(+cfg.pwa_gate_after) ? Math.max(0, parseInt(cfg.pwa_gate_after, 10)) : 2;
        let productId = cfg.product_id ? parseInt(cfg.product_id, 10) : null;
        // Produto INTERNO (chat/status) nunca é "o produto dos vídeos": sem
        // este guarda, o código do Premium na lista resolvia o produto do chat
        // aqui e o VIP (mesmo produto!) ganhava o feed inteiro de graça.
        if (productId) {
            try {
                const { rows: [pp] } = await db.query(
                    `SELECT 1 FROM products WHERE id = $1
                       AND (COALESCE(is_chat_plan, false) = true OR COALESCE(is_story_plan, false) = true)`,
                    [productId]
                );
                if (pp) productId = null;
            } catch (_) {}
        }
        // Sem produto configurado mas COM códigos de oferta: resolve o produto
        // pelo primeiro código NÃO-interno — garante unlock.product_id pro
        // popup do Pix pendente funcionar mesmo nessa configuração.
        if (!productId) {
            const codes = parseOfferCodes(cfg.unlock_offer_codes);
            if (codes.length) {
                try {
                    const { rows: [po] } = await db.query(
                        `SELECT po.product_id FROM product_offers po
                         JOIN products p ON p.id = po.product_id
                         WHERE po.offer_id = ANY($1::text[]) AND po.product_id IS NOT NULL
                           AND COALESCE(p.is_chat_plan, false) = false
                           AND COALESCE(p.is_story_plan, false) = false
                         LIMIT 1`,
                        [codes]
                    );
                    if (po) productId = po.product_id;
                } catch (_) {}
            }
        }
        const email = req.user?.email || null;
        let hasAccess = await ownsExploreProduct(email, productId);
        if (!hasAccess) hasAccess = await ownsExploreByOffers(email, cfg.unlock_offer_codes);
        // Premium leva os vídeos por definição (VIP não)
        if (!hasAccess) hasAccess = await isPremiumCustomer(email);

        // Pasta (coleção) do Bunny tem prioridade; senão, a lista manual de vídeos.
        let videos;
        if (cfg.collection_library_id && cfg.collection_id) {
            videos = await resolveExploreCollection(cfg);
        } else {
            const { rows } = await db.query(
                `SELECT id, caption, creator_name, video_url, bunny_library_id, bunny_video_id, hls_url, thumbnail_url, likes_seed
                 FROM explore_videos WHERE active = true ORDER BY position, id LIMIT 200`
            );
            videos = rows.map(resolveExploreVideo);
        }

        // Quem NÃO tem acesso recebe SÓ os vídeos do grátis. Antes o JSON
        // entregava as URLs jogáveis dos 200 vídeos e o corte era só visual no
        // app — qualquer curioso com DevTools levava o feed VIP inteiro.
        const totalCount = videos.length;
        if (!hasAccess) videos = videos.slice(0, freeLimit);

        // O que esta PESSOA já assistiu (servidor — segue o e-mail/visitante)
        let watchedIds = [];
        try {
            const ident = exploreIdentity(req);
            if (ident) {
                const { rows: seenRows } = await db.query(
                    `SELECT video_id FROM explore_seen WHERE identity = $1 LIMIT 3000`, [ident]
                );
                watchedIds = seenRows.map(r => r.video_id);
            }
        } catch (_) {}

        return res.json({
            success: true,
            enabled: cfg.enabled === true,
            has_access: hasAccess,
            free_limit: freeLimit,
            pwa_gate_after: pwaGateAfter,
            paywall: {
                title: explorePwCopy(cfg.paywall_title, EXPLORE_PW_TITLE),
                text: explorePwCopy(cfg.paywall_text, EXPLORE_PW_TEXT),
                cta: cfg.paywall_cta || 'QUERO ACESSO VIP',
                offer_price: cfg.offer_price != null ? cfg.offer_price : 19.90,
                offer_original_price: cfg.offer_original_price != null ? cfg.offer_original_price : 49.90,
                offer_note: explorePwCopy(cfg.offer_note, EXPLORE_PW_NOTE),
            },
            unlock: hasAccess ? null : await loadExploreUnlock(productId, cfg.checkout_url || null),
            // Opção "leve tudo": o plano Premium aparece no paywall dos vídeos
            // junto do preço avulso (chat + status + vídeos num pagamento só)
            premium_plan: hasAccess ? null : await loadPremiumPlan(),
            total_count: totalCount,
            watched_ids: watchedIds,
            videos,
        });
    } catch (err) {
        logger.error('Erro no feed Explorar:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// =============================================================================
// TRACKING — clientes enviam eventos de comportamento
// =============================================================================
// POST /api/user/track/view  — view de produto (popula product_views)
// POST /api/user/track/event — evento genérico (cta_click, scroll_end, etc)
// Endpoints aceitam não-logados também (anônimos).

router.post('/track/view', optionalUser, async (req, res) => {
    try {
        const { product_id, duration_seconds, clicked_buy, clicked_access } = req.body || {};
        const email = req.user?.email || null;
        const pid = parseInt(product_id, 10);
        if (!pid) return res.status(400).json({ success: false, error: 'product_id obrigatório' });

        await db.query(`
            INSERT INTO product_views (product_id, customer_email, has_access, duration_seconds, clicked_buy, clicked_access)
            VALUES ($1, $2, $3, $4, $5, $6)
        `, [pid, email, false, parseInt(duration_seconds, 10) || 0, !!clicked_buy, !!clicked_access]);
        return res.json({ success: true });
    } catch (err) {
        logger.error('track/view falhou:', err);
        return res.json({ success: false });
    }
});

router.post('/track/event', optionalUser, async (req, res) => {
    try {
        const { type, product_id, metadata } = req.body || {};
        if (!type || typeof type !== 'string') return res.status(400).json({ success: false, error: 'type obrigatório' });
        const email = req.user?.email || null;
        const pid = product_id ? parseInt(product_id, 10) : null;
        const meta = (metadata && typeof metadata === 'object') ? metadata : {};

        await db.query(`
            INSERT INTO tracking_events (event_type, customer_email, product_id, metadata)
            VALUES ($1, $2, $3, $4)
        `, [String(type).slice(0, 60), email, pid, meta]);
        return res.json({ success: true });
    } catch (err) {
        logger.error('track/event falhou:', err);
        return res.json({ success: false });
    }
});


// =============================================================================
// PUSH SUBSCRIPTIONS (Web Push API)
// =============================================================================

router.post('/push/subscribe', optionalUser, async (req, res) => {
    try {
        const { endpoint, keys, userAgent } = req.body || {};
        if (!endpoint || !keys?.p256dh || !keys?.auth) {
            return res.status(400).json({ success: false, error: 'subscription inválida' });
        }
        const email = req.user?.email || null;
        await db.query(`
            INSERT INTO push_subscriptions (customer_email, endpoint, p256dh, auth, user_agent, last_used_at)
            VALUES ($1, $2, $3, $4, $5, NOW())
            ON CONFLICT (endpoint) DO UPDATE
            SET customer_email = COALESCE(EXCLUDED.customer_email, push_subscriptions.customer_email),
                p256dh = EXCLUDED.p256dh,
                auth = EXCLUDED.auth,
                user_agent = EXCLUDED.user_agent,
                last_used_at = NOW()
        `, [email, endpoint, keys.p256dh, keys.auth, (userAgent || '').slice(0, 300)]);

        // SEQUÊNCIA DE BOAS-VINDAS (1x por e-mail): instalou + permitiu
        // notificação → agenda os passos da install_push_steps (+5min/+1h/+3h,
        // editáveis no painel) na fila do push-worker e manda a mensagem de
        // boas-vindas no chat de Suporte. Compra aprovada cancela o restante
        // (sales-processor já cancela os pushes pendentes do e-mail).
        if (email) scheduleInstallSequence(email).catch(() => {});

        return res.json({ success: true });
    } catch (err) {
        logger.error('push/subscribe falhou:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// Agenda a sequência pós-instalação. Trava install_sequence_sent garante 1x
// por e-mail (re-subscribe, troca de aparelho ou reinstalação não duplicam).
async function scheduleInstallSequence(email) {
    const e = String(email).toLowerCase().trim();
    const { rows: claim } = await db.query(
        `INSERT INTO install_sequence_sent (email) VALUES ($1) ON CONFLICT (email) DO NOTHING RETURNING email`,
        [e]
    );
    if (!claim.length) return; // já rodou pra este e-mail
    try {
        const { rows: steps } = await db.query(
            `SELECT * FROM install_push_steps WHERE active = true ORDER BY delay_minutes, id`
        );
        for (const s of steps) {
            await db.query(
                `INSERT INTO funnel_scheduled_pushes (customer_email, title, message, url, icon_url, send_at, install_step_id)
                 VALUES ($1, $2, $3, $4, $5, NOW() + make_interval(mins => $6), $7)`,
                [e, s.title, s.body || '', s.url || '/', s.icon_url || null, Math.max(1, s.delay_minutes | 0), s.id]
            );
        }
    } catch (err) { logger.warn('sequência pós-instalação falhou: ' + err.message); }
    // Boas-vindas no chat de Suporte (welcome_enabled na Central de Suporte)
    try {
        const chatsApi = require('./user-chats');
        if (typeof chatsApi.deliverInstallWelcome === 'function') await chatsApi.deliverInstallWelcome(e);
    } catch (err) { logger.warn('boas-vindas do suporte falhou: ' + err.message); }
}

// Beacon do RELATÓRIO de notificações (vem do service worker, sem auth):
// kind='delivered' quando a notificação foi EXIBIDA no aparelho;
// kind='opened' quando o cliente CLICOU nela. Incrementa a push_log.
router.post('/push/ack', async (req, res) => {
    try {
        const pid = parseInt(req.body?.pid, 10);
        const kind = req.body?.kind === 'opened' ? 'opened' : (req.body?.kind === 'delivered' ? 'delivered' : null);
        if (!pid || !kind) return res.json({ success: true });
        const col = kind === 'opened' ? 'opened' : 'delivered';
        await db.query(`UPDATE push_log SET ${col} = ${col} + 1 WHERE id = $1`, [pid]);
        return res.json({ success: true });
    } catch (_) {
        return res.json({ success: true });
    }
});

router.post('/push/unsubscribe', async (req, res) => {
    try {
        const { endpoint } = req.body || {};
        if (!endpoint) return res.status(400).json({ success: false, error: 'endpoint obrigatório' });
        await db.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [endpoint]);
        return res.json({ success: true });
    } catch (err) {
        return res.json({ success: true });
    }
});

// GET /api/user/push/vapid-key — chave pública pra subscription do client
router.get('/push/vapid-key', async (req, res) => {
    try {
        const { rows } = await db.query(`SELECT value FROM system_settings WHERE key = 'vapid_public_key'`);
        const pub = rows[0]?.value;
        if (!pub) return res.json({ success: false, error: 'Push ainda não configurado' });
        // value é JSONB — pode ser string com aspas
        const key = typeof pub === 'string' ? pub.replace(/^"|"$/g, '') : pub;
        return res.json({ success: true, publicKey: key });
    } catch (err) {
        return res.json({ success: false });
    }
});


// =============================================================================
// PREVIEW ANÔNIMO — sessão temporária pra modo funíl (sem email real)
// =============================================================================
//
// Quando cliente abre /f/SLUG, frontend chama esse endpoint pra ter uma
// "sessão fake" só pro app funcionar (gamificação, perfil, etc. não quebram).
// Esse usuário não tem acesso a produtos e NÃO aparece em métricas.
//

// Agenda as etapas tipo 'push' do funil pro e-mail que converteu.
// O worker (lib/push-worker.js) envia no horário — chega com o app FECHADO.
// Idempotente: índice único (step_id, email) impede fila duplicada se o lead
// converter duas vezes. E-mails anônimos (@preview.local) nunca entram na fila.
async function scheduleFunnelPushes(slug, email) {
    const s = String(slug || '').toLowerCase().slice(0, 80);
    const e = String(email || '').toLowerCase().trim().slice(0, 255);
    if (!s || !e || e.endsWith('@preview.local')) return;
    try {
        // 'push' SEMPRE é do servidor. 'notification' e 'chat' também ganham um
        // push de fallback (chega com o app fechado); se o app estiver aberto, o
        // runner in-app já mostra o banner — o push só reativa quem saiu.
        // MODO FILA: send_at usa o delay ACUMULADO (soma das etapas anteriores),
        // calculado sobre TODAS as etapas ativas em ordem — bate com o /sequence.
        await db.query(`
            WITH ordered AS (
                SELECT fs.*,
                       SUM(GREATEST(COALESCE(fs.delay_seconds,0),0))
                           OVER (ORDER BY fs.step_order, fs.id
                                 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum_delay
                FROM funnel_steps fs
                JOIN funnels f ON f.id = fs.funnel_id
                WHERE f.slug = $1 AND f.active = true AND fs.active = true
            )
            INSERT INTO funnel_scheduled_pushes (funnel_id, step_id, customer_email, title, message, url, send_at)
            SELECT s.funnel_id, s.id, $2,
                   CASE WHEN s.type = 'chat' THEN COALESCE(ch.name, 'Mensagem nova')
                        ELSE COALESCE(s.title, 'Novidade pra você') END,
                   CASE WHEN s.type = 'chat' THEN COALESCE(NULLIF(s.message, ''), 'enviou uma mensagem pra você')
                        ELSE s.message END,
                   COALESCE(
                       s.link_url,
                       CASE WHEN s.product_id IS NOT NULL THEN '/?p=' || s.product_id
                            WHEN s.chat_id IS NOT NULL THEN '/?chat=' || s.chat_id ELSE NULL END
                   ),
                   NOW() + make_interval(secs => s.cum_delay)
            FROM ordered s
            LEFT JOIN chats ch ON ch.id = s.chat_id
            WHERE s.type IN ('push', 'notification', 'chat')
            ON CONFLICT DO NOTHING
        `, [s, e]);
    } catch (err) {
        logger.warn('scheduleFunnelPushes falhou: ' + err.message);
    }
}

// POST /api/user/login/promote — converte sessão anônima em email real
// Body: { email, skipSuggestion?, funnel_slug? }
// Igual ao /login normal, mas registra origem do funíl pra tracking.
router.post('/login/promote', async (req, res) => {
    const { email, skipSuggestion, funnel_slug, campanha, visitor_id } = req.body || {};
    if (!email) return res.status(400).json({ success: false, error: 'Email obrigatório' });
    try {
        let result;
        if (skipSuggestion) {
            result = await forceLoginWithoutSuggestion(email);
        } else {
            result = await loginClient(email);
        }
        if (!result.success) {
            return res.json(result);
        }
        // Vincula a conversa ANÔNIMA (visitor_id) ao e-mail agora — assim, mesmo
        // que o cliente instale o PWA (storage novo), logado com o mesmo e-mail a
        // conversa é encontrada e CONTINUA de onde parou (não reseta do zero).
        const vid = String(visitor_id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
        if (vid) {
            try {
                await db.query(
                    `UPDATE chat_sessions SET customer_email = $1, updated_at = NOW()
                     WHERE visitor_id = $2 AND customer_email IS NULL`,
                    [String(result.email).toLowerCase(), vid]
                );
            } catch (_) { /* tabela de chat pode não existir em banco antigo */ }
            // Vídeos assistidos como anônimo passam pro e-mail (o contador do
            // grátis segue a pessoa, não o aparelho)
            try {
                await db.query(
                    `INSERT INTO explore_seen (identity, video_id)
                     SELECT $1, video_id FROM explore_seen WHERE identity = $2
                     ON CONFLICT DO NOTHING`,
                    [String(result.email).toLowerCase(), 'v:' + vid]
                );
            } catch (_) {}
        }
        // Login OK — registra origem do funíl
        if (funnel_slug) {
            try {
                await db.query(`
                    UPDATE funnel_visits
                    SET converted = true, converted_at = NOW(), customer_email = $2
                    WHERE funnel_slug = $1
                      AND id = (
                        SELECT id FROM funnel_visits
                        WHERE funnel_slug = $1 AND (converted = false OR customer_email IS NULL)
                        ORDER BY visited_at DESC LIMIT 1
                      )
                `, [String(funnel_slug).toLowerCase().slice(0,80), result.email]);
            } catch(_) {}
            // Lead capturado → agenda os pushes server-side do funil
            await scheduleFunnelPushes(funnel_slug, result.email);
        }
        res.cookie(USER_COOKIE_NAME, result.token, USER_COOKIE_OPTIONS);

        // Fase K2: mesma lógica do /login — resgata campanha se houver
        // código pendente vindo do localStorage do cliente.
        const campaignResult = await tryRedeemCampaign(campanha, result.email, req);

        // PIXEL META — evento Lead (o lead deu o e-mail = capturado). O CAPI
        // sai DAQUI (servidor, com e-mail hasheado + etiqueta do clique — nada
        // de bloqueador mata) e o event_id volta na resposta pro app disparar
        // o fbq('Lead') IGUAL → o Meta deduplica os dois em 1 evento rico.
        let metaLead = null;
        try {
            const metaPix = require('../lib/meta-pixel');
            const cfg = await metaPix.loadMetaConfig();
            if (cfg.enabled && cfg.pixel_id && cfg.ev_lead) {
                const attr = await metaPix.findAttribution({ visitorId: vid, email: result.email });
                if (vid || attr) {
                    metaPix.upsertAttribution({ visitorId: vid, email: result.email }).catch(() => {});
                }
                const eventId = 'lead_' + require('crypto').randomBytes(8).toString('hex');
                metaLead = { event_id: eventId };
                if (cfg.capi_token) {
                    metaPix.sendCapiEvents([{
                        event_name: 'Lead',
                        event_id: eventId,
                        user_data: metaPix.buildUserData({
                            email: result.email,
                            ip: require('../lib/device-check').getIp(req),
                            userAgent: req.headers['user-agent'],
                            fbp: attr && attr.fbp,
                            fbc: (attr && attr.fbc) || (attr && attr.fbclid
                                ? metaPix.fbcFromFbclid(attr.fbclid, attr.updated_at ? new Date(attr.updated_at).getTime() : null)
                                : null),
                            externalId: vid,
                        }),
                    }]).catch(() => {});
                }
            }
        } catch (_) { /* rastreio nunca quebra o login */ }

        return res.json({
            success: true,
            email: result.email,
            productsCount: result.productsCount,
            campaign: campaignResult,
            meta_lead: metaLead,
        });
    } catch (err) {
        logger.error('Erro em /login/promote:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// ─── GET /api/user/campaign/:code (PÚBLICO, sem auth) ────────────────────────
// Fase K2 — preview da campanha pra mostrar na tela de login.
// "Você foi convidado pra: 'Promo Telegram' — receba 24h de XYZ"
// Sem dados sensíveis (não retorna max_redemptions absoluto, nem redemptions_count).
//
// Devolve sempre 200 (mesmo se inativa/inexistente) com `found` e `active`
// pro frontend renderizar a mensagem certa. Em erro de servidor: null.
router.get('/campaign/:code', async (req, res) => {
    const code = (req.params.code || '').toLowerCase().trim().slice(0, 40);
    if (!code) return res.json({ success: true, campaign: { found: false } });
    try {
        const info = await getCampaignPublicInfo(code);
        return res.json({ success: true, campaign: info || { found: false } });
    } catch (err) {
        logger.warn(`/campaign/:code erro: ${err.message}`);
        return res.json({ success: true, campaign: { found: false } });
    }
});


router.post('/login/anon', async (req, res) => {
    try {
        const slug = (req.body?.funnel_slug || '').toLowerCase().slice(0, 80) || null;
        const rand = require('crypto').randomBytes(8).toString('hex');
        const anonEmail = 'anon_' + rand + '@preview.local';
        // Token JWT igual ao login normal, mas marcado como anônimo
        const jwt = require('jsonwebtoken');
        const token = jwt.sign(
            { email: anonEmail, type: 'user_anon', funnel: slug },
            process.env.JWT_SECRET + ':user',
            { expiresIn: '2h' }
        );
        res.cookie(USER_COOKIE_NAME, token, USER_COOKIE_OPTIONS);
        return res.json({ success: true, email: anonEmail, anonymous: true, funnel: slug });
    } catch (err) {
        logger.error('Erro em /login/anon:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// =============================================================================
// FUNÍS — landing customizada por link
// =============================================================================

// GET /api/user/funnel/:slug — dados públicos da landing
// POST /api/user/pressel/click — clique na pressel (o toque que dispara o
// breakout pro Chrome). Enviado via sendBeacon antes da navegação.
router.post('/pressel/click', async (req, res) => {
    const slug = String(req.body?.funnel_slug || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 80);
    try {
        await db.query(
            `INSERT INTO tracking_events (event_type, metadata) VALUES ('pressel_click', $1::jsonb)`,
            [JSON.stringify({ funnel_slug: slug })]
        );
    } catch (_) {}
    return res.json({ success: true });
});

router.get('/funnel/:slug', async (req, res) => {
    const slug = String(req.params.slug || '').toLowerCase().slice(0, 80);
    if (!slug) return res.status(400).json({ success: false, error: 'Slug inválido' });
    try {
        const { rows } = await db.query(`
            SELECT f.id, f.slug, f.name, f.description,
                   f.featured_product_id, f.video_call_id, f.pressel_config,
                   f.entry_type, f.entry_product_id, f.entry_category_id, f.entry_chat_id, f.entry_group_id,
                   c.slug AS entry_category_slug, c.name AS entry_category_name,
                   p.id AS product_id, p.name AS product_name,
                   p.description AS product_description, p.banner_url AS product_banner,
                   p.price AS product_price,
                   v.id AS call_id, v.slug AS call_slug, v.category AS call_category,
                   v.model_name AS call_model_name, v.model_photo AS call_model_photo,
                   v.video_url AS call_video_url, v.redirect_link AS call_redirect_link,
                   v.cta_text AS call_cta_text, v.trigger_delay_sec AS call_trigger_delay_sec,
                   COALESCE(v.cta_type, 'home') AS call_cta_type, v.cta_target_id AS call_cta_target_id
            FROM funnels f
            LEFT JOIN products p ON p.id = f.featured_product_id AND p.is_active = true
            LEFT JOIN categories c ON c.id = f.entry_category_id
            LEFT JOIN video_calls v ON v.id = f.video_call_id AND v.active = true
            WHERE f.slug = $1 AND f.active = true
            LIMIT 1
        `, [slug]);
        if (!rows.length) return res.json({ success: true, funnel: null });
        const r = rows[0];
        // Comportamento do funil (guardado em pressel_config): trava de chat,
        // atraso do Status/Lives e quando pedir e-mail. Defaults = tudo desligado
        // (funis antigos seguem idênticos).
        const pc = r.pressel_config || {};
        const behavior = {
            lock_chat: pc.lock_chat === true,
            status_delay_sec: Math.max(0, Math.min(600, parseInt(pc.status_delay_sec, 10) || 0)),
            email_gate: pc.email_gate === 'purchase' ? 'purchase' : 'default',
            force_install: pc.force_install === true,
        };
        const funnel = {
            id: r.id, slug: r.slug, name: r.name, description: r.description,
            behavior,
            // Destino de entrada: o app navega pra cá assim que o catálogo carrega
            entry: {
                type: r.entry_type || 'home',
                product_id: r.entry_product_id || null,
                category_id: r.entry_category_id || null,
                category_slug: r.entry_category_slug || null,
                chat_id: r.entry_chat_id || null,
                group_id: r.entry_group_id || null,
            },
            featured_product: r.product_id ? {
                id: r.product_id, name: r.product_name, description: r.product_description,
                banner_url: r.product_banner, price: parseFloat(r.product_price || 0),
            } : null,
            video_call: r.call_id ? enrichCallPayload({
                id: r.call_id, slug: r.call_slug, category: r.call_category,
                model_name: r.call_model_name, model_photo: r.call_model_photo,
                video_url: r.call_video_url, redirect_link: r.call_redirect_link,
                cta_text: r.call_cta_text, trigger_delay_sec: r.call_trigger_delay_sec,
                cta_type: r.call_cta_type || 'home',
                cta_target_id: r.call_cta_target_id || null,
                trigger_type: 'on_login',
            }) : null,
        };
        // Registra visita
        try {
            await db.query(
                `INSERT INTO funnel_visits (funnel_id, funnel_slug, ip, user_agent) VALUES ($1, $2, $3, $4)`,
                [r.id, slug, (req.ip || '').slice(0, 45), (req.headers['user-agent'] || '').slice(0, 500)]
            );
        } catch(_) {}
        return res.json({ success: true, funnel });
    } catch (err) {
        logger.error('Erro buscando funíl:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// GET /api/user/funnel/:slug/sequence?email=X — retorna etapas do funíl
// Filtra etapas com chamada já vista pelo cliente (não repete).
router.get('/funnel/:slug/sequence', async (req, res) => {
    const slug = String(req.params.slug || '').toLowerCase().slice(0, 80);
    const email = (req.query.email || '').toLowerCase().trim().slice(0, 255);
    if (!slug) return res.json({ success: true, steps: [] });
    try {
        const { rows: f } = await db.query(`SELECT id FROM funnels WHERE slug = $1 AND active = true LIMIT 1`, [slug]);
        if (!f.length) return res.json({ success: true, steps: [] });
        const funnelId = f[0].id;
        // Etapas tipo 'push' NÃO vão pro cliente: são enviadas pelo SERVIDOR
        // (worker) no horário agendado — agendadas na conversão do lead.
        // MODO FILA: delay_seconds vira ACUMULADO (soma das etapas anteriores +
        // a desta), calculado sobre TODAS as etapas ativas em ordem. Assim cada
        // etapa dispara "X segundos depois da anterior". O app já trata o valor
        // como tempo a partir do e-mail, então não precisa mudar nada lá.
        const { rows: steps } = await db.query(`
            WITH ordered AS (
                SELECT fs.*,
                       SUM(GREATEST(COALESCE(fs.delay_seconds,0),0))
                           OVER (ORDER BY fs.step_order, fs.id
                                 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum_delay
                FROM funnel_steps fs
                WHERE fs.funnel_id = $1 AND fs.active = true
            )
            SELECT s.id, s.type, s.cum_delay AS delay_seconds, s.video_call_id, s.product_id,
                   s.chat_id, s.title, s.message, s.link_url, s.step_order,
                   ch.name AS chat_name, ch.avatar_url AS chat_avatar,
                   (
                       SELECT json_build_object(
                           'id', vc.id, 'slug', vc.slug, 'category', vc.category,
                           'model_name', vc.model_name, 'model_photo', vc.model_photo,
                           'video_url', vc.video_url, 'redirect_link', vc.redirect_link,
                           'cta_text', vc.cta_text, 'trigger_delay_sec', vc.trigger_delay_sec,
                           'cta_type', COALESCE(vc.cta_type, 'home'),
                           'cta_target_id', vc.cta_target_id
                       ) FROM video_calls vc WHERE vc.id = s.video_call_id AND vc.active = true
                   ) AS video_call
            FROM ordered s
            LEFT JOIN chats ch ON ch.id = s.chat_id
            WHERE s.type <> 'push'
            ORDER BY s.step_order, s.id
        `, [funnelId]);

        // Se tem email, filtra chamadas j\u00e1 vistas
        let seenIds = new Set();
        if (email) {
            try {
                const { rows: seen } = await db.query(
                    `SELECT video_call_id FROM customer_call_history WHERE LOWER(customer_email) = $1`,
                    [email]
                );
                seenIds = new Set(seen.map(r => r.video_call_id));
            } catch(_) {}
        }

        const filtered = steps.filter(s => {
            if (s.type === 'video_call' && s.video_call_id && seenIds.has(s.video_call_id)) return false;
            return true;
        }).map(s => {
            // Enriquece o sub-objeto video_call se vier (tem video_url) — assim
            // o front pode renderizar HLS direto sem precisar de roundtrip extra.
            if (s && s.video_call && s.video_call.video_url) {
                s.video_call = enrichCallPayload(s.video_call);
            }
            return s;
        });
        return res.json({ success: true, steps: filtered });
    } catch (err) {
        logger.error('Erro pegando seq do fun\u00edl:', err);
        return res.json({ success: true, steps: [] });
    }
});

// POST /api/user/calls/:id/seen — marca chamada como vista pelo cliente
// Usado SO pelo fluxo de chamada-funil pre-login (Iago/Remarketing). Pos-Fase B
// a UNIQUE da tabela virou (email, vc_id, user_access_id, gift_id). Aqui ambos
// user_access_id e gift_id sao NULL (pre-login = sem compra, sem brinde).
// Como NULL nao conflita em UNIQUE no Postgres, esse INSERT NUNCA da conflito —
// na pratica vira "INSERT direto", e o ON CONFLICT vira no-op defensivo.
router.post('/calls/:id/seen', async (req, res) => {
    const callId = parseInt(req.params.id, 10);
    const email = (req.body?.email || '').toLowerCase().trim().slice(0, 255);
    const funnelSlug = (req.body?.funnel_slug || '').toLowerCase().slice(0, 80) || null;
    if (!callId || !email) return res.json({ success: false });
    try {
        await db.query(`
            INSERT INTO customer_call_history (customer_email, video_call_id, user_access_id, gift_id, funnel_slug)
            VALUES ($1, $2, NULL, NULL, $3)
            ON CONFLICT ON CONSTRAINT customer_call_history_unique_per_slot DO NOTHING
        `, [email, callId, funnelSlug]);
        return res.json({ success: true });
    } catch (err) {
        logger.error('Erro marcando chamada vista:', err);
        return res.json({ success: false });
    }
});

// POST /api/user/funnel/:slug/convert — marca conversão (chamado após login)
router.post('/funnel/:slug/convert', async (req, res) => {
    const slug = String(req.params.slug || '').toLowerCase().slice(0, 80);
    const email = (req.body?.email || '').toLowerCase().trim().slice(0, 255);
    if (!slug || !email) return res.json({ success: false });
    try {
        await db.query(`
            UPDATE funnel_visits
            SET converted = true, converted_at = NOW(), customer_email = $2
            WHERE funnel_slug = $1
              AND id = (
                SELECT id FROM funnel_visits
                WHERE funnel_slug = $1 AND converted = false
                ORDER BY visited_at DESC LIMIT 1
              )
        `, [slug, email]);
        // Garante o agendamento dos pushes mesmo se o promote não rodou
        // (ex.: cliente já tinha sessão real e só seguiu o link do funil)
        await scheduleFunnelPushes(slug, email);
        return res.json({ success: true });
    } catch (err) {
        logger.error('Erro convert funíl:', err);
        return res.json({ success: false });
    }
});


// =============================================================================
// VIDEO CALLS — chamada ativa pra disparar após login
// =============================================================================

router.get('/active-call', optionalUser, async (req, res) => {
    try {
        const email = (req.query.email || req.user?.email || '').toLowerCase().trim().slice(0, 255);
        const { rows } = await db.query(`
            SELECT vc.id, vc.name, vc.slug, vc.category, vc.model_name, vc.model_photo,
                   vc.video_url, vc.redirect_link, vc.cta_text,
                   COALESCE(vc.cta_type, 'home') as cta_type, vc.cta_target_id,
                   vc.trigger_type, vc.trigger_delay_sec
            FROM video_calls vc
            WHERE vc.active = true
              AND vc.trigger_type = 'on_login'
              AND NOT EXISTS (SELECT 1 FROM funnels f WHERE f.video_call_id = vc.id)
              AND NOT EXISTS (SELECT 1 FROM products p WHERE p.video_call_id = vc.id)
              AND NOT EXISTS (SELECT 1 FROM funnel_steps fs WHERE fs.video_call_id = vc.id)
            ORDER BY vc.created_at DESC
            LIMIT 1
        `);
        if (!rows.length) return res.json({ success: true, call: null });
        const call = enrichCallPayload(rows[0]);
        // Marca se cliente j\u00e1 viu essa chamada
        if (email) {
            try {
                const { rows: seen } = await db.query(
                    `SELECT 1 FROM customer_call_history WHERE LOWER(customer_email) = $1 AND video_call_id = $2 LIMIT 1`,
                    [email, call.id]
                );
                call.already_seen = seen.length > 0;
            } catch(_) {}
        }
        return res.json({ success: true, call });
    } catch (err) {
        logger.error('Erro buscando chamada ativa:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// =============================================================================
// GET /api/user/notifications/feed
// Notificações in-app (tipo 'in_app') já ENVIADAS e direcionadas a este usuário.
// O front guarda os IDs já vistos em localStorage e só mostra o banner pros
// novos. Retorna as recentes (últimas 48h) pra cobrir reaberturas do app.
// =============================================================================
router.get('/notifications/feed', optionalUser, async (req, res) => {
    try {
        const email = (req.user?.email || '').toLowerCase().trim().slice(0, 255) || null;

        // Status de compra (só se houver e-mail) pra resolver os alvos segmentados.
        let hasPurchased = false;
        if (email) {
            try {
                const { rows } = await db.query(
                    `SELECT COALESCE(total_purchases, 0) > 0 AS bought FROM customers WHERE LOWER(email) = $1 LIMIT 1`,
                    [email]
                );
                hasPurchased = !!(rows[0] && rows[0].bought);
            } catch (_) {}
        }

        const { rows } = await db.query(`
            SELECT n.id, n.title, n.body, n.icon, n.cta_text, n.cta_url, n.target_type,
                   n.target_value, n.sent_at, n.product_id, p.banner_url AS product_image
            FROM notifications n
            LEFT JOIN products p ON p.id = n.product_id
            WHERE n.type = 'in_app'
              AND n.status = 'sent'
              AND n.sent_at IS NOT NULL
              AND n.sent_at > NOW() - INTERVAL '48 hours'
            ORDER BY n.sent_at DESC
            LIMIT 30
        `);

        const matches = (n) => {
            const t = n.target_type || 'all';
            if (t === 'all' || t === 'by_level') return true; // by_level sem lookup → trata como todos
            if (t === 'has_purchased') return hasPurchased;
            if (t === 'no_purchase') return !hasPurchased;
            if (t === 'by_email') {
                if (!email) return false;
                let tv = n.target_value;
                try { if (typeof tv === 'string') tv = JSON.parse(tv); } catch (_) { tv = null; }
                const emails = (tv && Array.isArray(tv.emails)) ? tv.emails.map(e => String(e).toLowerCase().trim()) : [];
                return emails.includes(email);
            }
            return false;
        };

        const feed = rows.filter(matches).map(n => ({
            id: n.id,
            title: n.title,
            body: n.body,
            icon: n.icon || null,
            // se a notificação aponta pra um produto: usa a CAPA dele como imagem
            // e, sem link definido, leva pro produto ao clicar.
            image: n.product_id ? (n.product_image || null) : null,
            cta_text: n.cta_text || null,
            cta_url: n.cta_url || (n.product_id ? ('/?p=' + n.product_id) : null),
            sent_at: n.sent_at,
        }));

        return res.json({ success: true, notifications: feed });
    } catch (err) {
        logger.error('Erro no feed de notificações:', err);
        return res.json({ success: true, notifications: [] });
    }
});


module.exports = router;
// Helpers compartilhados com a aba Lives (mesma posse dos vídeos + mesmo popup)
module.exports.exploreAccess = exploreAccess;
module.exports.loadExploreUnlock = loadExploreUnlock;
module.exports.loadPremiumPlan = loadPremiumPlan;
module.exports.isPremiumCustomer = isPremiumCustomer;
