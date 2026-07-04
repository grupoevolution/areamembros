/**
 * =============================================================================
 * lib/gateways/kirvano.js — Adaptador Kirvano
 * =============================================================================
 *
 * Valida o webhook da Kirvano e traduz o payload para o formato normalizado
 * que o sales-processor entende.
 *
 * Como a Kirvano valida webhooks:
 *   A Kirvano envia um campo "Token" configurado no painel dela.
 *   Esse token vem no header HTTP (geralmente X-Kirvano-Token ou similar)
 *   ou no corpo do request. O valor tem que bater com KIRVANO_WEBHOOK_SECRET
 *   configurado aqui nas variáveis de ambiente.
 *
 * Mapeamento de eventos:
 *   SALE_APPROVED    → approved
 *   SALE_REFUNDED    → refunded
 *   SALE_CHARGEBACK  → chargeback
 *   SALE_REFUSED     → refused
 *   SALE_CANCELED    → canceled
 *
 * =============================================================================
 */

const { logger } = require('../logger');
const { getSecret } = require('../gateway-secrets');


/**
 * Valida se o webhook veio realmente da Kirvano.
 *
 * Lê o secret do banco (configurado pelo admin) com fallback pro env.
 *
 * @returns {Promise<boolean>} true se válido
 */
async function validateKirvanoSignature(req) {
    const expected = await getSecret('kirvano');
    
    // Se não configurou o secret, aceita tudo (modo dev)
    // IMPORTANTE: em produção, SEMPRE configure o secret!
    if (!expected || expected.trim() === '') {
        // Fail-closed em produção: sem secret configurado, REJEITA (senão
        // qualquer um forjaria uma venda aprovada). Só aceita sem validação
        // fora de produção, pra facilitar testes locais.
        if (process.env.NODE_ENV === 'production') {
            logger.error('Kirvano webhook secret não configurado em PRODUÇÃO — rejeitando (fail-closed). Configure o token no painel admin ou em KIRVANO_WEBHOOK_SECRET.');
            return false;
        }
        logger.warn('Kirvano webhook secret não configurado — aceitando sem validação (modo dev).');
        return true;
    }
    
    // Tenta várias fontes possíveis do token. A Kirvano envia no header
    // "security-token" (esse é o real); mantemos os outros por compatibilidade.
    const candidates = [
        req.headers['security-token'],
        req.headers['x-security-token'],
        req.headers['x-kirvano-token'],
        req.headers['x-webhook-token'],
        req.headers['x-kirvano-signature'],
        req.headers['token'],
        req.headers['authorization']?.replace(/^Bearer\s+/i, ''),
        req.body?.token,
        req.body?.webhook_token,
        req.body?.security_token,
        req.query?.token,
    ].filter(Boolean);
    
    return candidates.some(token => timingSafeEqual(token, expected));
}


/**
 * Comparação de strings imune a timing attacks.
 */
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
 * Mapeia o evento da Kirvano para o formato normalizado.
 */
function mapKirvanoEvent(eventName, status) {
    const event = (eventName || '').toUpperCase();
    const stat = (status || '').toUpperCase();
    
    if (event === 'SALE_APPROVED' || stat === 'APPROVED') return 'approved';
    if (event === 'SALE_REFUNDED' || stat === 'REFUNDED') return 'refunded';
    if (event === 'SALE_CHARGEBACK' || stat === 'CHARGEBACK') return 'chargeback';
    if (event === 'SALE_CANCELED' || stat === 'CANCELED') return 'canceled';
    if (event === 'SALE_REFUSED' || stat === 'REFUSED') return 'refused';
    if (event === 'SALE_EXPIRED' || stat === 'EXPIRED') return 'canceled';
    // PIX GERADO / aguardando pagamento — precisa estar HABILITADO no painel
    // da Kirvano (evento de venda pendente no cadastro do webhook). Vira a
    // mensagem automática de "só falta pagar" no chat de suporte.
    if (event === 'SALE_PENDING' || event === 'SALE_WAITING_PAYMENT' ||
        stat === 'PENDING' || stat === 'WAITING_PAYMENT') return 'pending';

    return null;
}


