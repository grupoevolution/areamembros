/**
 * =============================================================================
 * lib/gift-campaigns.js — Resgate de brindes via "link mágico" (Fase K2)
 * =============================================================================
 *
 * O admin cria uma campanha (gift_campaigns) com um código (slug). O link
 * `https://app/?campanha=CODE` é distribuído (Telegram, grupos, etc).
 *
 * Quando o cliente abre o link, o frontend salva o código em localStorage
 * e manda no body do POST /api/user/login (ou /login/promote). Esta lib é
 * chamada IMEDIATAMENTE APÓS o login bem-sucedido, ANTES de retornar pro
 * cliente — assim o brinde já está no banco quando o /library for chamado.
 *
 * Decisões de projeto:
 *   - Idempotência por (campaign_id, LOWER(email)): cliente abre o link 2x,
 *     loga 2x, redemptions_count incrementa só UMA vez. Garantido por
 *     UNIQUE INDEX + ON CONFLICT DO NOTHING (sem race window).
 *   - Se o cliente JÁ TINHA o brinde do mesmo produto (ex: compra anterior
 *     virou refund e o admin já tinha dado brinde): redemption é registrada
 *     com skipped=true + gift_id=NULL. Admin vê no painel "X resgataram,
 *     Y pularam (já tinham)".
 *   - Toda operação é tolerante a erro (logger.warn + retorna null) —
 *     campanha QUEBRADA não pode derrubar o /login. Login sempre tem que
 *     funcionar; brinde é bônus, não pré-requisito.
 *   - Transação opcional: faria sentido em alta concorrência (race em
 *     redemptions_count quando max_redemptions tá no limite), mas o custo
 *     de transação por login não compensa. O UNIQUE INDEX por (campaign, email)
 *     já garante que cada cliente conte só uma vez; o overshoot máximo é
 *     "max+N clientes que clicaram simultaneamente exatamente quando
 *     redemptions = max". Aceitável (admin pode setar max-2 se quiser
 *     margem).
 *
 * @param {string} code  Código da campanha (URL-friendly).
 * @param {string} email Email já normalizado (lowercase, trim).
 * @param {string} [requestIp] Pra log (opcional).
 * @returns {Promise<{
 *   redeemed: boolean,
 *   skipped?: boolean,       // true se cliente já tinha o brinde
 *   gift_id?: number,
 *   product_id?: number,
 *   reason?: string,         // 'not_found'|'inactive'|'expired'|'maxed'|'error'
 * } | null>}
 * =============================================================================
 */

const db = require('../db');
const { logger } = require('./logger');


/**
 * Valida + resgata o brinde de uma campanha pra um email.
 * Tudo idempotente. Tudo tolerante a erro (nunca lança — sempre retorna objeto).
 */
