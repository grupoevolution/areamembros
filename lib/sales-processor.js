/**
 * =============================================================================
 * lib/sales-processor.js — Processador central de vendas
 * =============================================================================
 *
 * Recebe dados normalizados de qualquer gateway (Kirvano, PerfectPay, futuros)
 * e aplica a lógica de negócio: liberar acesso, revogar acesso, etc.
 *
 * Os adaptadores (kirvano.js e perfectpay.js) traduzem o payload específico
 * de cada gateway para o "formato normalizado" que esta função processa.
 *
 * Formato normalizado:
 *   {
 *     gateway: 'kirvano' | 'perfectpay',
 *     event: 'approved' | 'refunded' | 'chargeback' | 'canceled' | 'refused',
 *     sale_id: string,
 *     sale_amount: number,
 *     customer: { email, name, phone, document },
 *     items: [{ offer_id, offer_name, product_name }],
 *     raw: object  // payload original (guardado no log)
 *   }
 *
 * =============================================================================
 */

const db = require('../db');
const { logger } = require('./logger');


/**
 * Processa uma venda normalizada.
 *
 * @param {object} sale - Venda no formato normalizado
 * @returns {Promise<object>} Resumo do processamento
 */
async function processSale(sale) {
    const summary = {
        gateway: sale.gateway,
        event: sale.event,
        sale_id: sale.sale_id,
        email: sale.customer?.email,
        items_total: sale.items?.length || 0,
        items_processed: 0,
        accesses_granted: 0,
        accesses_revoked: 0,
        accesses_already_existed: 0,
        items_without_product: 0,
        granted_product_ids: [],
        errors: [],
    };
    
    // Eventos que não geram ação (só logamos)
    if (sale.event === 'refused') {
        logger.info(`Venda recusada ignorada (${sale.gateway} / ${sale.sale_id})`);
        return { ...summary, message: 'Venda recusada — sem ação' };
    }
    
    // Validação básica
    if (!sale.customer?.email) {
        summary.errors.push('Email do cliente ausente');
        return summary;
    }
    
    if (!sale.items || sale.items.length === 0) {
        summary.errors.push('Nenhum item na venda');
        return summary;
    }
    
    const email = sale.customer.email.toLowerCase().trim();

    // Garante que o cliente existe na tabela `customers`
    await upsertCustomer(sale.customer);

    // ─── PIX GERADO (pending): ajuda ATIVA pra pagar ─────────────────────────
    // Não libera nada — manda no chat de suporte a mensagem "você gerou o Pix,
    // só falta pagar" com o botão de copiar o código. Dedupe por venda na
    // tabela pix_pending_notices (o gateway reenvia pending em retry).
    if (sale.event === 'pending') {
        try {
            // Nome/ID do produto: prefere o cadastrado no painel; senão, o do gateway
            let productName = null, productId = null;
            try {
                const first = sale.items[0] || {};
                const { rows: [off] } = await db.query(
                    `SELECT p.id, p.name FROM product_offers po
                     LEFT JOIN products p ON p.id = po.product_id
                     WHERE po.gateway = $1 AND po.offer_id = $2 LIMIT 1`,
                    [sale.gateway, first.offer_id]
                );
                if (off) { productId = off.id || null; productName = off.name || null; }
                productName = productName || first.product_name || first.offer_name || null;
            } catch (_) {}

            const { rows: ins } = await db.query(
                `INSERT INTO pix_pending_notices (gateway, sale_id, customer_email, product_id, pix_code, amount)
                 VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (gateway, sale_id) DO NOTHING RETURNING id`,
                [
                    sale.gateway,
                    sale.sale_id || `sem_id_${Date.now()}`,
                    email,
                    productId,
                    sale.payment?.pix_code || null,
                    sale.sale_amount > 0 ? sale.sale_amount : null,
                ]
            );
            if (!ins.length) {
                return { ...summary, message: 'Pix pendente já notificado (dedupe)' };
            }

            const chatsApi = require('../routes/user-chats');
            if (typeof chatsApi.deliverPixPendingToSupport === 'function') {
                const delivered = await chatsApi.deliverPixPendingToSupport(email, {
                    product_name: productName,
                    amount: sale.sale_amount,
                    pix_code: sale.payment?.pix_code || null,
                    pix_url: sale.payment?.pix_url || null,
                });
                for (const s of delivered) {
                    try {
                        const { sendChatPush } = require('./chat-worker');
                        const firstBot = (s.messages || [])[0];
                        if (typeof sendChatPush === 'function') await sendChatPush(s.email, s.chat, firstBot);
                    } catch (_) {}
                }
            }
            logger.info(`Pix pendente notificado: ${sale.gateway}/${sale.sale_id} → ${email}`);
        } catch (err) {
            logger.warn('Pix pendente → suporte falhou: ' + err.message);
            summary.errors.push('pix pendente: ' + err.message);
        }
        return { ...summary, message: 'Pix pendente — ajuda de pagamento enviada' };
    }

    // Venda resolvida (pagou/cancelou/reembolsou): apaga o CÓDIGO do Pix
    // pendente — o popup "termina de pagar" some, mas a linha fica pra manter
    // o dedupe da mensagem de suporte caso o gateway reenvie o pending.
    if (sale.sale_id) {
        try {
            await db.query(
                `UPDATE pix_pending_notices SET pix_code = NULL WHERE gateway = $1 AND sale_id = $2`,
                [sale.gateway, sale.sale_id]
            );
        } catch (_) {}
    }

    // Processa cada item da venda
    for (const item of sale.items) {
        try {
            summary.items_processed++;
            
            // Busca o produto correspondente ao offer_id
            const { rows: [offer] } = await db.query(
                `SELECT po.id as offer_row_id, po.product_id, po.offer_name,
                        COALESCE(po.is_premium, false) AS is_premium,
                        p.name as product_name
                 FROM product_offers po
                 LEFT JOIN products p ON p.id = po.product_id
                 WHERE po.gateway = $1 AND po.offer_id = $2
                 LIMIT 1`,
                [sale.gateway, item.offer_id]
            );
            
            if (!offer) {
                summary.items_without_product++;
                summary.errors.push(
                    `Produto não configurado: ${sale.gateway}/${item.offer_id} (${item.offer_name || item.product_name || 'sem nome'})`
                );
                logger.warn(
                    `Webhook ${sale.gateway}: offer_id '${item.offer_id}' não tem produto configurado no admin`
                );
                continue;
            }
            
            // Baseado no evento, faz a ação correta
            if (sale.event === 'approved') {
                const result = await grantAccess({
                    email,
                    product_id: offer.product_id,
                    offer_row_id: offer.offer_row_id,
                    gateway: sale.gateway,
                    sale_id: sale.sale_id,
                    sale_amount: sale.sale_amount,
                    sale_net_amount: sale.sale_net_amount,
                    utm_content: sale.utm_content || null,
                });
                
                if (result.alreadyExisted) {
                    summary.accesses_already_existed++;
                } else {
                    summary.accesses_granted++;
                }
                // REENTREGA do mesmo webhook (mesmo gateway+sale_id+produto, flag
                // `duplicate` do grantAccess) NÃO entra no pós-venda: sem ela, o
                // retry do gateway duplicava a mensagem de "compra aprovada" no
                // suporte e inflava total_purchases/total_spent. Recompra real
                // (sale_id novo) não tem a flag e segue disparando normalmente.
                if (offer.product_id && !result.duplicate) summary.granted_product_ids.push(offer.product_id);

                // PREMIUM: oferta marcada como "leva tudo" libera também status
                // + vídeos + grupo VIP por tempo limitado. Os extras NÃO entram
                // em granted_product_ids (o pós-venda fala do Premium em si, não
                // manda 3 mensagens de produto).
                //
                // Roda TAMBÉM em reprocesso/reentrega (sem o gate !duplicate):
                // cada concessão tem dedupe próprio, e é isso que permite
                // liberar RETROATIVO — cliente que comprou o Premium antes da
                // oferta ser marcada ganha tudo reprocessando a venda no painel.
                if (offer.is_premium) {
                    // Selo Premium no PRÓPRIO acesso (metadata.premium): o app
                    // detecta por aqui OU pela oferta. O metadata sobrevive ao
                    // painel recriar as ofertas (salvar produto deleta+recria
                    // product_offers e órfã o ua.offer_id — só a oferta não basta).
                    try {
                        await db.query(
                            `UPDATE user_access SET metadata = metadata || '{"premium": true}'::jsonb
                             WHERE gateway = $1 AND sale_id = $2 AND product_id IS NOT DISTINCT FROM $3`,
                            [sale.gateway, sale.sale_id, offer.product_id]
                        );
                    } catch (_) {}
                    try {
                        const extras = await grantPremiumExtras({
                            email,
                            gateway: sale.gateway,
                            sale_id: sale.sale_id,
                            offer_row_id: offer.offer_row_id,
                        });
                        if (extras.length) {
                            summary.premium_extras = extras;
                            logger.info(`Premium ${sale.gateway}/${sale.sale_id}: extras liberados → produtos [${extras.join(', ')}]`);
                        }
                    } catch (err) { logger.warn('extras do Premium falharam: ' + err.message); }
                } else if (offer.product_id) {
                    // Venda NÃO-Premium renovando o mesmo acesso: desliga o selo
                    // (cliente Premium que renovou como VIP volta a ser prata).
                    try {
                        await db.query(
                            `UPDATE user_access SET metadata = metadata || '{"premium": false}'::jsonb
                             WHERE gateway = $1 AND sale_id = $2 AND product_id = $3
                               AND metadata->>'premium' = 'true'`,
                            [sale.gateway, sale.sale_id, offer.product_id]
                        );
                    } catch (_) {}
                }
            } else if (['refunded', 'chargeback', 'canceled'].includes(sale.event)) {
                const result = await revokeAccess({
                    email,
                    product_id: offer.product_id,
                    gateway: sale.gateway,
                    sale_id: sale.sale_id,
                    reason: sale.event,
                });
                
                if (result.revoked) {
                    summary.accesses_revoked++;
                }
            }
        } catch (err) {
            logger.error(`Erro processando item da venda ${sale.sale_id}:`, err);
            summary.errors.push(`Item ${item.offer_id}: ${err.message}`);
        }
    }
    
    // Extras do PREMIUM caem junto com a venda: o loop acima revoga só o
    // produto de cada item (o chat); os acessos-bônus (status/vídeos/grupo VIP)
    // foram gravados com o MESMO gateway+sale_id e metadata.premium_extra.
    if (['refunded', 'chargeback', 'canceled'].includes(sale.event) && sale.sale_id) {
        try {
            const statusMap = { refunded: 'refunded', chargeback: 'chargeback', canceled: 'expired' };
            const { rowCount } = await db.query(
                `UPDATE user_access
                 SET status = $1, revoked_at = NOW(), revoke_reason = $2
                 WHERE gateway = $3 AND sale_id = $4 AND status = 'active'
                   AND (metadata->>'premium_extra') = 'true'`,
                [statusMap[sale.event] || 'manually_revoked',
                 `Extra do Premium revogado junto com a venda (${sale.event})`,
                 sale.gateway, sale.sale_id]
            );
            if (rowCount > 0) summary.accesses_revoked += rowCount;
        } catch (_) {}
    }

    // Pós-venda: dispara em TODA venda aprovada que casou um produto —
    // INCLUSIVE recompra/renovação (onde o acesso já existia, então
    // accesses_granted fica 0). Antes o gate era accesses_granted > 0 e
    // pulava a recompra: cliente que renovava não recebia a mensagem de
    // pós-compra nem tinha total_purchases/total_spent atualizados.
    if (sale.event === 'approved' && summary.granted_product_ids.length > 0) {
        await db.query(
            `UPDATE customers
             SET total_purchases = total_purchases + 1,
                 total_spent = total_spent + $1
             WHERE LOWER(email) = $2`,
            [sale.sale_amount || 0, email]
        );

        // Funil: lead virou CLIENTE → cancela os pushes de venda pendentes
        // dele (a sequência de re-engajamento não deve cobrar quem já comprou).
        try {
            await db.query(
                `UPDATE funnel_scheduled_pushes SET status = 'canceled'
                 WHERE LOWER(customer_email) = $1 AND status = 'pending'`,
                [email]
            );
        } catch (_) { /* tabela pode não existir em banco antigo — inofensivo */ }

        // Pós-compra: dispara o roteiro dos chats vinculados ao(s) produto(s)
        // comprado(s) e manda push de "ela te mandou mensagem".
        try {
            const chatsApi = require('../routes/user-chats');
            if (typeof chatsApi.triggerPostPurchaseChats === 'function' && summary.granted_product_ids.length) {
                const started = await chatsApi.triggerPostPurchaseChats(email, summary.granted_product_ids);
                for (const s of started) {
                    try {
                        const { sendChatPush } = require('./chat-worker');
                        const firstBot = (s.messages || []).find(m => m.sender === 'bot') || s.messages[0];
                        if (typeof sendChatPush === 'function') await sendChatPush(s.email, s.chat, firstBot);
                    } catch (_) {}
                }
            }
        } catch (err) { logger.warn('pós-compra chat falhou: ' + err.message); }

        // Entrega no chat de SUPORTE (mensagem de pós-compra do produto) — aditivo
        // ao WhatsApp, dispara em TODA venda aprovada (inclusive recompra).
        try {
            const chatsApi = require('../routes/user-chats');
            if (typeof chatsApi.deliverPurchaseToSupport === 'function' && summary.granted_product_ids.length) {
                const delivered = await chatsApi.deliverPurchaseToSupport(email, summary.granted_product_ids);
                for (const s of delivered) {
                    try {
                        const { sendChatPush } = require('./chat-worker');
                        const firstBot = (s.messages || []).find(m => m.sender === 'bot') || s.messages[0];
                        if (typeof sendChatPush === 'function') await sendChatPush(s.email, s.chat, firstBot);
                    } catch (_) {}
                }
            }
        } catch (err) { logger.warn('entrega no suporte falhou: ' + err.message); }
    }

    logger.info(
        `Venda processada: ${sale.gateway}/${sale.sale_id} - ` +
        `${summary.accesses_granted} liberado(s), ${summary.accesses_revoked} revogado(s), ` +
        `${summary.accesses_already_existed} já existente(s)`
    );
    
    return summary;
}


