/**
 * lib/gateways/stripe.js — Adaptador Stripe (Payment Links)
 *
 * Eventos usados:
 *   checkout.session.completed com payment_status 'paid' → approved (cartão)
 *   checkout.session.async_payment_succeeded             → approved (Pix)
 *   charge.refunded                                      → refunded
 *   charge.dispute.created                               → chargeback
 *   checkout.session.completed sem pagar ainda (Pix gerado) → pending (aviso no suporte)
 * Pix expirado é ignorado.
 */
const crypto = require('crypto');
const db = require('../../db');
const { getSecret } = require('../gateway-secrets');
const { kirvanoOfferFor } = require('../gateway-split');

const TOLERANCE_SEC = 5 * 60;

// Stripe-Signature: t=<unix>,v1=<hmac sha256 de "t.corpo">. Sem chave = rejeita.
async function validateStripeSignature(req, nowSec) {
    const secret = await getSecret('stripe');
    if (!secret || !req.rawBody) return false;
    const parts = String(req.headers['stripe-signature'] || '').split(',').map(p => p.trim().split('='));
    const t = (parts.find(p => p[0] === 't') || [])[1];
    const sigs = parts.filter(p => p[0] === 'v1').map(p => p[1]);
    if (!t || !sigs.length) return false;
    const now = nowSec || Math.floor(Date.now() / 1000);
    if (Math.abs(now - parseInt(t, 10)) > TOLERANCE_SEC) return false;
    const expected = Buffer.from(
        crypto.createHmac('sha256', secret).update(t + '.').update(req.rawBody).digest('hex')
    );
    return sigs.some(s => {
        const b = Buffer.from(String(s));
        return b.length === expected.length && crypto.timingSafeEqual(b, expected);
    });
}

function ignored(reason) { return { valid: false, ignored: true, reason }; }

async function fromSession(s, event) {
    const email = s.customer_details && s.customer_details.email || s.customer_email;
    const offer = s.payment_link ? await kirvanoOfferFor(s.payment_link) : null;
    if (!offer) return { valid: false, reason: `Link da Stripe não cadastrado no painel: ${s.payment_link || 'sem payment_link'}` };
    return {
        valid: true,
        data: {
            gateway: 'stripe',
            event: event || 'approved',
            payment: { method: 'pix', pix_code: null, pix_url: null },
            sale_id: s.payment_intent || s.id,
            sale_amount: (s.amount_total || 0) / 100,
            sale_net_amount: null,
            utm_content: s.client_reference_id ? String(s.client_reference_id).slice(0, 120) : null,
            customer: { email: email ? String(email).toLowerCase().trim() : null,
                        name: s.customer_details && s.customer_details.name || null, phone: null, document: null },
            items: [{ offer_id: offer, lookup_gateway: 'kirvano' }],
            raw: s,
        },
    };
}

// Reembolso/contestação não trazem o link: acha a venda pelo pagamento.
async function fromCharge(ch, event) {
    const pi = ch.payment_intent;
    if (!pi) return ignored('sem payment_intent');
    const { rows } = await db.query(
        `SELECT DISTINCT ua.email, po.offer_id, po.gateway AS offer_gateway
           FROM user_access ua JOIN product_offers po ON po.id = ua.offer_id
          WHERE ua.gateway = 'stripe' AND ua.sale_id = $1`, [pi]);
    if (!rows.length) return { valid: false, reason: `Venda Stripe não encontrada: ${pi}` };
    return {
        valid: true,
        data: {
            gateway: 'stripe', event, sale_id: pi,
            sale_amount: (ch.amount || 0) / 100, sale_net_amount: null, utm_content: null,
            customer: { email: rows[0].email, name: null, phone: null, document: null },
            items: rows.map(r => ({ offer_id: r.offer_id, lookup_gateway: r.offer_gateway })),
            raw: ch,
        },
    };
}

async function normalizeStripeEvent(evt) {
    const o = evt && evt.data && evt.data.object;
    if (!o) return { valid: false, reason: 'Evento sem objeto' };
    switch (evt.type) {
        case 'checkout.session.completed':
            return fromSession(o, o.payment_status === 'paid' ? 'approved' : 'pending');
        case 'checkout.session.async_payment_succeeded':
            return fromSession(o);
        case 'charge.refunded':
            return fromCharge(o, 'refunded');
        case 'charge.dispute.created':
            return fromCharge({ payment_intent: o.payment_intent, amount: o.amount }, 'chargeback');
        default:
            return ignored(`Evento ignorado: ${evt.type}`);
    }
}

module.exports = { validateStripeSignature, normalizeStripeEvent };
