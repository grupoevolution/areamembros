#!/usr/bin/env node
/**
 * Extrai todos os blocos <script>...</script> (sem src= e sem type=module
 * que poderia mudar parsing) e roda new Function() pra cada um pra
 * detectar erros de sintaxe.
 *
 * Uso: node scripts/check-html-js.js public/admin.html public/app.html
 */
const fs = require('fs');
const path = require('path');

const files = process.argv.slice(2);
if (!files.length) {
    console.error('Uso: node scripts/check-html-js.js <arquivos.html>');
    process.exit(1);
}

let hasError = false;

for (const file of files) {
    const src = fs.readFileSync(path.resolve(file), 'utf8');
    // Captura blocos <script> SEM atributo src= (inline)
    const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    let m;
    let idx = 0;
    while ((m = re.exec(src)) !== null) {
        idx++;
        const attrs = m[1] || '';
        // Pula <script src="..."> (não tem corpo interno relevante)
        if (/\bsrc\s*=/i.test(attrs)) continue;
        // Pula tipos não-JS (json, etc)
        if (/\btype\s*=\s*"([^"]*)"/i.test(attrs)) {
            const t = RegExp.$1;
            if (t && !/javascript|module/i.test(t)) continue;
        }
        const body = m[2];
        // Calcula linha aproximada do início do bloco
        const lineStart = src.slice(0, m.index).split('\n').length;
        try {
            // new Function valida sintaxe sem executar
            // eslint-disable-next-line no-new-func
            new Function(body);
        } catch (err) {
            hasError = true;
            console.error(`[X] ${file} bloco #${idx} (a partir da linha ~${lineStart}): ${err.message}`);
        }
    }
    console.log(`[OK] ${file}: ${idx} blocos <script> verificados`);
}

if (hasError) {
    process.exit(2);
}
console.log('Tudo OK.');
