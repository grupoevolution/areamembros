/**
 * =============================================================================
 * lib/mailcheck.js — Sugestão de correção de email
 * =============================================================================
 *
 * Detecta erros de digitação comuns em domínios de email e sugere a correção.
 *
 * Exemplos:
 *   gmial.com      → gmail.com
 *   hotmai.com     → hotmail.com
 *   yaho.com       → yahoo.com
 *   gmail.co       → gmail.com
 *
 * Uso:
 *   const { suggestEmail, isValidEmail } = require('./mailcheck');
 *   const result = suggestEmail('user@gmial.com');
 *   // => { valid: true, suggestion: 'user@gmail.com', original: 'user@gmial.com' }
 *
 * =============================================================================
 */

// Domínios populares que a gente quer sugerir (cobre ~95% dos casos no Brasil)
const POPULAR_DOMAINS = [
    'gmail.com',
    'hotmail.com',
    'outlook.com',
    'yahoo.com',
    'yahoo.com.br',
    'icloud.com',
    'live.com',
    'uol.com.br',
    'bol.com.br',
    'terra.com.br',
    'globo.com',
    'ig.com.br',
    'msn.com',
    'me.com',
    'protonmail.com',
];

// TLDs populares pra sugerir quando o domínio inteiro estiver errado
const POPULAR_TLDS = ['com', 'com.br', 'net', 'org', 'io', 'co'];


/**
 * Calcula a distância de Levenshtein entre duas strings.
 * Usado pra decidir se um domínio é "parecido o suficiente" com um popular.
 */
function levenshtein(a, b) {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    const matrix = Array.from({ length: b.length + 1 }, () => 
        new Array(a.length + 1).fill(0)
    );

    for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
    for (let j = 0; j <= b.length; j++) matrix[j][0] = j;

    for (let j = 1; j <= b.length; j++) {
        for (let i = 1; i <= a.length; i++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            matrix[j][i] = Math.min(
                matrix[j][i - 1] + 1,       // deletion
                matrix[j - 1][i] + 1,       // insertion
                matrix[j - 1][i - 1] + cost // substitution
            );
        }
    }

    return matrix[b.length][a.length];
}


/**
 * Valida email usando regex simples (suficiente pra UI — o backend faz
 * validação mais rígida).
 */
function isValidEmail(email) {
    if (!email || typeof email !== 'string') return false;
    const trimmed = email.trim();
    if (trimmed.length < 5 || trimmed.length > 254) return false;
    // Regex básica: algo@algo.algo
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}


/**
 * Encontra o domínio mais próximo na lista de populares.
 * Retorna null se nenhum for próximo o suficiente.
 *
 * Regras:
 *   - Só sugere se houver erro de digitação real (não se for só .com vs .com.br)
 *   - Não sugere se a diferença é apenas adicionar/remover um TLD secundário
 *   - Distância mínima pra sugerir: 1 (igual não sugere)
 *   - Distância máxima: 35% do tamanho do candidato
 */
function findClosestDomain(domain, candidates = POPULAR_DOMAINS) {
    const lower = domain.toLowerCase();
    
    // Se já é um domínio popular, retorna null (sem sugestão)
    if (candidates.includes(lower)) return null;
    
    // Se a diferença é só adicionar ou remover ".br" do final,
    // não sugere (ambos domínios geralmente são válidos)
    // Ex: uol.com ↔ uol.com.br, hotmail.com ↔ hotmail.com.br
    const withBr = lower.endsWith('.br') ? lower.slice(0, -3) : lower + '.br';
    if (candidates.includes(withBr)) return null;
    
    let best = null;
    let bestDistance = Infinity;
    
    for (const candidate of candidates) {
        const dist = levenshtein(lower, candidate);
        
        // Não sugere se a distância é zero (já é igual — tratado acima)
        if (dist === 0) continue;
        
        // Só considera se a distância é pequena em relação ao tamanho
        // (pra evitar sugerir "gmail" pra "qqeradlskfj")
        const maxAllowedDistance = Math.max(1, Math.floor(candidate.length * 0.3));
        
        if (dist <= maxAllowedDistance && dist < bestDistance) {
            bestDistance = dist;
            best = candidate;
        }
    }
    
    return best;
}


/**
 * Analisa um email e retorna sugestão de correção se detectar erro comum.
 *
 * @param {string} email - Email digitado pelo cliente
 * @returns {Object} Resultado da análise
 *   - valid: boolean        - Se o email tem formato válido
 *   - original: string      - Email original normalizado (lowercase + trim)
 *   - suggestion: string|null - Email sugerido (null se não houver correção)
 *   - reason: string|null   - Motivo da sugestão (pra debug/log)
 */
function suggestEmail(email) {
    const result = {
        valid: false,
        original: null,
        suggestion: null,
        reason: null,
    };
    
    if (!email || typeof email !== 'string') {
        return result;
    }
    
    const normalized = email.toLowerCase().trim();
    result.original = normalized;
    
    // Formato inválido? Retorna sem sugestão
    if (!isValidEmail(normalized)) {
        return result;
    }
    
    result.valid = true;
    
    // Separa local e domínio
    const atIndex = normalized.lastIndexOf('@');
    const localPart = normalized.substring(0, atIndex);
    const domain = normalized.substring(atIndex + 1);
    
    // Tenta encontrar domínio parecido com os populares
    const closest = findClosestDomain(domain);
    
    if (closest && closest !== domain) {
        result.suggestion = `${localPart}@${closest}`;
        result.reason = `domain_typo:${domain}→${closest}`;
    }
    
    return result;
}


module.exports = {
    suggestEmail,
    isValidEmail,
    findClosestDomain,  // exportado pra testes
    levenshtein,        // exportado pra testes
    POPULAR_DOMAINS,
};