async function redeemCampaign(code, email, requestIp = null) {
    if (!code || typeof code !== 'string') return null;
    if (!email || typeof email !== 'string') return null;

    const normalizedCode = code.toLowerCase().trim().slice(0, 40);
    if (!normalizedCode) return null;

    // Defensive: o caller (loginClient) já normaliza, mas o helper aceita
    // qualquer entrada — se alguém importar a lib em outro contexto, fica seguro.
    email = String(email).toLowerCase().trim();
    if (!email) return null;

    try {
        // 1) Busca campanha pelo código. Index parcial (active=true) acelera.
        const { rows: [campaign] } = await db.query(`
            SELECT id, code, product_id, expires_in_hours, campaign_expires_at,
                   max_redemptions, redemptions_count, active
            FROM gift_campaigns
            WHERE code = $1
        `, [normalizedCode]);

        if (!campaign) {
            return { redeemed: false, reason: 'not_found' };
        }
        if (!campaign.active) {
            return { redeemed: false, reason: 'inactive' };
        }
        if (campaign.campaign_expires_at && new Date(campaign.campaign_expires_at) <= new Date()) {
            return { redeemed: false, reason: 'expired' };
        }
        if (campaign.max_redemptions != null &&
            campaign.redemptions_count >= campaign.max_redemptions) {
            return { redeemed: false, reason: 'maxed' };
        }

        // 2) Calcula expires_at do brinde (NULL = vitalício).
        const expiresAt = (campaign.expires_in_hours && campaign.expires_in_hours > 0)
            ? new Date(Date.now() + campaign.expires_in_hours * 3600 * 1000)
            : null;

        // 3) INSERT do brinde com ON CONFLICT DO NOTHING (genérico).
        //    Captura qualquer unique violation — incluindo o nosso UNIQUE
        //    PARCIAL gifts_unique_active_per_email_product. Sem `target`
        //    específico pra não acoplar a sintaxe ao nome do índice (mais
        //    robusto a renames futuros). Retorno: rows.length > 0 → criou;
        //    rows.length == 0 → conflito (cliente já tinha brinde do produto).
        const { rows: insertedGift } = await db.query(`
            INSERT INTO gifts (email, product_id, label, expires_at, granted_by, status)
            VALUES ($1, $2, $3, $4, $5, 'active')
            ON CONFLICT DO NOTHING
            RETURNING id
        `, [
            email,
            campaign.product_id,
            `Campanha: ${normalizedCode}`,
            expiresAt,
            `campaign:${normalizedCode}`,
        ]);

        const giftId = insertedGift.length ? insertedGift[0].id : null;
        const skipped = giftId === null;

        // 4) Registra a redemption. UNIQUE INDEX por (campaign_id, LOWER(email))
        //    → se cliente clicar/logar 2x, segunda chamada cai em conflict e o
        //    contador NÃO incrementa de novo. ON CONFLICT genérico pra não
        //    acoplar a sintaxe ao nome do índice.
        const { rows: redempIns } = await db.query(`
            INSERT INTO gift_campaign_redemptions (campaign_id, email, gift_id, skipped)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT DO NOTHING
            RETURNING id
        `, [campaign.id, email, giftId, skipped]);

        const isFirstTimeRedeemer = redempIns.length > 0;

        if (isFirstTimeRedeemer) {
            await db.query(`
                UPDATE gift_campaigns
                SET redemptions_count = redemptions_count + 1
                WHERE id = $1
            `, [campaign.id]);
        }

        logger.info(
            `[campaign] resgate code=${normalizedCode} email=${email} ` +
            `gift=${giftId || 'skipped'} firstTime=${isFirstTimeRedeemer}` +
            (requestIp ? ` ip=${requestIp}` : '')
        );

        return {
            redeemed: !skipped,
            skipped,
            gift_id: giftId,
            product_id: campaign.product_id,
            campaign_id: campaign.id,
            first_time: isFirstTimeRedeemer,
        };
    } catch (err) {
        // Tolerante a falha: tabelas podem não existir em deploys antigos (42P01),
        // ou erro transitório de banco. Login NÃO pode quebrar.
        if (err.code === '42P01') {
            logger.warn(`[campaign] tabelas ausentes (migration pendente?): ${err.message}`);
        } else {
            logger.error(`[campaign] erro inesperado em redeemCampaign: ${err.message}`);
        }
        return { redeemed: false, reason: 'error' };
    }
}


/**
 * Lê info pública de uma campanha pra mostrar preview na tela de login.
 * Sem auth. Retorna só dados não-sensíveis (sem max_redemptions, sem stats).
 */
async function getCampaignPublicInfo(code) {
    if (!code || typeof code !== 'string') return null;
    const normalizedCode = code.toLowerCase().trim().slice(0, 40);
    if (!normalizedCode) return null;

    try {
        const { rows: [campaign] } = await db.query(`
            SELECT
                gc.code, gc.label, gc.expires_in_hours, gc.campaign_expires_at,
                gc.active, gc.max_redemptions, gc.redemptions_count,
                p.id   AS product_id,
                p.name AS product_name,
                p.banner_url AS product_banner
            FROM gift_campaigns gc
            INNER JOIN products p ON p.id = gc.product_id
            WHERE gc.code = $1
        `, [normalizedCode]);

        if (!campaign) return { found: false };

        const expired = !!(campaign.campaign_expires_at &&
            new Date(campaign.campaign_expires_at) <= new Date());
        const maxed = campaign.max_redemptions != null &&
            campaign.redemptions_count >= campaign.max_redemptions;

        return {
            found: true,
            code: campaign.code,
            label: campaign.label,
            active: campaign.active && !expired && !maxed,
            product: {
                id: campaign.product_id,
                name: campaign.product_name,
                banner_url: campaign.product_banner,
            },
            duration_hours: campaign.expires_in_hours || null,
        };
    } catch (err) {
        if (err.code !== '42P01') {
            logger.warn(`[campaign] erro em getCampaignPublicInfo: ${err.message}`);
        }
        return null;
    }
}


module.exports = {
    redeemCampaign,
    getCampaignPublicInfo,
};
