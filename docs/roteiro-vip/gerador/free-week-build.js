// CANAL FREE — SEMANA (7 dias). Só o ADMIN posta. Anuncia a FAMÍLIA de grupos
// (VIP + os temáticos) e empurra o lead pra eles. Menos texto, mais mídia/teaser.
const fs = require('fs');

let s = 99260716;
const rng = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
const ri = (n) => Math.floor(rng() * n);
const cursors = {};
const take = (name, pool) => pool[(cursors[name] = (cursors[name] ?? -1) + 1) % pool.length];
const M = (t, x) => Object.assign({ p: 1, g: 'f', t, admin: true, gap_s: 5 }, x);

const NOMES_F = ['Juliana','Camila','Fernanda','Larissa','Amanda','Bruna','Patrícia','Vanessa','Aline','Renata','Débora','Michele','Simone','Adriana','Gabriela','Jéssica','Karina','Mariana','Natália','Rafaela','Thaís','Bianca','Luana','Nicole','Sandra','Talita','Viviane','Carol','Duda','Milena','Yasmin','Andressa','Lorena','Sabrina','Kelly','Evelyn','Priscila','Tatiane','Elaine','Fabiana','Letícia','Paula','Raquel','Daniela'];
const NOMES_M = ['Marcos','Diego','Rafael','Thiago','Carlos','Eduardo','Felipe','Gustavo','Renan','Bruno'];

// A FAMÍLIA de grupos que o canal anuncia. link: destino do botão. Enquanto os
// temáticos não estão ativos, o botão cai na ABA de grupos (/?go=groups) — o
// lead vê a lista e escolhe; o VIP (ativo) tem link direto.
const GROUPS = [
    { nome: 'GRUPO VIP', link: '/?group=2', tag: 'as mais gatas, conversa liberada' },
    { nome: 'CLUBE DAS CASADAS', link: '/?go=groups', tag: 'casadas safadas procurando fora' },
    { nome: 'VIZINHAS SAFADAS', link: '/?go=groups', tag: 'mulheres da sua região' },
    { nome: 'SÓ VALE NUDES', link: '/?go=groups', tag: 'nude o dia inteiro' },
    { nome: 'NOVINHAS +18', link: '/?go=groups', tag: 'as mais novinhas' },
    { nome: 'ENCONTROS & SEXO', link: '/?go=groups', tag: 'pra marcar de verdade' },
    { nome: 'CRENTES SAFADAS', link: '/?go=groups', tag: 'as recatadas que soltam a franga' },
    { nome: 'PUTARIA 24H', link: '/?go=groups', tag: 'não para nunca' },
    { nome: 'NAMORO E AMIZADE', link: '/?go=groups', tag: 'quem quer algo sério... ou não' },
];
const gGroup = () => take('grp', GROUPS);

