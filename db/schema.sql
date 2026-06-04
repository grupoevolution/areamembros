-- ============================================================================
-- SCHEMA DO BANCO DE DADOS - AREA DE MEMBROS 2.0
-- ============================================================================
--
-- Esse arquivo é a estrutura completa do banco.
-- Rode com: node scripts/init-db.js
--
-- Tabelas:
--   1. admins                - Administradores do painel
--   2. customers             - Clientes que têm acesso (por email)
--   3. categories            - Categorias de produtos (fetiche, homens, etc)
--   4. products              - Produtos/conteúdos
--   5. product_media         - Galeria de mídia de cada produto
--   6. product_offers        - Ofertas por gateway (Kirvano, PerfectPay)
--   7. user_access           - Liberações de acesso por email
--   8. webhook_logs          - Log de todos os webhooks recebidos
--   9. product_views         - Estatísticas de visualização
--  10. system_settings       - Configurações globais (gateway ativo, etc)
--
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Extensões
-- ----------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";


-- ----------------------------------------------------------------------------
-- 1. ADMINS
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS admins (
    id              SERIAL PRIMARY KEY,
    username        VARCHAR(50) UNIQUE NOT NULL,
    password_hash   VARCHAR(255) NOT NULL,
    failed_logins   INTEGER DEFAULT 0,
    locked_until    TIMESTAMPTZ,
    last_login_at   TIMESTAMPTZ,
    last_login_ip   VARCHAR(45),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);


