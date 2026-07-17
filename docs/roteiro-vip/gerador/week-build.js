// GERADOR DA SEMANA VIP — 7 dias × ~1200 msgs, determinístico.
// Fontes: pools-a (combináveis), pools-b (âncoras únicas), p1..p6 (diálogos do
// dia 0 colhidos como sementes de uso único). Saída: semana-vip.json com o
// mapeamento de pastas embutido (o painel aplica no import).
const fs = require('fs');
const PA = require('./pools-a');
const PB = require('./pools-b');
const H = require('./h');

// ── sementes: diálogos do dia 0 (blocos só-texto) + novos do pools-b ─────────
const day0 = ['./p1', './p2', './p3', './p4a', './p4b', './p6'].flatMap(p => require(p)(H));
const SKIP = ['CHEGOU A HORA', 'CONFISSÃO DA TARDE']; // já estão em JOGOS/CONFISSOES
const harvested = day0
    .filter(b => b.messages.length >= 2 && b.messages.every(m => m.t === 'text' && !m.admin))
    .filter(b => !SKIP.some(s => (b.messages[0].text || '').startsWith(s)))
    .map(b => b.messages.map(m => [m.p, m.g, m.text]));
const SEEDS = harvested.concat(PB.DIALOGS);

// pools pequenos locais
const AUTHOR_RE = [
'kkkk obrigada amores','calma que hoje tem mais 👀','vcs me deixam sem graça kkkk','atrevidos kkkk amo','tá bom, convenceram: depois mando outra',
'exagerados kkkk','o pv já tá pegando fogo depois dessa kkkk','sabia que vcs iam gostar 😏','paro ou continuo? kkkk','a plateia daqui é a melhor',
'kkkkk vcs não existem','só elogio bom, assim eu viro assídua kkk','guardem essa energia pra mais tarde 👀','de nada, assinado: a generosa kkk','me derreto com esse grupo kkkk',
'continuem assim e eu não saio mais daqui','kkkk juízo zero vcs','a próxima vem melhor, prometo','isso que é recepção kkkk','vou fingir modéstia: obrigada kkkk',
'vcs pedem, eu entrego, simples kkk','elogio aceito e retribuído com juros depois 😏','que isso kkkk parem... mentira, continuem','hoje eu tô mesmo me sentindo kkk','já volto com mais, aquecendo kkkk',
'kkkk beijo pra cada um','o incentivo de vcs é meu combustível','tô rindo sozinha aqui kkkk','anotado quem elogiou melhor 👀','vcs venceram, mais tarde tem parte 2'
];
const APRES_RESP = [
'obrigada gente 🥰 já amei aqui','que recepção!! obrigada amores','kkkk obrigada, já me sinto em casa','awn vcs são fofos, obrigada','obrigada!! espero corresponder à fama kkk',
'valeu meus novos amigos kkk','obrigada 🙈 tô tímida ainda mas passa','recepção nota 10 hein kkk','obrigada!! prometo participar bastante 👀','gente que carinho, obrigada',
'obrigada amores, podem me chamar de novata só hoje kkk','kkk obrigada, o grupo é melhor que falaram','obrigada!! e o pv tá aberto viu kkk','que gentileza, obrigada gente','obrigada 🥰 já tô me soltando',
'valeu povo!! bora resenhar','obrigada, escolhi o grupo certo então kkk','awn obrigada!! já favoritei o grupo kkk','obrigada gente linda','kkkk obrigada, agora me contem tudo desse grupo'
];
const CTA_DEFS = [
{ top: 'e quem quiser ver os vídeos COMPLETOS... tá tudo na área especial 🔥', label: 'VER OS VÍDEOS COMPLETOS 🔥', link: '/?go=videos' },
{ top: 'o que rola aqui é só a ponta... o catálogo tem MUITO mais 👀', label: 'VER TUDO AGORA 🔥', link: '/' },
{ top: 'os vídeos que não podem ficar no grupo estão AQUI 🙈', label: 'ASSISTIR AGORA 🔥', link: '/?go=videos' },
];

