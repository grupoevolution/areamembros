/**
 * =============================================================================
 * routes/user-groups.js — GRUPOS-bot estilo WhatsApp (lado do cliente)
 * =============================================================================
 *
 * Cada grupo é uma timeline POR LEAD (como o chat 1:1): o motor sorteia CENAS
 * (mini-conversas importadas por JSON no painel) e materializa mensagens das
 * personas com espaçamento natural. Nada é compartilhado entre leads.
 *
 * Estados de acesso:
 *   channel — grupo GRATUITO: tudo visível, nunca digita, CTA fixo.
 *   member  — comprou o produto do grupo OU tem o Passe (is_group_pass):
 *             vê tudo, digita e manda foto à vontade.
 *   trial   — pago, 1ª experiência: trial_seconds ACUMULADOS com o grupo
 *             aberto (heartbeat). Digita normal; bots reagem.
 *   locked  — trial esgotado / assinatura vencida: mensagens novas chegam
 *             MASCARADAS (blur no app) + popup dos planos.
 *
 * Retenção: mensagens com mais de retention_hours somem (limpa ao abrir).
 * =============================================================================
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const { logger } = require('../lib/logger');
const { optionalUser } = require('../lib/user-auth');
const { listCollectionVideos, bunnyEmbedUrl, bunnyThumbUrl, listStorageFolder } = require('../lib/bunny');

// ── Identidade (mesmo padrão do chat) ────────────────────────────────────────
function getIdentity(req) {
    const email = (req.user?.email || '').toLowerCase().trim() || null;
    const raw = (req.body?.visitor_id || req.query?.visitor_id || '');
    const visitor = String(raw).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || null;
    return { email: email && !email.endsWith('@preview.local') ? email : null, visitor };
}

async function ownsProduct(email, productId) {
    if (!email) return false;
    try { if (await require('../lib/preview').isPreviewEmail(email)) return true; } catch (_) {}
    if (!productId) return false;
    try {
        const { rows } = await db.query(
            `SELECT 1 FROM user_access WHERE LOWER(email) = $1 AND product_id = $2
              AND status = 'active' AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1`,
            [email, productId]
        );
        return rows.length > 0;
    } catch (_) { return false; }
}

// Passe Vitalício: 1 produto (is_group_pass) libera TODOS os grupos, pra sempre
let _passCache = { id: null, at: 0 };
async function groupPassProductId() {
    if (Date.now() - _passCache.at < 60000) return _passCache.id;
    try {
        const { rows } = await db.query(
            `SELECT id FROM products WHERE is_group_pass = true AND is_active = true ORDER BY id LIMIT 1`
        );
        _passCache = { id: rows.length ? rows[0].id : null, at: Date.now() };
    } catch (_) { _passCache = { id: null, at: Date.now() }; }
    return _passCache.id;
}

async function ownsGroup(email, group) {
    if (group.is_free) return false; // free = canal, ninguém "possui"
    if (group.product_id && await ownsProduct(email, group.product_id)) return true;
    const passId = await groupPassProductId();
    if (passId) return ownsProduct(email, passId);
    return false;
}

// ── Sessão ───────────────────────────────────────────────────────────────────
async function findOrCreateSession(groupId, ident, createIfMissing) {
    let row = null;
    if (ident.email) {
        const { rows } = await db.query(
            `SELECT * FROM group_sessions WHERE group_id = $1 AND LOWER(customer_email) = $2 ORDER BY id DESC LIMIT 1`,
            [groupId, ident.email]
        );
        row = rows[0] || null;
        if (!row && ident.visitor) {
            const { rows: anon } = await db.query(
                `UPDATE group_sessions SET customer_email = $3, updated_at = NOW()
                 WHERE group_id = $1 AND visitor_id = $2 AND customer_email IS NULL RETURNING *`,
                [groupId, ident.visitor, ident.email]
            );
            row = anon[0] || null;
        }
    } else if (ident.visitor) {
        const { rows } = await db.query(
            `SELECT * FROM group_sessions WHERE group_id = $1 AND visitor_id = $2 AND customer_email IS NULL ORDER BY id DESC LIMIT 1`,
            [groupId, ident.visitor]
        );
        row = rows[0] || null;
    }
    if (row || !createIfMissing) return row;
    const { rows: created } = await db.query(
        `INSERT INTO group_sessions (group_id, customer_email, visitor_id) VALUES ($1, $2, $3) RETURNING *`,
        [groupId, ident.email, ident.email ? null : ident.visitor]
    );
    return created[0];
}

// ── Período do dia (Brasília, UTC-3) ─────────────────────────────────────────
function periodNow() {
    const h = (new Date(Date.now() - 3 * 3600 * 1000)).getUTCHours();
    if (h >= 6 && h < 12) return 'manha';
    if (h >= 12 && h < 18) return 'tarde';
    if (h >= 18) return 'noite';
    return 'madrugada';
}
const rand = (n) => Math.floor(Math.random() * n);
const pick = (arr) => (arr && arr.length ? arr[rand(arr.length)] : null);

// Junta as fotos configuradas LINK A LINK com as da PASTA da Bunny Storage
// (galeria + apresentações). Muta o objeto group — chamar após carregar.
async function hydrateGroupMedia(group) {
    try {
        const merge = (manual, extra) => {
            const a = Array.isArray(manual) ? manual : [];
            return extra.length ? a.concat(extra.filter(u => a.indexOf(u) < 0)) : a;
        };
        if (group.media_image_folder) {
            group.media_image_urls = merge(group.media_image_urls, await listStorageFolder(group.media_image_folder));
        }
        if (group.presentation_male_folder) {
            group.presentation_male_urls = merge(group.presentation_male_urls, await listStorageFolder(group.presentation_male_folder));
        }
        if (group.presentation_female_folder) {
            group.presentation_female_urls = merge(group.presentation_female_urls, await listStorageFolder(group.presentation_female_folder));
        }
        // PASTAS POR CATEGORIA (v3): groups.media_folders = { "academia": "pasta/na/bunny", ... }
        // As cenas referenciam pela chave: {"t":"image","folder":"academia",...}
        group.media_folder_urls = {};
        const folders = (group.media_folders && typeof group.media_folders === 'object') ? group.media_folders : {};
        for (const key of Object.keys(folders).slice(0, 30)) {
            try { group.media_folder_urls[key] = await listStorageFolder(folders[key]); } catch (_) { group.media_folder_urls[key] = []; }
        }
    } catch (_) {}
    return group;
}

// ═════════════════════════════════════════════════════════════════════════════
// ELENCO AUTOMÁTICO (v3) — os nomes saem DAQUI, não de personas manuais.
// Cada LEAD tem o próprio elenco (session.state.cast): nos papos as mesmas
// pessoas reaparecem (grupo real tem gente recorrente); nas APRESENTAÇÕES
// entra sempre alguém novo. O texto usa {nome} → vira o nome do remetente,
// então nunca mais "Júlia apresentando a Larissa".
// ═════════════════════════════════════════════════════════════════════════════
const CAST_F = [
    'Larissa','Camila','Juliana','Amanda','Bruna','Fernanda','Aline','Patrícia','Vanessa','Carla',
    'Tatiane','Renata','Débora','Priscila','Michele','Simone','Adriana','Cristiane','Daniela','Elaine',
    'Fabiana','Gabriela','Helena','Ingrid','Jéssica','Karina','Letícia','Mariana','Natália','Paula',
    'Raquel','Sabrina','Talita','Viviane','Bianca','Caroline','Duda','Eduarda','Flávia','Giovanna',
    'Isabela','Kelly','Luana','Marcela','Nicole','Pâmela','Rafaela','Sandra','Thaís','Valéria',
    'Alessandra','Beatriz','Cíntia','Denise','Érica','Franciele','Grazi','Iara','Josiane','Lívia',
    'Mônica','Nayara','Poliana','Rosana','Suelen','Tainá','Vitória','Yasmin','Andressa','Bárbara',
    'Clara','Daiane','Emanuelle','Geovana','Isadora','Jaqueline','Lorena','Milena','Núbia','Regina',
    'Sarah','Tamires','Valentina','Wesla','Ana Paula','Maria Clara','Ana Júlia','Rebeca','Stefany','Mirella',
    'Lays','Kamila','Joyce','Iasmin','Heloísa','Gislaine','Fabíola','Evelyn','Dandara','Cássia',
    'Brenda','Antônia','Alícia','Samara','Rayane','Quézia','Pietra','Olívia','Nathália','Marta',
    'Luciana','Késia','Janaína','Ivone','Hadassa','Gilmara','Filipa','Estela','Dara','Catarina'
];
const CAST_M = [
    'Marcos','Diego','Rafael','Thiago','Bruno','Carlos','Daniel','Eduardo','Felipe','Gustavo',
    'Henrique','Igor','João','Kaique','Leandro','Mateus','Nathan','Otávio','Paulo','Renan',
    'Samuel','Tiago','Vinícius','Wesley','Alex','Breno','Caio','Douglas','Emerson','Fábio',
    'Gabriel','Hugo','Ítalo','Jorge','Luan','Murilo','Nícolas','Pedro','Ricardo','Sérgio',
    'Talles','Victor','Wallace','Yuri','Anderson','Bernardo','Cristiano','Davi','Erick','Fernando',
    'Guilherme','Heitor','Jean','Lucas','Maurício','Robson','Rodrigo','Vitor Hugo','Washington','Adriano'
];

function sessionState(session) {
    if (!session.state || typeof session.state !== 'object' || Array.isArray(session.state)) session.state = {};
    return session.state;
}
async function saveSessionState(session) {
    try {
        await db.query(`UPDATE group_sessions SET state = $2, updated_at = NOW() WHERE id = $1`,
            [session.id, JSON.stringify(session.state || {})]);
    } catch (_) {}
}

// Escolhe uma pessoa do elenco do LEAD. fresh=true → SEMPRE alguém novo
// (apresentação). Senão: 75% reaproveita quem já apareceu (recorrência).
// exclude = nomes já usados NA MESMA CENA (duas pessoas da cena nunca são a
// mesma — senão vira alguém conversando sozinho).
function castPick(session, gender, fresh, exclude) {
    const st = sessionState(session);
    st.cast = Array.isArray(st.cast) ? st.cast : [];
    const pool = gender === 'm' ? CAST_M : CAST_F;
    const existing = st.cast.filter(c => c && c.g === gender && !(exclude && exclude.has(c.n)));
    if (!fresh && existing.length >= 4 && Math.random() < 0.75) return pick(existing);
    const usedNames = new Set(st.cast.map(c => c && c.n));
    const avail = pool.filter(n => !usedNames.has(n) && !(exclude && exclude.has(n)));
    if (!avail.length) return existing.length ? pick(existing) : { n: pick(pool), g: gender };
    const person = { n: pick(avail), g: gender };
    st.cast.push(person);
    if (st.cast.length > 120) st.cast = st.cast.slice(-120);
    return person;
}

// Foto sem repetição POR LEAD (apresentação e pastas): risca as já usadas na
// sessão; esgotou a pasta, volta a valer tudo.
function pickUnusedMedia(session, listKey, urls) {
    if (!Array.isArray(urls) || !urls.length) return null;
    const st = sessionState(session);
    st.used_media = (st.used_media && typeof st.used_media === 'object') ? st.used_media : {};
    const used = new Set(Array.isArray(st.used_media[listKey]) ? st.used_media[listKey] : []);
    let candidates = urls.filter(u => !used.has(u));
    if (!candidates.length) { st.used_media[listKey] = []; candidates = urls; }
    const chosen = pick(candidates);
    const arr = Array.isArray(st.used_media[listKey]) ? st.used_media[listKey] : [];
    arr.push(chosen);
    st.used_media[listKey] = arr.slice(-400);
    return chosen;
}

// ── Cenas ────────────────────────────────────────────────────────────────────
// Sorteio ponderado no pool ambiente (respeita o período; 'reacao' fica fora —
// só dispara quando o lead manda mensagem).
async function pickScene(groupId, opts) {
    opts = opts || {};
    const period = opts.period || periodNow();
    const params = [groupId, period];
    // 'reacao' só quando o lead fala; 'entrada' só no primeiro acesso (em ordem)
    let catSql = `AND category NOT IN ('reacao', 'entrada')`;
    if (opts.category) { params.push(opts.category); catSql = `AND category = $3`; }
    const { rows } = await db.query(
        `SELECT * FROM group_scenes
         WHERE group_id = $1 AND active = true AND (period = 'any' OR period = $2) ${catSql}`,
        params
    );
    if (!rows.length) return null;
    // Apresentações: respeita a proporção de gênero do grupo (female_ratio %).
    // O gênero da cena = g do 1º slot com t 'presentation' (ou do 1º slot).
    let pool = rows;
    if (opts.category === 'apresentacao' && opts.femaleRatio != null && rows.length > 1) {
        const sceneGender = (sc) => {
            const msgs = Array.isArray(sc.messages) ? sc.messages : [];
            const pres = msgs.find(m => m.t === 'presentation' && (m.g === 'f' || m.g === 'm'));
            if (pres) return pres.g;
            const first = msgs.find(m => m.g === 'f' || m.g === 'm');
            return first ? first.g : null;
        };
        const wantF = Math.random() * 100 < Math.max(0, Math.min(100, opts.femaleRatio));
        const filtered = rows.filter(r => sceneGender(r) === (wantF ? 'f' : 'm'));
        if (filtered.length) pool = filtered;
    }
    const rowsPool = pool;
    const total = rowsPool.reduce((s, r) => s + Math.max(1, r.weight | 0), 0);
    let roll = Math.random() * total;
    for (const r of rowsPool) {
        roll -= Math.max(1, r.weight | 0);
        if (roll <= 0) return r;
    }
    return rowsPool[rowsPool.length - 1];
}

// Materializa uma cena (v3 — ELENCO AUTOMÁTICO): sorteia gente do elenco do
// LEAD pros slots, troca {nome} pelo nome do remetente, escolhe fotos das
// pastas (sem repetir por lead) e insere com timestamps a partir de baseTime.
// m.admin === true → mensagem do ADMINISTRADOR (canal free de ofertas).
// Retorna { messages, endTime }.
async function materializeScene(session, group, scene, baseTime, gapScale) {
    const msgs = Array.isArray(scene.messages) ? scene.messages : [];
    if (!msgs.length) return { messages: [], endTime: baseTime };
    gapScale = gapScale || 1;
    const st = sessionState(session);
    const femaleRatio = Number.isFinite(+group.female_ratio) ? +group.female_ratio : 80;
    // slots → pessoas do elenco. O slot com t:'presentation' é SEMPRE alguém
    // novo pra este lead (apresentação não repete gente).
    const presSlot = (msgs.find(m => m.t === 'presentation') || {}).p || null;
    const slotMap = {};
    const usedInScene = new Set(); // pessoas desta cena — cada slot é ALGUÉM diferente
    const bySlot = (slot, g) => {
        if (slotMap[slot]) return slotMap[slot];
        const gender = (g === 'm' || g === 'f') ? g : (Math.random() * 100 < femaleRatio ? 'f' : 'm');
        const person = castPick(session, gender, slot === presSlot, usedInScene);
        slotMap[slot] = person;
        usedInScene.add(person.n);
        return person;
    };
    const imgs = Array.isArray(group.media_image_urls) ? group.media_image_urls : [];
    const presM = Array.isArray(group.presentation_male_urls) ? group.presentation_male_urls : [];
    const presF = Array.isArray(group.presentation_female_urls) ? group.presentation_female_urls : [];
    const folderUrls = (group.media_folder_urls && typeof group.media_folder_urls === 'object') ? group.media_folder_urls : {};
    const out = [];
    let t = baseTime;
    for (const m of msgs) {
        const gap = Math.max(2, Math.min(600, parseInt(m.gap_s, 10) || (4 + rand(9))));
        t = new Date(t.getTime() + gap * gapScale * 1000);
        const isAdmin = m.admin === true;
        const person = isAdmin ? null : bySlot(m.p || 1, m.g === 'm' || m.g === 'f' ? m.g : null);
        let type = 'text', content = (m.text || '').slice(0, 1000) || null, media = null, meta = null;
        // {nome} → quem está FALANDO; {nome2} → a pessoa do slot 2 (referência
        // cruzada: "bem vinda {nome1}" dito pelo slot 2 sobre o slot 1)
        if (content) {
            content = content.replace(/\{nome(\d+)\}/gi, (_, d) => bySlot(parseInt(d, 10), null).n);
            content = content.replace(/\{nome\}/gi, person ? person.n : (group.name || 'Admin'));
        }
        if (m.t === 'image') {
            type = 'image';
            const key = (m.folder || '').toString().trim();
            const pool = key ? (folderUrls[key] || []) : imgs;
            media = pickUnusedMedia(session, key ? 'folder:' + key : 'imgs', pool);
            if (!media) { if (!content) continue; type = 'text'; }
        } else if (m.t === 'presentation') {
            type = 'image';
            const g = person ? person.g : 'f';
            media = pickUnusedMedia(session, 'pres:' + g, g === 'm' ? presM : presF);
            if (!media) { if (!content) continue; type = 'text'; }
        } else if (m.t === 'cta') {
            type = 'cta';
            content = content || 'Ver agora';
            meta = { link_url: m.link || null, product_id: m.pid || null, cta_color: m.color || '#25a55f' };
        } else if (m.t && m.t !== 'text') {
            continue; // tipo desconhecido/futuro (media_video): pula
        }
        if (!content && !media) continue;
        if (isAdmin) meta = Object.assign({}, meta || {}, { admin: true });
        const { rows } = await db.query(
            `INSERT INTO group_messages (session_id, persona_id, sender, type, content, media_url, meta, created_at, sender_name, sender_gender)
             VALUES ($1, NULL, 'bot', $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [
                session.id, type, content, media,
                meta ? JSON.stringify(meta) : null, t,
                isAdmin ? 'Admin' : person.n,
                isAdmin ? null : person.g,
            ]
        );
        out.push(rows[0]);
    }
    // elenco + fotos usadas persistem no estado da sessão (1 UPDATE por cena)
    await saveSessionState(session);
    return { messages: out, endTime: t };
}

// Agenda a PRÓXIMA cena conforme o ritmo (msgs/hora) com variação natural
async function scheduleNext(session, group, fromTime) {
    const perMsg = 3600 / Math.max(10, group.msgs_per_hour || 60);
    const gapSecs = Math.round(perMsg * (2 + rand(6))); // ~2-8 mensagens de "respiro"
    const at = new Date((fromTime || new Date()).getTime() + gapSecs * 1000);
    await db.query(`UPDATE group_sessions SET next_scene_at = $2, updated_at = NOW() WHERE id = $1`, [session.id, at]);
    session.next_scene_at = at;
}

// Preenche o grupo pra parecer VIVO: gera cenas com timestamps NO PASSADO
// (entrada nova ou lead que ficou fora um tempo).
async function backfill(session, group, targetMsgs) {
    targetMsgs = targetMsgs || 22;
    const per = periodNow();
    // mix: saudação do período (se houver) + apresentação + ambiente
    const plan = [];
    if (per === 'manha' && Math.random() < 0.6) plan.push('bomdia');
    if (per === 'noite' && Math.random() < 0.4) plan.push('boanoite');
    if (Math.random() < 0.7) plan.push('apresentacao');
    let count = 0, guard = 10;
    const picked = [];
    while (count < targetMsgs && guard-- > 0) {
        const cat = plan.shift() || null;
        const scene = await pickScene(group.id, cat
            ? { category: cat, period: per, femaleRatio: group.female_ratio }
            : { period: per });
        if (!scene) { if (cat) continue; break; }
        picked.push(scene);
        count += (Array.isArray(scene.messages) ? scene.messages.length : 0);
    }
    if (!picked.length) return [];
    // duração total comprimida: tudo aconteceu nos últimos ~40 min
    let dur = 0;
    for (const s of picked) for (const m of (s.messages || [])) dur += Math.max(2, Math.min(600, parseInt(m.gap_s, 10) || 8));
    const windowS = Math.min(40 * 60, Math.max(300, dur));
    const scale = windowS / Math.max(1, dur);
    let t = new Date(Date.now() - windowS * 1000 - 20000);
    const all = [];
    for (const s of picked) {
        const r = await materializeScene(session, group, s, t, scale);
        all.push(...r.messages);
        t = new Date(r.endTime.getTime() + Math.round(45 * scale) * 1000);
    }
    return all;
}

// ROTEIRO DE ENTRADA (v3): cenas da categoria 'entrada' rodam NA ORDEM no
// primeiro acesso, com timestamps pra FRENTE — pingam AO VIVO via poll
// enquanto o trial corre ("chegou carne nova, se apresenta" etc). 1x por lead.
async function runEntryScript(session, group) {
    const st = sessionState(session);
    if (st.entry_done) return [];
    st.entry_done = true;
    const { rows: scenes } = await db.query(
        `SELECT * FROM group_scenes WHERE group_id = $1 AND active = true AND category = 'entrada' ORDER BY id`,
        [group.id]
    );
    if (!scenes.length) { await saveSessionState(session); return []; }
    const out = [];
    let t = new Date(Date.now() + 6000); // 1ª fala ~6s depois de entrar
    for (const s of scenes.slice(0, 10)) {
        const r = await materializeScene(session, group, s, t, 1);
        out.push(...r.messages);
        t = new Date(r.endTime.getTime() + (8 + rand(10)) * 1000);
    }
    return out;
}

// Cenas VENCIDAS (next_scene_at passou): materializa até 2 pra "aparecer agora"
async function runDueScenes(session, group) {
    const out = [];
    let guard = 2;
    while (guard-- > 0 && session.next_scene_at && new Date(session.next_scene_at) <= new Date()) {
        const scene = await pickScene(group.id, { period: periodNow() });
        if (!scene) break;
        const base = new Date(Math.max(new Date(session.next_scene_at).getTime(), Date.now() - 90000));
        const r = await materializeScene(session, group, scene, base, 1);
        out.push(...r.messages);
        await scheduleNext(session, group, r.endTime);
    }
    return out;
}

// ── Acesso / máscara ─────────────────────────────────────────────────────────
function trialState(session, group) {
    const limit = Math.max(15, group.trial_seconds || 60);
    const used = session.trial_used_seconds || 0;
    return { limit, used, remaining: Math.max(0, limit - used) };
}
function lockedFrom(session) {
    const lf = session.state && session.state.locked_from;
    return lf ? new Date(lf) : null;
}
// Mensagem mascarada: o conteúdo REAL nunca sai do servidor — vai uma frase
// FAKE de tamanho parecido, que o app mostra BORRADA (parece conversa real).
const FAKE_S = ['vem no privado', 'olha isso kkk', 'que delícia', 'to passada', 'manda mais aí', 'sério isso?'];
const FAKE_M = ['gente olha o que ela mandou agora', 'vem cá que eu te mostro tudo kkk', 'quem viu isso ontem sabe kkkk', 'ela postou e apagou correndo'];
const FAKE_L = ['não acredito que ela mandou isso aqui no grupo, olha a foto que vazou agora', 'quem tava na resenha ontem à noite sabe muito bem do que eu to falando kkkk'];
function maskContent(content) {
    const len = (content || '').length;
    const pool = len <= 14 ? FAKE_S : len <= 40 ? FAKE_M : FAKE_L;
    return pool[Math.floor(Math.random() * pool.length)];
}
function publicMsg(m, personasById, masked) {
    const p = m.persona_id ? personasById[m.persona_id] : null;
    return {
        id: m.id,
        sender: m.sender,
        // v3: nome vem gravado na mensagem (elenco automático); persona_id é legado
        name: m.sender === 'user' ? null : (m.sender_name || (p ? p.name : 'Membro')),
        gender: m.sender_gender || (p ? p.gender : null),
        type: masked ? (m.type === 'text' ? 'text' : 'image') : m.type,
        content: masked ? (m.type === 'text' || m.type === 'cta' ? maskContent(m.content) : null) : m.content,
        media_url: masked ? null : m.media_url,
        meta: masked ? null : (m.meta || null),
        created_at: m.created_at,
        masked: masked === true,
    };
}

// Info do PASSE (banner dourado + linha 'OU LEVE TUDO'): tenta o 1º plano do
// produto do Passe; sem plano com link, cai no preço do produto + checkout da
// oferta. Retorna null se o produto do Passe não existir/não tiver link.
async function groupPassInfo() {
    const passId = await groupPassProductId();
    if (!passId) return null;
    try {
        const { rows: pp } = await db.query(
            `SELECT name, price, original_price, benefits, checkout_url
             FROM product_plans WHERE product_id = $1 AND active = true
             ORDER BY display_order, id LIMIT 1`, [passId]
        );
        if (pp.length && pp[0].checkout_url) return pp[0];
        const { rows: pr } = await db.query(`SELECT name, price FROM products WHERE id = $1`, [passId]);
        const { rows: off } = await db.query(
            `SELECT checkout_url FROM product_offers
             WHERE product_id = $1 AND is_active = true AND checkout_url IS NOT NULL
             ORDER BY priority DESC, id LIMIT 1`, [passId]
        );
        if (pr.length && off.length) {
            return { name: pr[0].name || 'Passe Vitalício', price: pr[0].price, original_price: null, benefits: null, checkout_url: off[0].checkout_url };
        }
    } catch (_) {}
    return null;
}

// Popup do grupo: planos do produto (mensal/trimestral) + Passe Vitalício
async function groupUnlock(group) {
    const info = { product_id: group.product_id || null, checkout_url: null, plans: [] };
    if (group.product_id) {
        try {
            const { rows: plans } = await db.query(
                `SELECT name, price, original_price, badge, benefits, checkout_url, is_recommended
                 FROM product_plans WHERE product_id = $1 AND active = true ORDER BY display_order, id`,
                [group.product_id]
            );
            info.plans = plans;
        } catch (_) {}
    }
    try {
        const passId = await groupPassProductId();
        if (passId && passId !== group.product_id) {
            const pass = await groupPassInfo();
            if (pass) info.plans.push({ ...pass, is_recommended: false, badge: 'VITALÍCIO' });
        }
    } catch (_) {}
    return info;
}

async function loadPersonas(groupId) {
    const { rows } = await db.query(
        `SELECT id, name, gender FROM group_personas WHERE group_id = $1 AND active = true`, [groupId]
    );
    return rows;
}
const personasMap = (arr) => { const m = {}; for (const p of arr) m[p.id] = p; return m; };

async function cleanupRetention(session, group) {
    try {
        await db.query(
            `DELETE FROM group_messages WHERE session_id = $1 AND created_at < NOW() - make_interval(hours => $2)`,
            [session.id, Math.max(1, group.retention_hours || 24)]
        );
    } catch (_) {}
}

async function accessState(ident, group, session) {
    if (group.is_free) return 'channel';
    if (await ownsGroup(ident.email, group)) return 'member';
    const t = trialState(session, group);
    return t.remaining > 0 ? 'trial' : 'locked';
}

// Até quando vai o acesso do MEMBRO (assinatura do grupo OU Passe). NULL =
// vitalício (qualquer acesso sem expires_at ganha). Alimenta o aviso de
// "seu acesso vence em X dias" no topo do grupo.
async function memberUntil(email, group) {
    if (!email) return null;
    try {
        const passId = await groupPassProductId();
        const ids = [group.product_id, passId].filter(Boolean);
        if (!ids.length) return null;
        const { rows } = await db.query(
            `SELECT expires_at FROM user_access
             WHERE LOWER(email) = $1 AND product_id = ANY($2::int[]) AND status = 'active'
               AND (expires_at IS NULL OR expires_at > NOW())`,
            [email, ids]
        );
        if (!rows.length) return null;
        if (rows.some(r => !r.expires_at)) return null; // tem acesso vitalício
        return rows.map(r => new Date(r.expires_at)).sort((a, b) => b - a)[0];
    } catch (_) { return null; }
}

// ── Worker de fundo: o grupo continua VIVO com o app fechado ────────────────
// Chamado pelo group-worker a cada 60s. Materializa cenas vencidas das
// sessões de leads ATIVOS (abriram o grupo nos últimos 3 dias) — quando o
// lead voltar, encontra o histórico acumulado de verdade (parece um grupo
// real que não parou). Base fria fica de fora de propósito: pra ela o
// runDueScenes do /open resolve na volta, sem gastar banco com lead morto.
async function runBackgroundScenes() {
    const { rows: sessions } = await db.query(`
        SELECT s.* FROM group_sessions s
        JOIN groups g ON g.id = s.group_id AND g.active = true
        WHERE s.next_scene_at IS NOT NULL
          AND s.next_scene_at <= NOW()
          AND s.last_seen_at >= NOW() - INTERVAL '3 days'
        ORDER BY s.next_scene_at
        LIMIT 40
    `);
    if (!sessions.length) return 0;
    const groupCache = {};
    let ran = 0;
    for (const s of sessions) {
        try {
            if (!groupCache[s.group_id]) {
                const { rows: gr } = await db.query(`SELECT * FROM groups WHERE id = $1`, [s.group_id]);
                if (!gr.length) continue;
                await hydrateGroupMedia(gr[0]);
                groupCache[s.group_id] = gr[0];
            }
            const group = groupCache[s.group_id];
            await runDueScenes(s, group);
            await cleanupRetention(s, group);
            ran++;
        } catch (_) { /* uma sessão com erro não derruba o lote */ }
    }
    return ran;
}

