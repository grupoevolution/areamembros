/**
 * =============================================================================
 * lib/gateways/perfectpay.js — Adaptador PerfectPay
 * =============================================================================
 *
 * Valida o webhook da PerfectPay e traduz o payload para o formato normalizado.
 *
 * Como a PerfectPay valida webhooks:
 *   Envia um campo "token" dentro do próprio payload JSON.
 *   Esse token é o "Public Token" que aparece no painel da PerfectPay.
 *   O valor precisa bater com PERFECTPAY_WEBHOOK_SECRET.
 *
 *   Exemplo do payload:
 *     { "token": "1d1c36b64b05c11c4620e7ead69ceefd", ... }
 *
 * Identificação do produto:
 *   Na PerfectPay, cada "plano" tem um `plan.code` (tipo "PPLQQLSTB").
 *   Esse é o identificador que a gente usa no sistema como offer_id.
 *
 * Mapeamento de eventos (sale_status_enum_key):
 *   approved     → approved
 *   refunded     → refunded
 *   chargeback   → chargeback
 *   canceled     → canceled
 *   refused      → refused
 *
 * Também trata eventos de assinatura (subscription.status_event):
 *   subscription_expired   → canceled
 *   subscription_canceled  → canceled
 *
 * =============================================================================
 */

const { logger } = require('../logger');
const { getSecret } = require('../gateway-secrets');


/**
 * Valida se o webhook veio realmente da PerfectPay.
 * A PerfectPay envia um "token" no body.
 */
async function validatePerfectPaySignature(req) {
    const expected = await getSecret('perfectpay');
    
    if (!expected || expected.trim() === '') {
        // Fail-closed em produção: sem secret configurado, REJEITA (senão
        // qualquer um forjaria uma venda aprovada). Só aceita sem validação
        // fora de produção, pra facilitar testes locais.
        if (process.env.NODE_ENV === 'production') {
            logger.error('PerfectPay webhook secret não configurado em PRODUÇÃO — rejeitando (fail-closed). Configure o token no painel admin ou em PERFECTPAY_WEBHOOK_SECRET.');
            return false;
        }
        logger.warn('PerfectPay webhook secret não configurado — aceitando sem validação (modo dev).');
        return true;
    }
    
    const token = req.body?.token;
    if (!token) return false;
    
    return timingSafeEqual(token, expected);
}


function timingSafeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    let result = 0;
    for (let i = 0; i < a.length; i++) {
        result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
}


/**
 * Mapeia status da PerfectPay para o formato normalizado.
 */
function mapPerfectPayEvent(saleStatusKey, subscriptionStatusEvent) {
    const sale = (saleStatusKey || '').toLowerCase();
    const sub = (subscriptionStatusEvent || '').toLowerCase();
    
    // Eventos de assinatura têm prioridade
    if (sub === 'subscription_expired' || sub === 'subscription_canceled') {
        return 'canceled';
    }
    
    if (sale === 'approved') return 'approved';
    if (sale === 'refunded') return 'refunded';
    if (sale === 'chargeback' || sale === 'refund_chargeback') return 'chargeback';
    if (sale === 'canceled') return 'canceled';
    if (sale === 'refused') return 'refused';
    if (sale === 'expired') return 'canceled';
    
    return null;
}


/**
 * Normaliza payload da PerfectPay.
 *
 * Estrutura (do exemplo real):
 *   {
 *     code: "PPCPMTB5GHE3IK",            // ID único da venda
 *     sale_amount: 14.99,                  // valor (já número)
 *     sale_status_enum_key: "approved",    // status
 *     product: { code, name, ... },
 *     plan: { code: "PPLQQLSTB", name },   // identificador do produto!
 *     customer: { email, full_name, phone_number, identification_number },
 *     subscription: { status_event, ... }
 *   }
 *
 * Diferente da Kirvano, PerfectPay envia UM produto por venda (não array).
 */
function normalizePerfectPayPayload(payload) {
    const event = mapPerfectPayEvent(
        payload.sale_status_enum_key,
        payload.subscription?.status_event
    );
    
    if (!event) {
        return {
            valid: false,
            reason: `Status desconhecido: sale='${payload.sale_status_enum_key}', sub='${payload.subscription?.status_event}'`,
        };
    }
    
    const customer = payload.customer || {};
    const plan = payload.plan || {};
    const product = payload.product || {};
    
    // PerfectPay identifica o item pelo plan.code (que é o "offer_id" equivalente)
    // Se não tiver plano, usa product.code como fallback
    const offerId = plan.code || product.code;
    
    if (!offerId) {
        return {
            valid: false,
            reason: 'Sem plan.code nem product.code no payload',
        };
    }
    
    // LÍQUIDO: PerfectPay usa commission_amount como repasse pro produtor.
    // Se ausente, deixa NULL (dashboard não conta vendas sem net real).
    const parseNum = (v) => {
        if (v === null || v === undefined || v === '') return null;
        const n = parseFloat(v);
        return isNaN(n) ? null : n;
    };
    const netAmount = parseNum(payload.commission_amount)
        ?? parseNum(payload.producer_amount)
        ?? null;

    return {
        valid: true,
        data: {
            gateway: 'perfectpay',
            event,
            sale_id: payload.code,
            sale_amount: parseFloat(payload.sale_amount) || 0,
            sale_net_amount: netAmount,
            customer: {
                email: customer.email,
                name: customer.full_name,
                phone: customer.phone_number ?
                    `${customer.phone_area_code || ''}${customer.phone_number}` : null,
                document: customer.identification_number,
            },
            items: [{
                offer_id: offerId,
                offer_name: plan.name,
                product_name: product.name,
                is_order_bump: false,  // PerfectPay não tem order bump explícito no payload
            }],
            raw: payload,
        },
    };
}


module.exports = {
    validatePerfectPaySignature,
    normalizePerfectPayPayload,
    mapPerfectPayEvent,
};