// ── aleatório determinístico + cursores globais de pool ─────────────────────
let s = 20260715;
const rng = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
const ri = (n) => Math.floor(rng() * n);
const cursors = {};
function take(name, pool) {
    const i = (cursors[name] = (cursors[name] ?? -1) + 1);
    return pool[i % pool.length];
}
let gi = 0;
const gap = () => 4 + ((gi++ * 7) % 27);

// ── helpers de bloco ─────────────────────────────────────────────────────────
const M = (p, g, t, x) => Object.assign({ p, g, t, gap_s: gap() }, x);
function reacts(n, start, opts = {}) {
    const out = [];
    for (let i = 0; i < n; i++) {
        const fem = rng() < (opts.femRatio ?? 0.3);
        const line = opts.pool ? take(opts.poolName, opts.pool)
            : fem ? take('reactF', PA.REACT_F) : take('reactM', PA.REACT_M);
        if (Array.isArray(line)) out.push(M(start + i, line[0], 'text', { text: line[1] }));
        else out.push(M(start + i, fem ? 'f' : 'm', 'text', { text: line }));
    }
    return out;
}

// ── geradores de bloco (retornam messages[]) ─────────────────────────────────
function apresF(night, comCidade) {
    const i = (cursors.apresF = (cursors.apresF ?? -1) + 1);
    const open = PA.APRES_OPEN[i % PA.APRES_OPEN.length];
    let meio = PA.APRES_MEIO[(i * 7) % PA.APRES_MEIO.length];
    const prof = (i % 5) < 3 ? ', ' + PA.APRES_PROF[(i * 3) % PA.APRES_PROF.length] : '';
    const fim = PA.APRES_FIM[(i * 11) % PA.APRES_FIM.length];
    const cidade = comCidade ? ', de {cidade}' : '';
    const text = `${open}, ${meio}${prof}${cidade}... ${fim}`;
    const n = 3 + (night ? 1 : 0) + (rng() < 0.7 ? 1 : 0);
    const msgs = [M(1, 'f', 'presentation', { text })];
    for (let k = 0; k < n; k++) {
        const w = take('welcF', PA.WELCOME_F);
        msgs.push(M(2 + k, w[0], 'text', { text: w[1] }));
    }
    if (rng() < 0.8) msgs.push(M(1, 'f', 'text', { text: take('apResp', APRES_RESP) }));
    return msgs;
}
function apresM() {
    const text = take('apresM', PA.APRES_M_FULL);
    const msgs = [M(1, 'm', 'presentation', { text })];
    for (let k = 0; k < 2 + ri(2); k++) {
        const w = take('welcM', PA.WELCOME_M);
        msgs.push(M(2 + k, w[0], 'text', { text: w[1] }));
    }
    return msgs;
}
function foto(folder, capPool, capName, night) {
    const msgs = [M(1, 'f', 'image', { folder, text: take(capName, capPool) })];
    msgs.push(...reacts(4 + (night ? 2 : 0) + (rng() < 0.6 ? 1 : 0), 2));
    if (rng() < 0.65) msgs.push(M(1, 'f', 'text', { text: take('authRe', AUTHOR_RE) }));
    return msgs;
}
function vonce(kind, night) {
    const msgs = [M(1, 'f', 'vonce', { kind, folder: kind === 'foto' ? 'vonce' : 'videos-sexy', text: take('vonceT', PA.VONCE_TXT) })];
    for (let k = 0; k < 3 + (night ? 1 : 0) + (rng() < 0.5 ? 1 : 0); k++) {
        const r = take('reactV', PA.REACT_VONCE);
        msgs.push(M(2 + k, r[0], 'text', { text: r[1] }));
    }
    return msgs;
}
function rajada(n, night) {
    const msgs = [];
    for (let i = 0; i < n; i++) {
        const m = M(1, 'f', 'video', { folder: 'videos-sexy' });
        if (i === 0) m.text = take('rajT', PA.RAJADA_TXT); else m.gap_s = 3 + (i % 3);
        msgs.push(m);
    }
    msgs.push(...reacts(3 + (night ? 2 : 0), 2));
    return msgs;
}
function galeria() {
    const fotos = 3 + ri(2), videos = 1 + ri(2);
    const msgs = [M(1, 'f', 'album', { folder: 'sexy', vfolder: 'videos-sexy', fotos, videos, text: take('galT', PA.GAL_TXT) })];
    msgs.push(...reacts(3 + ri(2), 2));
    if (rng() < 0.6) msgs.push(M(1, 'f', 'text', { text: take('authRe', AUTHOR_RE) }));
    return msgs;
}
function seedDialog() {
    const lines = take('seed', SEEDS);
    return lines.map(([p, g, tx]) => M(p, g, 'text', { text: tx }));
}
function chatter() {
    const n = 2 + (rng() < 0.35 ? 1 : 0);
    const msgs = [];
    for (let i = 0; i < n; i++) {
        const c = take('chat', PA.CHATTER);
        msgs.push(M(i + 1, c[0], 'text', { text: c[1] }));
    }
    return msgs;
}
function enquete() {
    const q = take('enq', PA.ENQUETES);
    const msgs = [M(1, 'f', 'text', { text: q })];
    for (let k = 0; k < 6 + ri(2); k++) {
        const o = take('opin', PA.OPINIONS);
        msgs.push(M(2 + k, o[0], 'text', { text: o[1] }));
    }
    msgs.push(M(1, 'f', 'text', { text: ['kkkk amei as respostas','o grupo não decepciona nas respostas kkk','anotei TUDO 👀','respostas dignas desse grupo kkkk','sabia que ia render kkk'][ri(5)] }));
    return msgs;
}
function cascata(amPm) {
    const pool = amPm === 'am' ? PA.GREET_AM : PA.GREET_PM;
    const rePool = amPm === 'am' ? PA.GREET_AM_RE : PA.GREET_PM_RE;
    const msgs = [M(1, 'f', 'text', { text: take('gr' + amPm, pool) })];
    for (let k = 0; k < 6 + ri(3); k++) {
        const r = take('grRe' + amPm, rePool);
        msgs.push(M(2 + k, r[0], 'text', { text: r[1] }));
    }
    return msgs;
}
const fixo = (lines) => lines.map(([p, g, tx]) => M(p, g, 'text', { text: tx }));

