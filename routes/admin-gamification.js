/**
 * =============================================================================
 * routes/admin-gamification.js
 * =============================================================================
 * Endpoints pra ler/gravar configs de gamificação:
 * - Brindes (gifts_catalog)
 * - Missões (missions_list)
 * - Reviews (reviews_list)
 * - Regras de Desejos (wishes_config)
 * =============================================================================
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const { logger } = require('../lib/logger');
const { requireAdmin } = require('../lib/auth');

// Whitelist de keys válidas
const VALID_KEYS = [
    'gifts_catalog',
    'missions_list',
    'reviews_list',
    'wishes_config',
    'levels_list',
    'dopamine_event',
    'flash_offers',
    'login_config',
    'profile_config',
    'app_config',
    'home_layout',
    'live_notifications',
    'chat_config',
    'chat_rotation',
    'chat_greetings',
    'upgrade_rules',
];

// =============================================================================
// GET /api/admin/gamification — retorna TODAS as configs de uma vez
// =============================================================================
router.get('/', requireAdmin, async (req, res) => {
    try {
        const { rows } = await db.query(`
            SELECT key, value, updated_at, updated_by
            FROM gamification_config
            WHERE key = ANY($1)
        `, [VALID_KEYS]);
        
        const result = {};
        for (const row of rows) {
            result[row.key] = {
                value: row.value,
                updated_at: row.updated_at,
                updated_by: row.updated_by,
            };
        }
        
        // Preenche defaults pras keys faltantes
        for (const key of VALID_KEYS) {
            if (!result[key]) {
                result[key] = { value: defaultFor(key), updated_at: null, updated_by: null };
            }
        }
        
        return res.json({ success: true, configs: result });
    } catch (err) {
        logger.error('Erro lendo gamification:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// =============================================================================
// GET /api/admin/gamification/:key
// =============================================================================
router.get('/:key', requireAdmin, async (req, res) => {
    try {
        const { key } = req.params;
        if (!VALID_KEYS.includes(key)) {
            return res.status(400).json({ success: false, error: 'Key inválida' });
        }
        
        const { rows } = await db.query(
            'SELECT value, updated_at, updated_by FROM gamification_config WHERE key = $1',
            [key]
        );
        
        if (rows.length === 0) {
            return res.json({ success: true, value: defaultFor(key), updated_at: null });
        }
        
        return res.json({ success: true, ...rows[0] });
    } catch (err) {
        logger.error('Erro lendo gamification key:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// =============================================================================
// PUT /api/admin/gamification/:key — substitui o valor inteiro
// =============================================================================
router.put('/:key', requireAdmin, async (req, res) => {
    try {
        const { key } = req.params;
        const { value } = req.body || {};
        
        if (!VALID_KEYS.includes(key)) {
            return res.status(400).json({ success: false, error: 'Key inválida' });
        }
        if (value === undefined || value === null) {
            return res.status(400).json({ success: false, error: 'Value obrigatório' });
        }
        
        // Valida estrutura conforme a key
        const validation = validateValue(key, value);
        if (!validation.ok) {
            return res.status(400).json({ success: false, error: validation.error });
        }
        
        const adminUser = req.admin?.username || 'admin';
        
        await db.query(`
            INSERT INTO gamification_config (key, value, updated_by, updated_at)
            VALUES ($1, $2::jsonb, $3, NOW())
            ON CONFLICT (key) DO UPDATE SET
                value = EXCLUDED.value,
                updated_by = EXCLUDED.updated_by,
                updated_at = NOW()
        `, [key, JSON.stringify(value), adminUser]);
        
        return res.json({ success: true, message: 'Configuração salva' });
    } catch (err) {
        logger.error('Erro salvando gamification:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// =============================================================================
// VALIDAÇÕES
// =============================================================================

function validateValue(key, value) {
    if (typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, error: 'Value deve ser um objeto' };
    }
    
    if (key === 'gifts_catalog' || key === 'missions_list' || key === 'reviews_list') {
        if (!Array.isArray(value.items)) {
            return { ok: false, error: 'value.items deve ser array' };
        }
        if (value.items.length > 100) {
            return { ok: false, error: 'Máximo 100 itens' };
        }
    }
    
    if (key === 'gifts_catalog') {
        for (const item of value.items) {
            if (!item.id || !item.name || !item.type) {
                return { ok: false, error: 'Cada brinde precisa de id, name, type' };
            }
        }
    }
    
    if (key === 'missions_list') {
        for (const item of value.items) {
            if (!item.id || !item.title) {
                return { ok: false, error: 'Cada missão precisa de id e title' };
            }
            if (typeof item.goal !== 'number' || item.goal < 1) {
                return { ok: false, error: 'goal deve ser número positivo' };
            }
        }
    }
    
    if (key === 'reviews_list') {
        for (const item of value.items) {
            if (!item.id || !item.author || !item.text) {
                return { ok: false, error: 'Cada review precisa de id, author e text' };
            }
            if (typeof item.rating !== 'number' || item.rating < 1 || item.rating > 5) {
                return { ok: false, error: 'rating deve ser 1-5' };
            }
        }
    }
    
    if (key === 'wishes_config') {
        if (typeof value.max_discount_percent !== 'number' || value.max_discount_percent < 0 || value.max_discount_percent > 100) {
            return { ok: false, error: 'max_discount_percent deve ser 0-100' };
        }
    }
    
    if (key === 'levels_list') {
        if (!Array.isArray(value.items)) {
            return { ok: false, error: 'value.items deve ser array' };
        }
        if (value.items.length > 50) {
            return { ok: false, error: 'Máximo 50 níveis' };
        }
        for (const item of value.items) {
            if (!item.id || !item.name) {
                return { ok: false, error: 'Cada nível precisa de id e name' };
            }
            if (typeof item.xp_required !== 'number' || item.xp_required < 0) {
                return { ok: false, error: 'xp_required deve ser número >= 0' };
            }
        }
    }
    
    if (key === 'dopamine_event') {
        if (typeof value.weekday !== 'number' || value.weekday < 0 || value.weekday > 6) {
            return { ok: false, error: 'weekday deve ser 0-6 (0=domingo)' };
        }
    }
    
    if (key === 'flash_offers') {
        if (!Array.isArray(value.items)) {
            return { ok: false, error: 'value.items deve ser array' };
        }
        if (value.items.length > 50) {
            return { ok: false, error: 'Máximo 50 ofertas' };
        }
        for (const item of value.items) {
            if (!item.id || !item.title) {
                return { ok: false, error: 'Cada oferta precisa de id e title' };
            }
        }
    }
    
    // login_config / profile_config / app_config: objetos livres, validação leve
    if (key === 'login_config') {
        // Tudo opcional, mas se vier deve ser string
        for (const f of ['hero_title', 'hero_subtitle', 'cta_text', 'success_message', 'mailcheck_enabled']) {
            if (value[f] !== undefined && f !== 'mailcheck_enabled' && typeof value[f] !== 'string') {
                return { ok: false, error: `Campo ${f} deve ser texto` };
            }
        }
    }
    
    if (key === 'profile_config') {
        if (value.visible_cards !== undefined && !Array.isArray(value.visible_cards)) {
            return { ok: false, error: 'visible_cards deve ser array' };
        }
    }
    
    if (key === 'app_config') {
        if (value.maintenance_mode !== undefined && typeof value.maintenance_mode !== 'boolean') {
            return { ok: false, error: 'maintenance_mode deve ser boolean' };
        }
    }
    
    if (key === 'chat_greetings') {
        if (!Array.isArray(value.phrases)) {
            return { ok: false, error: 'value.phrases deve ser array' };
        }
        if (value.phrases.length > 200) {
            return { ok: false, error: 'Máximo 200 frases' };
        }
        const validPeriods = ['any', 'manha', 'tarde', 'noite', 'madrugada'];
        for (const p of value.phrases) {
            if (!p || typeof p.text !== 'string' || !p.text.trim()) {
                return { ok: false, error: 'Cada frase precisa de text' };
            }
            if (p.period !== undefined && !validPeriods.includes(p.period)) {
                return { ok: false, error: 'period deve ser any/manha/tarde/noite/madrugada' };
            }
        }
    }

    if (key === 'upgrade_rules') {
        if (!Array.isArray(value.rules)) {
            return { ok: false, error: 'value.rules deve ser array' };
        }
        if (value.rules.length > 30) {
            return { ok: false, error: 'Máximo 30 regras' };
        }
        for (const r of value.rules) {
            if (!r || !parseInt(r.has_product_id, 10)) {
                return { ok: false, error: 'Cada regra precisa do produto que o cliente TEM (has_product_id)' };
            }
            if (typeof r.checkout_url !== 'string' || !r.checkout_url.trim()) {
                return { ok: false, error: 'Cada regra precisa do link do checkout da diferença' };
            }
        }
    }

    if (key === 'home_layout') {
        if (!Array.isArray(value.sections)) {
            return { ok: false, error: 'sections deve ser array' };
        }
        if (value.sections.length > 30) {
            return { ok: false, error: 'Máximo 30 seções' };
        }
        const validSectionTypes = ['hero', 'flash_offer_banner', 'featured_carousel', 'category_carousel', 'banner_image', 'reviews_carousel', 'cta_block'];
        for (const sec of value.sections) {
            if (!sec.id || !sec.type) {
                return { ok: false, error: 'Cada seção precisa de id e type' };
            }
            if (!validSectionTypes.includes(sec.type)) {
                return { ok: false, error: `type "${sec.type}" inválido` };
            }
        }
    }
    
    return { ok: true };
}

function defaultFor(key) {
    if (key === 'gifts_catalog') return { items: [] };
    if (key === 'missions_list') return { items: [] };
    if (key === 'reviews_list') return { items: [] };
    if (key === 'levels_list') return {
        items: [
            { id: 'lv1', name: 'Iniciante', xp_required: 0, color: '#737373', icon: '🌱', perks: 'Acesso básico' },
            { id: 'lv2', name: 'Curioso', xp_required: 200, color: '#3b82f6', icon: '👀', perks: 'Roleta semanal desbloqueada' },
            { id: 'lv3', name: 'Dominador', xp_required: 800, color: '#e50914', icon: '🔥', perks: '+10% XP em todas ações' },
            { id: 'lv4', name: 'Insaciável', xp_required: 1800, color: '#facc15', icon: '⚡', perks: 'Brindes premium na roleta' },
            { id: 'lv5', name: 'Lenda', xp_required: 4000, color: '#a855f7', icon: '👑', perks: 'Acesso antecipado a lançamentos' },
        ]
    };
    if (key === 'dopamine_event') return {
        weekday: 4,
        weekday_name: 'Quinta',
        title: 'Quinta da Dopamina',
        subtitle: 'Brindes em dobro hoje!',
        xp_multiplier: 2,
        special_gift_id: null,
        active: true,
        hour_start: 0,    // 0-23
        hour_end: 24,     // 1-24 (24 = vai até meia-noite)
    };
    if (key === 'flash_offers') return { items: [] };
    if (key === 'login_config') return {
        hero_title: 'Bem-vindo de volta',
        hero_subtitle: 'Entre com seu email pra acessar seus produtos',
        cta_text: 'Entrar',
        success_message: 'Bem-vindo!',
        mailcheck_enabled: true,
        autologin_days: 90,
    };
    if (key === 'profile_config') return {
        visible_cards: ['avatar', 'level', 'wishes', 'stats', 'streak', 'missions'],
        show_apelido_edit: true,
        show_avatar_upload: true,
        show_logout: true,
    };
    if (key === 'app_config') return {
        app_name: 'Membros Vip',
        app_tagline: 'Sua coleção de conteúdo VIP',
        primary_color: '#e50914',
        maintenance_mode: false,
        maintenance_message: 'Estamos em manutenção. Volte em breve!',
        bonus_delay_minutes: 3,
        // ── TOGGLES (todos DESLIGADOS por padrão) ──────────────────
        // Liga no admin → "App geral" → seção "Funcionalidades extras"
        wheel_enabled: false,
        cofre_enabled: false,
        desejos_enabled: false,
        xp_enabled: false,
        missions_enabled: false,
        dopamine_enabled: false,
        reviews_enabled: false,
        live_notifications_enabled: false,
        flash_offers_enabled: false,
        streak_enabled: false,
        favorites_enabled: false,
        continue_watching_enabled: false,
        onboarding_enabled: false,
        referral_enabled: false,
        explore_tab_enabled: false,
        // ── Labels (mantidos) ──────────────────────────────────────
        show_continue_watching: false,
        label_cofre: '',
        label_roleta: '',
        label_desejos: '',
        label_xp: '',
        label_nivel: '',
        label_cofre_eyebrow: '',
        label_roleta_eyebrow: '',
        version: '1.0.0',
    };
    if (key === 'live_notifications') return {
        enabled: false,
        mode: 'real_only',
        visible_ms: 5000,
        gap_min_ms: 30000,
        gap_max_ms: 90000,
        initial_delay_ms: 8000,
        cities: ['SP', 'RJ', 'MG', 'BA', 'PR', 'RS', 'SC', 'GO', 'DF', 'CE', 'PE'],
        messages: [
            { template: '<strong>Alguém de {city}</strong> acabou de comprar', type: 'purchase' },
            { template: '<strong>{n} pessoas</strong> estão vendo isso agora', type: 'live' },
            { template: '<strong>{members}</strong> membros estão online', type: 'online' },
        ],
    };
    if (key === 'home_layout') return {
        sections: [
            { id: 's1', type: 'hero', active: true, title: 'Sua coleção VIP', subtitle: 'Os melhores conteúdos da semana' },
            { id: 's2', type: 'flash_offer_banner', active: true, label: 'Oferta relâmpago' },
            { id: 's3', type: 'featured_carousel', active: true, title: '🔥 Em alta agora', limit: 8 },
            { id: 's4', type: 'category_carousel', active: true, title: 'Mais Vendidos', category_slug: 'mais_vendidos', limit: 8 },
            { id: 's5', type: 'category_carousel', active: true, title: 'Criadoras de Conteúdo', category_slug: 'criadoras_conteudos', limit: 8 },
            { id: 's6', type: 'category_carousel', active: true, title: 'Para Homens', category_slug: 'para_homens', limit: 8 },
            { id: 's7', type: 'category_carousel', active: true, title: 'Fetiches', category_slug: 'fetiches', limit: 8 },
            { id: 's8', type: 'reviews_carousel', active: true, title: 'O que dizem' },
        ]
    };
    // Saudação automática: a lista real é semeada pela migração (lib/migrations.js);
    // este default só cobre banco recém-criado antes do INSERT rodar.
    if (key === 'chat_greetings') return { enabled_default: false, phrases: [] };
    // Upgrades entre planos (pague a diferença): regras avaliadas em ordem.
    if (key === 'upgrade_rules') return { rules: [] };
    if (key === 'wishes_config') return {
        max_discount_percent: 30,
        xp_to_wishes_ratio: 10,
        wishes_per_referral: 100,
        wishes_per_review: 20,
        min_wishes_to_use: 50,
    };
    return {};
}

module.exports = router;
