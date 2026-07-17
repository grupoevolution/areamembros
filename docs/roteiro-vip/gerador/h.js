// Helpers do builder do dia 0 — expandem chamadas compactas em blocos da agenda
let gi = 0;
const gap = () => 4 + ((gi++ * 7) % 27); // 4..30s, variado e determinístico

const B = (time, messages) => ({ day: 0, time, messages });
const rx = (reacts, start) => (reacts || []).map(([g, tx], i) => ({ p: start + i, g, t: 'text', text: tx, gap_s: gap() }));

// apresentação feminina/masculina + reações [[g,'texto'],...]
const A = (time, text, reacts) => B(time, [{ p: 1, g: 'f', t: 'presentation', text, gap_s: gap() }, ...rx(reacts, 2)]);
const AM = (time, text, reacts) => B(time, [{ p: 1, g: 'm', t: 'presentation', text, gap_s: gap() }, ...rx(reacts, 2)]);
// foto avulsa de uma pasta
const F = (time, folder, caption, reacts) => B(time, [{ p: 1, g: 'f', t: 'image', folder, text: caption, gap_s: gap() }, ...rx(reacts, 2)]);
// rajada de n vídeos sexy (legenda só no primeiro), mesma mulher mandando
const V = (time, n, caption, reacts) => B(time, [
    ...Array.from({ length: n }, (_, i) => {
        const m = { p: 1, g: 'f', t: 'video', folder: 'videos-sexy', gap_s: i === 0 ? gap() : 3 + (i % 3) };
        if (i === 0 && caption) m.text = caption;
        return m;
    }),
    ...rx(reacts, 2),
]);
// visualização única (foto da pasta vonce / vídeo da videos-sexy) — SEMPRE mulher
const VO = (time, kind, text, reacts) => B(time, [
    { p: 1, g: 'f', t: 'vonce', kind, folder: kind === 'foto' ? 'vonce' : 'videos-sexy', text, gap_s: gap() },
    ...rx(reacts, 2),
]);
// galeria agrupada (álbum misto)
const G = (time, fotos, videos, caption, reacts) => B(time, [
    { p: 1, g: 'f', t: 'album', folder: 'sexy', vfolder: 'videos-sexy', fotos, videos, text: caption, gap_s: gap() },
    ...rx(reacts, 2),
]);
// diálogo puro: [[p,g,'texto'],...]
const D = (time, lines) => B(time, lines.map(([p, g, tx]) => ({ p, g, t: 'text', text: tx, gap_s: gap() })));
const CTA = (time, top, label, link) => B(time, [
    { p: 1, g: 'f', t: 'text', text: top, gap_s: gap() },
    { p: 1, g: 'f', t: 'cta', label, link, gap_s: 8 },
]);

module.exports = { A, AM, F, V, VO, G, D, CTA };
