/**
 * =============================================================================
 * scripts/init-db.js — Inicialização do banco de dados
 * =============================================================================
 *
 * Executa o schema.sql e cria o admin inicial a partir das variáveis
 * de ambiente ADMIN_USERNAME e ADMIN_INITIAL_PASSWORD.
 *
 * Como rodar:
 *   - Localmente:    node scripts/init-db.js
 *   - Na EasyPanel:  Console → node scripts/init-db.js
 *
 * Seguro de rodar várias vezes (não duplica dados).
 *
 * =============================================================================
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');


async function main() {
    console.log('============================================');
    console.log('Inicialização do banco — Area de Membros 2.0');
    console.log('============================================');
    
    // Validações
    if (!process.env.DATABASE_URL) {
        console.error('ERRO: DATABASE_URL não configurada.');
        process.exit(1);
    }
    // Defaults sensatos pra primeiro deploy
    if (!process.env.ADMIN_USERNAME) {
        process.env.ADMIN_USERNAME = 'admin';
        console.log('AVISO: ADMIN_USERNAME não definido — usando "admin"');
    }
    if (!process.env.ADMIN_INITIAL_PASSWORD || process.env.ADMIN_INITIAL_PASSWORD.length < 8) {
        process.env.ADMIN_INITIAL_PASSWORD = 'admin12345';
        console.log('AVISO: ADMIN_INITIAL_PASSWORD não definido — usando "admin12345". TROQUE depois!');
    }
    
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
    });
    
    try {
        // 1. Roda o schema
        console.log('\n[1/2] Aplicando schema...');
        const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
        const schema = fs.readFileSync(schemaPath, 'utf8');
        await pool.query(schema);
        console.log('      Schema aplicado.');
        
        // 2. Cria admin inicial (se ainda não existir)
        console.log('\n[2/2] Criando admin inicial...');
        
        const username = process.env.ADMIN_USERNAME;
        const password = process.env.ADMIN_INITIAL_PASSWORD;
        
        const { rows: existing } = await pool.query(
            'SELECT id FROM admins WHERE username = $1',
            [username]
        );
        
        if (existing.length > 0) {
            console.log(`      Admin '${username}' já existe. Pulando criação.`);
        } else {
            const hash = await bcrypt.hash(password, 12);
            await pool.query(
                'INSERT INTO admins (username, password_hash) VALUES ($1, $2)',
                [username, hash]
            );
            console.log(`      Admin '${username}' criado.`);
            console.log(`      ⚠️  Lembre de trocar a senha após o primeiro login!`);
        }
        
        // Resumo final
        const { rows: [{ count: productsCount }] } = await pool.query('SELECT COUNT(*)::int as count FROM products');
        const { rows: [{ count: categoriesCount }] } = await pool.query('SELECT COUNT(*)::int as count FROM categories');
        const { rows: [{ count: adminsCount }] } = await pool.query('SELECT COUNT(*)::int as count FROM admins');
        
        console.log('\n============================================');
        console.log('Inicialização concluída com sucesso!');
        console.log(`  Admins:      ${adminsCount}`);
        console.log(`  Categorias:  ${categoriesCount}`);
        console.log(`  Produtos:    ${productsCount}`);
        console.log('============================================');
        
    } catch (err) {
        console.error('\nErro durante inicialização:', err.message);
        if (err.stack) console.error(err.stack);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

main();
