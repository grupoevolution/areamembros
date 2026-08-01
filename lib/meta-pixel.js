/**
 * =============================================================================
 * lib/meta-pixel.js — Pixel do Facebook (Meta) + API de Conversões (CAPI)
 * =============================================================================
 *
 * FASE 1 (jul/2026): o Meta passa a enxergar o funil INTEIRO, não só o
 * checkout da Kirvano.
 *
 *   - Navegador (fbq): PageView / ViewContent / Lead — o app e a pressel
 *     disparam com um event_id gerado no cliente.
 *   - Servidor (CAPI): espelha os MESMOS eventos com o MESMO event_id →
 *     o Meta deduplica (fica 1 evento só, com os dados mais ricos dos dois).
 *     É o padrão recomendado: o lado servidor recupera o que iOS/bloqueador
 *     mata no navegador.
 *   - Purchase fica FORA por enquanto (é do Pixel da Kirvano no checkout —
 *     mandar em dobro sem o mesmo event_id contaria venda 2x). Fase 2.
 *
 * Config no painel (gamification_config → key 'meta_pixel'):
 *   { enabled, pixel_id, capi_token, test_event_code,
 *     ev_pageview, ev_viewcontent, ev_lead }
 *
 * Dados pessoais (e-mail etc.) SEMPRE hasheados em SHA-256 antes de sair,
 * como o Meta exige.
 * =============================================================================
 */

const crypto = require('crypto');
const db = require('../db');
const { logger } = require('./logger');

const GRAPH_VERSION = 'v21.0';

// cache curto da config (o painel salva pouco; 60s evita query por evento)
let _cfg = { at: 0, val: null };
async function loadMetaConfig() {
    if (_cfg.val && Date.now() - _cfg.at < 60000) return _cfg.val;
    let cfg = {
        enabled: false, pixel_id: '', capi_token: '', test_event_code: '',
        ev_pageview: true, ev_viewcontent: true, ev_lead: true,
    };
    try {
        const { rows } = await db.query(`SELECT value FROM gamification_config WHERE key = 'meta_pixel'`);
        const v = rows[0]?.value || {};
        cfg = {
            enabled: v.enabled === true,
            pixel_id: String(v.pixel_id || '').replace(/\D/g, '').slice(0, 32),
            capi_token: typeof v.capi_token === 'string' ? v.capi_token.trim() : '',
            test_event_code: typeof v.test_event_code === 'string' ? v.test_event_code.trim().slice(0, 40) : '',
            ev_pageview: v.ev_pageview !== false,
            ev_viewcontent: v.ev_viewcontent !== false,
            ev_lead: v.ev_lead !== false,
        };
    } catch (_) {}
    _cfg = { at: Date.now(), val: cfg };
    return cfg;
}
function invalidateMetaConfig() { _cfg = { at: 0, val: null }; }

// A parte PÚBLICA da config (vai pro app/pressel — pixel_id não é segredo,
// aparece no HTML de qualquer site com pixel; o token NUNCA sai daqui).
async function publicMetaConfig() {
    const c = await loadMetaConfig();
    if (!c.enabled || !c.pixel_id) return null;
    return {
        pixel_id: c.pixel_id,
        ev_pageview: c.ev_pageview,
        ev_viewcontent: c.ev_viewcontent,
        ev_lead: c.ev_lead,
    };
}

// SHA-256 com a normalização que o Meta pede (minúsculo, sem espaços)
function sha256(v) {
    const s = String(v || '').trim().toLowerCase();
    if (!s) return null;
    return crypto.createHash('sha256').update(s).digest('hex');
}
// telefone: só dígitos, com DDI (Brasil: prefixa 55 se faltar)
function sha256Phone(v) {
    let d = String(v || '').replace(/\D/g, '');
    if (!d) return null;
    if (d.length <= 11 && !d.startsWith('55')) d = '55' + d;
    return crypto.createHash('sha256').update(d).digest('hex');
}

/**
 * Monta o user_data do CAPI a partir do que temos do lead.
 * Quanto mais chaves, melhor o Event Match Quality (meta: nota 8+).
 */
function buildUserData({ email, phone, firstName, ip, userAgent, fbp, fbc, externalId } = {}) {
    const ud = {};
    const em = sha256(email); if (em) ud.em = [em];
    const ph = sha256Phone(phone); if (ph) ud.ph = [ph];
    const fn = sha256(String(firstName || '').split(/\s+/)[0]); if (fn) ud.fn = [fn];
    const ei = sha256(externalId); if (ei) ud.external_id = [ei];
    if (ip) ud.client_ip_address = String(ip).slice(0, 64);
    if (userAgent) ud.client_user_agent = String(userAgent).slice(0, 512);
    if (fbp && /^fb\.\d\.\d+\.[\w-]+$/.test(String(fbp))) ud.fbp = String(fbp).slice(0, 128);
    if (fbc && /^fb\.\d\.\d+\./.test(String(fbc))) ud.fbc = String(fbc).slice(0, 512);
    return ud;
}

// fbc reconstruído do fbclid cru (quando o cookie ainda não existia na hora
// do clique — formato oficial: fb.1.<timestamp ms>.<fbclid>)
function fbcFromFbclid(fbclid, atMs) {
    const f = String(fbclid || '').trim();
    if (!f || f.length > 400) return null;
    return `fb.1.${atMs || Date.now()}.${f}`;
}

