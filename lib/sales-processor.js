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
    
    // Atualiza totais do cliente (se foi venda aprovada)
    if (sale.event === 'approved' && summary.accesses_granted > 0) {
        await db.query(
            `UPDATE customers 
             SET total_purchases = total_purchases + 1,
                 total_spent = total_spent + $1
             WHERE LOWER(email) = $2`,
            [sale.sale_amount || 0, email]
        );
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
    // ─── Idempotência por (gateway, sale_id) ─────────────────────────────────
    // O gateway reenvia o MESMO webhook em caso de timeout/retry. Uma recompra
    // real SEMPRE tem um sale_id novo, então se já existe um acesso com este
    // mesmo (gateway, sale_id) — qualquer status — é reentrega: não cria acesso
    // novo (evita crédito duplicado em produto-chamada e linha duplicada em
    // conteúdo). Retorna como "já existia" pra não inflar métricas.
    if (sale_id) {
        const { rows: [dup] } = await db.query(
            `SELECT id FROM user_access
             WHERE gateway = $1 AND sale_id = $2
             ORDER BY id DESC LIMIT 1`,
            [gateway, sale_id]
        );
        if (dup) {
            logger.info(`grantAccess idempotente: ${gateway}/${sale_id} já processado (acesso ${dup.id})`);
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

    // ─── Conteúdo (default/legado): UPSERT inalterado ────────────────────────
    const { rows: [existing] } = await db.query(
        `SELECT id FROM user_access
         WHERE LOWER(email) = $1 AND product_id = $2 AND status = 'active'
         LIMIT 1`,
        [email, product_id]
    );

    if (existing) {
        // Atualiza metadados do acesso existente (novo sale_id, etc)
        await db.query(
            `UPDATE user_access
             SET gateway = $1,
                 sale_id = $2,
                 sale_amount = $3,
                 net_amount = $4,
                 offer_id = $5,
                 granted_at = NOW(),
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

    // Cria novo acesso
    const { rows: [newAccess] } = await db.query(
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
    
    return { revoked: rowCount > 0 };
}


module.exports = {
    processSale,
    grantAccess,
    revokeAccess,
};
