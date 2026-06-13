/**
 * lib/geo.js — Cidade do cliente pelo IP (offline, sem serviço externo).
 *
 * Usa geoip-lite (optionalDependency). Se o pacote não estiver instalado,
 * resolveCity devolve null e quem chama usa o texto reserva ("sua região").
 * Precisão de IP móvel no Brasil costuma cair na capital do estado — por
 * isso o fallback configurável por chat.
 */

const { logger } = require('./logger');

let geoip = null;
let triedLoad = false;
function lazyGeoip() {
    if (triedLoad) return geoip;
    triedLoad = true;
    try { geoip = require('geoip-lite'); }
    catch (_) { logger.warn('[geo] geoip-lite não instalado — {cidade} usa fallback.'); geoip = null; }
    return geoip;
}

// Normaliza o IP (remove ::ffff: do IPv4-mapped, pega o 1º de uma lista)
function cleanIp(ip) {
    if (!ip) return null;
    let s = String(ip).split(',')[0].trim();
    if (s.startsWith('::ffff:')) s = s.slice(7);
    if (s === '::1' || s === '127.0.0.1') return null; // localhost: sem cidade
    return s;
}

// Devolve o nome da cidade ou null. Capitaliza simples.
function resolveCity(ip) {
    const g = lazyGeoip();
    const clean = cleanIp(ip);
    if (!g || !clean) return null;
    try {
        const r = g.lookup(clean);
        const city = r && r.city && String(r.city).trim();
        if (!city) return null;
        return city.length > 60 ? city.slice(0, 60) : city;
    } catch (_) { return null; }
}

module.exports = { resolveCity, cleanIp };