// =============================================================================
// PREMIUM — o plano "leva tudo" (jul/2026)
// =============================================================================
// A oferta do plano Premium (product_offers.is_premium) libera, além do produto
// dela (o chat), os EXTRAS: status (is_story_plan), vídeos (explore_config) e o
// grupo VIP (groups.pinned) por PREMIUM_GROUP_DAYS dias. Regras:
//   - status/vídeos herdam a VALIDADE da oferta Premium (mensal → 33 dias etc.;
//     oferta sem validade → extras vitalícios).
//   - quem JÁ tem o extra por compra própria NÃO é tocado (não rebaixa um
//     vitalício avulso pra validade do Premium).
//   - reembolso/cancelamento da venda Premium derruba os extras junto (mesmo
//     gateway+sale_id, metadata.premium_extra).
const PREMIUM_GROUP_DAYS = 7;

async function premiumExtraTargets() {
    const targets = [];
    try {
        const { rows } = await db.query(
            `SELECT id FROM products WHERE is_story_plan = true AND is_active = true ORDER BY id LIMIT 1`
        );
        if (rows.length) targets.push({ product_id: rows[0].id, kind: 'story', days: null });
    } catch (_) {}
    try {
        const { rows } = await db.query(`SELECT value FROM gamification_config WHERE key = 'explore_config'`);
        const cfg = rows[0]?.value || {};
        let pid = cfg.product_id ? parseInt(cfg.product_id, 10) : null;
        // Produto interno (chat/status) nunca é "o produto dos vídeos" — sem
        // este guarda o extra apontava pro próprio chat e não liberava nada.
        if (pid) {
            const { rows: [pp] } = await db.query(
                `SELECT 1 FROM products WHERE id = $1
                   AND (COALESCE(is_chat_plan, false) = true OR COALESCE(is_story_plan, false) = true)`,
                [pid]
            );
            if (pp) pid = null;
        }
        if (!pid && cfg.unlock_offer_codes) {
            const codes = String(cfg.unlock_offer_codes).split(',').map(s => s.trim()).filter(Boolean).slice(0, 50);
            if (codes.length) {
                const { rows: po } = await db.query(
                    `SELECT po.product_id FROM product_offers po
                     JOIN products p ON p.id = po.product_id
                     WHERE po.offer_id = ANY($1::text[]) AND po.product_id IS NOT NULL
                       AND COALESCE(p.is_chat_plan, false) = false
                       AND COALESCE(p.is_story_plan, false) = false
                     LIMIT 1`,
                    [codes]
                );
                if (po.length) pid = po[0].product_id;
            }
        }
        if (pid) targets.push({ product_id: pid, kind: 'explore', days: null });
    } catch (_) {}
    try {
        const { rows } = await db.query(
            `SELECT product_id FROM groups WHERE pinned = true AND active = true AND product_id IS NOT NULL ORDER BY id LIMIT 1`
        );
        if (rows.length) targets.push({ product_id: rows[0].product_id, kind: 'vip_group', days: PREMIUM_GROUP_DAYS });
    } catch (_) {}
    return targets;
}

