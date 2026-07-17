// Monta o dia-0.json final: junta as partes, ordena por horário e valida
const fs = require('fs');
const H = require('./h');

const parts = ['./p1', './p2', './p3', './p4a', './p4b', './p5', './p6'];
const all = parts.flatMap(p => require(p)(H));
all.sort((a, b) => a.time.localeCompare(b.time));

// ── VALIDAÇÃO ────────────────────────────────────────────────────────────────
const FOLDERS = new Set(['bom-dia', 'trabalho', 'academia', 'sexy', 'boa-noite', 'vonce', 'videos-sexy']);
const stats = { blocos: all.length, msgs: 0, presF: 0, presM: 0, cidade: 0, image: {}, videoRajada: 0, vonceFoto: 0, vonceVideo: 0, album: 0, albumFotos: 0, albumVideos: 0, cta: 0, text: 0 };
const errs = [];
const seenTimes = {};
for (const b of all) {
    if (b.day !== 0) errs.push('day != 0 em ' + b.time);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(b.time)) errs.push('time inválido: ' + b.time);
    seenTimes[b.time] = (seenTimes[b.time] || 0) + 1;
    if (!Array.isArray(b.messages) || !b.messages.length) errs.push('bloco vazio ' + b.time);
    if (b.messages.length > 40) errs.push('bloco >40 msgs ' + b.time);
    for (const m of b.messages) {
        stats.msgs++;
        if (m.gap_s !== undefined && (m.gap_s < 2 || m.gap_s > 600)) errs.push('gap fora ' + b.time);
        if (m.folder && !FOLDERS.has(m.folder)) errs.push('pasta desconhecida "' + m.folder + '" em ' + b.time);
        if (m.vfolder && !FOLDERS.has(m.vfolder)) errs.push('vfolder desconhecida em ' + b.time);
        if (m.t === 'presentation') {
            if (m.g === 'f') stats.presF++; else stats.presM++;
            if (/\{cidade\}/.test(m.text || '')) stats.cidade++;
        } else if (m.t === 'image') { stats.image[m.folder] = (stats.image[m.folder] || 0) + 1; }
        else if (m.t === 'video') stats.videoRajada++;
        else if (m.t === 'vonce') { m.kind === 'foto' ? stats.vonceFoto++ : stats.vonceVideo++; if (m.g !== 'f') errs.push('vonce não-mulher em ' + b.time); }
        else if (m.t === 'album') { stats.album++; stats.albumFotos += m.fotos || 0; stats.albumVideos += m.videos || 0; }
        else if (m.t === 'cta') stats.cta++;
        else stats.text++;
    }
}
for (const [t, n] of Object.entries(seenTimes)) if (n > 1) errs.push('horário duplicado: ' + t + ' (' + n + 'x)');
if (stats.cidade > 5) errs.push('mais de 5 apresentações com {cidade}: ' + stats.cidade);

const sexyFotoTotal = (stats.image.sexy || 0) + stats.albumFotos;
const videoTotal = stats.videoRajada + stats.albumVideos + stats.vonceVideo;
console.log(JSON.stringify({ ...stats, sexyFotoTotal, videoTotal, erros: errs }, null, 1));

if (!errs.length) {
    fs.writeFileSync(process.argv[2] || 'dia-0.json', JSON.stringify(all, null, 1));
    console.log('OK: escrito', process.argv[2]);
}
