// Gerador de roteiro (7 dias) pra grupo SECUNDÁRIO temático: MENOS diálogo,
// MAIS mídia. Reusa o acervo de mídia do VIP + pools genéricos de reação.
// Uso: node group-build.js "NOME DO TEMA" saida.json
const fs = require('fs');
const PA = require('./pools-a');
const THEMES = require('./themes');

const themeName = process.argv[2];
const theme = THEMES[themeName];
if (!theme || theme.skip) { console.error('tema inválido:', themeName); process.exit(1); }

let s = 33330000 + theme.id * 101;
const rng = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
const ri = (n) => Math.floor(rng() * n);
const cursors = {};
const take = (name, pool) => pool[(cursors[name] = (cursors[name] ?? -1) + 1) % pool.length];
let gi = 0;
const gap = () => 4 + ((gi++ * 7) % 27);
const M = (p, g, t, x) => Object.assign({ p, g, t, gap_s: gap() }, x);
const femR = theme.femOnly === false ? 0.75 : 1; // femOnly=false → alguns homens

// blocos
const react = (n) => { const o = []; for (let i = 0; i < n; i++) { const fem = rng() < 0.3; o.push(M(2 + i, fem ? 'f' : 'm', 'text', { text: fem ? take('rf', PA.REACT_F) : take('rm', PA.REACT_M) })); } return o; };
const reactV = (n) => { const o = []; for (let i = 0; i < n; i++) { const r = take('rv', PA.REACT_VONCE); o.push(M(2 + i, r[0], 'text', { text: r[1] })); } return o; };
const folderByHour = (min) => { const h = min / 60; if (h < 10) return 'bom-dia'; if (h < 12) return rng() < 0.5 ? 'academia' : 'sexy'; if (h < 17) return rng() < 0.35 ? 'trabalho' : 'sexy'; if (h < 22.5) return 'sexy'; return 'boa-noite'; };

function apres(night, comCidade) {
  let t = take('ap', theme.apres);
  if (!comCidade) t = t.replace(', de {cidade}', '').replace(' de {cidade}', '');
  const g = rng() < femR ? 'f' : 'm';
  const msgs = [M(1, g, 'presentation', { text: t })];
  for (let k = 0; k < 3 + (night ? 1 : 0); k++) { const w = take('wf', PA.WELCOME_F); msgs.push(M(2 + k, w[0], 'text', { text: w[1] })); }
  return msgs;
}
const foto = (folder, night) => [M(1, 'f', 'image', { folder, text: take('cap', theme.caps) }), ...react(3 + (night ? 2 : 0))];
const vonce = (kind, night) => [M(1, 'f', 'vonce', { kind, folder: kind === 'foto' ? 'sexy' : 'videos-sexy', text: take('vo', theme.vonce) }), ...reactV(3 + (night ? 1 : 0))];
const rajada = (n, night) => { const o = []; for (let i = 0; i < n; i++) { const m = M(1, 'f', 'video', { folder: 'videos-sexy' }); if (i === 0) m.text = take('rj', PA.RAJADA_TXT); else m.gap_s = 3 + (i % 3); o.push(m); } o.push(...react(2 + (night ? 1 : 0))); return o; };
const galeria = () => [M(1, 'f', 'album', { folder: 'sexy', vfolder: 'videos-sexy', fotos: 3 + ri(2), videos: 1 + ri(2), text: take('gt', PA.GAL_TXT) }), ...react(3 + ri(2))];
const chatter = () => { const a = take('ch', PA.CHATTER), b = take('ch', PA.CHATTER); return [M(1, a[0], 'text', { text: a[1] }), M(2, b[0], 'text', { text: b[1] })]; };
const cascata = (amPm) => { const pool = amPm === 'am' ? PA.GREET_AM : PA.GREET_PM; const re = amPm === 'am' ? PA.GREET_AM_RE : PA.GREET_PM_RE; const m = [M(1, 'f', 'text', { text: take('g' + amPm, pool) })]; for (let k = 0; k < 4 + ri(2); k++) { const r = take('gr' + amPm, re); m.push(M(2 + k, r[0], 'text', { text: r[1] })); } return m; };

