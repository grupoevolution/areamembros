/**
 * lib/testers.js — E-MAILS DE TESTE (out/2026)
 * O dono cadastra e-mails no painel (Configurações do App → "E-mails de teste").
 * Quem entra com um deles vê recursos ainda DESLIGADOS pra todo mundo (ex.:
 * Encontros), pra testar em produção antes de ligar a chave geral.
 *   gamification_config → key 'testers' → { emails: ['a@b.com', ...] }
 */
const db = require('../db');
let _cache = { at: 0, list: [] };
async function list() {
    if (Date.now() - _cache.at < 30000) return _cache.list;
    let emails = [];
    try {
        const { rows } = await db.query(`SELECT value FROM gamification_config WHERE key = 'testers'`);
        const v = (rows[0] && rows[0].value) || {};
        const raw = Array.isArray(v.emails) ? v.emails : String(v.emails || '').split(/[\s,;]+/);
        emails = raw.map(e => String(e || '').trim().toLowerCase()).filter(e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
    } catch (_) {}
    _cache = { at: Date.now(), list: emails };
    return emails;
}
async function isTester(email) {
    if (!email) return false;
    const l = await list();
    return l.includes(String(email).toLowerCase().trim());
}
function clearCache() { _cache = { at: 0, list: [] }; }
module.exports = { list, isTester, clearCache };