async function grantPremiumExtras({ email, gateway, sale_id, offer_row_id }) {
    let offerDays = null;
    try {
        const { rows: [off] } = await db.query(`SELECT duration_days FROM product_offers WHERE id = $1`, [offer_row_id]);
        if (off && off.duration_days > 0) offerDays = parseInt(off.duration_days, 10);
    } catch (_) {}
    const granted = [];
    for (const t of await premiumExtraTargets()) {
        try {
            const days = t.days != null ? t.days : offerDays;
            const ok = await grantExtraAccess({ email, product_id: t.product_id, gateway, sale_id, offer_row_id, days, kind: t.kind });
            if (ok) granted.push(t.product_id);
        } catch (err) { logger.warn(`Premium extra '${t.kind}' falhou: ` + err.message); }
    }
    return granted;
}

async function grantExtraAccess({ email, product_id, gateway, sale_id, offer_row_id, days, kind }) {
    // Reentrega do mesmo sale pro mesmo produto → já concedido, não repete
    if (sale_id) {
        const { rows: [dup] } = await db.query(
            `SELECT id FROM user_access WHERE gateway = $1 AND sale_id = $2 AND product_id = $3 LIMIT 1`,
            [gateway, sale_id, product_id]
        );
        if (dup) return false;
    }
    // Já tem acesso VÁLIDO por conta própria → não mexe (não rebaixa validade)
    const { rows: [own] } = await db.query(
        `SELECT 1 FROM user_access WHERE LOWER(email) = $1 AND product_id = $2 AND status = 'active'
          AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1`,
        [email, product_id]
    );
    if (own) return false;

    const expiresSql = (days && days > 0) ? `NOW() + make_interval(days => ${parseInt(days, 10)})` : 'NULL';
    const meta = JSON.stringify({ premium_extra: true, premium_kind: kind, at: new Date().toISOString() });

    // Linha morta (vencida/expirada) do mesmo produto → renova ela (o índice
    // único de 'active' não deixa duas ativas do mesmo produto)
    const { rows: [existing] } = await db.query(
        `SELECT id FROM user_access WHERE LOWER(email) = $1 AND product_id = $2 AND status IN ('active', 'expired')
         ORDER BY (status = 'active') DESC, id DESC LIMIT 1`,
        [email, product_id]
    );
    if (existing) {
        await db.query(
            `UPDATE user_access
             SET gateway = $1, sale_id = $2, offer_id = $3, granted_at = NOW(), status = 'active',
                 revoked_at = NULL, revoke_reason = NULL, expires_at = ${expiresSql},
                 metadata = metadata || $4::jsonb
             WHERE id = $5`,
            [gateway, sale_id, offer_row_id, meta, existing.id]
        );
        return true;
    }
    await db.query(
        `INSERT INTO user_access (email, product_id, offer_id, gateway, sale_id, status, granted_by, expires_at, metadata)
         VALUES ($1, $2, $3, $4, $5, 'active', 'premium', ${expiresSql}, $6::jsonb)`,
        [email, product_id, offer_row_id, gateway, sale_id, meta]
    );
    return true;
}