// ── grade horária: [iniMin, fimMin] × alocação por tipo ──────────────────────
// tipos: aF aM bd ac tr sx bn vf vv rj ga en se ch  (jogo/conf/cta/cascatas à parte)
const BANDS = [
    { i: 2,    f: 149,  aF: 3, sx: 2, vf: 2, vv: 2, rj: 1, se: 2, ch: 4 },              // madrugada
    { i: 150,  f: 329,  se: 1, ch: 2 },                                                  // vale
    { i: 330,  f: 389,  aF: 1, ch: 2 },                                                  // cedo
    { i: 391,  f: 479,  aF: 6, bd: 3, se: 1, ch: 2 },                                    // bom dia (cascata 06:4x)
    { i: 480,  f: 569,  aF: 4, bd: 1, ac: 1, sx: 1, se: 2, ch: 6 },                      // manhã 1
    { i: 570,  f: 689,  aF: 6, aM: 1, sx: 3, vf: 1, rj: 1, en: 1, se: 2, ch: 6 },        // manhã 2
    { i: 690,  f: 809,  aF: 5, tr: 1, sx: 3, rj: 1, ga: 1, se: 2, ch: 6 },               // almoço
    { i: 810,  f: 929,  aF: 5, tr: 2, sx: 3, vf: 1, rj: 1, en: 1, se: 2, ch: 6 },        // tarde
    { i: 931,  f: 1049, aF: 6, aM: 1, tr: 1, ac: 1, sx: 3, vf: 1, vv: 1, rj: 1, se: 1, ch: 6 }, // conf. tarde
    { i: 1050, f: 1139, aF: 5, sx: 4, vv: 1, rj: 2, se: 1, ch: 3 },                      // saída trabalho
    { i: 1140, f: 1229, aF: 7, aM: 1, sx: 4, vf: 1, vv: 2, rj: 2, ga: 1, se: 1, ch: 3 }, // esquenta
    { i: 1231, f: 1379, aF: 10, aM: 1, sx: 7, vf: 3, vv: 5, rj: 4, ga: 1, en: 1, se: 2, ch: 8 }, // PICO
    { i: 1380, f: 1438, aF: 4, sx: 2, bn: 4, vf: 1, vv: 1, se: 1, ch: 2 },               // reta final
];
const NIGHT = (min) => min >= 1140 || min < 150;

