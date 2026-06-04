/**
 * scripts/generate-icons.js
 *
 * Gera os ícones PNG necessários pro PWA a partir do SVG existente.
 *
 * Saída:
 *   public/assets/icon-192.png       (192x192, qualquer purpose)
 *   public/assets/icon-512.png       (512x512, qualquer purpose)
 *   public/assets/icon-maskable-512.png (512x512, com padding pra "safe area" do mascarável)
 *   public/assets/apple-touch-icon.png (180x180, iOS)
 *
 * Como rodar:
 *   node scripts/generate-icons.js
 *
 * Se não existir um SVG fonte, o script gera um placeholder vermelho ("M" em
 * branco) só pra o PWA ter ícones válidos. Substitua depois pelo seu logo
 * real (recomendo um PNG 1024x1024 transparente em public/assets/icon-source.png).
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ASSETS_DIR = path.resolve(__dirname, '..', 'public', 'assets');

if (!fs.existsSync(ASSETS_DIR)) fs.mkdirSync(ASSETS_DIR, { recursive: true });

// Fonte preferida: PNG 1024x1024 que você colocar em public/assets/icon-source.png
const SOURCE_PNG = path.join(ASSETS_DIR, 'icon-source.png');
// Fallback: o SVG já existente
const SOURCE_SVG = path.join(ASSETS_DIR, 'icon.svg');

async function getSource() {
    if (fs.existsSync(SOURCE_PNG)) {
        console.log('[icons] usando icon-source.png como fonte');
        return sharp(SOURCE_PNG);
    }
    if (fs.existsSync(SOURCE_SVG)) {
        console.log('[icons] usando icon.svg como fonte');
        return sharp(fs.readFileSync(SOURCE_SVG), { density: 384 });
    }
    // Placeholder: M branco em fundo gradiente vermelho
    console.log('[icons] nenhuma fonte encontrada — gerando placeholder vermelho');
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
        <defs>
          <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#e50914"/>
            <stop offset="100%" stop-color="#8B0000"/>
          </linearGradient>
        </defs>
        <rect width="1024" height="1024" fill="url(#g)"/>
        <text x="512" y="660" font-family="-apple-system,Helvetica,Arial" font-size="600"
              font-weight="900" fill="#ffffff" text-anchor="middle">M</text>
      </svg>`;
    return sharp(Buffer.from(svg), { density: 384 });
}

async function makeIcon(srcBuilder, size, outName, opts = {}) {
    const out = path.join(ASSETS_DIR, outName);
    const src = await srcBuilder();
    let pipeline = src.clone().resize(size, size, { fit: 'contain', background: opts.bg || { r: 229, g: 9, b: 20, alpha: 1 } });
    if (opts.padding) {
        // pra maskable: encolhe pra 80% e centraliza num quadrado da cor de fundo
        const inner = Math.floor(size * 0.8);
        const padBuf = await src.clone()
            .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .png()
            .toBuffer();
        pipeline = sharp({
            create: { width: size, height: size, channels: 4, background: opts.bg || { r: 229, g: 9, b: 20, alpha: 1 } },
        }).composite([{ input: padBuf, gravity: 'center' }]);
    }
    await pipeline.png({ compressionLevel: 9 }).toFile(out);
    const stat = fs.statSync(out);
    console.log(`[icons] ${outName} → ${(stat.size / 1024).toFixed(1)} KB`);
}

(async () => {
    try {
        const builder = () => getSource();
        await makeIcon(builder, 192, 'icon-192.png');
        await makeIcon(builder, 512, 'icon-512.png');
        await makeIcon(builder, 512, 'icon-maskable-512.png', { padding: true });
        await makeIcon(builder, 180, 'apple-touch-icon.png');
        console.log('[icons] OK — todos os ícones gerados em public/assets/');
    } catch (err) {
        console.error('[icons] FALHA:', err);
        process.exit(1);
    }
})();