/**
 * Insere ou atualiza cliente na tabela customers.
 */
async function upsertCustomer(customer) {
    const email = customer.email.toLowerCase().trim();
    
    await db.query(
        `INSERT INTO customers (email, name, phone, document)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (email) DO UPDATE SET
             name = COALESCE(EXCLUDED.name, customers.name),
             phone = COALESCE(EXCLUDED.phone, customers.phone),
             document = COALESCE(EXCLUDED.document, customers.document),
             updated_at = NOW()`,
        [
            email,
            customer.name || null,
            customer.phone || null,
            customer.document || null,
        ]
    );
}


/**
 * Libera acesso pra um cliente a um produto.
 *
 * Comportamento depende de products.product_type:
 *   - 'content' (default/legado): UPSERT — segunda compra atualiza o acesso
 *     existente, mantém histórico no metadata.last_sale.
 *   - 'video_call': SEMPRE cria acesso novo. Marca o anterior (se houver)
 *     como 'replaced' dentro da MESMA transação. Isso porque cada compra
 *     de produto-chamada vale 1 nova oportunidade de assistir, e o
 *     customer_call_history é amarrado ao user_access_id específico.
 *
 * Idempotente: webhook duplicado do MESMO sale_id não dispara compra dupla
 * (o caller normalmente desduplica antes via webhook_logs; aqui dentro o
 * pior caso é grantAccess rodar 2x → cria 2 acessos novos pro mesmo sale,
 * o que é raro mas tolerável — o /library mostra o mais recente).
 */
