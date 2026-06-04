/**
 * =============================================================================
 * routes/health.js — Health check endpoint
 * =============================================================================
 *
 * Usado por:
 *   - Docker HEALTHCHECK
 *   - EasyPanel (verifica se o container está saudável)
 *   - Você mesmo, pra confirmar que tá tudo rodando
 *
 * =============================================================================
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const db = require('../db');


/**
 * GET /health
 * Verifica se servidor e banco estão funcionando.
 */
router.get('/', async (req, res) => {
    const health = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: '2.0.0',
        phase: 'Fase 0 — Fundação',
        uptime_seconds: Math.floor(process.uptime()),
        node_version: process.version,
        environment: process.env.NODE_ENV || 'development',
    };
    
    // Testa banco
    try {
        const start = Date.now();
        await db.query('SELECT 1');
        health.database = {
            status: 'connected',
            latency_ms: Date.now() - start,
        };
    } catch (err) {
        health.status = 'degraded';
        health.database = {
            status: 'error',
            error: err.message,
        };
        return res.status(503).json(health);
    }
    
    return res.json(health);
});


/**
 * GET /health/bunny
 * Diagnostico: confere se as envs Bunny estao setadas e se o hls.min.js
 * existe no filesystem do container. Nao expoe valores sensiveis.
 */
router.get('/bunny', (req, res) => {
    const host = process.env.BUNNY_HLS_HOST || '';
    const key = process.env.BUNNY_API_KEY || '';
    const hlsPath = path.join(__dirname, '..', 'public', 'vendor', 'hls.min.js');
    let hlsExists = false;
    let hlsSizeKb = 0;
    try {
        const stat = fs.statSync(hlsPath);
        hlsExists = stat.isFile();
        hlsSizeKb = Math.round(stat.size / 1024);
    } catch (_) {}

    // Mascara o host: vz-60dd1013-52f.b-cdn.net -> vz-60***52f.b-cdn.net
    const maskedHost = host
        ? host.replace(/^(vz-[a-z0-9]{4})[a-z0-9-]*?([a-z0-9]{3}\.b-cdn\.net)$/i, '$1***$2')
        : null;

    res.json({
        bunny_hls_host_set: !!host,
        bunny_hls_host_sample: maskedHost,
        bunny_api_key_set: !!key,
        bunny_api_key_length: key ? key.length : 0,
        hls_min_js_exists: hlsExists,
        hls_min_js_size_kb: hlsSizeKb,
    });
});


module.exports = router;