const APRES_TXT = [
    '🔥 {N}, {I} anos — ONLINE AGORA no {G} e respondendo todo mundo 👇',
    '😈 {N}, {I} anos, casada... acabou de postar no {G}. Corre 👇',
    '👀 {N}, {I} anos — entrou AO VIVO no {G} agora. Ela conversa 👇',
    '🔞 {N}, {I} anos, solteira — mandou visualização única no {G} faz 2 minutos 👇',
    '🔥 {N}, {I} anos — a mais elogiada do {G} hoje. Tá online 👇',
    '😏 {N}, {I} anos — procurando papo AGORA no {G} 👇',
    '💣 {N}, {I} anos, divorciada — soltou um vídeo no {G} que tá dando o que falar 👇',
    '👑 {N}, {I} anos — a novata que tá dominando o {G}. Online agora 👇',
    '📍 {N}, {I} anos — tá pertinho de você, no {G} agora 👇',
];
const ENTROU_F = ['🔔 {N} acabou de entrar no {G} 👀','🔔 {N} entrou agora no {G}... e já se apresentou 🔥','🔔 {N} entrou no {G} 👀','🔔 mais uma: {N} acabou de entrar no {G} 😈'];
const ENTROU_M = ['🔔 {N} entrou no {G} agora — os homens tão chegando, corre 👀'];
const POST_CAPS = ['olha o clima do {G} nesse exato momento 🔥','uma das fotos que rolou AGORA lá no {G} 👀','isso aqui é só o que PODE ser mostrado... imagina o resto 😈','direto do {G} pra vitrine 🔥','as meninas do {G} não têm limite... prova 👇','foto liberada da resenha de hoje no {G} 🙈','o nível das mulheres do {G} 👑','só um gostinho do que rolou hoje cedo lá dentro 👀','vitrine atualizada: o {G} tá ASSIM hoje 🔥','uma cortesia das meninas do {G} 🙈','se aqui fora já é assim, imagina lá dentro 😈','essa foi a foto mais comentada do {G} hoje 🔥'];
const TEASER_F_TXT = ['essa foto tá SEM censura lá no {G} 😈','o que tem embaixo desse borrão? só quem tá no {G} sabe 👀','censurada AQUI... liberada no {G} 🔥','essa eu só mostro no {G} 😏'];
const TEASER_V_TXT = ['os primeiros segundos são grátis... o resto é no {G} 😈','prévia liberada — o vídeo completo tá no {G} 🔥','5 segundos pra você entender o nível do {G} 👀','assiste a prévia e vem pro {G} kkk'];
const STATUS_TXT = ['🔥 o {G} tá com a resenha PEGADA agora — quem entrar nessa hora pega tudo ao vivo','📊 mais de 300 mensagens na última hora no {G}... e você perdendo','😈 a noite no {G} começou — visualizações únicas rolando AGORA','👀 as meninas tão escolhendo os privados de hoje no {G}... só entra quem tá lá','🔥 recorde de hoje: 47 fotos postadas no {G} numa tarde'];

const fill = (txt, g, n, i) => txt.replace('{G}', g.nome).replace('{N}', n || '').replace('{I}', i || '');

