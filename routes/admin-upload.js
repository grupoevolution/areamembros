/**
 * /api/admin/upload — upload de imagem com resize automático.
 *
 * Aceita multipart/form-data com 1 file (campo "file") + preset (banner-produto,
 * card-produto, card-categoria, hero, avatar). Faz resize via sharp pra
 * resolução-alvo, salva em /app/uploads/<preset>/<filename>.webp e devolve
 * a URL final pra colar no formulário.
 *
 * Presets:
 *   hero            → 1080x1350 (4:5, padrão Insta feed)
 *   banner-produto  → 1080x1350
 *   card-produto    → 720x900
 *   card-categoria  → 600x600 (1:1)
 *   avatar          → 200x200
 *   raw             → mantém dimensões mas converte pra webp + comprime
 *
 * Saída sempre webp (qualidade 86, mais leve que JPG, melhor que PNG pra fotos).
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');
const { requireAdmin } = require('../lib/auth');
const { logger } = require('../lib/logger');

const UPLOADS_DIR = path.resolve(__dirname, '..', 'uploads');
const PUBLIC_BASE = '/uploads';

const PRESETS = {
    'hero':           { width: 1080, height: 1350, fit: 'cover' },
    'banner-produto': { width: 1080, height: 1350, fit: 'cover' },
    'card-produto':   { width: 720,  height: 900,  fit: 'cover' },
    'card-categoria': { width: 600,  height: 600,  fit: 'cover' },
    'avatar':         { width: 200,  height: 200,  fit: 'cover' },
    'raw':            { width: null, height: null, fit: 'inside' },
};

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 12 * 1024 * 1024, // 12MB
        files: 1,
    },
    fileFilter(_req, file, cb) {
        if (!/^image\/(jpeg|png|webp|jpg|gif|avif)$/i.test(file.mimetype)) {
            return cb(new Error('Formato inválido. Use JPG, PNG, WEBP, AVIF ou GIF.'));
        }
        cb(null, true);
    },
});

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeFilename(original) {
    const random = crypto.randomBytes(8).toString('hex');
    const ts = Date.now().toString(36);
    return `${ts}_${random}.webp`;
}

router.post('/', requireAdmin, (req, res) => {
    upload.single('file')(req, res, async (err) => {
        if (err) {
            return res.status(400).json({ success: false, error: err.message || 'Erro no upload' });
        }
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'Nenhum arquivo enviado' });
        }

        // SEGURANÇA: o presetKey vira nome de pasta — se viesse cru (ex.: "../../x")
        // permitiria gravar arquivo fora de uploads/. Força sempre uma chave do
        // whitelist; qualquer valor desconhecido cai em 'raw'.
        const rawPresetKey = (req.body?.preset || 'raw').toString();
        const presetKey = Object.prototype.hasOwnProperty.call(PRESETS, rawPresetKey) ? rawPresetKey : 'raw';
        const preset = PRESETS[presetKey];

        try {
            ensureDir(UPLOADS_DIR);
            const subdir = path.join(UPLOADS_DIR, presetKey);
            ensureDir(subdir);

            const filename = safeFilename(req.file.originalname);
            const finalPath = path.join(subdir, filename);

            let pipeline = sharp(req.file.buffer, { failOn: 'none' }).rotate(); // EXIF orientation

            if (preset.width && preset.height) {
                pipeline = pipeline.resize(preset.width, preset.height, {
                    fit: preset.fit,
                    withoutEnlargement: false,
                    position: 'attention', // smart crop pra rosto/olhos
                });
            } else if (preset.fit === 'inside') {
                pipeline = pipeline.resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true });
            }

            await pipeline
                .webp({ quality: 86, effort: 4 })
                .toFile(finalPath);

            const stat = fs.statSync(finalPath);
            const url = `${PUBLIC_BASE}/${presetKey}/${filename}`;

            return res.json({
                success: true,
                url,
                preset: presetKey,
                width: preset.width,
                height: preset.height,
                size: stat.size,
            });
        } catch (e) {
            logger.error('Erro processando upload:', e);
            return res.status(500).json({ success: false, error: 'Falha ao processar imagem' });
        }
    });
});

// Lista uploads recentes de um preset (pra reuso visual)
router.get('/list/:preset', requireAdmin, (req, res) => {
    const preset = req.params.preset;
    if (!PRESETS[preset]) {
        return res.status(400).json({ success: false, error: 'Preset inválido' });
    }
    try {
        const dir = path.join(UPLOADS_DIR, preset);
        if (!fs.existsSync(dir)) return res.json({ success: true, files: [] });
        const files = fs.readdirSync(dir)
            .filter(f => f.endsWith('.webp'))
            .map(f => {
                const stat = fs.statSync(path.join(dir, f));
                return {
                    url: `${PUBLIC_BASE}/${preset}/${f}`,
                    name: f,
                    size: stat.size,
                    mtime: stat.mtime,
                };
            })
            .sort((a, b) => b.mtime - a.mtime)
            .slice(0, 50);
        return res.json({ success: true, files });
    } catch (e) {
        logger.error('Erro listando uploads:', e);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// ─── Upload de áudio (separado — sem resize, copia direto) ────
const AUDIO_DIR = path.join(UPLOADS_DIR, 'audio');

const uploadAudio = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024, files: 1 },
    fileFilter(_req, file, cb) {
        if (!/^audio\/(mpeg|mp4|wav|ogg|webm|x-m4a|aac)$/i.test(file.mimetype)) {
            return cb(new Error('Formato de áudio inválido. Use MP3, WAV, M4A, OGG.'));
        }
        cb(null, true);
    },
});

function audioExt(mime, original) {
    const m = (mime || '').toLowerCase();
    if (m.includes('mpeg')) return 'mp3';
    if (m.includes('wav')) return 'wav';
    if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a';
    if (m.includes('ogg')) return 'ogg';
    if (m.includes('webm')) return 'webm';
    const fromName = (original || '').split('.').pop();
    return /^[a-z0-9]{2,5}$/i.test(fromName) ? fromName.toLowerCase() : 'mp3';
}

router.post('/audio', requireAdmin, (req, res) => {
    uploadAudio.single('file')(req, res, async (err) => {
        if (err) return res.status(400).json({ success: false, error: err.message || 'Erro no upload' });
        if (!req.file) return res.status(400).json({ success: false, error: 'Nenhum arquivo enviado' });
        try {
            ensureDir(UPLOADS_DIR);
            ensureDir(AUDIO_DIR);
            const ts = Date.now().toString(36);
            const rnd = crypto.randomBytes(6).toString('hex');
            const ext = audioExt(req.file.mimetype, req.file.originalname);
            const filename = `${ts}_${rnd}.${ext}`;
            const finalPath = path.join(AUDIO_DIR, filename);
            fs.writeFileSync(finalPath, req.file.buffer);
            const url = `${PUBLIC_BASE}/audio/${filename}`;
            const stat = fs.statSync(finalPath);
            return res.json({ success: true, url, size: stat.size, mime: req.file.mimetype });
        } catch (e) {
            logger.error('Erro upload áudio:', e);
            return res.status(500).json({ success: false, error: 'Falha ao salvar áudio' });
        }
    });
});

module.exports = router;