/**
 * Extrai os dados do PIX de um payload pendente (defensivo: a Kirvano já
 * mudou nome de campo antes — tenta os candidatos conhecidos).
 */
function extractKirvanoPayment(payload) {
    const pay = payload.payment || {};
    const pix = payload.pix || {};
    const code = pay.qrcode || pay.qr_code || pay.pix_code || pay.copy_paste ||
        pix.qrcode || pix.code || pay.digitable_line || null;
    const url = pay.link || pay.url || payload.checkout_url || null;
    const method = String(pay.method || payload.payment_method || '').toUpperCase() || null;
    return { method, pix_code: code ? String(code) : null, pix_url: url || null };
}


/**
 * Converte "R$ 20,00" para 20.00 (número).
 */
function parsePrice(priceStr) {
    if (typeof priceStr === 'number') return priceStr;
    if (!priceStr) return 0;
    
    const cleaned = String(priceStr)
        .replace(/R\$\s*/i, '')
        .replace(/\./g, '')      // remove separador de milhar
        .replace(/,/g, '.')      // vírgula decimal vira ponto
        .trim();
    
    const num = parseFloat(cleaned);
    return isNaN(num) ? 0 : num;
}


/**
 * Normaliza um payload da Kirvano para o formato universal.
 *
 * Payload Kirvano tem esta estrutura (baseado no exemplo real):
 *   {
 *     event: "SALE_APPROVED",
 *     status: "APPROVED",
 *     sale_id: "86DEWNRQ",
 *     total_price: "R$ 20,00",
 *     customer: { email, name, phone_number, document },
 *     products: [{ id, name, offer_id, offer_name, ... }],
 *     ...
 *   }
 */
// Aceita number/string. NÃO confunde 0 com ausente (afiliado sem comissão = 0 válido).
function parseFinanceField(val) {
    if (val === null || val === undefined || val === '') return null;
    const n = parseFloat(val);
    return isNaN(n) ? null : n;
}

function normalizeKirvanoPayload(payload) {
    const event = mapKirvanoEvent(payload.event, payload.status);

    if (!event) {
        return {
            valid: false,
            reason: `Evento desconhecido: event='${payload.event}', status='${payload.status}'`,
        };
    }

    const customer = payload.customer || {};
    const products = Array.isArray(payload.products) ? payload.products : [];

    // BRUTO: o que o cliente pagou (fiscal.total_value é o mais confiável,
    // contempla juros do parcelamento; cai pra total_price se ausente).
    const fiscal = payload.fiscal || {};
    const saleAmount = parseFinanceField(fiscal.total_value)
        ?? parsePrice(payload.total_price);

    // LÍQUIDO: o que cai pro produtor. Validado em produção no Orion.
    // ⚠ fiscal.net_value é ENGANOSO — Kirvano coloca o BRUTO lá. NÃO usar.
    const netAmount = parseFinanceField(fiscal.commission)
        ?? parseFinanceField(payload.commission)
        ?? parseFinanceField(fiscal.total_commissions)
        ?? null;

    return {
        valid: true,
        data: {
            gateway: 'kirvano',
            event,
            sale_id: payload.sale_id || payload.checkout_id,
            sale_amount: saleAmount,
            sale_net_amount: netAmount,
            // dados de pagamento (PIX copia-e-cola etc.) — usados no evento
            // 'pending' pra mandar o "só falta pagar" no chat de suporte
            payment: extractKirvanoPayment(payload),
            customer: {
                email: customer.email,
                name: customer.name,
                phone: customer.phone_number,
                document: customer.document,
            },
            items: products.map(p => ({
                offer_id: p.offer_id,
                offer_name: p.offer_name,
                product_name: p.name,
                is_order_bump: p.is_order_bump || false,
            })),
            raw: payload,
        },
    };
}


module.exports = {
    validateKirvanoSignature,
    normalizeKirvanoPayload,
    mapKirvanoEvent,
    parsePrice,
};