async function grantAccess({ email, product_id, offer_row_id, gateway, sale_id, sale_amount, sale_net_amount, utm_content }) {
    // ─── Idempotência por (gateway, sale_id, produto) ────────────────────────
    // O gateway reenvia o MESMO webhook em caso de timeout/retry. Uma recompra
    // real SEMPRE tem um sale_id novo, então se já existe um acesso com este
    // mesmo (gateway, sale_id) PRO MESMO PRODUTO — qualquer status — é
    // reentrega: não cria acesso novo. O filtro por produto é OBRIGATÓRIO:
    // venda com order bump tem VÁRIOS itens no mesmo sale_id — sem ele, o
    // primeiro item liberado fazia os demais parecerem "duplicados" e o
    // cliente nunca recebia o bump.
    if (sale_id) {
        const { rows: [dup] } = await db.query(
            `SELECT id FROM user_access
             WHERE gateway = $1 AND sale_id = $2 AND product_id IS NOT DISTINCT FROM $3
             ORDER BY id DESC LIMIT 1`,
            [gateway, sale_id, product_id]
        );
        if (dup) {
            logger.info(`grantAccess idempotente: ${gateway}/${sale_id}/produto ${product_id} já processado (acesso ${dup.id})`);
            return { alreadyExisted: true, accessId: dup.id, duplicate: true };
        }
    }

    // Descobre o tipo do produto (afeta a estratégia de granting)
    const { rows: [product] } = await db.query(
        `SELECT COALESCE(product_type, 'content') AS product_type
         FROM products WHERE id = $1 LIMIT 1`,
        [product_id]
    );
    const productType = product?.product_type || 'content';

    // ─── Produto-chamada: cada compra = novo acesso ──────────────────────────
    if (productType === 'video_call') {
        const accessId = await db.transaction(async (client) => {
            // Marca acesso ativo anterior (se existir) como 'replaced'.
            // Necessário porque user_access tem UNIQUE(LOWER(email), product_id)
            // WHERE status='active' — não dá pra ter 2 ativos do mesmo produto.
            await client.query(
                `UPDATE user_access
                 SET status = 'replaced',
                     revoked_at = NOW(),
                     revoke_reason = $1,
                     metadata = metadata || $2::jsonb
                 WHERE LOWER(email) = $3
                   AND product_id = $4
                   AND status = 'active'`,
                [
                    `Substituído por recompra (sale: ${sale_id})`,
                    JSON.stringify({ replaced_by: { gateway, sale_id, at: new Date().toISOString() } }),
                    email,
                    product_id,
                ]
            );

            // Insere novo acesso ativo
            const { rows: [newAccess] } = await client.query(
                `INSERT INTO user_access (
                    email, product_id, offer_id, gateway, sale_id, sale_amount, net_amount,
                    status, granted_by, metadata
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', 'webhook', $8::jsonb)
                RETURNING id`,
                [
                    email,
                    product_id,
                    offer_row_id,
                    gateway,
                    sale_id,
                    sale_amount,
                    sale_net_amount,
                    JSON.stringify({
                        granted_via: 'webhook',
                        product_type: 'video_call',
                        at: new Date().toISOString(),
                    })
                ]
            );

            return newAccess.id;
        });

        return { alreadyExisted: false, accessId };
    }

    // ─── Validade da oferta (assinaturas) ────────────────────────────────────
    // duration_days no código da oferta: mensal 33, trimestral 95, NULL =
    // vitalício. Cada cobrança RENOVA a validade (expires_at = NOW() + dias) —
    // inclusive num acesso expirado, que volta a ficar 'active' de novo.
    let expiresAt = null;
    if (offer_row_id) {
        try {
            const { rows: [off] } = await db.query(
                `SELECT duration_days FROM product_offers WHERE id = $1 LIMIT 1`, [offer_row_id]
            );
            if (off && off.duration_days > 0) expiresAt = off.duration_days;
        } catch (_) {}
    }
    const expiresSql = expiresAt ? `NOW() + make_interval(days => ${parseInt(expiresAt, 10)})` : 'NULL';

    // ─── Conteúdo (default/legado): UPSERT — cobrança nova renova a validade ──
    // Pega também acesso 'expired' (assinatura vencida que renovou): reativa.
    const { rows: [existing] } = await db.query(
        `SELECT id FROM user_access
         WHERE LOWER(email) = $1 AND product_id = $2 AND status IN ('active', 'expired')
         ORDER BY (status = 'active') DESC, id DESC
         LIMIT 1`,
        [email, product_id]
    );

    if (existing) {
        // Atualiza metadados + RENOVA validade e reativa se estava expirado
        await db.query(
            `UPDATE user_access
             SET gateway = $1,
                 sale_id = $2,
                 sale_amount = $3,
                 net_amount = $4,
                 offer_id = $5,
                 granted_at = NOW(),
                 status = 'active',
                 revoked_at = NULL,
                 revoke_reason = NULL,
                 expires_at = ${expiresSql},
                 metadata = metadata || $6::jsonb
             WHERE id = $7`,
            [
                gateway,
                sale_id,
                sale_amount,
                sale_net_amount,
                offer_row_id,
                JSON.stringify({ last_sale: { gateway, sale_id, net_amount: sale_net_amount, at: new Date().toISOString() } }),
                existing.id
            ]
        );
        return { alreadyExisted: true, accessId: existing.id };
    }

    // Cria novo acesso (com validade da oferta, quando houver)
    const { rows: [newAccess] } = await db.query(
        `INSERT INTO user_access (
            email, product_id, offer_id, gateway, sale_id, sale_amount, net_amount,
            status, granted_by, expires_at, metadata, utm_content
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', 'webhook', ${expiresSql}, $8::jsonb, $9)
        RETURNING id`,
        [
            email,
            product_id,
            offer_row_id,
            gateway,
            sale_id,
            sale_amount,
            sale_net_amount,
            JSON.stringify({ granted_via: 'webhook', net_amount: sale_net_amount, at: new Date().toISOString() }),
            utm_content || null,
        ]
    );

    return { alreadyExisted: false, accessId: newAccess.id };
}


