/**
 * =============================================================================
 * routes/user-groups.js — GRUPOS estilo WhatsApp com TIMELINE COMPARTILHADA
 * =============================================================================
 *
 * v4 (jul/2026): o grupo tem UMA linha do tempo, igual pra todos — como um
 * canal real. Ela NÃO é materializada: é COMPUTADA na leitura a partir da
 * AGENDA recorrente (group_schedule_items: dia do ciclo × horário Brasília).
 * O sorteio de nomes/fotos/idades é DETERMINÍSTICO por (grupo, item, ciclo):
 * todo mundo vê o mesmo, e a cada volta do ciclo a mídia rotaciona sem
 * repetir até esgotar a pasta. Janela rolante de window_hours (padrão 72h).
 *
 * Materializado compartilhado só o BROADCAST (group_broadcasts — envio
 * manual do painel; group_ids NULL = todos os grupos, 1 linha, sem fan-out).
 *
 * Camada POR LEAD (group_sessions/group_messages) ficou só com:
 *   - mensagens que o PRÓPRIO lead manda (e as reações 'reacao'/'novato');
 *   - roteiro de 'entrada' (pinga ao vivo no 1º acesso).
 *
 * Estados de acesso (inalterados):
 *   channel — grupo GRATUITO: tudo visível, nunca digita, CTA fixo.
 *   member  — comprou o produto do grupo OU tem o Passe (is_group_pass).
 *   trial   — trial_seconds ACUMULADOS com o grupo aberto (heartbeat).
 *   locked  — trial esgotado / assinatura vencida: mensagens novas chegam
 *             MASCARADAS (blur no app) + popup dos planos. Fim de trial
 *             dispara o chat de convite (groups.trial_end_chat_id).
 * =============================================================================
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const { logger } = require('../lib/logger');
const { optionalUser } = require('../lib/user-auth');
const { listCollectionVideos, bunnyEmbedUrl, bunnyThumbUrl, listStorageMedia, listStorageSubfolders } = require('../lib/bunny');
const { resolveCity } = require('../lib/geo');

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

// {cidade} das apresentações: geo por IP 1x por sessão (padrão do chat)
async function ensureSessionGeo(session, req) {
    if (session.city || session.ip) return;
    try {
        const raw = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString();
        const ip = raw.split(',')[0].trim().slice(0, 64) || null;
        const city = resolveCity(raw);
        session.ip = ip; session.city = city;
        await db.query(`UPDATE group_sessions SET ip = $2, city = $3 WHERE id = $1`, [session.id, ip, city]);
    } catch (_) {}
}

// ── Aleatório DETERMINÍSTICO (a base do "igual pra todos") ───────────────────
function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
}
function mulberry32(a) {
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const rand = (n) => Math.floor(Math.random() * n);
const pick = (arr) => (arr && arr.length ? arr[rand(arr.length)] : null);

// ═════════════════════════════════════════════════════════════════════════════
// ELENCO — os nomes saem daqui. Na timeline COMPARTILHADA o sorteio é seedado
// (todo mundo vê o mesmo nome); na camada pessoal (entrada/reação) continua o
// elenco por lead (session.state.cast), com recorrência de 75%.
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
// {cidade} sem geo: cai numa capital grande (seedado — igual pra todos)
const FALLBACK_CITIES = ['São Paulo','Rio de Janeiro','Belo Horizonte','Curitiba','Salvador','Fortaleza','Recife','Porto Alegre','Goiânia','Campinas'];

// ── Pastas de mídia v2 ───────────────────────────────────────────────────────
// media_folders aceita o formato antigo { chave: "pasta" } e o novo
// { chave: { path, label, hidden } }. hidden = fora da galeria (pastas de
// rosto/apresentação servem só pro roteiro).
function normalizeFolders(mediaFolders) {
    const out = {};
    const src = (mediaFolders && typeof mediaFolders === 'object' && !Array.isArray(mediaFolders)) ? mediaFolders : {};
    for (const key of Object.keys(src).slice(0, 30)) {
        const v = src[key];
        if (typeof v === 'string') out[key] = { path: v, label: key, hidden: false };
        else if (v && typeof v === 'object' && v.path) {
            out[key] = { path: String(v.path), label: String(v.label || key).slice(0, 60), hidden: v.hidden === true };
        }
    }
    return out;
}

// Pasta de APRESENTAÇÃO: sub-pastas "18-24" viram faixas etárias — a foto sai
// da faixa e a {idade} do texto é gerada DENTRO dela (foto casa com a idade).
const BAND_RE = /^(\d{1,2})\s*[-_]\s*(\d{1,2})$/;
async function loadPresFolder(folder, manualUrls) {
    const out = { bands: [], flat: [] };
    if (Array.isArray(manualUrls)) out.flat.push(...manualUrls.filter(u => typeof u === 'string' && u.trim()));
    if (!folder) return out;
    try {
        const media = await listStorageMedia(folder);
        out.flat.push(...media.filter(f => f.kind === 'image').map(f => f.url));
        const dirs = await listStorageSubfolders(folder);
        for (const d of dirs.slice(0, 12)) {
            const m = String(d).match(BAND_RE);
            if (!m) continue;
            const min = parseInt(m[1], 10), max = parseInt(m[2], 10);
            if (!(min >= 18 && max >= min && max <= 99)) continue;
            const files = (await listStorageMedia(folder + '/' + d)).filter(f => f.kind === 'image').map(f => f.url);
            if (files.length) out.bands.push({ label: d, min, max, files });
        }
    } catch (_) {}
    return out;
}

// Resolve TODAS as pastas do grupo (cache real fica no lib/bunny, 10 min).
// Muta o objeto group — chamar após carregar do banco.
async function hydrateGroupMedia(group) {
    try {
        group.folders = normalizeFolders(group.media_folders);
        group.folder_media = {};
        for (const key of Object.keys(group.folders)) {
            try { group.folder_media[key] = await listStorageMedia(group.folders[key].path); }
            catch (_) { group.folder_media[key] = []; }
        }
        // compat com a camada pessoal (cenas usam listas de URL de imagem)
        group.media_folder_urls = {};
        for (const key of Object.keys(group.folder_media)) {
            group.media_folder_urls[key] = group.folder_media[key].filter(f => f.kind === 'image').map(f => f.url);
        }
        const manual = Array.isArray(group.media_image_urls) ? group.media_image_urls : [];
        let legacyFolder = [];
        if (group.media_image_folder) {
            try { legacyFolder = (await listStorageMedia(group.media_image_folder)).filter(f => f.kind === 'image').map(f => f.url); } catch (_) {}
        }
        group.media_image_urls = manual.concat(legacyFolder.filter(u => manual.indexOf(u) < 0));
        group.pres = {
            m: await loadPresFolder(group.presentation_male_folder, group.presentation_male_urls),
            f: await loadPresFolder(group.presentation_female_folder, group.presentation_female_urls),
        };
    } catch (_) {}
    return group;
}

// ═════════════════════════════════════════════════════════════════════════════
// TIMELINE COMPARTILHADA (computada — nada disso toca o banco)
// ═════════════════════════════════════════════════════════════════════════════

// Agenda em cache curto (evita 1 query por poll de cada lead)
const _agendaCache = new Map(); // groupId -> { at, items }
async function loadAgenda(groupId) {
    const c = _agendaCache.get(groupId);
    if (c && Date.now() - c.at < 15000) return c.items;
    const { rows } = await db.query(
        `SELECT id, day, time_minutes, messages FROM group_schedule_items
         WHERE group_id = $1 AND active = true ORDER BY day, time_minutes, id`,
        [groupId]
    );
    _agendaCache.set(groupId, { at: Date.now(), items: rows });
    return rows;
}
function invalidateAgenda(groupId) { _agendaCache.delete(groupId); }

function anchorMs(group) {
    const a = group.cycle_anchor || group.created_at;
    return a ? new Date(a).getTime() : Date.now();
}

// Rotação sem repetição: cada mensagem tem um offset próprio e anda +1 a cada
// volta do ciclo — só repete quando a pasta inteira já rodou.
function rotatePick(list, baseSeed, k, usedIdx) {
    if (!Array.isArray(list) || !list.length) return null;
    let idx = (baseSeed + k) % list.length;
    let guard = list.length;
    while (usedIdx && usedIdx.has(idx) && guard-- > 0) idx = (idx + 1) % list.length;
    if (usedIdx) usedIdx.add(idx);
    return list[idx];
}

// Materializa (em memória) UMA ocorrência de um item da agenda no ciclo k.
// Retorna mensagens {sid, t, name, gender, admin, type, content, media_url, meta}.
// O conteúdo pode conter {cidade} — substituída por lead na hora de responder.
function renderOccurrence(group, item, k, occMs) {
    const msgs = Array.isArray(item.messages) ? item.messages : [];
    if (!msgs.length) return [];
    const seed = hashStr(group.id + ':' + item.id + ':' + k);
    const rng = mulberry32(seed);
    const femaleRatio = Number.isFinite(+group.female_ratio) ? +group.female_ratio : 80;
    const slotMap = {};
    const usedNames = new Set();
    const bySlot = (slot, g) => {
        if (slotMap[slot]) return slotMap[slot];
        const gender = (g === 'm' || g === 'f') ? g : (rng() * 100 < femaleRatio ? 'f' : 'm');
        const pool = gender === 'm' ? CAST_M : CAST_F;
        let n = pool[Math.floor(rng() * pool.length)];
        let guard = 8;
        while (usedNames.has(n) && guard-- > 0) n = pool[Math.floor(rng() * pool.length)];
        usedNames.add(n);
        slotMap[slot] = { n, g: gender };
        return slotMap[slot];
    };
    const usedPerList = new Map(); // evita 2 msgs da mesma ocorrência com a mesma mídia
    const usedFor = (key) => { if (!usedPerList.has(key)) usedPerList.set(key, new Set()); return usedPerList.get(key); };
    const folderFiles = (key, kind) =>
        ((group.folder_media && group.folder_media[key]) || []).filter(f => f.kind === kind).map(f => f.url);

    const out = [];
    let t = occMs;
    let idadeOcc = null;
    for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        const gap = Math.max(2, Math.min(600, parseInt(m.gap_s, 10) || (4 + Math.floor(rng() * 9))));
        t += gap * 1000;
        const isAdmin = m.admin === true;
        const person = isAdmin ? null : bySlot(m.p || 1, m.g === 'm' || m.g === 'f' ? m.g : null);
        const mseed = hashStr('m' + item.id + ':' + i);
        let type = 'text', content = (m.text || '').slice(0, 1000) || null, media = null, meta = null;
        let idadeMsg = null;

        if (m.t === 'image' || m.t === 'video' || m.t === 'audio') {
            type = m.t;
            const kind = m.t === 'image' ? 'image' : m.t;
            const key = (m.folder || '').toString().trim();
            const pool = key ? folderFiles(key, kind)
                : (kind === 'image' ? (group.media_image_urls || []) : []);
            media = rotatePick(pool, mseed, k, usedFor(key + ':' + kind));
            if (!media) { if (!content) continue; type = 'text'; }
        } else if (m.t === 'presentation') {
            type = 'image';
            const g = person ? person.g : 'f';
            const pres = (group.pres && group.pres[g]) || { bands: [], flat: [] };
            if (pres.bands.length) {
                const band = pres.bands[Math.floor(rng() * pres.bands.length)];
                media = rotatePick(band.files, mseed, k, usedFor('pres:' + g));
                idadeMsg = band.min + ((mseed + k * 3) % (band.max - band.min + 1));
            } else {
                media = rotatePick(pres.flat, mseed, k, usedFor('pres:' + g));
                idadeMsg = 19 + ((mseed + k * 3) % 15);
            }
            if (idadeOcc == null) idadeOcc = idadeMsg;
            if (!media) { if (!content) continue; type = 'text'; }
        } else if (m.t === 'vonce') {
            // visualização única: PRA MEMBRO abre de verdade (mídia real da
            // pasta, consumo por aparelho no app); pra não-membro é a isca
            type = 'vonce';
            const kind = m.kind === 'foto' ? 'foto' : 'video';
            meta = { kind };
            const key = (m.folder || '').toString().trim();
            if (key) media = rotatePick(folderFiles(key, kind === 'foto' ? 'image' : 'video'), mseed, k, usedFor(key + ':vonce'));
        } else if (m.t === 'cta') {
            type = 'cta';
            content = content || 'Ver agora';
            meta = { link_url: m.link || null, product_id: m.pid || null, cta_color: m.color || '#25a55f' };
        } else if (m.t && m.t !== 'text') {
            continue; // tipo desconhecido/futuro
        }

        if (content) {
            content = content.replace(/\{nome(\d+)\}/gi, (_, d) => bySlot(parseInt(d, 10), null).n);
            content = content.replace(/\{nome\}/gi, person ? person.n : (group.name || 'Admin'));
            const idade = idadeMsg != null ? idadeMsg : (idadeOcc != null ? idadeOcc : 19 + ((mseed + k) % 15));
            content = content.replace(/\{idade\}/gi, String(idade));
        }
        if (!content && !media && type !== 'vonce') continue;
        if (isAdmin) meta = Object.assign({}, meta || {}, { admin: true });
        out.push({
            sid: `s${item.id}_${k}_${i}`,
            t,
            name: isAdmin ? 'Admin' : person.n,
            gender: isAdmin ? null : person.g,
            type, content, media_url: media, meta,
        });
    }
    return out;
}

// Todas as mensagens compartilhadas da AGENDA com fromMs < t <= toMs
function computeAgendaWindow(group, items, fromMs, toMs) {
    if (!items.length) return [];
    const anchor = anchorMs(group);
    const cycleDays = Math.max(1, Math.min(60, group.cycle_days | 0 || 7));
    const cycleMs = cycleDays * 86400000;
    const out = [];
    const kMin = Math.max(0, Math.floor((fromMs - anchor) / cycleMs) - 1);
    const kMax = Math.floor((toMs - anchor) / cycleMs);
    for (const item of items) {
        const day = Math.min(Math.max(0, item.day | 0), cycleDays - 1);
        const offset = (day * 1440 + Math.min(Math.max(0, item.time_minutes | 0), 1439)) * 60000;
        for (let k = kMin; k <= kMax; k++) {
            const occ = anchor + k * cycleMs + offset
                + (hashStr('j' + item.id + ':' + k) % 46) * 1000; // jitter natural por ciclo
            if (occ > toMs) continue;
            if (occ < fromMs - 8 * 3600000) continue; // ocorrência velha demais pra ter msg na janela
            for (const msg of renderOccurrence(group, item, k, occ)) {
                if (msg.t > fromMs && msg.t <= toMs) out.push(msg);
            }
        }
    }
    return out;
}

// Broadcasts do painel que caem na janela (group_ids NULL = todos os grupos)
async function broadcastsWindow(groupId, fromMs, toMs) {
    try {
        // date_trunc: o cursor do cliente tem precisão de MILISSEGUNDO; sem
        // truncar, os microssegundos do Postgres re-entregam a mesma linha
        const { rows } = await db.query(
            `SELECT * FROM group_broadcasts
             WHERE date_trunc('milliseconds', created_at) > to_timestamp($1 / 1000.0)
               AND created_at <= to_timestamp($2 / 1000.0)
               AND (group_ids IS NULL OR group_ids @> $3::jsonb)
             ORDER BY created_at`,
            [fromMs, toMs, JSON.stringify([groupId])]
        );
        return rows.map(b => ({
            sid: 'b' + b.id,
            t: new Date(b.created_at).getTime(),
            name: b.sender_name || 'Admin',
            gender: null,
            type: b.type || 'text',
            content: b.content || null,
            media_url: b.media_url || null,
            meta: Object.assign({}, b.meta || {}, b.sender_name ? {} : { admin: true }),
        }));
    } catch (_) { return []; }
}

// Janela compartilhada completa (agenda + broadcast), ordenada
async function sharedWindow(group, fromMs, toMs) {
    const items = await loadAgenda(group.id);
    const agenda = computeAgendaWindow(group, items, fromMs, toMs);
    const casts = await broadcastsWindow(group.id, fromMs, toMs);
    const all = agenda.concat(casts);
    all.sort((a, b) => (a.t - b.t) || (a.sid < b.sid ? -1 : 1));
    return all;
}

// ── Máscara (locked) ─────────────────────────────────────────────────────────
// Conteúdo real nunca sai do servidor — vai uma frase FAKE de tamanho parecido
// (SEEDADA pelo id: estável entre polls), que o app mostra borrada.
const FAKE_S = ['vem no privado', 'olha isso kkk', 'que delícia', 'to passada', 'manda mais aí', 'sério isso?'];
const FAKE_M = ['gente olha o que ela mandou agora', 'vem cá que eu te mostro tudo kkk', 'quem viu isso ontem sabe kkkk', 'ela postou e apagou correndo'];
const FAKE_L = ['não acredito que ela mandou isso aqui no grupo, olha a foto que vazou agora', 'quem tava na resenha ontem à noite sabe muito bem do que eu to falando kkkk'];
function maskContent(content, seedKey) {
    const len = (content || '').length;
    const pool = len <= 14 ? FAKE_S : len <= 40 ? FAKE_M : FAKE_L;
    const idx = seedKey != null ? hashStr(String(seedKey)) % pool.length : Math.floor(Math.random() * pool.length);
    return pool[idx];
}

// Mensagem compartilhada → formato da API (aplica cidade por lead + máscara)
function publicShared(m, opts) {
    const masked = opts.masked === true && m.type !== 'vonce';
    let content = m.content;
    if (content && content.indexOf('{cidade}') >= 0) {
        const city = opts.city || FALLBACK_CITIES[hashStr('c' + m.sid) % FALLBACK_CITIES.length];
        content = content.replace(/\{cidade\}/gi, city);
    }
    // vonce: mídia real SÓ pra quem pode abrir (membro/canal) — isca pros demais
    let media = m.media_url;
    let meta = m.meta || null;
    if (m.type === 'vonce' && !opts.canOpenVonce) media = null;
    return {
        id: m.sid,
        sender: 'bot',
        name: m.name,
        gender: m.gender,
        type: masked ? (m.type === 'text' || m.type === 'cta' ? 'text' : 'image') : m.type,
        content: masked ? (m.type === 'text' || m.type === 'cta' ? maskContent(content, m.sid) : null) : content,
        media_url: masked ? null : media,
        meta: masked ? null : meta,
        created_at: new Date(m.t).toISOString(),
        masked,
    };
}

// ═════════════════════════════════════════════════════════════════════════════
// CAMADA PESSOAL — cenas 'entrada' (1º acesso), 'reacao'/'novato' (quando o
// lead fala) e as mensagens do próprio lead. Igual ao motor antigo, só que
// restrita a essas categorias.
// ═════════════════════════════════════════════════════════════════════════════
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

// Cena da camada pessoal (só 'entrada', 'reacao' e 'novato' existem agora)
async function pickScene(groupId, category) {
    const { rows } = await db.query(
        `SELECT * FROM group_scenes WHERE group_id = $1 AND active = true AND category = $2`,
        [groupId, category]
    );
    if (!rows.length) return null;
    const total = rows.reduce((s, r) => s + Math.max(1, r.weight | 0), 0);
    let roll = Math.random() * total;
    for (const r of rows) {
        roll -= Math.max(1, r.weight | 0);
        if (roll <= 0) return r;
    }
    return rows[rows.length - 1];
}

// Materializa uma cena PESSOAL (grava em group_messages desta sessão)
async function materializeScene(session, group, scene, baseTime, gapScale) {
    const msgs = Array.isArray(scene.messages) ? scene.messages : [];
    if (!msgs.length) return { messages: [], endTime: baseTime };
    gapScale = gapScale || 1;
    const femaleRatio = Number.isFinite(+group.female_ratio) ? +group.female_ratio : 80;
    const presSlot = (msgs.find(m => m.t === 'presentation') || {}).p || null;
    const slotMap = {};
    const usedInScene = new Set();
    const bySlot = (slot, g) => {
        if (slotMap[slot]) return slotMap[slot];
        const gender = (g === 'm' || g === 'f') ? g : (Math.random() * 100 < femaleRatio ? 'f' : 'm');
        const person = castPick(session, gender, slot === presSlot, usedInScene);
        slotMap[slot] = person;
        usedInScene.add(person.n);
        return person;
    };
    const imgs = Array.isArray(group.media_image_urls) ? group.media_image_urls : [];
    const folderUrls = (group.media_folder_urls && typeof group.media_folder_urls === 'object') ? group.media_folder_urls : {};
    const presFlat = (g) => {
        const p = (group.pres && group.pres[g]) || { bands: [], flat: [] };
        return p.flat.concat(p.bands.flatMap(b => b.files));
    };
    const out = [];
    let t = baseTime;
    for (const m of msgs) {
        const gap = Math.max(2, Math.min(600, parseInt(m.gap_s, 10) || (4 + rand(9))));
        t = new Date(t.getTime() + gap * gapScale * 1000);
        const isAdmin = m.admin === true;
        const person = isAdmin ? null : bySlot(m.p || 1, m.g === 'm' || m.g === 'f' ? m.g : null);
        let type = 'text', content = (m.text || '').slice(0, 1000) || null, media = null, meta = null;
        if (content) {
            content = content.replace(/\{nome(\d+)\}/gi, (_, d) => bySlot(parseInt(d, 10), null).n);
            content = content.replace(/\{nome\}/gi, person ? person.n : (group.name || 'Admin'));
            content = content.replace(/\{idade\}/gi, String(19 + rand(15)));
            content = content.replace(/\{cidade\}/gi, session.city || pick(FALLBACK_CITIES));
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
            media = pickUnusedMedia(session, 'pres:' + g, presFlat(g));
            if (!media) { if (!content) continue; type = 'text'; }
        } else if (m.t === 'vonce') {
            type = 'vonce';
            meta = { kind: m.kind === 'foto' ? 'foto' : 'video' };
        } else if (m.t === 'cta') {
            type = 'cta';
            content = content || 'Ver agora';
            meta = { link_url: m.link || null, product_id: m.pid || null, cta_color: m.color || '#25a55f' };
        } else if (m.t && m.t !== 'text') {
            continue;
        }
        if (!content && !media && type !== 'vonce') continue;
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
    await saveSessionState(session);
    return { messages: out, endTime: t };
}

// ROTEIRO DE ENTRADA: cenas 'entrada' rodam NA ORDEM no primeiro acesso, com
// timestamps pra FRENTE — pingam AO VIVO via poll. 1x por lead.
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
    let t = new Date(Date.now() + 6000);
    for (const s of scenes.slice(0, 10)) {
        const r = await materializeScene(session, group, s, t, 1);
        out.push(...r.messages);
        t = new Date(r.endTime.getTime() + (8 + rand(10)) * 1000);
    }
    return out;
}

// Mensagem pessoal (linha do group_messages) → formato da API
function publicPersonal(m, masked) {
    if (m.type === 'vonce') masked = false;
    return {
        id: m.id,
        sender: m.sender,
        name: m.sender === 'user' ? null : (m.sender_name || 'Membro'),
        gender: m.sender_gender || null,
        type: masked ? (m.type === 'text' ? 'text' : 'image') : m.type,
        content: masked ? (m.type === 'text' || m.type === 'cta' ? maskContent(m.content, m.id) : null) : m.content,
        media_url: masked ? null : m.media_url,
        meta: masked ? null : (m.meta || null),
        created_at: m.created_at,
        masked: masked === true,
    };
}

// ── Acesso / trial ───────────────────────────────────────────────────────────
function trialState(session, group) {
    const limit = Math.max(15, group.trial_seconds || 60);
    const used = session.trial_used_seconds || 0;
    return { limit, used, remaining: Math.max(0, limit - used) };
}
function lockedFrom(session) {
    const lf = session.state && session.state.locked_from;
    return lf ? new Date(lf) : null;
}

async function accessState(ident, group, session) {
    if (group.is_free) return 'channel';
    if (await ownsGroup(ident.email, group)) return 'member';
    const t = trialState(session, group);
    return t.remaining > 0 ? 'trial' : 'locked';
}

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
        if (rows.some(r => !r.expires_at)) return null;
        return rows.map(r => new Date(r.expires_at)).sort((a, b) => b - a)[0];
    } catch (_) { return null; }
}

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

function windowHours(group) {
    return Math.max(6, Math.min(720, group.window_hours | 0 || 72));
}

async function cleanupPersonal(session, group) {
    try {
        await db.query(
            `DELETE FROM group_messages WHERE session_id = $1 AND created_at < NOW() - make_interval(hours => $2)`,
            [session.id, windowHours(group)]
        );
    } catch (_) {}
}

// Mescla compartilhada + pessoal em ordem cronológica
function mergeTimeline(shared, personal) {
    const all = shared.concat(personal);
    all.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    return all;
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
        const now = Date.now();
        for (const g of groups) {
            const owned = await ownsGroup(ident.email, g);
            const session = await findOrCreateSession(g.id, ident, false);
            // última mensagem/contagem: computadas da agenda (sem mídia — só
            // preview de texto/tipo), iguais pra todo mundo
            const winFrom = now - windowHours(g) * 3600000;
            let shared = [];
            try { shared = await sharedWindow(g, winFrom, now); } catch (_) {}
            let last = null, unread = 0, masked = false;
            const lastShared = shared.length ? shared[shared.length - 1] : null;
            if (session) {
                masked = !g.is_free && !owned && trialState(session, g).remaining <= 0;
                const seen = session.last_seen_at ? new Date(session.last_seen_at).getTime() : 0;
                unread = shared.reduce((n, m) => n + (m.t > seen ? 1 : 0), 0);
                if (lastShared) {
                    last = {
                        name: lastShared.name || 'Membro',
                        preview: masked ? maskContent(lastShared.content, lastShared.sid)
                            : (lastShared.type === 'image' || lastShared.type === 'vonce' ? 'Foto'
                                : lastShared.type === 'video' ? 'Vídeo'
                                : lastShared.type === 'audio' ? 'Áudio'
                                : (lastShared.content || 'Mensagem')),
                        at: new Date(lastShared.t).toISOString(),
                    };
                }
            } else {
                // nunca entrou: número "cheio" pra dar curiosidade (estável por grupo)
                unread = Math.min(999, Math.max(shared.length, 40 + ((g.id * 37) % 160)));
                masked = !g.is_free;
                last = lastShared
                    ? { name: masked ? null : lastShared.name, preview: masked ? maskContent(lastShared.content, lastShared.sid) : (lastShared.content || 'Mensagem'), at: new Date(lastShared.t).toISOString() }
                    : (masked ? { name: null, preview: maskContent('primeira vez', 'g' + g.id), at: null } : null);
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
        await ensureSessionGeo(session, req);
        await cleanupPersonal(session, group);
        const access = await accessState(ident, group, session);
        const trial = trialState(session, group);

        // roteiro de entrada (1x por lead) pinga ao vivo enquanto ele olha
        await runEntryScript(session, group);

        const now = Date.now();
        const winFrom = now - windowHours(group) * 3600000;
        const shared = await sharedWindow(group, winFrom, now);
        const { rows: personal } = await db.query(
            `SELECT * FROM group_messages
             WHERE session_id = $1 AND created_at > to_timestamp($2 / 1000.0) AND created_at <= NOW()
             ORDER BY created_at, id LIMIT 300`,
            [session.id, winFrom]
        );

        const lf = lockedFrom(session);
        const lfMs = lf ? lf.getTime() : null;
        const canOpenVonce = access === 'member' || access === 'channel';
        const city = session.city || null;
        const sharedPub = shared.map(m => publicShared(m, {
            masked: access === 'locked' && (!lfMs || m.t >= lfMs),
            city, canOpenVonce,
        }));
        const personalPub = personal.map(m => publicPersonal(m,
            access === 'locked' && m.sender !== 'user' && (!lf || new Date(m.created_at) >= lf)));
        const list = mergeTimeline(sharedPub, personalPub).slice(-60);

        await db.query(`UPDATE group_sessions SET last_seen_at = NOW(), updated_at = NOW() WHERE id = $1`, [session.id]);

        // "entrou no grupo → modelo chama no privado" (1x por lead)
        let invite = null;
        if (!group.is_free && !session.invited_at && Array.isArray(group.invite_chat_ids) && group.invite_chat_ids.length) {
            await db.query(`UPDATE group_sessions SET invited_at = NOW() WHERE id = $1`, [session.id]);
            invite = { chat_ids: group.invite_chat_ids.slice(0, 3), delay_seconds: group.invite_delay_seconds || 120 };
        }

        const until = access === 'member' ? await memberUntil(ident.email, group) : null;

        // galeria existe se qualquer pasta visível/coleção tiver conteúdo
        const hasFolderMedia = Object.keys(group.folders || {}).some(k =>
            !group.folders[k].hidden && (group.folder_media[k] || []).length);
        return res.json({
            success: true,
            group: {
                id: group.id, name: group.name, avatar_url: group.avatar_url,
                is_free: group.is_free,
                members_count: group.members_count, online_count: group.online_count,
                has_media: !!(group.media_video_collection_id || (group.media_image_urls || []).length || hasFolderMedia),
                telegram_url: group.telegram_url || null,
                cta_label: group.cta_label || null,
                cta_link: group.cta_link || null,
            },
            access,
            trial_remaining: access === 'trial' ? trial.remaining : 0,
            trial_total: trial.limit,
            messages: list,
            server_now: new Date().toISOString(),
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

// GET /api/user/groups/:id/poll?after=ISO — cursor por TIMESTAMP (a timeline
// compartilhada é computada; ids numéricos não existem mais nela)
router.get('/groups/:id/poll', optionalUser, async (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    if (!groupId) return res.json({ success: false });
    try {
        const ident = getIdentity(req);
        const { rows: gr } = await db.query(`SELECT * FROM groups WHERE id = $1 AND active = true`, [groupId]);
        if (!gr.length) return res.json({ success: false });
        const group = gr[0];
        await hydrateGroupMedia(group);
        const session = await findOrCreateSession(groupId, ident, false);
        if (!session) return res.json({ success: true, messages: [] });
        const access = await accessState(ident, group, session);

        const now = Date.now();
        const winFrom = now - windowHours(group) * 3600000;
        let afterMs = Date.parse(req.query.after || '');
        if (!Number.isFinite(afterMs)) afterMs = now; // sem cursor: só o que vier daqui pra frente
        afterMs = Math.max(afterMs, winFrom);

        const shared = await sharedWindow(group, afterMs, now);
        // date_trunc: cursor em ms vs microssegundos do Postgres (sem isso a
        // mesma mensagem volta em todo poll até o cursor passar dela)
        const { rows: personal } = await db.query(
            `SELECT * FROM group_messages
             WHERE session_id = $1
               AND date_trunc('milliseconds', created_at) > to_timestamp($2 / 1000.0)
               AND created_at <= NOW()
             ORDER BY created_at, id LIMIT 100`,
            [session.id, afterMs]
        );
        const lf = lockedFrom(session);
        const lfMs = lf ? lf.getTime() : null;
        const canOpenVonce = access === 'member' || access === 'channel';
        const city = session.city || null;
        const sharedPub = shared.map(m => publicShared(m, {
            masked: access === 'locked' && (!lfMs || m.t >= lfMs),
            city, canOpenVonce,
        }));
        const personalPub = personal.map(m => publicPersonal(m,
            access === 'locked' && m.sender !== 'user' && (!lf || new Date(m.created_at) >= lf)));
        const list = mergeTimeline(sharedPub, personalPub);
        if (list.length) await db.query(`UPDATE group_sessions SET last_seen_at = NOW() WHERE id = $1`, [session.id]);
        return res.json({
            success: true, messages: list, access,
            server_now: new Date().toISOString(),
            trial_remaining: access === 'trial' ? trialState(session, group).remaining : 0,
        });
    } catch (err) {
        return res.json({ success: false });
    }
});

// POST /api/user/groups/:id/heartbeat {sec} — soma o tempo de TRIAL (grupo
// aberto na tela). Cruza o limite → marca locked_from + dispara o chat de
// convite de FIM DE TRIAL (groups.trial_end_chat_id), se configurado.
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
            // trial acabou → a "modelo" chama no privado com a oferta (1x —
            // startChatForIdentity não re-dispara se a conversa já existe)
            if (group.trial_end_chat_id) {
                try {
                    const { startChatForIdentity } = require('./user-chats');
                    startChatForIdentity(ident, group.trial_end_chat_id, req)
                        .catch(e => logger.warn('[grupos] chat fim de trial falhou: ' + e.message));
                } catch (_) {}
            }
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
        const { rows: [{ n: sent }] } = await db.query(
            `SELECT COUNT(*)::int AS n FROM group_messages WHERE session_id = $1 AND sender = 'user'`,
            [session.id]
        );
        // TRIAL: só UMA mensagem — na 2ª tentativa, popup de planos
        if (access === 'trial' && sent >= 1) {
            return res.status(403).json({ success: false, error: 'vip_required', unlock: await groupUnlock(group) });
        }
        const { rows: [mine] } = await db.query(
            `INSERT INTO group_messages (session_id, sender, type, content) VALUES ($1, 'user', 'text', $2) RETURNING *`,
            [session.id, text]
        );
        // bots REAGEM chegando nos próximos segundos via poll. 1ª mensagem do
        // lead → cena 'novato' (boas-vindas ao carne nova), senão 'reacao'.
        try {
            let scene = null;
            if (sent === 0) scene = await pickScene(groupId, 'novato');
            if (!scene) scene = await pickScene(groupId, 'reacao');
            if (scene) await materializeScene(session, group, scene, new Date(Date.now() + 2000), 1);
        } catch (_) {}
        await db.query(`UPDATE group_sessions SET last_seen_at = NOW(), updated_at = NOW() WHERE id = $1`, [session.id]);
        return res.json({ success: true, message: publicPersonal(mine, false) });
    } catch (err) {
        logger.error('Erro no send do grupo:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// GET /api/user/groups/:id/media — galeria: agrega as pastas NÃO escondidas
// (fotos e vídeos de arquivo) + coleção Bunny Stream + links manuais.
router.get('/groups/:id/media', optionalUser, async (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    if (!groupId) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        const ident = getIdentity(req);
        const { rows: gr } = await db.query(`SELECT * FROM groups WHERE id = $1 AND active = true`, [groupId]);
        if (!gr.length) return res.status(404).json({ success: false, error: 'Grupo não encontrado' });
        const group = gr[0];
        await hydrateGroupMedia(group);

        // agrega galeria: legado + pastas visíveis
        const images = [...(group.media_image_urls || [])];
        const fileVideos = [];
        for (const key of Object.keys(group.folders || {})) {
            if (group.folders[key].hidden) continue;
            for (const f of (group.folder_media[key] || [])) {
                if (f.kind === 'image' && images.indexOf(f.url) < 0) images.push(f.url);
                if (f.kind === 'video') fileVideos.push(f.url);
            }
        }
        let streamVideos = [];
        if (group.media_video_library_id && group.media_video_collection_id) {
            try {
                const vids = await listCollectionVideos(group.media_video_library_id, group.media_video_collection_id);
                streamVideos = (vids || []).map(v => ({
                    title: v.title || null,
                    embed_url: bunnyEmbedUrl(group.media_video_library_id, v.guid),
                    thumb_url: bunnyThumbUrl(v.guid, v.thumbnailFileName || 'thumbnail.jpg'),
                }));
            } catch (_) {}
        }

        if (!group.is_free && !(await ownsGroup(ident.email, group))) {
            // galeria TRAVADA: PRÉVIA real (thumbs) borrada no cliente — isca
            const vidThumbs = streamVideos.map(v => v.thumb_url).filter(Boolean);
            const preview = [];
            const maxP = 24;
            for (let i = 0; i < maxP; i++) {
                if (i < images.length) preview.push(images[i]);
                if (preview.length >= maxP) break;
                if (i < vidThumbs.length) preview.push(vidThumbs[i]);
                if (preview.length >= maxP) break;
            }
            return res.json({
                success: true,
                locked: true,
                photos: images.length,
                videos: streamVideos.length + fileVideos.length,
                preview,
                unlock: await groupUnlock(group),
            });
        }
        const videos = streamVideos.concat(fileVideos.map(u => ({ title: null, file_url: u, thumb_url: null })));
        return res.json({ success: true, images, videos });
    } catch (err) {
        logger.error('Erro na mídia do grupo:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

module.exports = router;
// usados pelo admin (invalidar cache da agenda ao salvar) e pela galeria
module.exports.invalidateAgenda = invalidateAgenda;
module.exports.hydrateGroupMedia = hydrateGroupMedia;