let items = [];
function buildDay(day) {
  s = 33330000 + theme.id * 101 + day * 4441;
  const used = new Set();
  const at = (min, messages) => { min = Math.round(min); while (used.has(min)) min++; used.add(min); items.push({ day, time: String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0'), messages }); };
  at(430 + ri(9), cascata('am'));
  at(1425 + ri(9), cascata('pm'));
  // grade MÍDIA-PESADA: [ini,fim, apres, foto, vonce, rajada, galeria, chatter]
  const BANDS = [
    [2, 149, 2, 2, 1, 1, 0, 1],
    [150, 389, 1, 1, 0, 0, 0, 1],
    [440, 719, 4, 4, 1, 1, 1, 2],
    [720, 1019, 5, 5, 2, 2, 1, 2],
    [1020, 1199, 4, 4, 1, 1, 1, 1],
    [1200, 1420, 6, 6, 3, 3, 1, 2],
  ];
  for (const [ini, fim, nA, nF, nV, nR, nG, nC] of BANDS) {
    const kinds = [];
    const push = (k, n) => { for (let i = 0; i < n; i++) kinds.push(k); };
    push('A', nA); push('F', nF); push('V', nV); push('R', nR); push('G', nG); push('C', nC);
    for (let j = kinds.length - 1; j > 0; j--) { const k = ri(j + 1); [kinds[j], kinds[k]] = [kinds[k], kinds[j]]; }
    kinds.forEach((k, j) => {
      const min = ini + (j + 0.2 + rng() * 0.6) * ((fim - ini) / kinds.length);
      const night = min >= 1140 || min < 150;
      if (k === 'A') at(min, apres(night, rng() < 0.16));  // ~poucas com cidade
      else if (k === 'F') at(min, foto(folderByHour(min), night));
      else if (k === 'V') at(min, vonce(rng() < 0.5 ? 'foto' : 'video', night));
      else if (k === 'R') at(min, rajada(3 + ri(2), night));
      else if (k === 'G') at(min, galeria());
      else at(min, chatter());
    });
  }
}
for (let d = 0; d < 7; d++) buildDay(d);
items.sort((a, b) => (a.day - b.day) || a.time.localeCompare(b.time));

// saudação temática: pill + boas-vindas + VONCE isca + reações
const link = '/?group=' + theme.id;
const scenes = [
  { category: 'entrada', period: 'any', weight: 1, messages: [
    { p: 1, g: 'f', t: 'text', text: theme.saud[0][0], gap_s: 4 },
    { p: 2, g: 'f', t: 'text', text: 'bem vindo!! fica a vontade 😏', gap_s: 5 },
  ] },
  { category: 'entrada', period: 'any', weight: 1, messages: [
    { p: 1, g: 'f', t: 'text', text: theme.saud[1][0], gap_s: 5 },
    { p: 1, g: 'f', t: 'vonce', kind: 'foto', folder: 'sexy', text: 'toma uma amostra do que rola aqui 🙈', gap_s: 5 },
    { p: 2, g: 'm', t: 'text', text: 'MEU DEUS que recepção kkkk', gap_s: 5 },
    { p: 3, g: 'f', t: 'text', text: 'ela não perdoa mesmo kkkk', gap_s: 4 },
  ] },
  { category: 'entrada', period: 'any', weight: 1, messages: [
    { p: 1, g: 'f', t: 'vonce', kind: 'video', folder: 'videos-sexy', text: 'e um videozinho também... 1 visualização só 🔥', gap_s: 5 },
    { p: 2, g: 'm', t: 'text', text: 'esse grupo não existe kkkk', gap_s: 5 },
    { p: 3, g: 'f', t: 'text', text: 'agora fala com a gente... de onde você é? 👀', gap_s: 6 },
  ] },
  { category: 'novato', period: 'any', weight: 1, messages: [
    { p: 1, g: 'f', t: 'text', text: 'olhaaa ele falou!! seja bem vindo 😏', gap_s: 4 },
    { p: 2, g: 'f', t: 'text', text: 'conta de onde você é 👀', gap_s: 5 },
  ] },
  { category: 'reacao', period: 'any', weight: 1, messages: [
    { p: 1, g: 'f', t: 'text', text: 'kkkk adorei esse aí', gap_s: 4 },
    { p: 2, g: 'f', t: 'text', text: 'continua assim que você ganha mimo 😏', gap_s: 5 },
  ] },
];

const out = {
  folders: {
    'bom-dia': 'IAGO GRUPOS/GRUPO VIP/bom-dia',
    'academia': 'IAGO GRUPOS/GRUPO VIP/academia',
    'trabalho': 'IAGO GRUPOS/GRUPO VIP/trabalho',
    'sexy': 'IAGO GRUPOS/GRUPO VIP/sexy',
    'boa-noite': 'IAGO GRUPOS/GRUPO VIP/boa-noite',
    'videos-sexy': 'stream:*',
  },
  presentation_female_folder: 'IAGO GRUPOS/GRUPO VIP/apresentacao-mulheres',
  presentation_male_folder: 'IAGO GRUPOS/GRUPO VIP/apresentacao-homens',
  trial_seconds: 120,
  scenes, items,
};
const byDay = {}; let media = 0, txt = 0;
for (const it of items) { byDay[it.day] = (byDay[it.day] || 0) + it.messages.length; for (const m of it.messages) { if (['image', 'video', 'vonce', 'album'].includes(m.t)) media++; else txt++; } }
console.log(themeName, '(grupo ' + theme.id + ') → blocos:', items.length, '| msgs/dia:', JSON.stringify(byDay), '| mídia:', media, '| texto:', txt);
fs.writeFileSync(process.argv[3], JSON.stringify(out, null, 1));