/**
 * Revoga acesso de um cliente a um produto.
 */
async function revokeAccess({ email, product_id, gateway, sale_id, reason }) {
    const statusMap = {
        refunded: 'refunded',
        chargeback: 'chargeback',
        canceled: 'expired',
    };
    
    const newStatus = statusMap[reason] || 'manually_revoked';
    
    // Só derruba o acesso se ele ainda for DESTA venda. Na renovação, o
    // grantAccess atualiza a MESMA linha com o sale_id novo — então reembolso
    // da venda ANTIGA não pode matar o acesso que a renovação paga sustenta.
    // sale_id NULL (acesso legado/sem venda amarrada) mantém o comportamento
    // antigo: reembolso do produto revoga.
    const { rowCount } = await db.query(
        `UPDATE user_access
         SET status = $1,
             revoked_at = NOW(),
             revoke_reason = $2,
             metadata = metadata || $3::jsonb
         WHERE LOWER(email) = $4
           AND product_id = $5
           AND status = 'active'
           AND (sale_id IS NULL OR sale_id = $6)`,
        [
            newStatus,
            `Webhook ${gateway}: ${reason} (sale: ${sale_id})`,
            JSON.stringify({ revoke: { gateway, sale_id, reason, at: new Date().toISOString() } }),
            email,
            product_id,
            sale_id || null,
        ]
    );

    // BRINDE do mesmo produto também cai: /library, Explorar etc. aceitam
    // gifts como posse — sem isso, o cliente reembolsado continuava com o
    // acesso pelo brinde, mesmo com o user_access revogado. Só quando o
    // acesso caiu de fato — se a venda reembolsada era a antiga (renovação
    // ativa segurou o acesso), o cliente segue pagante e mantém o brinde.
    if (rowCount > 0) {
        try {
            await db.query(
                `UPDATE gifts
                 SET status = 'revoked',
                     revoked_at = NOW(),
                     metadata = metadata || $3::jsonb
                 WHERE LOWER(email) = $1 AND product_id = $2 AND status = 'active'`,
                [
                    email,
                    product_id,
                    JSON.stringify({ revoke: { gateway, sale_id, reason, at: new Date().toISOString() } }),
                ]
            );
        } catch (_) { /* tabela gifts pode não existir em banco antigo */ }
    }

    return { revoked: rowCount > 0 };
}