// ── monta um dia ─────────────────────────────────────────────────────────────
function buildDay(day) {
    const used = new Set();
    const items = [];
    const at = (min, messages) => {
        min = Math.max(0, Math.min(1439, Math.round(min)));
        while (used.has(min)) min = (min + 1) % 1440;
        used.add(min);
        const hh = String(Math.floor(min / 60)).padStart(2, '0');
        const mm = String(min % 60).padStart(2, '0');
        items.push({ day, time: hh + ':' + mm, messages });
    };
    // âncoras fixas do dia
    at(400 + ri(9), cascata('am'));                            // 06:40-06:49 bom dia
    at(930 + ri(9), fixo(PB.CONFISSOES[day]));                 // 15:30-15:39
    at(1290 + ri(9), fixo(PB.JOGOS[day]));                     // 21:30-21:39 jogo
    at(1420 + ri(12), cascata('pm'));                          // 23:40-23:52 boa noite
    if (day % 2 === 0) { const c = CTA_DEFS[(day / 2) % CTA_DEFS.length]; at(1398 + ri(8), [M(1, 'f', 'text', { text: c.top }), M(1, 'f', 'cta', { label: c.label, link: c.link, gap_s: 8 })]); }
    // cidade: 5 apresentações do dia (sorteadas nas bandas mais quentes)
    let cityLeft = 5;
    const rajSizes = [3, 4, 3, 4, 4, 3, 4, 3, 4, 3, 4, 4, 3, 4];
    let rajIdx = 0;
    for (const b of BANDS) {
        const span = b.f - b.i;
        const kinds = [];
        const push = (k, n) => { for (let j = 0; j < (n || 0); j++) kinds.push(k); };
        push('aF', b.aF); push('aM', b.aM); push('bd', b.bd); push('ac', b.ac); push('tr', b.tr);
        push('sx', b.sx); push('bn', b.bn); push('vf', b.vf); push('vv', b.vv); push('rj', b.rj);
        push('ga', b.ga); push('en', b.en); push('se', b.se); push('ch', b.ch);
        // embaralha determinístico
        for (let j = kinds.length - 1; j > 0; j--) { const k = ri(j + 1); [kinds[j], kinds[k]] = [kinds[k], kinds[j]]; }
        kinds.forEach((k, j) => {
            const min = b.i + (j + 0.15 + rng() * 0.7) * (span / kinds.length);
            const night = NIGHT(min);
            let messages;
            if (k === 'aF') { const cid = cityLeft > 0 && night === false && rng() < 0.18 ? (cityLeft--, true) : false; messages = apresF(night, cid); }
            else if (k === 'aM') messages = apresM();
            else if (k === 'bd') messages = foto('bom-dia', PA.CAP_BOMDIA, 'capBd', night);
            else if (k === 'ac') messages = foto('academia', PA.CAP_ACAD, 'capAc', night);
            else if (k === 'tr') messages = foto('trabalho', PA.CAP_TRAB, 'capTr', night);
            else if (k === 'sx') messages = foto('sexy', PA.CAP_SEXY, 'capSx', night);
            else if (k === 'bn') messages = foto('boa-noite', PA.CAP_BOANOITE, 'capBn', night);
            else if (k === 'vf') messages = vonce('foto', night);
            else if (k === 'vv') messages = vonce('video', night);
            else if (k === 'rj') messages = rajada(rajSizes[(rajIdx++) % rajSizes.length], night);
            else if (k === 'ga') messages = galeria();
            else if (k === 'en') messages = enquete();
            else if (k === 'se') messages = seedDialog();
            else messages = chatter();
            at(min, messages);
        });
    }
    // garante as 5 {cidade} do dia (se o sorteio não usou todas, injeta nas últimas aF)
    if (cityLeft > 0) {
        for (const it of items) {
            if (cityLeft <= 0) break;
            const m0 = it.messages[0];
            if (m0.t === 'presentation' && m0.g === 'f' && !/\{cidade\}/.test(m0.text)) {
                m0.text = m0.text.replace('... ', ', de {cidade}... ');
                cityLeft--;
            }
        }
    }
    items.sort((a, b2) => a.time.localeCompare(b2.time));
    return items;
}

