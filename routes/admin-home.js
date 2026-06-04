/**
 * =============================================================================
 * routes/admin-home.js
 * =============================================================================
 * CRUD de:
 *   - Hero Slides (banner rotativo do topo)
 *   - Home Carousels (esteiras configuráveis)
 *   - Carousel Products (produtos dentro das esteiras)
 *
 * Regra: 1 produto pode estar em N esteiras (UNIQUE carousel_id+product_id no
 * banco — só impede duplicar na MESMA esteira).
 * =============================================================================
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const { logger } = require('../lib/logger');
const { requireAdmin } = require('../lib/auth');


// =============================================================================
// HERO SLIDES
// =============================================================================

// GET /api/admin/home/hero — lista todos os slides
router.get('/hero', requireAdmin, async (req, res) => {
    try {
        const { rows } = await db.query(`
            SELECT
                hs.id, hs.thumb_url, hs.title, hs.subtitle, hs.badge_text,
                hs.cta_text, hs.product_id, hs.display_order, hs.is_active,
                hs.created_at, hs.updated_at,
                p.name AS product_name,
                p.banner_url AS product_banner
            FROM hero_slides hs
            LEFT JOIN products p ON p.id = hs.product_id
            ORDER BY hs.display_order, hs.id
        `);
        return res.json({ success: true, slides: rows });
    } catch (err) {
        logger.error('Erro listando hero slides:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// POST /api/admin/home/hero — cria slide
router.post('/hero', requireAdmin, async (req, res) => {
    try {
        const { thumb_url, title, subtitle, badge_text, cta_text, product_id, is_active, variant_group, variant_weight } = req.body || {};
        
        if (!thumb_url || typeof thumb_url !== 'string' || thumb_url.trim().length < 5) {
            return res.status(400).json({ success: false, error: 'URL da thumb obrigatória' });
        }
        // title é OPCIONAL — hero pode ser banner 100% visual sem texto
        // product_id é OPCIONAL — slide pode ser banner visual sem vinculação
        let productIdInt = null;
        if (product_id !== null && product_id !== undefined && product_id !== '') {
            productIdInt = parseInt(product_id, 10);
            if (!productIdInt) {
                return res.status(400).json({ success: false, error: 'ID de produto inválido' });
            }
            const { rows: prodCheck } = await db.query('SELECT id FROM products WHERE id = $1', [productIdInt]);
            if (prodCheck.length === 0) {
                return res.status(400).json({ success: false, error: 'Produto não existe' });
            }
        }

        // Pega max display_order pra colocar no fim
        const { rows: orderRow } = await db.query('SELECT COALESCE(MAX(display_order), 0) + 1 as next FROM hero_slides');
        const displayOrder = orderRow[0].next;

        const baseValues = [
            thumb_url.trim(),
            (title || '').trim().slice(0, 200) || null,
            (subtitle || '').trim().slice(0, 200) || null,
            (badge_text || '').trim().slice(0, 80) || null,
            (cta_text || 'Descobrir').trim().slice(0, 50),
            productIdInt,
            displayOrder,
            is_active !== false,
        ];

        let rows;
        try {
            const result = await db.query(`
                INSERT INTO hero_slides (thumb_url, title, subtitle, badge_text, cta_text, product_id, display_order, is_active, variant_group, variant_weight)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                RETURNING *
            `, [
                ...baseValues,
                (variant_group || '').trim().slice(0, 40) || null,
                Math.max(1, Math.min(1000, parseInt(variant_weight, 10) || 100)),
            ]);
            rows = result.rows;
        } catch (insertErr) {
            // Fallback: colunas variant_group/variant_weight ainda não existem.
            // Insere sem elas (migration auto rodará no próximo restart).
            logger.warn('hero insert sem variant_group (provavel migration pendente):', insertErr.message);
            const result = await db.query(`
                INSERT INTO hero_slides (thumb_url, title, subtitle, badge_text, cta_text, product_id, display_order, is_active)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                RETURNING *
            `, baseValues);
            rows = result.rows;
        }
        return res.json({ success: true, slide: rows[0] });
    } catch (err) {
        logger.error('Erro criando hero slide:', err);
        return res.status(500).json({ success: false, error: err.message || 'Erro interno' });
    }
});

// PUT /api/admin/home/hero/:id — atualiza slide
router.put('/hero/:id', requireAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
        
        const { thumb_url, title, subtitle, badge_text, cta_text, product_id, is_active, variant_group, variant_weight } = req.body || {};
        const updates = [];
        const values = [];
        let p = 1;

        if (thumb_url !== undefined) { updates.push(`thumb_url = $${p++}`); values.push(thumb_url.trim()); }
        if (title !== undefined) { updates.push(`title = $${p++}`); values.push((title || '').trim().slice(0, 200) || null); }
        if (subtitle !== undefined) { updates.push(`subtitle = $${p++}`); values.push((subtitle || '').trim().slice(0, 200) || null); }
        if (badge_text !== undefined) { updates.push(`badge_text = $${p++}`); values.push((badge_text || '').trim().slice(0, 80) || null); }
        if (cta_text !== undefined) { updates.push(`cta_text = $${p++}`); values.push((cta_text || 'Descobrir').trim().slice(0, 50)); }
        if (product_id !== undefined) {
            if (product_id === null || product_id === '') {
                updates.push(`product_id = $${p++}`); values.push(null);
            } else {
                const pid = parseInt(product_id, 10);
                if (!pid) return res.status(400).json({ success: false, error: 'Produto inválido' });
                updates.push(`product_id = $${p++}`); values.push(pid);
            }
        }
        if (is_active !== undefined) { updates.push(`is_active = $${p++}`); values.push(!!is_active); }

        // variant_group/variant_weight: separa em outro array — se as colunas
        // não existirem ainda (migration pendente), faz UPDATE só com o resto.
        const variantUpdates = [];
        const variantValues = [];
        if (variant_group !== undefined) {
            variantUpdates.push(`variant_group`);
            variantValues.push((variant_group || '').trim().slice(0, 40) || null);
        }
        if (variant_weight !== undefined) {
            variantUpdates.push(`variant_weight`);
            variantValues.push(Math.max(1, Math.min(1000, parseInt(variant_weight, 10) || 100)));
        }

        if (updates.length === 0 && variantUpdates.length === 0) {
            return res.status(400).json({ success: false, error: 'Nada pra atualizar' });
        }

        // Tenta com variant_*; se falhar (coluna inexistente), faz só sem.
        const tryWith = async () => {
            const allUpdates = [...updates];
            const allValues = [...values];
            let pp = p;
            for (let i = 0; i < variantUpdates.length; i++) {
                allUpdates.push(`${variantUpdates[i]} = $${pp++}`);
                allValues.push(variantValues[i]);
            }
            allUpdates.push(`updated_at = NOW()`);
            allValues.push(id);
            return db.query(
                `UPDATE hero_slides SET ${allUpdates.join(', ')} WHERE id = $${pp} RETURNING *`,
                allValues
            );
        };

        let rows;
        try {
            const r = await tryWith();
            rows = r.rows;
        } catch (e) {
            logger.warn('hero update sem variant_*:', e.message);
            const baseUpdates = [...updates, `updated_at = NOW()`];
            const baseValues = [...values, id];
            const r = await db.query(
                `UPDATE hero_slides SET ${baseUpdates.join(', ')} WHERE id = $${baseValues.length} RETURNING *`,
                baseValues
            );
            rows = r.rows;
        }
        if (rows.length === 0) return res.status(404).json({ success: false, error: 'Slide não encontrado' });
        return res.json({ success: true, slide: rows[0] });
    } catch (err) {
        logger.error('Erro atualizando hero slide:', err);
        return res.status(500).json({ success: false, error: err.message || 'Erro interno' });
    }
});

// DELETE /api/admin/home/hero/:id
router.delete('/hero/:id', requireAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
        
        const { rowCount } = await db.query('DELETE FROM hero_slides WHERE id = $1', [id]);
        if (rowCount === 0) return res.status(404).json({ success: false, error: 'Slide não encontrado' });
        return res.json({ success: true, deleted: true });
    } catch (err) {
        logger.error('Erro deletando hero slide:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// POST /api/admin/home/hero/reorder — reordena slides
router.post('/hero/reorder', requireAdmin, async (req, res) => {
    try {
        const { ids } = req.body || {};
        if (!Array.isArray(ids)) {
            return res.status(400).json({ success: false, error: 'ids deve ser array' });
        }
        
        for (let i = 0; i < ids.length; i++) {
            const id = parseInt(ids[i], 10);
            if (!id) continue;
            await db.query('UPDATE hero_slides SET display_order = $1 WHERE id = $2', [i + 1, id]);
        }
        return res.json({ success: true });
    } catch (err) {
        logger.error('Erro reordenando hero:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// =============================================================================
// HOME CAROUSELS (esteiras)
// =============================================================================

// GET /api/admin/home/carousels — lista todas com seus produtos
router.get('/carousels', requireAdmin, async (req, res) => {
    try {
        // Busca esteiras
        const { rows: carousels } = await db.query(`
            SELECT id, title, subtitle, display_order, is_active, created_at
            FROM home_carousels
            ORDER BY display_order, id
        `);
        
        // Busca produtos de cada esteira em uma query só
        const { rows: products } = await db.query(`
            SELECT
                cp.id, cp.carousel_id, cp.product_id, cp.display_order,
                p.name, p.banner_url, p.price, p.is_active AS product_active
            FROM carousel_products cp
            INNER JOIN products p ON p.id = cp.product_id
            ORDER BY cp.carousel_id, cp.display_order, cp.id
        `);
        
        // Agrupa produtos por esteira
        const productsByCarousel = {};
        for (const p of products) {
            if (!productsByCarousel[p.carousel_id]) productsByCarousel[p.carousel_id] = [];
            productsByCarousel[p.carousel_id].push({
                id: p.id,
                product_id: p.product_id,
                display_order: p.display_order,
                name: p.name,
                banner_url: p.banner_url,
                price: p.price,
                product_active: p.product_active,
            });
        }
        
        const result = carousels.map(c => ({
            ...c,
            products: productsByCarousel[c.id] || [],
        }));
        
        return res.json({ success: true, carousels: result });
    } catch (err) {
        logger.error('Erro listando carousels:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// POST /api/admin/home/carousels — cria esteira
router.post('/carousels', requireAdmin, async (req, res) => {
    try {
        const { title, subtitle, is_active } = req.body || {};
        if (!title || typeof title !== 'string' || title.trim().length < 2) {
            return res.status(400).json({ success: false, error: 'Título obrigatório' });
        }
        
        const { rows: orderRow } = await db.query('SELECT COALESCE(MAX(display_order), 0) + 1 as next FROM home_carousels');
        const displayOrder = orderRow[0].next;
        
        const { rows } = await db.query(`
            INSERT INTO home_carousels (title, subtitle, display_order, is_active)
            VALUES ($1, $2, $3, $4)
            RETURNING *
        `, [
            title.trim().slice(0, 120),
            (subtitle || '').trim().slice(0, 200) || null,
            displayOrder,
            is_active !== false,
        ]);
        return res.json({ success: true, carousel: rows[0] });
    } catch (err) {
        logger.error('Erro criando carousel:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// PUT /api/admin/home/carousels/:id
router.put('/carousels/:id', requireAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
        
        const { title, subtitle, is_active } = req.body || {};
        const updates = [];
        const values = [];
        let p = 1;
        
        if (title !== undefined) { updates.push(`title = $${p++}`); values.push(title.trim().slice(0, 120)); }
        if (subtitle !== undefined) { updates.push(`subtitle = $${p++}`); values.push((subtitle || '').trim().slice(0, 200) || null); }
        if (is_active !== undefined) { updates.push(`is_active = $${p++}`); values.push(!!is_active); }
        
        if (updates.length === 0) return res.status(400).json({ success: false, error: 'Nada pra atualizar' });
        
        updates.push(`updated_at = NOW()`);
        values.push(id);
        
        const { rows } = await db.query(
            `UPDATE home_carousels SET ${updates.join(', ')} WHERE id = $${p} RETURNING *`,
            values
        );
        if (rows.length === 0) return res.status(404).json({ success: false, error: 'Esteira não encontrada' });
        return res.json({ success: true, carousel: rows[0] });
    } catch (err) {
        logger.error('Erro atualizando carousel:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// DELETE /api/admin/home/carousels/:id
router.delete('/carousels/:id', requireAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!id) return res.status(400).json({ success: false, error: 'ID inválido' });
        
        // CASCADE remove os carousel_products também
        const { rowCount } = await db.query('DELETE FROM home_carousels WHERE id = $1', [id]);
        if (rowCount === 0) return res.status(404).json({ success: false, error: 'Não encontrada' });
        return res.json({ success: true, deleted: true });
    } catch (err) {
        logger.error('Erro deletando carousel:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// POST /api/admin/home/carousels/reorder — reordena esteiras
router.post('/carousels/reorder', requireAdmin, async (req, res) => {
    try {
        const { ids } = req.body || {};
        if (!Array.isArray(ids)) {
            return res.status(400).json({ success: false, error: 'ids deve ser array' });
        }
        
        for (let i = 0; i < ids.length; i++) {
            const id = parseInt(ids[i], 10);
            if (!id) continue;
            await db.query('UPDATE home_carousels SET display_order = $1 WHERE id = $2', [i + 1, id]);
        }
        return res.json({ success: true });
    } catch (err) {
        logger.error('Erro reordenando carousels:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// =============================================================================
// CAROUSEL_PRODUCTS (gerencia produtos dentro de cada esteira)
// =============================================================================

// GET /api/admin/home/products-availability
// Retorna TODOS os produtos com a LISTA de esteiras em que cada um está.
// Produto pode estar em N esteiras — por isso 'carousels' é array.
router.get('/products-availability', requireAdmin, async (req, res) => {
    try {
        const { rows } = await db.query(`
            SELECT
                p.id, p.name, p.banner_url, p.price, p.is_active,
                COALESCE(
                    json_agg(
                        json_build_object('id', hc.id, 'title', hc.title)
                        ORDER BY hc.display_order
                    ) FILTER (WHERE hc.id IS NOT NULL),
                    '[]'
                ) AS carousels
            FROM products p
            LEFT JOIN carousel_products cp ON cp.product_id = p.id
            LEFT JOIN home_carousels hc ON hc.id = cp.carousel_id
            WHERE p.is_active = true
            GROUP BY p.id
            ORDER BY p.created_at DESC
        `);
        return res.json({ success: true, products: rows });
    } catch (err) {
        logger.error('Erro listando availability:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// POST /api/admin/home/carousels/:id/products — adiciona produto à esteira
// Se o produto já está em outra, MOVE pra essa.
router.post('/carousels/:id/products', requireAdmin, async (req, res) => {
    try {
        const carouselId = parseInt(req.params.id, 10);
        const productId = parseInt(req.body?.product_id, 10);
        
        if (!carouselId) return res.status(400).json({ success: false, error: 'Carousel ID inválido' });
        if (!productId) return res.status(400).json({ success: false, error: 'Product ID obrigatório' });
        
        // Verifica se esteira existe
        const { rows: carCheck } = await db.query('SELECT id FROM home_carousels WHERE id = $1', [carouselId]);
        if (carCheck.length === 0) return res.status(404).json({ success: false, error: 'Esteira não encontrada' });
        
        // Verifica se produto existe
        const { rows: prodCheck } = await db.query('SELECT id FROM products WHERE id = $1', [productId]);
        if (prodCheck.length === 0) return res.status(400).json({ success: false, error: 'Produto não existe' });
        
        // Pega próximo display_order dentro dessa esteira
        const { rows: orderRow } = await db.query(
            'SELECT COALESCE(MAX(display_order), 0) + 1 as next FROM carousel_products WHERE carousel_id = $1',
            [carouselId]
        );
        const displayOrder = orderRow[0].next;
        
        // INSERT ON CONFLICT — produto pode estar em N esteiras.
        // Conflito só acontece se já estiver NESTA mesma esteira: nesse caso, no-op.
        const { rows } = await db.query(`
            INSERT INTO carousel_products (carousel_id, product_id, display_order)
            VALUES ($1, $2, $3)
            ON CONFLICT (carousel_id, product_id) DO NOTHING
            RETURNING *
        `, [carouselId, productId, displayOrder]);

        if (rows.length === 0) {
            // Já estava nessa esteira — devolve o registro existente
            const { rows: existing } = await db.query(
                'SELECT * FROM carousel_products WHERE carousel_id = $1 AND product_id = $2',
                [carouselId, productId]
            );
            return res.json({ success: true, item: existing[0], alreadyPresent: true });
        }

        return res.json({ success: true, item: rows[0] });
    } catch (err) {
        logger.error('Erro adicionando produto à esteira:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// DELETE /api/admin/home/carousels/:id/products/:productId — remove
router.delete('/carousels/:id/products/:productId', requireAdmin, async (req, res) => {
    try {
        const carouselId = parseInt(req.params.id, 10);
        const productId = parseInt(req.params.productId, 10);
        if (!carouselId || !productId) return res.status(400).json({ success: false, error: 'IDs inválidos' });
        
        const { rowCount } = await db.query(
            'DELETE FROM carousel_products WHERE carousel_id = $1 AND product_id = $2',
            [carouselId, productId]
        );
        if (rowCount === 0) return res.status(404).json({ success: false, error: 'Não encontrado' });
        return res.json({ success: true, deleted: true });
    } catch (err) {
        logger.error('Erro removendo produto da esteira:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// POST /api/admin/home/carousels/:id/products/reorder
router.post('/carousels/:id/products/reorder', requireAdmin, async (req, res) => {
    try {
        const carouselId = parseInt(req.params.id, 10);
        const { product_ids } = req.body || {};
        
        if (!carouselId) return res.status(400).json({ success: false, error: 'Carousel ID inválido' });
        if (!Array.isArray(product_ids)) {
            return res.status(400).json({ success: false, error: 'product_ids deve ser array' });
        }
        
        for (let i = 0; i < product_ids.length; i++) {
            const pid = parseInt(product_ids[i], 10);
            if (!pid) continue;
            await db.query(
                'UPDATE carousel_products SET display_order = $1 WHERE carousel_id = $2 AND product_id = $3',
                [i + 1, carouselId, pid]
            );
        }
        return res.json({ success: true });
    } catch (err) {
        logger.error('Erro reordenando carousel products:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


module.exports = router;