// ── BACKFILL do Premium (roda em todo boot, idempotente e barato) ────────────
// Compras do Premium feitas ANTES da oferta ser marcada: aplica o selo
// (metadata.premium) e concede os extras (status/vídeos/grupo VIP) agora.
// Depois da primeira passada não sobra nada pra fazer (0 linhas).
async function backfillPremiumAccesses() {
    try {
        // Pega TODO Premium válido (pela oferta OU pelo selo) — não só os sem
        // selo. Assim, se algum extra ficou faltando (ex.: o produto dos
        // vídeos foi resolvido errado numa rodada anterior), o boot completa.
        // As concessões são idempotentes: quem já tem tudo não gera escrita.
        const { rows } = await db.query(
            `SELECT ua.id, ua.email, ua.gateway, ua.sale_id, ua.offer_id AS offer_row_id,
                    (COALESCE(ua.metadata->>'premium', '') = 'true') AS stamped
             FROM user_access ua
             JOIN products p ON p.id = ua.product_id AND p.is_chat_plan = true
             LEFT JOIN product_offers po ON po.id = ua.offer_id
             WHERE ua.status = 'active'
               AND (ua.expires_at IS NULL OR ua.expires_at > NOW())
               AND (COALESCE(po.is_premium, false) = true OR ua.metadata->>'premium' = 'true')`
        );
        let touched = 0;
        for (const r of rows) {
            if (!r.stamped) {
                await db.query(
                    `UPDATE user_access SET metadata = metadata || '{"premium": true}'::jsonb WHERE id = $1`,
                    [r.id]
                );
            }
            try {
                const extras = await grantPremiumExtras({ email: r.email, gateway: r.gateway, sale_id: r.sale_id, offer_row_id: r.offer_row_id });
                if (extras.length || !r.stamped) {
                    touched++;
                    logger.info(`[premium-backfill] ${r.email}: ${!r.stamped ? 'selo dourado' : ''}${!r.stamped && extras.length ? ' + ' : ''}${extras.length ? 'extras [' + extras.join(', ') + ']' : ''} aplicado(s)`);
                }
            } catch (e) { logger.warn(`[premium-backfill] extras de ${r.email} falharam: ` + e.message); }
        }
        if (touched) logger.info(`[premium-backfill] ${touched} compra(s) Premium regularizadas`);
    } catch (e) { logger.warn('[premium-backfill] falhou: ' + e.message); }
}

// Erros TRANSITÓRIOS de item (ex.: banco piscou no meio do grantAccess — o
// catch do loop guarda "Item <offer_id>: <erro>"). Uma venda com item desses
// NÃO pode ser marcada como processada: o painel precisa enxergar a falha e o
// gateway precisa reenviar. "Produto não configurado" NÃO entra aqui — tem
// fluxo próprio (venda órfã + Reprocessar no painel).
function saleItemFailures(summary) {
    return ((summary && summary.errors) || []).filter(e => String(e).startsWith('Item '));
}

module.exports = {
    processSale,
    grantAccess,
    revokeAccess,
    backfillPremiumAccesses,
    saleItemFailures,
};