-- ----------------------------------------------------------------------------
-- 2. CUSTOMERS (clientes — identificados por email)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS customers (
    id              SERIAL PRIMARY KEY,
    email           VARCHAR(255) UNIQUE NOT NULL,
    name            VARCHAR(255),
    phone           VARCHAR(30),
    document        VARCHAR(20),
    first_seen_at   TIMESTAMPTZ DEFAULT NOW(),
    last_login_at   TIMESTAMPTZ,
    last_login_ip   VARCHAR(45),
    total_purchases INTEGER DEFAULT 0,
    total_spent     DECIMAL(10,2) DEFAULT 0,
    metadata        JSONB DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(LOWER(email));


-- ----------------------------------------------------------------------------
-- 3. CATEGORIES (categorias dinâmicas, editáveis pelo admin)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS categories (
    id              SERIAL PRIMARY KEY,
    slug            VARCHAR(50) UNIQUE NOT NULL,
    name            VARCHAR(100) NOT NULL,
    description     TEXT,
    icon            VARCHAR(50),
    display_order   INTEGER DEFAULT 0,
    is_active       BOOLEAN DEFAULT true,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Categorias iniciais que o seu sistema já tem
INSERT INTO categories (slug, name, display_order) VALUES
    ('mais_vendidos',       'Mais Vendidos',         1),
    ('criadoras_conteudos', 'Criadoras de Conteúdo', 2),
    ('chamadas_video',      'Chamadas de Vídeo',     3),
    ('para_homens',         'Para Homens',           4),
    ('fetiches',            'Fetiches',              5)
ON CONFLICT (slug) DO NOTHING;


-- ----------------------------------------------------------------------------
-- 4. PRODUCTS (produtos do catálogo)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS products (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    category_id     INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    banner_url      TEXT,
    main_video_url  TEXT,
    access_url      TEXT,
    price           DECIMAL(10,2) DEFAULT 0,
    is_active       BOOLEAN DEFAULT true,
    is_featured     BOOLEAN DEFAULT false,
    display_order   INTEGER DEFAULT 0,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(is_active);

-- Coluna is_published (Fase 1.1) — adicionada via migration idempotente.
-- Produto só fica visível pro cliente quando is_published = true. Default FALSE
-- pra permitir cadastro em RASCUNHO (sem gateway/link de checkout ainda).
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_published BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_products_published ON products(is_published) WHERE is_published = true;


-- ----------------------------------------------------------------------------
-- 5. PRODUCT_MEDIA (galeria de imagens e vídeos de cada produto)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS product_media (
    id              SERIAL PRIMARY KEY,
    product_id      INTEGER REFERENCES products(id) ON DELETE CASCADE,
    media_type      VARCHAR(10) CHECK (media_type IN ('image', 'video')),
    url             TEXT NOT NULL,
    thumbnail_url   TEXT,
    display_order   INTEGER DEFAULT 0,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_media_product ON product_media(product_id);


-- ----------------------------------------------------------------------------
-- 6. PRODUCT_OFFERS (ofertas por gateway de pagamento)
-- ----------------------------------------------------------------------------
-- Cada produto pode ter várias ofertas em gateways diferentes.
-- Ex: um produto "Pacote X" pode ter 1 oferta na Kirvano e 1 na PerfectPay.

CREATE TABLE IF NOT EXISTS product_offers (
    id              SERIAL PRIMARY KEY,
    product_id      INTEGER REFERENCES products(id) ON DELETE CASCADE,
    gateway         VARCHAR(20) NOT NULL CHECK (gateway IN ('kirvano', 'perfectpay')),
    offer_id        VARCHAR(100) NOT NULL,
    offer_name      VARCHAR(255),
    checkout_url    TEXT,
    price           DECIMAL(10,2),
    priority        INTEGER DEFAULT 0,
    is_active       BOOLEAN DEFAULT true,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(gateway, offer_id)
);

CREATE INDEX IF NOT EXISTS idx_offers_product ON product_offers(product_id);
CREATE INDEX IF NOT EXISTS idx_offers_gateway_offer ON product_offers(gateway, offer_id);


-- ----------------------------------------------------------------------------
-- 7. USER_ACCESS (acessos liberados por email)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS user_access (
    id              SERIAL PRIMARY KEY,
    email           VARCHAR(255) NOT NULL,
    product_id      INTEGER REFERENCES products(id) ON DELETE CASCADE,
    offer_id        INTEGER REFERENCES product_offers(id) ON DELETE SET NULL,
    gateway         VARCHAR(20),
    sale_id         VARCHAR(100),
    sale_amount     DECIMAL(10,2),
    status          VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'refunded', 'chargeback', 'expired', 'manually_revoked')),
    granted_at      TIMESTAMPTZ DEFAULT NOW(),
    expires_at      TIMESTAMPTZ,
    revoked_at      TIMESTAMPTZ,
    revoke_reason   TEXT,
    granted_by      VARCHAR(100),
    metadata        JSONB DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_access_email ON user_access(LOWER(email));
CREATE INDEX IF NOT EXISTS idx_access_status ON user_access(status);
CREATE INDEX IF NOT EXISTS idx_access_sale ON user_access(gateway, sale_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_access_active 
    ON user_access(LOWER(email), product_id) 
    WHERE status = 'active';


-- ----------------------------------------------------------------------------
-- 8. WEBHOOK_LOGS (log de todos webhooks recebidos - pra debug e auditoria)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS webhook_logs (
    id              SERIAL PRIMARY KEY,
    gateway         VARCHAR(20) NOT NULL,
    event_type      VARCHAR(50),
    sale_id         VARCHAR(100),
    customer_email  VARCHAR(255),
    signature_valid BOOLEAN,
    processed       BOOLEAN DEFAULT false,
    processing_error TEXT,
    raw_payload     JSONB,
    source_ip       VARCHAR(45),
    received_at     TIMESTAMPTZ DEFAULT NOW(),
    processed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_webhooks_gateway ON webhook_logs(gateway);
CREATE INDEX IF NOT EXISTS idx_webhooks_sale ON webhook_logs(gateway, sale_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_received ON webhook_logs(received_at DESC);


-- ----------------------------------------------------------------------------
-- 9. PRODUCT_VIEWS (estatísticas de visualização)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS product_views (
    id              SERIAL PRIMARY KEY,
    product_id      INTEGER REFERENCES products(id) ON DELETE CASCADE,
    customer_email  VARCHAR(255),
    has_access      BOOLEAN DEFAULT false,
    duration_seconds INTEGER DEFAULT 0,
    clicked_buy     BOOLEAN DEFAULT false,
    clicked_access  BOOLEAN DEFAULT false,
    viewed_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_views_product ON product_views(product_id);
CREATE INDEX IF NOT EXISTS idx_views_date ON product_views(viewed_at DESC);
CREATE INDEX IF NOT EXISTS idx_views_email ON product_views(LOWER(customer_email));


-- ----------------------------------------------------------------------------
-- 10. SYSTEM_SETTINGS (configurações globais — gateway ativo, etc)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS system_settings (
    key             VARCHAR(100) PRIMARY KEY,
    value           JSONB NOT NULL,
    description     TEXT,
    updated_by      VARCHAR(100),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Configurações iniciais
INSERT INTO system_settings (key, value, description) VALUES
    ('active_gateway', '"kirvano"'::jsonb, 'Gateway ativo para os botões de compra (kirvano ou perfectpay)'),
    ('maintenance_mode', 'false'::jsonb, 'Modo manutenção - se true, mostra tela de manutenção'),
    ('app_version', '"2.0.0"'::jsonb, 'Versão do sistema')
ON CONFLICT (key) DO NOTHING;


-- ----------------------------------------------------------------------------
-- TRIGGER: atualizar updated_at automaticamente
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_admins_updated_at ON admins;
CREATE TRIGGER update_admins_updated_at BEFORE UPDATE ON admins
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_customers_updated_at ON customers;
CREATE TRIGGER update_customers_updated_at BEFORE UPDATE ON customers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_categories_updated_at ON categories;
CREATE TRIGGER update_categories_updated_at BEFORE UPDATE ON categories
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_products_updated_at ON products;
CREATE TRIGGER update_products_updated_at BEFORE UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_offers_updated_at ON product_offers;
CREATE TRIGGER update_offers_updated_at BEFORE UPDATE ON product_offers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_access_updated_at ON user_access;
CREATE TRIGGER update_access_updated_at BEFORE UPDATE ON user_access
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- ----------------------------------------------------------------------------
-- 12. GAMIFICATION_CONFIG (configuração de Brindes, Missões, Reviews, etc)
-- ----------------------------------------------------------------------------
-- Estrutura key-value flexível pra evitar criar 10 tabelas pequenas.
-- Cada feature tem uma key:
--   'gifts_catalog'   - lista de brindes que aparecem na roleta/cofre
--   'missions_list'   - lista de missões com XP/Desejos de recompensa
--   'reviews_list'    - reviews fake mostrados no app (social proof)
--   'wishes_config'   - regras de desejos (% desconto máx, conversão XP→Desejos, etc)

CREATE TABLE IF NOT EXISTS gamification_config (
    key             VARCHAR(50) PRIMARY KEY,
    value           JSONB NOT NULL DEFAULT '{}'::jsonb,
    description     TEXT,
    updated_by      VARCHAR(100),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Defaults iniciais pra cada feature
INSERT INTO gamification_config (key, value, description) VALUES
    ('gifts_catalog', '{"items":[
        {"id":"g1","name":"50 Desejos","type":"wishes","amount":50,"icon":"💎","weight":40,"active":true},
        {"id":"g2","name":"100 Desejos","type":"wishes","amount":100,"icon":"💎","weight":25,"active":true},
        {"id":"g3","name":"500 Desejos","type":"wishes","amount":500,"icon":"💰","weight":3,"active":true},
        {"id":"g4","name":"Vídeo Exclusivo","type":"video","url":"","icon":"🎬","weight":15,"active":true},
        {"id":"g5","name":"Acesso Grátis 24h","type":"access","duration_hours":24,"icon":"🔓","weight":2,"active":true}
    ]}'::jsonb, 'Catálogo de brindes da roleta/cofre'),

    ('missions_list', '{"items":[
        {"id":"m1","title":"Faça login 5 dias seguidos","xp":50,"wishes":0,"goal":5,"type":"login_streak","active":true},
        {"id":"m2","title":"Explore 20 produtos","xp":100,"wishes":0,"goal":20,"type":"product_views","active":true},
        {"id":"m3","title":"Favorite 5 produtos","xp":30,"wishes":50,"goal":5,"type":"favorites","active":true},
        {"id":"m4","title":"Indique 1 amigo que se cadastre","xp":200,"wishes":100,"goal":1,"type":"referral","active":true}
    ]}'::jsonb, 'Lista de missões semanais'),

    ('reviews_list', '{"items":[
        {"id":"r1","author":"Carlos M.","rating":5,"text":"Vale cada centavo, conteúdo top!","product_id":null,"date":"há 2 dias","active":true},
        {"id":"r2","author":"Pedro S.","rating":5,"text":"Surreal a qualidade. Recomendo!","product_id":null,"date":"há 1 semana","active":true},
        {"id":"r3","author":"Lucas F.","rating":4,"text":"Muito bom, voltarei a comprar.","product_id":null,"date":"há 2 semanas","active":true}
    ]}'::jsonb, 'Reviews fake exibidos no app (social proof)'),

    ('wishes_config', '{
        "max_discount_percent":30,
        "xp_to_wishes_ratio":10,
        "wishes_per_referral":100,
        "wishes_per_review":20,
        "min_wishes_to_use":50
    }'::jsonb, 'Regras gerais de desejos'),

    ('levels_list', '{"items":[
        {"id":"lv1","name":"Iniciante","xp_required":0,"color":"#737373","icon":"🌱","perks":"Acesso básico","active":true},
        {"id":"lv2","name":"Curioso","xp_required":200,"color":"#3b82f6","icon":"👀","perks":"Roleta semanal","active":true},
        {"id":"lv3","name":"Dominador","xp_required":800,"color":"#e50914","icon":"🔥","perks":"+10% XP em todas ações","active":true},
        {"id":"lv4","name":"Insaciável","xp_required":1800,"color":"#facc15","icon":"⚡","perks":"Brindes premium","active":true},
        {"id":"lv5","name":"Lenda","xp_required":4000,"color":"#a855f7","icon":"👑","perks":"Acesso antecipado","active":true}
    ]}'::jsonb, 'Níveis (elos) do cliente baseados em XP'),

    ('dopamine_event', '{
        "weekday":4,
        "weekday_name":"Quinta",
        "title":"Quinta da Dopamina",
        "subtitle":"Brindes em dobro hoje!",
        "xp_multiplier":2,
        "special_gift_id":null,
        "active":true
    }'::jsonb, 'Configuração do evento semanal de bônus'),

    ('flash_offers', '{"items":[]}'::jsonb, 'Ofertas relâmpago da home')
ON CONFLICT (key) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_gamification_key ON gamification_config(key);


-- ----------------------------------------------------------------------------
-- 13. NOTIFICATIONS (mensagens enviadas pelo admin aos clientes)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS notifications (
    id              SERIAL PRIMARY KEY,
    title           VARCHAR(200) NOT NULL,
    body            TEXT NOT NULL,
    type            VARCHAR(20) DEFAULT 'in_app',  -- in_app, email, push
    target_type     VARCHAR(30) DEFAULT 'all',     -- all, has_purchased, no_purchase, by_level, by_email
    target_value    JSONB,                          -- depende do target_type (ex: {level_id:'lv3'} ou {emails:['a@b.com']})
    cta_text        VARCHAR(50),                   -- texto do botão (opcional)
    cta_url         TEXT,                          -- link do botão (opcional)
    icon            VARCHAR(10),                   -- emoji
    scheduled_at    TIMESTAMPTZ,                   -- null = enviar agora
    sent_at         TIMESTAMPTZ,                   -- quando foi enviado
    sent_count      INTEGER DEFAULT 0,             -- pra quantos foi
    read_count      INTEGER DEFAULT 0,             -- quantos leram (in_app)
    status          VARCHAR(20) DEFAULT 'draft',   -- draft, scheduled, sent, failed
    created_by      VARCHAR(100),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status);
CREATE INDEX IF NOT EXISTS idx_notifications_scheduled ON notifications(scheduled_at) WHERE scheduled_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC);


-- ----------------------------------------------------------------------------
-- 14. HERO_SLIDES (banner rotativo do topo da home)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS hero_slides (
    id              SERIAL PRIMARY KEY,
    thumb_url       TEXT NOT NULL,                 -- imagem própria do hero (ex: 1920x800)
    title           VARCHAR(200),                  -- título grande no slide (opcional — vazio = banner visual)
    subtitle        VARCHAR(200),                  -- categoria/badge ("EM DESTAQUE", "GRUPO VIP", etc)
    badge_text      VARCHAR(80),                   -- texto pequeno (ex: "5.2K membros · Atualizado hoje")
    cta_text        VARCHAR(50) DEFAULT 'Descobrir', -- texto botão principal
    product_id      INTEGER REFERENCES products(id) ON DELETE SET NULL, -- opcional — null = banner sem clique
    display_order   INTEGER DEFAULT 0,
    is_active       BOOLEAN DEFAULT true,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hero_slides_active ON hero_slides(is_active, display_order);
CREATE INDEX IF NOT EXISTS idx_hero_slides_product ON hero_slides(product_id);


-- ----------------------------------------------------------------------------
-- 15. HOME_CAROUSELS (esteiras configuráveis da home — manual)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS home_carousels (
    id              SERIAL PRIMARY KEY,
    title           VARCHAR(120) NOT NULL,         -- ex: "Mais quentes hoje"
    subtitle        VARCHAR(200),                  -- texto opcional secundário
    display_order   INTEGER DEFAULT 0,
    is_active       BOOLEAN DEFAULT true,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_home_carousels_active ON home_carousels(is_active, display_order);


-- ----------------------------------------------------------------------------
-- 16. CAROUSEL_PRODUCTS (relação esteira ↔ produto, com regra de unicidade)
-- ----------------------------------------------------------------------------
-- Regra: 1 produto só pode estar em 1 esteira (UNIQUE em product_id).
-- Quando você arrasta produto de uma esteira pra outra, o registro é movido.

CREATE TABLE IF NOT EXISTS carousel_products (
    id              SERIAL PRIMARY KEY,
    carousel_id     INTEGER NOT NULL REFERENCES home_carousels(id) ON DELETE CASCADE,
    product_id      INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    display_order   INTEGER DEFAULT 0,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(product_id)  -- ⚠️ Esse UNIQUE garante que 1 produto = 1 esteira só
);

CREATE INDEX IF NOT EXISTS idx_carousel_products_carousel ON carousel_products(carousel_id, display_order);
CREATE INDEX IF NOT EXISTS idx_carousel_products_product ON carousel_products(product_id);


-- Esteiras: começam vazias. A home é organizada por CATEGORIAS (esteiras
-- automáticas). Esteira manual é opcional, criada pelo admin quando quiser.


-- ----------------------------------------------------------------------------
-- 16. TRACKING_EVENTS (comportamento do cliente — clicks, scroll, modal)
-- ----------------------------------------------------------------------------
-- Eventos genéricos pra otimização de funil.
-- type: 'product_view' | 'cta_buy_click' | 'cta_access_click' | 'hero_impression'
--       | 'hero_click' | 'modal_open' | 'scroll_end' | 'session_start' | etc.

CREATE TABLE IF NOT EXISTS tracking_events (
    id              BIGSERIAL PRIMARY KEY,
    event_type      VARCHAR(60) NOT NULL,
    customer_email  VARCHAR(255),
    product_id      INTEGER REFERENCES products(id) ON DELETE SET NULL,
    metadata        JSONB DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tracking_type ON tracking_events(event_type);
CREATE INDEX IF NOT EXISTS idx_tracking_product ON tracking_events(product_id);
CREATE INDEX IF NOT EXISTS idx_tracking_email ON tracking_events(LOWER(customer_email));
CREATE INDEX IF NOT EXISTS idx_tracking_date ON tracking_events(created_at DESC);


-- ----------------------------------------------------------------------------
-- 17. PUSH_SUBSCRIPTIONS (Web Push API — VAPID)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS push_subscriptions (
    id              SERIAL PRIMARY KEY,
    customer_email  VARCHAR(255),
    endpoint        TEXT UNIQUE NOT NULL,
    p256dh          TEXT NOT NULL,
    auth            TEXT NOT NULL,
    user_agent      TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    last_used_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_push_email ON push_subscriptions(LOWER(customer_email));


-- ----------------------------------------------------------------------------
-- 18. REFERRALS (indicação viral via bot Telegram)
-- ----------------------------------------------------------------------------
-- Cliente compartilha link único do bot Telegram.
-- Quando alguém compra com tracking de origem, registra-se aqui.
-- Após webhook do bot confirmar venda, o referrer ganha desejos+xp.

CREATE TABLE IF NOT EXISTS referrals (
    id              BIGSERIAL PRIMARY KEY,
    referrer_email  VARCHAR(255) NOT NULL,
    referrer_code   VARCHAR(40) NOT NULL,
    referred_email  VARCHAR(255),
    referred_telegram_id VARCHAR(60),
    product_id      INTEGER REFERENCES products(id) ON DELETE SET NULL,
    status          VARCHAR(20) DEFAULT 'pending',  -- pending | converted | rewarded
    reward_desejos  INTEGER DEFAULT 0,
    reward_xp       INTEGER DEFAULT 0,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    converted_at    TIMESTAMPTZ,
    rewarded_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(LOWER(referrer_email));
CREATE INDEX IF NOT EXISTS idx_referrals_code ON referrals(referrer_code);
CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals(status);


-- ----------------------------------------------------------------------------
-- 19. HERO_SLIDE_VARIANTS (extensão pra A/B testing)
-- ----------------------------------------------------------------------------
-- Adiciona colunas ao hero_slides (variante e peso) sem quebrar registros antigos.

ALTER TABLE hero_slides ADD COLUMN IF NOT EXISTS variant_group VARCHAR(40);
ALTER TABLE hero_slides ADD COLUMN IF NOT EXISTS variant_weight INTEGER DEFAULT 100;
