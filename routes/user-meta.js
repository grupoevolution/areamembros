/**
 * =============================================================================
 * routes/user-meta.js — eventos do Pixel do Facebook (lado do app/pressel)
 * =============================================================================
 *
 * POST /api/user/meta/track  (SEM login obrigatório — a pressel e o lead
 * anônimo do funil também rastreiam)
 *
 * O app dispara o evento no NAVEGADOR (fbq, com event_id gerado lá) e chama
 * este endpoint com o MESMO event_id → nós:
 *   1. guardamos a atribuição (fbclid/fbp/fbc/UTMs) do visitante;
 *   2. espelhamos o evento pro Meta via API de Conversões (dedup por event_id).
 *
 * O Lead NÃO passa por aqui — ele nasce no /login/promote (servidor manda o
 * CAPI e devolve o event_id pro app disparar o fbq igual).
 * =============================================================================
 */

const express = require('express');
const router = express.Router();
const { logger } = require('../lib/logger');
const { optionalUser } = require('../lib/user-auth');
const { getIp } = require('../lib/device-check');
const meta = require('../lib/meta-pixel');

const EVENTS = { pageview: 'PageView', viewcontent: 'ViewContent' };

router.post('/meta/track', optionalUser, async (req, res) => {
    try {
        const b = req.body || {};
        const cfg = await meta.loadMetaConfig();
        const ip = getIp(req);
        const ua = String(req.headers['user-agent'] || '').slice(0, 512);
        const email = (req.user && !req.user.anonymous && req.user.email) ? req.user.email : null;
        const visitorId = String(b.visitor_id || '').slice(0, 80) || null;
        const fbclid = String(b.fbclid || '').slice(0, 400) || null;
        // fbc: cookie do navegador vence; sem ele, reconstruímos do fbclid cru
        const fbc = (String(b.fbc || '').slice(0, 500) || null)
            || (fbclid ? meta.fbcFromFbclid(fbclid) : null);
        const fbp = String(b.fbp || '').slice(0, 128) || null;

        // 1) Atribuição — sempre que vier algo útil (mesmo com pixel desligado:
        // se o dono ligar amanhã, o histórico de cliques já está guardado)
        if (fbclid || fbp || fbc || (b.utm && (b.utm.source || b.utm.campaign)) || (email && visitorId)) {
            await meta.upsertAttribution({
                visitorId, email, fbclid, fbp, fbc,
                utm: b.utm || null,
                funnelSlug: b.funnel_slug || null,
                ip, userAgent: ua,
            });
        }

        // 2) Espelho CAPI (só eventos conhecidos, com a chave do evento ligada)
        const evName = EVENTS[String(b.event || '').toLowerCase()] || null;
        const evOn = evName === 'PageView' ? cfg.ev_pageview : evName === 'ViewContent' ? cfg.ev_viewcontent : false;
        if (evName && evOn && cfg.enabled && cfg.pixel_id && cfg.capi_token) {
            const userData = meta.buildUserData({
                email, ip, userAgent: ua, fbp, fbc, externalId: visitorId,
            });
            const custom = {};
            if (evName === 'ViewContent' && b.content_name) custom.content_name = String(b.content_name).slice(0, 120);
            meta.sendCapiEvents([{
                event_name: evName,
                event_id: String(b.event_id || '').slice(0, 80) || undefined,
                event_source_url: String(b.url || '').slice(0, 500) || undefined,
                user_data: userData,
                custom_data: Object.keys(custom).length ? custom : undefined,
            }]).catch(() => {});
        }

        return res.json({ success: true });
    } catch (err) {
        logger.warn('[meta] track falhou: ' + (err && err.message));
        return res.json({ success: true }); // rastreio nunca quebra o app
    }
});

module.exports = router;
