/**
 * =============================================================================
 * routes/user-roulette.js — ROLETA VIP (lado do cliente)
 * =============================================================================
 *
 * O QUE É (em português de gente):
 *   O cliente toca no banner dourado "ROLETA VIP" em Minhas Compras, gira uma
 *   roleta e leva um prêmio de verdade na hora.
 *
 * QUANTOS GIROS: 1 giro grátis POR E-MAIL NA VIDA (não é 1 por dia). Depois
 *   desse, só ganha giro convidando gente nova pelo link (+1 por visitante
 *   novo, teto de 3 por dia) ou tirando "+1 GIRO" na própria roda.
 *
 * O QUE SAI DE VERDADE (só isso):
 *   - CHAMADA DE VÍDEO  → ele escolhe 1 entre até 3 modelos e o acesso cai
 *                         em "Minhas Compras" (mesmo fluxo da compra).
 *   - CONTEÚDO SECRETO  → acesso ao produto de conteúdo configurado.
 *   - +1 GIRO           → ganha mais um giro e gira de novo na hora.
 *
 * O QUE NUNCA SAI (é só decoração pra roda ficar tentadora):
 *   ★ R$ 1.000, ACESSO VIP, PREMIUM, GRUPOS LIBERADOS.
 *
 * REGRA DE OURO DE SEGURANÇA: prêmio vale dinheiro, então QUEM SORTEIA É O
 * SERVIDOR. O app só anima a roda até a fatia que o servidor mandou. Nada do
 * que o cliente envia decide prêmio.
 *
 * =============================================================================
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../db');
const { logger } = require('../lib/logger');
const { requireUser } = require('../lib/user-auth');

// Pesos do sorteio (o 1º giro da vida do cliente é SEMPRE 'call', programado)
const WEIGHTS = { call: 45, content: 30, spin: 25 };

// Teto de segurança: no máximo 5 prêmios "+1 GIRO" por dia por e-mail.
// Sem isso, uma sequência de sorte vira giro infinito.
const MAX_SPIN_PRIZES_PER_DAY = 5;

// Teto de giros creditados por convite, por dia
const MAX_REF_CREDITS_PER_DAY = 3;

// "Hoje" sempre no fuso de Brasília (igual ao resto do sistema)
const TODAY_BR = `(NOW() AT TIME ZONE 'America/Sao_Paulo')::date`;


// ─────────────────────────────────────────────────────────────────────────────
// CONFIG (gamification_config → key 'roulette')
// ─────────────────────────────────────────────────────────────────────────────
async function loadConfig() {
    const fallback = {
        enabled: false, popup_enabled: true, popup_delay_sec: 5, call_product_ids: [],
        content_product_id: null, no_spins_reminder_days: 3,
    };
    try {
        const { rows } = await db.query(`SELECT value FROM gamification_config WHERE key = 'roulette'`);
        const v = rows[0]?.value || {};
        // Lembrete pra quem está SEM giro (tela de compartilhar). 0 = nunca.
        // Ausente no config antigo → 3 dias (padrão combinado com o dono).
        const rem = (v.no_spins_reminder_days === null || v.no_spins_reminder_days === undefined)
            ? 3 : parseInt(v.no_spins_reminder_days, 10);
        return {
            enabled: v.enabled === true,
            // A roleta abre sozinha em 2 momentos (decisão do dono): ao entrar
            // no CATÁLOGO e ao VOLTAR do checkout sem comprar (carrinho
            // abandonado). O banner de Minhas Compras continua sendo o caminho
            // pra abrir quando ele quiser. Ausente = LIGADO.
            popup_enabled: v.popup_enabled !== false,
            popup_delay_sec: Math.max(0, Math.min(120, parseInt(v.popup_delay_sec, 10) || 5)),
            call_product_ids: (Array.isArray(v.call_product_ids) ? v.call_product_ids : [])
                .map(n => parseInt(n, 10)).filter(Boolean).slice(0, 3),
            content_product_id: parseInt(v.content_product_id, 10) || null,
            no_spins_reminder_days: Math.max(0, Math.min(60, isNaN(rem) ? 3 : rem)),
        };
    } catch (err) {
        logger.warn('[roleta] falha lendo config:', err.message);
        return fallback;
    }
}

// A roleta só "existe" pro cliente se estiver ligada E tiver pelo menos uma
// modelo de chamada configurada (senão o prêmio principal não tem o que
// entregar e o cliente ficaria com a mão abanando).
function configUsable(cfg) {
    return cfg.enabled && cfg.call_product_ids.length > 0;
}


// ─────────────────────────────────────────────────────────────────────────────
// ESTADO POR E-MAIL
// ─────────────────────────────────────────────────────────────────────────────
function newRefCode() {
    // 8 caracteres, sem confundir 0/O e 1/I (o cliente pode digitar/ler)
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.randomBytes(8);
    let out = '';
    for (let i = 0; i < 8; i++) out += alphabet[bytes[i] % alphabet.length];
    return out;
}

/**
 * Pega (ou cria) o estado do cliente. Cliente novo NASCE com 1 giro.
 * Idempotente: chamar várias vezes não dá giro extra.
 */