// ── gera a semana + valida ───────────────────────────────────────────────────
const all = [];
for (let d = 0; d < 7; d++) all.push(...buildDay(d));

const FOLDERS = new Set(['bom-dia', 'trabalho', 'academia', 'sexy', 'boa-noite', 'vonce', 'videos-sexy']);
const errs = [];
const byDay = {};
for (const it of all) {
    const st = (byDay[it.day] = byDay[it.day] || { blocos: 0, msgs: 0, presF: 0, presM: 0, cidade: 0, videos: 0, vonce: 0, fotos: 0, album: 0 });
    st.blocos++;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(it.time)) errs.push('time ' + it.time);
    if (it.messages.length > 40) errs.push('bloco>40 ' + it.day + ' ' + it.time);
    for (const m of it.messages) {
        st.msgs++;
        if (m.folder && !FOLDERS.has(m.folder)) errs.push('pasta ' + m.folder);
        if (m.gap_s < 2 || m.gap_s > 600) errs.push('gap');
        if (m.t === 'presentation') { m.g === 'f' ? st.presF++ : st.presM++; if (/\{cidade\}/.test(m.text)) st.cidade++; }
        if (m.t === 'video') st.videos++;
        if (m.t === 'vonce') st.vonce++;
        if (m.t === 'image') st.fotos++;
        if (m.t === 'album') st.album++;
    }
}
console.log('POR DIA:');
Object.entries(byDay).forEach(([d, s2]) => console.log(' dia', d, JSON.stringify(s2)));
console.log('TOTAL blocos:', all.length, '| erros:', errs.length, errs.slice(0, 5));

if (!errs.length) {
    const out = {
        folders: {
            'bom-dia': 'IAGO GRUPOS/GRUPO VIP/bom-dia',
            'trabalho': 'IAGO GRUPOS/GRUPO VIP/trabalho',
            'academia': 'IAGO GRUPOS/GRUPO VIP/academia',
            'sexy': 'IAGO GRUPOS/GRUPO VIP/sexy',
            'boa-noite': 'IAGO GRUPOS/GRUPO VIP/boa-noite',
            'vonce': { path: 'IAGO GRUPOS/GRUPO VIP/vonce', hidden: true }, // fora da galeria: exclusividade real
            'videos-sexy': 'stream:*', // TODOS os vídeos da library do grupo (Membros VIP)
        },
        presentation_female_folder: 'IAGO GRUPOS/GRUPO VIP/apresentacao-mulheres',
        presentation_male_folder: 'IAGO GRUPOS/GRUPO VIP/apresentacao-homens',
        // trial de ~1min30 (o lead assiste a saudação inteira antes de travar)
        trial_seconds: 90,
        // saudação de entrada (roda 1x por lead, pinga ao vivo no 1º acesso)
        scenes: require('/Users/iagobastos/Downloads/areademembros2-0-main/docs/roteiro-vip/cena-entrada.json')
            .map(sc => Object.assign({ category: 'entrada', period: 'any', weight: 1 }, sc)),
        items: all,
    };
    fs.writeFileSync(process.argv[2] || 'semana-vip.json', JSON.stringify(out, null, 1));
    console.log('OK →', process.argv[2] || 'semana-vip.json');
}