// ── ROTAS ────────────────────────────────────────────────────────────────────

// GET /api/user/groups — lista (fixados primeiro: pinned/comprados)
router.get('/groups', optionalUser, async (req, res) => {
    try {
        const ident = getIdentity(req);
        const { rows: groups } = await db.query(
            `SELECT * FROM groups WHERE active = true ORDER BY display_order, id`
        );
        const out = [];
        for (const g of groups) {
            const owned = await ownsGroup(ident.email, g);
            const session = await findOrCreateSession(g.id, ident, false);
            let last = null, unread = 0, masked = false;
            if (session) {
                const { rows: lm } = await db.query(
                    `SELECT m.*, p.name AS persona_name FROM group_messages m
                     LEFT JOIN group_personas p ON p.id = m.persona_id
                     WHERE m.session_id = $1 ORDER BY m.id DESC LIMIT 1`, [session.id]
                );
                if (lm[0]) {
                    masked = !g.is_free && !owned && trialState(session, g).remaining <= 0;
                    last = {
                        name: lm[0].sender === 'user' ? 'Você' : (lm[0].sender_name || lm[0].persona_name || 'Membro'),
                        preview: masked ? maskContent(lm[0].content) :
                            (lm[0].type === 'image' ? 'Foto' : (lm[0].content || 'Mensagem')),
                        at: lm[0].created_at,
                    };
                }
                const { rows: ur } = await db.query(
                    `SELECT COUNT(*)::int AS n FROM group_messages
                     WHERE session_id = $1 AND sender = 'bot' AND ($2::timestamptz IS NULL OR created_at > $2)`,
                    [session.id, session.last_seen_at]
                );
                unread = ur[0]?.n || 0;
            } else {
                // nunca entrou: número "cheio" pra dar curiosidade (estável por grupo)
                unread = 40 + ((g.id * 37) % 160);
                masked = !g.is_free;
                last = masked ? { name: null, preview: maskContent('primeira vez'), at: null } : null;
            }
            out.push({
                id: g.id, name: g.name, avatar_url: g.avatar_url,
                is_free: g.is_free, pinned: g.pinned === true || owned,
                owned, locked_preview: masked,
                members_count: g.members_count, online_count: g.online_count,
                last, unread,
            });
        }
        out.sort((a, b) => (b.pinned - a.pinned));
        // Banner do PASSE VIP (topo da lista): só pra quem ainda não tem
        let pass = null;
        try {
            const passId = await groupPassProductId();
            if (passId && !(await ownsProduct(ident.email, passId))) {
                pass = await groupPassInfo();
            }
        } catch (_) {}
        return res.json({ success: true, groups: out, pass });
    } catch (err) {
        logger.error('Erro listando grupos:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// POST /api/user/groups/:id/open
router.post('/groups/:id/open', optionalUser, async (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    if (!groupId) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const ident = getIdentity(req);
        if (!ident.email && !ident.visitor) return res.status(400).json({ success: false, error: 'visitor_id obrigatório' });
        const { rows: gr } = await db.query(`SELECT * FROM groups WHERE id = $1 AND active = true`, [groupId]);
        if (!gr.length) return res.status(404).json({ success: false, error: 'Grupo não encontrado' });
        const group = gr[0];
        await hydrateGroupMedia(group);
        const session = await findOrCreateSession(groupId, ident, true);
        await cleanupRetention(session, group);
        const personas = await loadPersonas(groupId);
        const access = await accessState(ident, group, session);
        const trial = trialState(session, group);

        // preenche/atualiza a timeline (grupo sempre parece vivo)
        const { rows: [{ n: msgCount }] } = await db.query(
            `SELECT COUNT(*)::int AS n FROM group_messages WHERE session_id = $1`, [session.id]
        );
        if (msgCount < 10) {
            // primeira vez: passado vivo (backfill) + ROTEIRO DE ENTRADA pingando
            // ao vivo ("chegou carne nova, se apresenta") enquanto o trial corre
            await backfill(session, group);
            await runEntryScript(session, group);
            await scheduleNext(session, group, new Date());
        } else {
            if (!session.next_scene_at) await scheduleNext(session, group, new Date());
            else await runDueScenes(session, group);
        }

        const { rows: msgs } = await db.query(
            `SELECT * FROM group_messages WHERE session_id = $1 AND created_at <= NOW() ORDER BY id DESC LIMIT 60`,
            [session.id]
        );
        msgs.reverse();
        const pMap = personasMap(personas);
        const lf = lockedFrom(session);
        const list = msgs.map(m => publicMsg(m, pMap,
            access === 'locked' && m.sender !== 'user' && (!lf || new Date(m.created_at) >= lf)));

        await db.query(`UPDATE group_sessions SET last_seen_at = NOW(), updated_at = NOW() WHERE id = $1`, [session.id]);

        // "entrou no grupo → modelo chama no privado" (1x por lead)
        let invite = null;
        if (!group.is_free && !session.invited_at && Array.isArray(group.invite_chat_ids) && group.invite_chat_ids.length) {
            await db.query(`UPDATE group_sessions SET invited_at = NOW() WHERE id = $1`, [session.id]);
            invite = { chat_ids: group.invite_chat_ids.slice(0, 3), delay_seconds: group.invite_delay_seconds || 120 };
        }

        // membro com assinatura por tempo: quando vence (NULL = vitalício).
        // Alimenta o aviso de renovação no topo (<= 2 dias) — e nesse caso o
        // unlock (planos) vai junto pra oferta de renovação abrir o popup.
        const until = access === 'member' ? await memberUntil(ident.email, group) : null;

        return res.json({
            success: true,
            group: {
                id: group.id, name: group.name, avatar_url: group.avatar_url,
                is_free: group.is_free,
                members_count: group.members_count, online_count: group.online_count,
                has_media: !!(group.media_video_collection_id || (Array.isArray(group.media_image_urls) && group.media_image_urls.length)),
                telegram_url: group.telegram_url || null,
                cta_label: group.cta_label || null,
                cta_link: group.cta_link || null,
            },
            access,
            trial_remaining: access === 'trial' ? trial.remaining : 0,
            trial_total: trial.limit,
            messages: list,
            member_until: until,
            unlock: (access === 'trial' || access === 'locked' || until)
                ? await groupUnlock(group)
                : null,
            monthly_price: null,
            invite,
        });
    } catch (err) {
        logger.error('Erro abrindo grupo:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// GET /api/user/groups/:id/poll?after=ID
router.get('/groups/:id/poll', optionalUser, async (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    const after = parseInt(req.query.after, 10) || 0;
    if (!groupId) return res.json({ success: false });
    try {
        const ident = getIdentity(req);
        const { rows: gr } = await db.query(`SELECT * FROM groups WHERE id = $1 AND active = true`, [groupId]);
        if (!gr.length) return res.json({ success: false });
        const group = gr[0];
        await hydrateGroupMedia(group);
        const session = await findOrCreateSession(groupId, ident, false);
        if (!session) return res.json({ success: true, messages: [] });
        const personas = await loadPersonas(groupId);
        await runDueScenes(session, group);
        const access = await accessState(ident, group, session);
        const { rows: msgs } = await db.query(
            `SELECT * FROM group_messages WHERE session_id = $1 AND id > $2 AND created_at <= NOW() ORDER BY id`,
            [session.id, after]
        );
        const pMap = personasMap(personas);
        const lf = lockedFrom(session);
        const list = msgs.map(m => publicMsg(m, pMap,
            access === 'locked' && m.sender !== 'user' && (!lf || new Date(m.created_at) >= lf)));
        if (msgs.length) await db.query(`UPDATE group_sessions SET last_seen_at = NOW() WHERE id = $1`, [session.id]);
        return res.json({ success: true, messages: list, access, trial_remaining: access === 'trial' ? trialState(session, group).remaining : 0 });
    } catch (err) {
        return res.json({ success: false });
    }
});

// POST /api/user/groups/:id/heartbeat {sec} — soma o tempo de TRIAL (grupo
// aberto na tela). Cruza o limite → marca locked_from (dali pra frente, blur).
router.post('/groups/:id/heartbeat', optionalUser, async (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    if (!groupId) return res.json({ success: false });
    try {
        const ident = getIdentity(req);
        const { rows: gr } = await db.query(`SELECT * FROM groups WHERE id = $1 AND active = true`, [groupId]);
        if (!gr.length) return res.json({ success: false });
        const group = gr[0];
        if (group.is_free) return res.json({ success: true, access: 'channel' });
        const session = await findOrCreateSession(groupId, ident, true);
        if (await ownsGroup(ident.email, group)) return res.json({ success: true, access: 'member' });
        const sec = Math.max(0, Math.min(15, parseInt(req.body?.sec, 10) || 10));
        const t = trialState(session, group);
        const newUsed = Math.min(t.limit + 60, (session.trial_used_seconds || 0) + sec);
        const crossed = t.remaining > 0 && newUsed >= t.limit;
        if (crossed) {
            const state = Object.assign({}, session.state || {}, { locked_from: new Date().toISOString() });
            await db.query(
                `UPDATE group_sessions SET trial_used_seconds = $2, state = $3, updated_at = NOW() WHERE id = $1`,
                [session.id, newUsed, JSON.stringify(state)]
            );
        } else {
            await db.query(
                `UPDATE group_sessions SET trial_used_seconds = $2, updated_at = NOW() WHERE id = $1`,
                [session.id, newUsed]
            );
        }
        const remaining = Math.max(0, t.limit - newUsed);
        return res.json({
            success: true,
            access: remaining > 0 ? 'trial' : 'locked',
            trial_remaining: remaining,
            unlock: remaining > 0 ? null : await groupUnlock(group),
        });
    } catch (err) {
        return res.json({ success: false });
    }
});

// POST /api/user/groups/:id/send {text} — membro OU trial ativo. Bots reagem.
router.post('/groups/:id/send', optionalUser, async (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    if (!groupId) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const ident = getIdentity(req);
        const text = (req.body?.text || '').toString().trim().slice(0, 500);
        if (!text) return res.status(400).json({ success: false, error: 'Mensagem vazia' });
        const { rows: gr } = await db.query(`SELECT * FROM groups WHERE id = $1 AND active = true`, [groupId]);
        if (!gr.length) return res.status(404).json({ success: false, error: 'Grupo não encontrado' });
        const group = gr[0];
        await hydrateGroupMedia(group);
        if (group.is_free) return res.status(403).json({ success: false, error: 'channel_readonly' });
        const session = await findOrCreateSession(groupId, ident, true);
        const access = await accessState(ident, group, session);
        if (access === 'locked') {
            return res.status(403).json({ success: false, error: 'vip_required', unlock: await groupUnlock(group) });
        }
        // TRIAL: só UMA mensagem — na 2ª tentativa, popup de planos
        if (access === 'trial') {
            const { rows: [{ n: sent }] } = await db.query(
                `SELECT COUNT(*)::int AS n FROM group_messages WHERE session_id = $1 AND sender = 'user'`,
                [session.id]
            );
            if (sent >= 1) {
                return res.status(403).json({ success: false, error: 'vip_required', unlock: await groupUnlock(group) });
            }
        }
        const { rows: [mine] } = await db.query(
            `INSERT INTO group_messages (session_id, sender, type, content) VALUES ($1, 'user', 'text', $2) RETURNING *`,
            [session.id, text]
        );
        // bots REAGEM (cena 'reacao') chegando nos próximos segundos via poll
        try {
            const scene = await pickScene(groupId, { category: 'reacao', period: periodNow() });
            if (scene) await materializeScene(session, group, scene, new Date(Date.now() + 2000), 1);
        } catch (_) {}
        await db.query(`UPDATE group_sessions SET last_seen_at = NOW(), updated_at = NOW() WHERE id = $1`, [session.id]);
        return res.json({ success: true, message: publicMsg(mine, {}, false) });
    } catch (err) {
        logger.error('Erro no send do grupo:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// GET /api/user/groups/:id/media — galeria (membro ou canal free)
router.get('/groups/:id/media', optionalUser, async (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    if (!groupId) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const ident = getIdentity(req);
        const { rows: gr } = await db.query(`SELECT * FROM groups WHERE id = $1 AND active = true`, [groupId]);
        if (!gr.length) return res.status(404).json({ success: false, error: 'Grupo não encontrado' });
        const group = gr[0];
        await hydrateGroupMedia(group);
        if (!group.is_free && !(await ownsGroup(ident.email, group))) {
            // galeria TRAVADA: mostra só as CONTAGENS (nada de mídia real) +
            // popup de planos no botão — o acervo vira isca de venda
            let vidCount = 0;
            if (group.media_video_library_id && group.media_video_collection_id) {
                try {
                    const vids = await listCollectionVideos(group.media_video_library_id, group.media_video_collection_id);
                    vidCount = (vids || []).length;
                } catch (_) {}
            }
            const imgCount = Array.isArray(group.media_image_urls) ? group.media_image_urls.length : 0;
            return res.json({
                success: true,
                locked: true,
                photos: imgCount,
                videos: vidCount,
                unlock: await groupUnlock(group),
            });
        }
        const images = Array.isArray(group.media_image_urls) ? group.media_image_urls : [];
        let videos = [];
        if (group.media_video_library_id && group.media_video_collection_id) {
            try {
                const vids = await listCollectionVideos(group.media_video_library_id, group.media_video_collection_id);
                videos = (vids || []).map(v => ({
                    title: v.title || null,
                    embed_url: bunnyEmbedUrl(group.media_video_library_id, v.guid),
                    // capa: thumbnailFileName vem da API do Bunny (fallback padrão)
                    thumb_url: bunnyThumbUrl(v.guid, v.thumbnailFileName || 'thumbnail.jpg'),
                }));
            } catch (_) {}
        }
        return res.json({ success: true, images, videos });
    } catch (err) {
        logger.error('Erro na mídia do grupo:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

module.exports = router;
// usado pelo group-worker (cenas continuam rodando com o app fechado)
module.exports.runBackgroundScenes = runBackgroundScenes;
