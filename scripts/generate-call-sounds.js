/**
 * scripts/generate-call-sounds.js
 * Gera 2 sons de chamada (WAV PCM 16-bit mono, sem dependências):
 *   public/assets/ringback.wav  — "chamando..." (cliente liga pra modelo)
 *   public/assets/ringtone.wav  — "telefone tocando" (modelo liga pro cliente)
 * Rodar: node scripts/generate-call-sounds.js
 */
const fs = require('fs');
const path = require('path');
const SR = 16000;
const ASSETS = path.resolve(__dirname, '..', 'public', 'assets');

function writeWav(file, samples) {
    const n = samples.length;
    const buf = Buffer.alloc(44 + n * 2);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28);
    buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
    buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) {
        const s = Math.max(-1, Math.min(1, samples[i] || 0));
        buf.writeInt16LE((s * 32767) | 0, 44 + i * 2);
    }
    fs.writeFileSync(file, buf);
    console.log('[sons] ' + path.basename(file) + ' → ' + (buf.length / 1024).toFixed(1) + ' KB');
}

// soma de senóides com fade nas pontas (evita clique), opcional tremolo (warble)
function burst(samples, startSec, durSec, freqs, amp, tremHz) {
    const start = Math.floor(startSec * SR), n = Math.floor(durSec * SR);
    const fadeN = 0.012 * SR;
    for (let i = 0; i < n; i++) {
        const t = i / SR;
        const fade = Math.min(1, i / fadeN, (n - i) / fadeN);
        let v = 0; for (const f of freqs) v += Math.sin(2 * Math.PI * f * t);
        v /= freqs.length;
        const trem = tremHz ? (0.62 + 0.38 * Math.sin(2 * Math.PI * tremHz * t)) : 1;
        samples[start + i] = (samples[start + i] || 0) + v * amp * fade * trem;
    }
}

// RINGBACK (chamando) — 425 Hz, 1s ligado / 4s desligado (padrão BR). 5s, faz loop.
(function () {
    const total = Math.floor(5 * SR);
    const s = new Float32Array(total);
    burst(s, 0, 1.0, [425], 0.33, 0);
    writeWav(path.join(ASSETS, 'ringback.wav'), s);
})();

// RINGTONE (telefone tocando) — "briiing briiing" (440+480 c/ warble 22Hz),
// 0.4s on / 0.2s gap / 0.4s on, depois 2.4s de silêncio. ~4s, faz loop.
(function () {
    const total = Math.floor(4 * SR);
    const s = new Float32Array(total);
    burst(s, 0.0, 0.4, [440, 480], 0.34, 22);
    burst(s, 0.6, 0.4, [440, 480], 0.34, 22);
    writeWav(path.join(ASSETS, 'ringtone.wav'), s);
})();

console.log('[sons] OK');