let items = [];
function buildDay(day, seed) {
    s = seed;
    const used = new Set();
    const at = (min, messages) => {
        min = Math.round(min); while (used.has(min)) min++; used.add(min);
        items.push({ day, time: String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0'), messages });
    };
    const cta = (g) => M('cta', { label: 'ENTRAR NO ' + g.nome + ' 🔥', link: g.link, gap_s: 4 });
    const folderByHour = (min) => { const h = min / 60; if (h < 10) return 'bom-dia'; if (h < 12) return rng() < 0.5 ? 'academia' : 'sexy'; if (h < 17) return rng() < 0.35 ? 'trabalho' : 'sexy'; if (h < 22.5) return 'sexy'; return 'boa-noite'; };

    at(430 + ri(9), [M('text', { text: 'bom dia 😏 hoje os grupos amanheceram MOVIMENTADOS, olha só 👇' }), cta(GROUPS[0])]);
    at(1428 + ri(8), [M('text', { text: 'boa noite por aqui... lá nos grupos a madrugada tá SÓ começando 😈' }), cta(gGroup())]);

    // grade: [ini, fim, apres, entrou, post, teaserFoto, teaserVideo, status]
    const BANDS = [
        [440, 599, 1, 1, 2, 0, 0, 0],
        [600, 779, 1, 2, 2, 1, 0, 1],
        [780, 1019, 2, 2, 3, 1, 1, 1],
        [1020, 1199, 2, 2, 2, 0, 1, 1],
        [1200, 1420, 3, 3, 4, 2, 1, 2],
        [5, 80, 0, 1, 1, 0, 0, 1],
    ];
    for (const [ini, fim, nA, nE, nP, nTf, nTv, nS] of BANDS) {
        const kinds = [];
        const push = (k, n) => { for (let i = 0; i < n; i++) kinds.push(k); };
        push('A', nA); push('E', nE); push('P', nP); push('F', nTf); push('V', nTv); push('S', nS);
        for (let j = kinds.length - 1; j > 0; j--) { const k = ri(j + 1); [kinds[j], kinds[k]] = [kinds[k], kinds[j]]; }
        kinds.forEach((k, j) => {
            const min = ini + (j + 0.2 + rng() * 0.6) * ((fim - ini) / kinds.length);
            const g = gGroup();
            if (k === 'A') {
                const faixas = [['apres-jovem', 22, 28], ['apres-media', 29, 36], ['apres-madura', 37, 45]];
                const fx = faixas[ri(3)];
                at(min, [M('image', { folder: fx[0], text: fill(take('ap', APRES_TXT), g, take('nf', NOMES_F), fx[1] + ri(fx[2] - fx[1] + 1)) }), cta(g)]);
            } else if (k === 'E') {
                const fem = rng() < 0.78;
                at(min, [M('text', { text: fill(fem ? take('ef', ENTROU_F) : take('em', ENTROU_M), g, fem ? take('nf', NOMES_F) : take('nm', NOMES_M)) })]);
            } else if (k === 'P') at(min, [M('image', { folder: folderByHour(min), text: fill(take('pc', POST_CAPS), g) })]);
            else if (k === 'F') at(min, [M('teaser', { kind: 'foto', folder: 'sexy', text: fill(take('tf', TEASER_F_TXT), g), dest: g.link, dlabel: 'VER NO ' + g.nome + ' 🔥', dtext: 'Disponível apenas no ' + g.nome })]);
            else if (k === 'V') at(min, [M('teaser', { kind: 'video', folder: 'videos-sexy', text: fill(take('tv', TEASER_V_TXT), g), dest: g.link, dlabel: 'ASSISTIR NO ' + g.nome + ' 🔥', dtext: 'O vídeo completo tá no ' + g.nome, preview_s: 5 })]);
            else at(min, [M('text', { text: fill(take('st', STATUS_TXT), g) }), cta(g)]);
        });
    }
}

for (let d = 0; d < 7; d++) buildDay(d, 99260716 + d * 7919);
items.sort((a, b) => (a.day - b.day) || a.time.localeCompare(b.time));

const byDay = {};
for (const it of items) byDay[it.day] = (byDay[it.day] || 0) + it.messages.length;
console.log('CANAL FREE 7 dias → blocos:', items.length, '| msgs/dia:', JSON.stringify(byDay));

const out = {
    folders: {
        'bom-dia': 'IAGO GRUPOS/GRUPO VIP/bom-dia',
        'academia': 'IAGO GRUPOS/GRUPO VIP/academia',
        'trabalho': 'IAGO GRUPOS/GRUPO VIP/trabalho',
        'sexy': 'IAGO GRUPOS/GRUPO VIP/sexy',
        'boa-noite': 'IAGO GRUPOS/GRUPO VIP/boa-noite',
        'apres-jovem': { path: 'IAGO GRUPOS/GRUPO VIP/apresentacao-mulheres/22-28', hidden: true },
        'apres-media': { path: 'IAGO GRUPOS/GRUPO VIP/apresentacao-mulheres/29-36', hidden: true },
        'apres-madura': { path: 'IAGO GRUPOS/GRUPO VIP/apresentacao-mulheres/37-45', hidden: true },
        'videos-sexy': 'stream:AVULSOS,LB',
    },
    scenes: [
        { category: 'entrada', period: 'any', weight: 1, messages: [
            { p: 1, g: 'f', t: 'text', admin: true, text: '🔔 você entrou na VITRINE do Membros VIP — aqui é só a amostra do que rola nos grupos', gap_s: 4 },
            { p: 1, g: 'f', t: 'text', admin: true, text: '👀 agora mesmo tem mulher de {cidade} ONLINE nos grupos conversando com os membros', gap_s: 6 },
        ] },
        { category: 'entrada', period: 'any', weight: 1, messages: [
            { p: 1, g: 'f', t: 'text', admin: true, text: '😈 tem grupo pra tudo: casadas, vizinhas, novinhas, encontros... escolhe o teu e entra', gap_s: 7 },
            { p: 1, g: 'f', t: 'cta', admin: true, label: 'VER TODOS OS GRUPOS 🔥', link: '/?go=groups', gap_s: 5 },
        ] },
    ],
    items,
};
fs.writeFileSync(process.argv[2] || 'free-semana.json', JSON.stringify(out, null, 1));
console.log('OK →', process.argv[2] || 'free-semana.json');