async function getOrCreateState(email) {
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            const { rows } = await db.query(
                `INSERT INTO roulette_state (email, spins, ref_code)
                 VALUES ($1, 1, $2)
                 ON CONFLICT (email) DO NOTHING
                 RETURNING *`,
                [email, newRefCode()]
            );
            if (rows[0]) return rows[0];
        } catch (_) { /* código de convite colidiu — tenta outro na volta seguinte */ }

        const { rows: found } = await db.query(`SELECT * FROM roulette_state WHERE email = $1`, [email]);
        if (found[0]) {
            // Estado antigo sem código de convite (banco de antes): gera agora
            if (!found[0].ref_code) {
                try {
                    const { rows: up } = await db.query(
                        `UPDATE roulette_state SET ref_code = $2 WHERE email = $1 AND ref_code IS NULL RETURNING *`,
                        [email, newRefCode()]
                    );
                    if (up[0]) return up[0];
                } catch (_) { continue; } // colisão de código: tenta de novo
            }
            return found[0];
        }
        // colisão de ref_code no INSERT (raríssimo) → novo código na próxima volta
    }
    throw new Error('não consegui criar o estado da roleta');
}


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/user/roulette/state
// Diz se a roleta está ligada, quantos giros ele tem e se pode abrir o popup.
//
// REGRA DO GIRO (combinada com o dono): é 1 giro grátis POR E-MAIL NA VIDA —
// não é 1 por dia. Quem cria o giro é o getOrCreateState (INSERT ... ON CONFLICT
// DO NOTHING, ou seja, só na primeira vez). A ÚNICA outra forma de ganhar giro é
// o convite (/roulette/track-ref: alguém novo entra pelo link dele, +1 giro,
// teto de 3 por dia) e o prêmio "+1 GIRO" da própria roda.
//
// O popup automático (chave `popup_enabled`, LIGADA por padrão) abre no máximo
// 1x por dia — o próprio GET marca a data. O app chama nos 2 momentos que o
// dono pediu: ao abrir o catálogo e ao voltar do checkout sem comprar. Abrir
// pelo banner de Minhas Compras usa ?peek=1 (não gasta o popup do dia).
// ?peek=1 → só lê, NÃO gasta o popup do dia (usado depois de girar).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/roulette/state', requireUser, async (req, res) => {
    try {
        const cfg = await loadConfig();
        if (!configUsable(cfg)) {
            return res.json({ success: true, enabled: false, spins: 0, show_popup: false, mode: null, first_done: false, popup_enabled: false });
        }
        // Lead anônimo de funil não entra na roleta (prêmio vale dinheiro e
        // o e-mail é a identidade). Só cliente identificado.
        if (req.user.anonymous) {
            return res.json({ success: true, enabled: false, spins: 0, show_popup: false, mode: null, first_done: false, popup_enabled: false });
        }

        const email = req.user.email;
        const st = await getOrCreateState(email);
        const peek = req.query.peek === '1';

        // DOIS popups, duas janelas (o app usa o `mode` pra escolher a tela):
        //   'spin'  → tem giro na conta: convite pra girar. No máximo 1x por dia.
        //   'share' → sem giro: "seus giros acabaram, chame um amigo". Aparece
        //             1x a cada N dias (config do painel; 0 = nunca).
        // Com o popup desligado no painel, nem marca data nem devolve modo —
        // o app só usa o state pra pintar o banner e abrir a roleta no toque.
        const popupOn = cfg.popup_enabled === true;
        let showPopup = false;
        let mode = null;
        if (!popupOn) {
            showPopup = false;
        } else if (!peek && st.spins > 0) {
            // Marca o popup do dia de forma atômica: quem chegar primeiro leva.
            const { rows } = await db.query(
                `UPDATE roulette_state
                    SET last_popup_date = ${TODAY_BR}
                  WHERE email = $1
                    AND (last_popup_date IS NULL OR last_popup_date < ${TODAY_BR})
                  RETURNING email`,
                [email]
            );
            showPopup = rows.length > 0;
            if (showPopup) mode = 'spin';
        } else if (!peek && st.spins <= 0 && cfg.no_spins_reminder_days > 0) {
            const { rows } = await db.query(
                `UPDATE roulette_state
                    SET last_share_popup_date = ${TODAY_BR}
                  WHERE email = $1
                    AND (last_share_popup_date IS NULL
                         OR last_share_popup_date <= ${TODAY_BR} - ($2::int))
                  RETURNING email`,
                [email, cfg.no_spins_reminder_days]
            );
            showPopup = rows.length > 0;
            if (showPopup) mode = 'share';
        }

        return res.json({
            success: true,
            enabled: true,
            spins: st.spins,
            show_popup: showPopup,
            mode,
            first_done: st.first_spin_done === true,
            popup_enabled: popupOn,
            popup_delay_sec: cfg.popup_delay_sec,
            ref_code: st.ref_code,
        });
    } catch (err) {
        logger.error('[roleta] state:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// ─────────────────────────────────────────────────────────────────────────────
// Sorteio (SERVIDOR decide)
// ─────────────────────────────────────────────────────────────────────────────
function drawKind(pool) {
    const total = pool.reduce((s, k) => s + WEIGHTS[k], 0);
    let r = Math.random() * total;
    for (const k of pool) {
        r -= WEIGHTS[k];
        if (r <= 0) return k;
    }
    return pool[pool.length - 1];
}

async function spinPrizesToday(email) {
    const { rows } = await db.query(
        `SELECT COUNT(*)::int AS n FROM roulette_prizes
          WHERE LOWER(email) = $1 AND kind = 'spin'
            AND (created_at AT TIME ZONE 'America/Sao_Paulo')::date = ${TODAY_BR}`,
        [email]
    );
    return rows[0]?.n || 0;
}

// O que conta como produto de CHAMADINHA. O painel aceita 3 formas de cadastrar
// (mesma regra do editor de produto): vídeo direto, chamada vinculada, ou o tipo
// 'video_call'. Filtrar só pelo tipo deixava de fora os produtos reais do dono
// (que aparecem como "Externo · Chamadinha" na lista).
const CALL_PRODUCT_SQL = `(
    product_type = 'video_call'
    OR video_call_id IS NOT NULL
    OR NULLIF(TRIM(COALESCE(direct_call_video_url, '')), '') IS NOT NULL
)`;

// Modelos de chamada disponíveis pro prêmio (na ordem que o dono configurou)
async function callOptions(ids) {
    if (!ids.length) return [];
    const { rows } = await db.query(
        `SELECT id, name,
                COALESCE(NULLIF(call_photo_url, ''), NULLIF(banner_url, '')) AS photo
           FROM products
          WHERE id = ANY($1::int[]) AND is_active = true AND ${CALL_PRODUCT_SQL}
          ORDER BY array_position($1::int[], id)`,
        [ids]
    );
    return rows.map(r => ({ id: r.id, name: r.name, photo: r.photo || null }));
}


// ─────────────────────────────────────────────────────────────────────────────
// POST /api/user/roulette/spin
// ─────────────────────────────────────────────────────────────────────────────
router.post('/roulette/spin', requireUser, async (req, res) => {
    try {
        const cfg = await loadConfig();
        if (!configUsable(cfg) || req.user.anonymous) {
            return res.status(403).json({ success: false, error: 'Roleta indisponível agora.' });
        }

        const email = req.user.email;
        await getOrCreateState(email);

        // Gasta 1 giro de forma atômica — sem saldo, sem giro.
        const { rows: spent } = await db.query(
            `UPDATE roulette_state SET spins = spins - 1
              WHERE email = $1 AND spins > 0
              RETURNING spins, first_spin_done`,
            [email]
        );
        if (!spent[0]) {
            return res.status(400).json({ success: false, error: 'Você não tem giro disponível agora.' });
        }
        let spinsLeft = spent[0].spins;
        const isFirst = spent[0].first_spin_done !== true;

        // ── Decide o prêmio ────────────────────────────────────────────────
        let kind;
        if (isFirst) {
            kind = 'call'; // 1º giro da vida: SEMPRE chamada (programado)
            await db.query(`UPDATE roulette_state SET first_spin_done = true WHERE email = $1`, [email]);
        } else {
            const pool = ['call'];
            if (cfg.content_product_id) pool.push('content');
            if (await spinPrizesToday(email) < MAX_SPIN_PRIZES_PER_DAY) pool.push('spin');
            kind = drawKind(pool);
        }

        // ── Entrega ────────────────────────────────────────────────────────
        if (kind === 'call') {
            const options = await callOptions(cfg.call_product_ids);
            if (!options.length) {
                // Configuração quebrou no meio do caminho: devolve o giro.
                await db.query(`UPDATE roulette_state SET spins = spins + 1 WHERE email = $1`, [email]);
                return res.status(503).json({ success: false, error: 'Roleta indisponível agora.' });
            }
            const { rows: [prize] } = await db.query(
                `INSERT INTO roulette_prizes (email, kind, claimed) VALUES ($1, 'call', false) RETURNING id`,
                [email]
            );
            return res.json({ success: true, prize: { kind: 'call', prize_id: prize.id }, options, spins: spinsLeft });
        }

        if (kind === 'content') {
            const granted = await grantAccess(email, cfg.content_product_id, null);
            const { rows: [prize] } = await db.query(
                `INSERT INTO roulette_prizes (email, kind, product_id, claimed)
                 VALUES ($1, 'content', $2, true) RETURNING id`,
                [email, cfg.content_product_id]
            );
            return res.json({
                success: true,
                prize: { kind: 'content', prize_id: prize.id, product_name: granted.product_name || null },
                spins: spinsLeft,
            });
        }

        // '+1 GIRO'
        const { rows: [after] } = await db.query(
            `UPDATE roulette_state SET spins = spins + 1 WHERE email = $1 RETURNING spins`,
            [email]
        );
        spinsLeft = after ? after.spins : spinsLeft + 1;
        const { rows: [prize] } = await db.query(
            `INSERT INTO roulette_prizes (email, kind, claimed) VALUES ($1, 'spin', true) RETURNING id`,
            [email]
        );
        return res.json({ success: true, prize: { kind: 'spin', prize_id: prize.id }, spins: spinsLeft });
    } catch (err) {
        logger.error('[roleta] spin:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});


// ─────────────────────────────────────────────────────────────────────────────
// Concede o acesso — MESMA porta de entrada da compra (user_access ativo).
//
// Cuidados com o banco:
//   - Existe um índice único de "1 acesso ativo por (email, produto)". Então:
//     • já tem acesso ativo e AINDA NÃO usou  → reaproveita (não duplica).
//     • já tem e JÁ consumiu a chamada        → marca 'replaced' e cria uma
//       linha nova (slot novo pra ligar de novo) — é o mesmo que a recompra faz.
//   - granted_by = 'roulette' e sale_id = NULL → não polui relatório de vendas.
// ─────────────────────────────────────────────────────────────────────────────
async function grantAccess(email, productId, prizeId) {
    const { rows: [product] } = await db.query(
        `SELECT id, name, product_type FROM products WHERE id = $1 AND is_active = true`,
        [productId]
    );
    if (!product) throw new Error('produto do prêmio não existe ou está inativo');

    return db.transaction(async (client) => {
        const { rows: [existing] } = await client.query(
            `SELECT id FROM user_access
              WHERE LOWER(email) = $1 AND product_id = $2 AND status = 'active'
                AND (expires_at IS NULL OR expires_at > NOW())
              FOR UPDATE`,
            [email, productId]
        );

        if (existing) {
            // A chamada só é "gasta" quando existe registro no histórico.
            // São DOIS históricos: o legado (chamada cadastrada no Remarketing)
            // e o de produto (chamadinha com link direto — o caso do dono).
            // Se ignorar o segundo, o prêmio novo cairia num acesso JÁ usado e
            // o cliente ficaria sem poder ligar.
            const { rows: used } = await client.query(
                `SELECT 1 FROM customer_call_history
                  WHERE LOWER(customer_email) = $1 AND user_access_id = $2
                 UNION ALL
                 SELECT 1 FROM product_call_history
                  WHERE LOWER(customer_email) = $1 AND user_access_id = $2
                 LIMIT 1`,
                [email, existing.id]
            );
            if (!used.length) {
                // Acesso intacto: o prêmio já está lá, não precisa duplicar.
                return { access_id: existing.id, reused: true, product_name: product.name };
            }
            await client.query(
                `UPDATE user_access
                    SET status = 'replaced', revoked_at = NOW(), revoke_reason = 'Prêmio da Roleta VIP (slot novo)'
                  WHERE id = $1`,
                [existing.id]
            );
        }

        const { rows: [ins] } = await client.query(
            `INSERT INTO user_access (email, product_id, status, granted_by, metadata)
             VALUES ($1, $2, 'active', 'roulette', $3::jsonb)
             RETURNING id`,
            [email, productId, JSON.stringify({
                granted_via: 'roulette',
                prize_id: prizeId || null,
                product_type: product.product_type,
                at: new Date().toISOString(),
            })]
        );
        return { access_id: ins.id, reused: false, product_name: product.name };
    });
}


// ─────────────────────────────────────────────────────────────────────────────
// POST /api/user/roulette/claim-call { prize_id, product_id }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/roulette/claim-call', requireUser, async (req, res) => {
    try {
        const cfg = await loadConfig();
        if (!configUsable(cfg) || req.user.anonymous) {
            return res.status(403).json({ success: false, error: 'Roleta indisponível agora.' });
        }

        const email = req.user.email;
        const prizeId = parseInt(req.body?.prize_id, 10);
        const productId = parseInt(req.body?.product_id, 10);
        if (!prizeId || !productId) {
            return res.status(400).json({ success: false, error: 'Escolha uma modelo pra continuar.' });
        }
        // O produto TEM que ser um dos configurados pelo dono
        if (!cfg.call_product_ids.includes(productId)) {
            return res.status(400).json({ success: false, error: 'Essa opção não está disponível.' });
        }

        // Fecha a pendência ANTES de conceder (atômico: só a 1ª chamada passa).
        const { rows: claimed } = await db.query(
            `UPDATE roulette_prizes
                SET claimed = true, product_id = $3
              WHERE id = $1 AND LOWER(email) = $2 AND kind = 'call' AND claimed = false
              RETURNING id`,
            [prizeId, email, productId]
        );
        if (!claimed.length) {
            return res.status(400).json({ success: false, error: 'Esse prêmio já foi resgatado.' });
        }

        try {
            const granted = await grantAccess(email, productId, prizeId);
            return res.json({ success: true, product_name: granted.product_name, product_id: productId });
        } catch (err) {
            // Não conseguiu entregar: devolve a pendência pro cliente tentar de novo
            await db.query(
                `UPDATE roulette_prizes SET claimed = false, product_id = NULL WHERE id = $1`,
                [prizeId]
            ).catch(() => {});
            throw err;
        }
    } catch (err) {
        logger.error('[roleta] claim-call:', err);
        return res.status(500).json({ success: false, error: 'Não consegui liberar agora. Tenta de novo.' });
    }
});


// ─────────────────────────────────────────────────────────────────────────────
// POST /api/user/roulette/track-ref { code, visitor_id }  (SEM login)
// Alguém abriu o app pelo link de convite → dono do código ganha +1 giro.
// Conta 1 vez por visitante e no máximo 3 por dia.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/roulette/track-ref', async (req, res) => {
    try {
        const code = String(req.body?.code || '').trim().toUpperCase().slice(0, 16);
        const visitorId = String(req.body?.visitor_id || '').trim().slice(0, 80);
        if (!code || !visitorId || !/^[A-Z0-9]{4,16}$/.test(code)) {
            return res.json({ success: true, credited: false });
        }

        const { rows: [owner] } = await db.query(
            `SELECT email, credited_today, credit_date FROM roulette_state WHERE ref_code = $1`,
            [code]
        );
        if (!owner) return res.json({ success: true, credited: false });

        // Visitante novo? (dedupe)
        const { rows: visit } = await db.query(
            `INSERT INTO roulette_ref_visits (ref_code, visitor_id) VALUES ($1, $2)
             ON CONFLICT (ref_code, visitor_id) DO NOTHING
             RETURNING ref_code`,
            [code, visitorId]
        );
        if (!visit.length) return res.json({ success: true, credited: false });

        // Credita respeitando o teto do dia (zera o contador quando vira o dia)
        const { rows: credited } = await db.query(
            `UPDATE roulette_state
                SET spins = spins + 1,
                    credited_today = CASE WHEN credit_date = ${TODAY_BR} THEN credited_today + 1 ELSE 1 END,
                    credit_date = ${TODAY_BR}
              WHERE ref_code = $1
                AND (credit_date IS NULL OR credit_date < ${TODAY_BR} OR credited_today < $2)
              RETURNING spins`,
            [code, MAX_REF_CREDITS_PER_DAY]
        );
        return res.json({ success: true, credited: credited.length > 0 });
    } catch (err) {
        logger.error('[roleta] track-ref:', err);
        return res.json({ success: true, credited: false });
    }
});


module.exports = router;
