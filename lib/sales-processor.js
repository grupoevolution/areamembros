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
async function grantAccess({ email, product_id, offer_row_id, gateway, sale_id, sale_amount, sale_net_amount }) {
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
            status, granted_by, expires_at, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', 'webhook', ${expiresSql}, $8::jsonb)
        RETURNING id`,
        [
            email,
            product_id,
            offer_row_id,
            gateway,
            sale_id,
            sale_amount,
            sale_net_amount,
            JSON.stringify({ granted_via: 'webhook', net_amount: sale_net_amount, at: new Date().toISOString() })
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
    
    const { rowCount } = await db.query(
        `UPDATE user_access
         SET status = $1,
             revoked_at = NOW(),
             revoke_reason = $2,
             metadata = metadata || $3::jsonb
         WHERE LOWER(email) = $4
           AND product_id = $5
           AND status = 'active'`,
        [
            newStatus,
            `Webhook ${gateway}: ${reason} (sale: ${sale_id})`,
            JSON.stringify({ revoke: { gateway, sale_id, reason, at: new Date().toISOString() } }),
            email,
            product_id,
        ]
    );

    // BRINDE do mesmo produto também cai: /library, Explorar etc. aceitam
    // gifts como posse — sem isso, o cliente reembolsado continuava com o
    // acesso pelo brinde, mesmo com o user_access revogado.
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

    return { revoked: rowCount > 0 };
}


module.exports = {
    processSale,
    grantAccess,
    revokeAccess,
};