/**
 * Envia eventos pro CAPI. Nunca lança erro (venda/navegação do lead JAMAIS
 * pode depender do Meta responder) — falha vira warn no log.
 * events: [{ event_name, event_id, event_time?, event_source_url, user_data, custom_data? }]
 */
async function sendCapiEvents(events) {
    const cfg = await loadMetaConfig();
    if (!cfg.enabled || !cfg.pixel_id || !cfg.capi_token || !events?.length) return false;
    const body = {
        data: events.map(e => ({
            event_name: e.event_name,
            event_time: e.event_time || Math.floor(Date.now() / 1000),
            event_id: e.event_id || undefined,
            action_source: 'website',
            event_source_url: e.event_source_url || undefined,
            user_data: e.user_data || {},
            custom_data: e.custom_data || undefined,
        })),
    };
    if (cfg.test_event_code) body.test_event_code = cfg.test_event_code;
    try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 6000);
        const resp = await fetch(
            `https://graph.facebook.com/${GRAPH_VERSION}/${cfg.pixel_id}/events?access_token=${encodeURIComponent(cfg.capi_token)}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: ctl.signal,
            }
        );
        clearTimeout(t);
        if (!resp.ok) {
            const txt = await resp.text().catch(() => '');
            logger.warn(`[meta-capi] Meta respondeu ${resp.status}: ${txt.slice(0, 300)}`);
            return false;
        }
        return true;
    } catch (err) {
        logger.warn('[meta-capi] envio falhou: ' + (err && err.message));
        return false;
    }
}

/**
 * Guarda/atualiza a ATRIBUIÇÃO do visitante (fbclid/fbp/fbc/UTMs) — o elo
 * entre o clique do anúncio e tudo que o lead fizer depois (inclusive a
 * Purchase da Fase 2). Última entrada com fbclid vence (clique mais recente).
 */
async function upsertAttribution({ visitorId, email, fbclid, fbp, fbc, utm, funnelSlug, ip, userAgent }) {
    const vid = String(visitorId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || null;
    const em = email ? String(email).toLowerCase().trim().slice(0, 255) : null;
    if (!vid && !em) return;
    const u = utm || {};
    const clean = (x, n) => { const s = String(x || '').trim().slice(0, n); return s || null; };
    try {
        const { rowCount } = await db.query(
            `UPDATE ad_attributions SET
                email       = COALESCE($2, email),
                fbclid      = COALESCE($3, fbclid),
                fbc         = COALESCE($4, fbc),
                fbp         = COALESCE($5, fbp),
                utm_source  = COALESCE($6, utm_source),
                utm_medium  = COALESCE($7, utm_medium),
                utm_campaign= COALESCE($8, utm_campaign),
                utm_content = COALESCE($9, utm_content),
                utm_term    = COALESCE($10, utm_term),
                funnel_slug = COALESCE($11, funnel_slug),
                ip          = COALESCE($12, ip),
                user_agent  = COALESCE($13, user_agent),
                updated_at  = NOW()
              WHERE ($1::text IS NOT NULL AND visitor_id = $1)
                 OR ($1::text IS NULL AND $2::text IS NOT NULL AND LOWER(email) = LOWER($2))`,
            [vid, em,
             clean(fbclid, 400), clean(fbc, 500), clean(fbp, 128),
             clean(u.source, 120), clean(u.medium, 120), clean(u.campaign, 200),
             clean(u.content, 200), clean(u.term, 200),
             clean(funnelSlug, 80), clean(ip, 64), clean(userAgent, 512)]
        );
        if (!rowCount) {
            await db.query(
                `INSERT INTO ad_attributions
                    (visitor_id, email, fbclid, fbc, fbp, utm_source, utm_medium,
                     utm_campaign, utm_content, utm_term, funnel_slug, ip, user_agent)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
                [vid, em,
                 clean(fbclid, 400), clean(fbc, 500), clean(fbp, 128),
                 clean(u.source, 120), clean(u.medium, 120), clean(u.campaign, 200),
                 clean(u.content, 200), clean(u.term, 200),
                 clean(funnelSlug, 80), clean(ip, 64), clean(userAgent, 512)]
            );
        }
    } catch (err) {
        logger.warn('[meta-capi] upsert atribuição falhou: ' + (err && err.message));
    }
}

// Busca a atribuição mais completa do lead (por visitor OU por e-mail)
async function findAttribution({ visitorId, email }) {
    try {
        const vid = String(visitorId || '').slice(0, 80) || null;
        const em = email ? String(email).toLowerCase().trim() : null;
        if (!vid && !em) return null;
        const { rows } = await db.query(
            `SELECT * FROM ad_attributions
              WHERE ($1::text IS NOT NULL AND visitor_id = $1)
                 OR ($2::text IS NOT NULL AND LOWER(email) = $2)
              ORDER BY (fbclid IS NOT NULL) DESC, updated_at DESC LIMIT 1`,
            [vid, em]
        );
        return rows[0] || null;
    } catch (_) { return null; }
}

module.exports = {
    loadMetaConfig, invalidateMetaConfig, publicMetaConfig,
    sha256, sha256Phone, buildUserData, fbcFromFbclid,
    sendCapiEvents, upsertAttribution, findAttribution,
};
