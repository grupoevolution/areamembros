/**
 * Auto-migrations — rodam no boot do servidor.
 *
 * Cada migration usa IF NOT EXISTS, então é segura de rodar várias vezes.
 * Quando você adiciona uma coluna/tabela nova, soma aqui — não precisa
 * mais entrar no console pra rodar init-db.js.
 */

const db = require('../db');
const { logger } = require('./logger');

const MIGRATIONS = [
    // Colunas novas em hero_slides (A/B test)
    `ALTER TABLE hero_slides ADD COLUMN IF NOT EXISTS variant_group VARCHAR(40)`,
    `ALTER TABLE hero_slides ADD COLUMN IF NOT EXISTS variant_weight INTEGER DEFAULT 100`,

    // Badge customizável por produto (texto + cor)
    `ALTER TABLE products ADD COLUMN IF NOT EXISTS badge_text VARCHAR(40)`,
    `ALTER TABLE products ADD COLUMN IF NOT EXISTS badge_color VARCHAR(20)`,

    // Dados ricos da tela de detalhe do produto (galeria extra, stats, urgência, CTA, reviews)
    `ALTER TABLE products ADD COLUMN IF NOT EXISTS extra_data JSONB DEFAULT '{}'::jsonb`,

    // Flag de publicação — produto só aparece pro cliente quando is_published = true.
    // Default FALSE pra que produtos novos sem gateway/link fiquem em rascunho.
    // Produtos antigos (que já têm gateway) são marcados true logo abaixo.
    `ALTER TABLE products ADD COLUMN IF NOT EXISTS is_published BOOLEAN NOT NULL DEFAULT false`,
    // Marca como publicado qualquer produto que JÁ tinha oferta vinculada
    // (estavam no ar antes dessa migration). Idempotente: só atualiza onde
    // ainda está false. Roda só uma vez efetivamente.
    `UPDATE products p
        SET is_published = true
        WHERE is_published = false
          AND EXISTS (SELECT 1 FROM product_offers po WHERE po.product_id = p.id)`,
    `CREATE INDEX IF NOT EXISTS idx_products_published ON products(is_published) WHERE is_published = true`,

    // tracking_events (eventos de comportamento do cliente)
    `CREATE TABLE IF NOT EXISTS tracking_events (
        id              BIGSERIAL PRIMARY KEY,
        event_type      VARCHAR(60) NOT NULL,
        customer_email  VARCHAR(255),
        product_id      INTEGER REFERENCES products(id) ON DELETE SET NULL,
        metadata        JSONB DEFAULT '{}'::jsonb,
        created_at      TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_tracking_type ON tracking_events(event_type)`,
    `CREATE INDEX IF NOT EXISTS idx_tracking_product ON tracking_events(product_id)`,
    `CREATE INDEX IF NOT EXISTS idx_tracking_email ON tracking_events(LOWER(customer_email))`,
    `CREATE INDEX IF NOT EXISTS idx_tracking_date ON tracking_events(created_at DESC)`,

    // push_subscriptions (Web Push API)
    `CREATE TABLE IF NOT EXISTS push_subscriptions (
        id              SERIAL PRIMARY KEY,
        customer_email  VARCHAR(255),
        endpoint        TEXT UNIQUE NOT NULL,
        p256dh          TEXT NOT NULL,
        auth            TEXT NOT NULL,
        user_agent      TEXT,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        last_used_at    TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS idx_push_email ON push_subscriptions(LOWER(customer_email))`,

    // referrals (indicação viral via Telegram)
    `CREATE TABLE IF NOT EXISTS referrals (
        id              BIGSERIAL PRIMARY KEY,
        referrer_email  VARCHAR(255) NOT NULL,
        referrer_code   VARCHAR(40) NOT NULL,
        referred_email  VARCHAR(255),
        referred_telegram_id VARCHAR(60),
        product_id      INTEGER REFERENCES products(id) ON DELETE SET NULL,
        status          VARCHAR(20) DEFAULT 'pending',
        reward_desejos  INTEGER DEFAULT 0,
        reward_xp       INTEGER DEFAULT 0,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        converted_at    TIMESTAMPTZ,
        rewarded_at     TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(LOWER(referrer_email))`,
    `CREATE INDEX IF NOT EXISTS idx_referrals_code ON referrals(referrer_code)`,
    `CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals(status)`,

    // Produto em múltiplas esteiras — remove o UNIQUE(product_id) que prendia
    // 1 produto a 1 esteira só. Troca por UNIQUE(carousel_id, product_id):
    // mesmo produto pode estar em N esteiras, mas não duplica na MESMA esteira.
    // Idempotente: dropa (se existir) e recria sempre.
    `ALTER TABLE carousel_products DROP CONSTRAINT IF EXISTS carousel_products_product_id_key`,
    `ALTER TABLE carousel_products DROP CONSTRAINT IF EXISTS carousel_products_carousel_id_product_id_key`,
    `ALTER TABLE carousel_products ADD CONSTRAINT carousel_products_carousel_id_product_id_key UNIQUE (carousel_id, product_id)`,

    // Hero pode ser banner 100% visual — sem título e sem produto vinculado.
    // Remove os NOT NULL de product_id e title. DROP NOT NULL é idempotente.
    `ALTER TABLE hero_slides ALTER COLUMN product_id DROP NOT NULL`,
    `ALTER TABLE hero_slides ALTER COLUMN title DROP NOT NULL`,
    // Troca ON DELETE CASCADE por SET NULL: se o produto vinculado for deletado,
    // o hero vira banner visual em vez de sumir junto.
    `ALTER TABLE hero_slides DROP CONSTRAINT IF EXISTS hero_slides_product_id_fkey`,
    `ALTER TABLE hero_slides ADD CONSTRAINT hero_slides_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL`,

    // Remove as 3 esteiras de exemplo que vinham como seed do schema.
    // Só apaga se ainda estiverem VAZIAS (não destrói esteira que o admin populou).
    `DELETE FROM home_carousels
        WHERE title IN ('🔥 Em alta agora', 'Mais quentes hoje', 'Volte pra onde parou')
          AND NOT EXISTS (SELECT 1 FROM carousel_products cp WHERE cp.carousel_id = home_carousels.id)`,

    // ─────────────────────────────────────────────────────────────
    // Áudio em produtos — 1 áudio por produto, com toggle
    // ─────────────────────────────────────────────────────────────
    `ALTER TABLE products ADD COLUMN IF NOT EXISTS audio_url TEXT`,
    `ALTER TABLE products ADD COLUMN IF NOT EXISTS audio_enabled BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE products ADD COLUMN IF NOT EXISTS audio_title VARCHAR(120)`,

    // ─────────────────────────────────────────────────────────────
    // Chamadas de vídeo simuladas
    // ─────────────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS video_calls (
        id                  SERIAL PRIMARY KEY,
        name                VARCHAR(120) NOT NULL,
        slug                VARCHAR(80) UNIQUE NOT NULL,
        category            VARCHAR(20) NOT NULL DEFAULT 'amostra',
        model_name          VARCHAR(120) NOT NULL,
        model_photo         TEXT,
        video_url           TEXT,
        redirect_link       TEXT,
        cta_text            VARCHAR(60),
        trigger_type        VARCHAR(20) NOT NULL DEFAULT 'on_login',
        trigger_delay_sec   INTEGER NOT NULL DEFAULT 5,
        active              BOOLEAN NOT NULL DEFAULT true,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_video_calls_active ON video_calls(active) WHERE active = true`,
    `CREATE INDEX IF NOT EXISTS idx_video_calls_trigger ON video_calls(trigger_type)`,

    // ─────────────────────────────────────────────────────────────
    // Chamada vinculada ao produto (produto-chamada)
    // ─────────────────────────────────────────────────────────────
    `ALTER TABLE products ADD COLUMN IF NOT EXISTS video_call_id INTEGER REFERENCES video_calls(id) ON DELETE SET NULL`,
    `CREATE INDEX IF NOT EXISTS idx_products_video_call ON products(video_call_id) WHERE video_call_id IS NOT NULL`,

    // ─────────────────────────────────────────────────────────────
    // FUNÍS — landing customizada por link de campanha
    // ─────────────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS funnels (
        id                  SERIAL PRIMARY KEY,
        slug                VARCHAR(80) UNIQUE NOT NULL,
        name                VARCHAR(120) NOT NULL,
        description         TEXT,
        featured_product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
        video_call_id       INTEGER REFERENCES video_calls(id) ON DELETE SET NULL,
        active              BOOLEAN NOT NULL DEFAULT true,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_funnels_active ON funnels(active) WHERE active = true`,

    `CREATE TABLE IF NOT EXISTS funnel_visits (
        id              BIGSERIAL PRIMARY KEY,
        funnel_id       INTEGER NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
        funnel_slug     VARCHAR(80) NOT NULL,
        customer_email  VARCHAR(255),
        ip              VARCHAR(45),
        user_agent      TEXT,
        converted       BOOLEAN NOT NULL DEFAULT false,
        visited_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        converted_at    TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS idx_funnel_visits_slug ON funnel_visits(funnel_slug)`,
    `CREATE INDEX IF NOT EXISTS idx_funnel_visits_email ON funnel_visits(LOWER(customer_email))`,
    `CREATE INDEX IF NOT EXISTS idx_funnel_visits_date ON funnel_visits(visited_at DESC)`,

    // ─────────────────────────────────────────────────────────────
    // Chamada: CTA configur\u00e1vel no final (interno ao sistema)
    // ─────────────────────────────────────────────────────────────
    `ALTER TABLE video_calls ADD COLUMN IF NOT EXISTS cta_type VARCHAR(20) NOT NULL DEFAULT 'home'`,
    // cta_type: 'home' | 'calls_catalog' | 'product' | 'category' | 'external'
    `ALTER TABLE video_calls ADD COLUMN IF NOT EXISTS cta_target_id INTEGER`,
    // cta_target_id: id do produto ou categoria (depende de cta_type)

    // ─────────────────────────────────────────────────────────────
    // Hist\u00f3rico: chamadas vistas por cliente (n\u00e3o repete chamada)
    // ─────────────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS customer_call_history (
        id              BIGSERIAL PRIMARY KEY,
        customer_email  VARCHAR(255) NOT NULL,
        video_call_id   INTEGER NOT NULL REFERENCES video_calls(id) ON DELETE CASCADE,
        funnel_slug     VARCHAR(80),
        seen_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(customer_email, video_call_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_call_history_email ON customer_call_history(LOWER(customer_email))`,

    // ─────────────────────────────────────────────────────────────
    // Etapas do fun\u00edl (sequ\u00eancia de eventos p\u00f3s-login)
    // ─────────────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS funnel_steps (
        id              SERIAL PRIMARY KEY,
        funnel_id       INTEGER NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
        step_order      INTEGER NOT NULL DEFAULT 0,
        type            VARCHAR(30) NOT NULL,
        -- type: 'video_call' | 'notification' | 'open_product'
        delay_seconds   INTEGER NOT NULL DEFAULT 0,
        video_call_id   INTEGER REFERENCES video_calls(id) ON DELETE SET NULL,
        product_id      INTEGER REFERENCES products(id) ON DELETE SET NULL,
        title           VARCHAR(120),
        message         TEXT,
        active          BOOLEAN NOT NULL DEFAULT true,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_funnel_steps_funnel ON funnel_steps(funnel_id, step_order)`,

    // ─────────────────────────────────────────────────────────────
    // M\u00faltiplos planos por produto (Basic, VIP, Premium, etc.)
    // ─────────────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS product_plans (
        id              SERIAL PRIMARY KEY,
        product_id      INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        name            VARCHAR(80) NOT NULL,
        price           DECIMAL(10,2) NOT NULL DEFAULT 0,
        original_price  DECIMAL(10,2),
        badge           VARCHAR(40),
        benefits        TEXT,
        checkout_url    TEXT,
        is_recommended  BOOLEAN NOT NULL DEFAULT false,
        display_order   INTEGER NOT NULL DEFAULT 0,
        active          BOOLEAN NOT NULL DEFAULT true,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_product_plans_product ON product_plans(product_id, display_order)`,

    // ─────────────────────────────────────────────────────────────
    // Índices p/ a rota /active-call — os NOT EXISTS por video_call_id
    // varriam tabela inteira sem índice (lentidão → timeout → 500 →
    // frontend tratava como sessão inválida → cliente caía no login).
    // products.video_call_id já tem idx_products_video_call acima.
    // ─────────────────────────────────────────────────────────────
    `CREATE INDEX IF NOT EXISTS idx_funnels_video_call ON funnels(video_call_id) WHERE video_call_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_funnel_steps_video_call ON funnel_steps(video_call_id) WHERE video_call_id IS NOT NULL`,
    // Lookup "cliente já viu essa chamada" — casa com o
    // SELECT ... WHERE LOWER(customer_email) = $1 AND video_call_id = $2.
    // Índice composto com a expressão LOWER() pra o planner usar direto.
    `CREATE INDEX IF NOT EXISTS idx_call_history_email_call ON customer_call_history(LOWER(customer_email), video_call_id)`,

    // ─────────────────────────────────────────────────────────────
    // Tipo de produto: 'content' (galeria vitalícia) ou 'video_call'
    // (chamada — cliente assiste 1 vez só, depois vê CTA de recompra).
    // Default 'content' pra não quebrar produtos legados.
    // ─────────────────────────────────────────────────────────────
    `ALTER TABLE products ADD COLUMN IF NOT EXISTS product_type VARCHAR(20) NOT NULL DEFAULT 'content'`,
    // CHECK constraint via bloco DO/EXCEPTION (idempotente — ignora se já existe)
    `DO $migr$ BEGIN
        ALTER TABLE products ADD CONSTRAINT chk_product_type CHECK (product_type IN ('content','video_call'));
    EXCEPTION WHEN duplicate_object THEN NULL; END $migr$`,
    `CREATE INDEX IF NOT EXISTS idx_products_type ON products(product_type)`,
    // Backfill: produtos antigos com video_call_id vinculado viram 'video_call'.
    // Idempotente — só atualiza onde ainda está no default 'content'.
    `UPDATE products SET product_type = 'video_call'
        WHERE video_call_id IS NOT NULL AND product_type = 'content'`,

    // ─────────────────────────────────────────────────────────────
    // Recall messages — mensagens de recompra exibidas no acervo
    // depois que o cliente já consumiu uma vídeo-chamada.
    // Janela em dias (min_days/max_days) decide qual mensagem usar.
    // Suporta placeholder {modelo} substituído no servidor.
    // ─────────────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS recall_messages (
        id          SERIAL PRIMARY KEY,
        min_days    INTEGER NOT NULL DEFAULT 0,
        max_days    INTEGER,
        message     TEXT NOT NULL,
        active      BOOLEAN NOT NULL DEFAULT true,
        priority    INTEGER NOT NULL DEFAULT 0,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_recall_active ON recall_messages(active) WHERE active = true`,
    // Seed default: 1 mensagem cobrindo qualquer janela (min_days=0, max_days=NULL).
    // Garante que /library nunca renderize recall_message vazio na primeira semana.
    // Roda só 1x efetivamente: WHERE NOT EXISTS evita duplicar.
    `INSERT INTO recall_messages (min_days, max_days, message, priority, active)
        SELECT 0, NULL, 'Quer outra vídeo chamada com a {modelo}? 🔥', 0, true
        WHERE NOT EXISTS (SELECT 1 FROM recall_messages)`,

    // ─────────────────────────────────────────────────────────────
    // RECOMPRA DE VÍDEO-CHAMADA — cada compra = 1 nova oportunidade
    //
    // Antes:  customer_call_history UNIQUE(customer_email, video_call_id)
    //         → uma vez consumida, fica gravado pra sempre. Cliente recompra
    //           o produto e o /library continua retornando consumed=true.
    //
    // Agora:  amarra cada consumo ao user_access que liberou a chamada.
    //         Recompra → novo user_access → novo "slot" pra assistir.
    //
    // Registros legados ficam com user_access_id=NULL e seguem servindo
    // como histórico (NULL não conflita em UNIQUE no Postgres).
    // ─────────────────────────────────────────────────────────────

    // Adiciona 'replaced' ao CHECK de user_access.status pra marcar acessos
    // antigos quando o cliente recompra um produto do tipo video_call.
    // Drop idempotente (nome padrão gerado pelo Postgres) + recria.
    `ALTER TABLE user_access DROP CONSTRAINT IF EXISTS user_access_status_check`,
    `DO $migr$ BEGIN
        ALTER TABLE user_access ADD CONSTRAINT user_access_status_check
            CHECK (status IN ('active','refunded','chargeback','expired','manually_revoked','replaced'));
    EXCEPTION WHEN duplicate_object THEN NULL; END $migr$`,

    // Nova coluna em customer_call_history apontando pro user_access da compra.
    // NULLABLE — registros legados ficam NULL, novos sempre preenchem.
    `ALTER TABLE customer_call_history
        ADD COLUMN IF NOT EXISTS user_access_id INTEGER
        REFERENCES user_access(id) ON DELETE SET NULL`,
    `CREATE INDEX IF NOT EXISTS idx_call_history_access
        ON customer_call_history(user_access_id)`,

    // Drop do UNIQUE antigo (nome gerado pelo Postgres).
    // Se o nome do constraint for diferente nesse banco (ex.: customizado),
    // o segundo DO/EXCEPTION garante que o novo seja criado mesmo assim.
    `ALTER TABLE customer_call_history
        DROP CONSTRAINT IF EXISTS customer_call_history_customer_email_video_call_id_key`,
    `DO $migr$ BEGIN
        ALTER TABLE customer_call_history
            ADD CONSTRAINT customer_call_history_unique_per_access
            UNIQUE (customer_email, video_call_id, user_access_id);
    EXCEPTION WHEN duplicate_object THEN NULL; END $migr$`,

    // Índice composto novo casando com o JOIN do /library
    // (LOWER(email), video_call_id, user_access_id).
    `CREATE INDEX IF NOT EXISTS idx_call_history_email_call_access
        ON customer_call_history(LOWER(customer_email), video_call_id, user_access_id)`,

    // Backfill: amarra registros legados (user_access_id = NULL) ao user_access
    // que existia quando o consumo aconteceu. Sem isso, o cliente legado teria
    // direito a 1 "vídeo grátis" porque NULL não conflita em UNIQUE no Postgres.
    //
    // Estratégia: pra cada cch sem user_access_id, pega o user_access do MESMO
    // (email, produto-da-chamada) cujo granted_at <= seen_at. Se houver mais de um,
    // usa o mais recente (último ativo na época). Se NÃO houver match (consumo
    // sem compra registrada — ex: chamada de funnel pré-compra), deixa NULL —
    // esse caso é raro e o cliente continua bloqueado pelo NULL no INSERT futuro
    // só se ele acabar comprando depois, que é o comportamento desejado.
    //
    // Idempotente: WHERE user_access_id IS NULL evita rodar 2x.
    `UPDATE customer_call_history cch
        SET user_access_id = sub.access_id
        FROM (
            SELECT DISTINCT ON (cch2.id) cch2.id AS cch_id, ua.id AS access_id
            FROM customer_call_history cch2
            JOIN products p ON p.video_call_id = cch2.video_call_id
            JOIN user_access ua
              ON ua.product_id = p.id
             AND LOWER(ua.email) = LOWER(cch2.customer_email)
             AND ua.granted_at <= cch2.seen_at
            WHERE cch2.user_access_id IS NULL
            ORDER BY cch2.id, ua.granted_at DESC
        ) sub
        WHERE cch.id = sub.cch_id
          AND cch.user_access_id IS NULL`,

    // ─────────────────────────────────────────────────────────────
    // E-MAILS PREMIUM (preview mode) — emails que veem o app como se
    // tivessem comprado todos os produtos publicados. Pra testar a
    // experiencia do cliente sem precisar pagar. Nao gravam consumo,
    // nao recebem recall, nao aparecem em metricas.
    // ─────────────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS preview_emails (
        id          SERIAL PRIMARY KEY,
        email       VARCHAR(255) NOT NULL UNIQUE,
        label       VARCHAR(120),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_preview_emails_email_lower ON preview_emails(LOWER(email))`,

    // ─────────────────────────────────────────────────────────────
    // RECALL ROTATION (Fase C, mai/2026) — substitui janela em dias
    // pela rotacao global por bucket de tempo. min_days/max_days
    // viram lixo. display_order define ordem; intervalo global em
    // system_settings.recall_rotation_interval_minutes (default 30).
    // ─────────────────────────────────────────────────────────────
    `ALTER TABLE recall_messages DROP COLUMN IF EXISTS min_days`,
    `ALTER TABLE recall_messages DROP COLUMN IF EXISTS max_days`,
    `ALTER TABLE recall_messages ADD COLUMN IF NOT EXISTS display_order INTEGER NOT NULL DEFAULT 0`,
    `CREATE INDEX IF NOT EXISTS idx_recall_order ON recall_messages(display_order, id) WHERE active = true`,

    // system_settings ja existe (schema.sql) com value JSONB. Insere o default
    // pra rotacao se ainda nao existir. JSONB aceita string com aspas.
    `INSERT INTO system_settings (key, value, description)
        VALUES ('recall_rotation_interval_minutes', '30'::jsonb,
                'Intervalo (em minutos) entre as mensagens de recompra no acervo. Bucket global por tempo, mesma mensagem pra todos os clientes na mesma janela.')
        ON CONFLICT (key) DO NOTHING`,

    // ─────────────────────────────────────────────────────────────
    // BUNNY STREAM — Collection lookup por produto (Fase D, mai/2026)
    //
    // Em vez de o admin colar 20 URLs uma a uma na galeria do produto,
    // ele coloca o (libraryId, collectionId) e o backend resolve a lista
    // de vídeos via API do Bunny. Fotos continuam coladas manualmente.
    //
    // bunny_library_id   — VARCHAR(20) (Bunny usa numérico mas tratamos
    //                       como string pra não amarrar futuros formatos).
    // bunny_collection_id — VARCHAR(60) (GUID-ish; deixamos folga).
    //
    // Índice parcial: só produtos que TÊM collection. Reduz tamanho.
    // ─────────────────────────────────────────────────────────────
    `ALTER TABLE products ADD COLUMN IF NOT EXISTS bunny_library_id VARCHAR(20)`,
    `ALTER TABLE products ADD COLUMN IF NOT EXISTS bunny_collection_id VARCHAR(60)`,
    `CREATE INDEX IF NOT EXISTS idx_products_bunny_collection
        ON products(bunny_collection_id) WHERE bunny_collection_id IS NOT NULL`,

    // ─────────────────────────────────────────────────────────────
    // Fase E (mai/2026) — link Bunny direto na chamada do produto.
    //
    // Antes: produto-chamada precisava ter video_call_id apontando pra
    // uma entrada em `video_calls` (cadastrada pelo menu Remarketing).
    // Isso forçava duplicação: pra vender 1 chamada, o admin tinha que
    // criar a chamada em 2 lugares.
    //
    // Agora: o produto-chamada pode ter `direct_call_video_url` (link
    // Bunny colado direto). O backend monta o payload virtual em runtime.
    // `video_call_id` continua existindo (caso queira reusar uma chamada
    // do Remarketing) — direct_call_video_url tem prioridade quando
    // os dois estão preenchidos.
    // ─────────────────────────────────────────────────────────────
    `ALTER TABLE products ADD COLUMN IF NOT EXISTS direct_call_video_url TEXT`,

    // ─────────────────────────────────────────────────────────────
    // Fase F (mai/2026) — cinematografia da chamadinha vendida.
    //
    // Antes: o overlay de chamada usava a CAPA do produto (banner_url)
    // como foto da modelo. Isso confunde — capa é imagem comercial
    // de card de venda, não selfie íntima de "ligação".
    //
    // Agora: 3 campos opcionais por produto pra customizar o overlay:
    //   - call_photo_url:     foto da modelo durante a ligação
    //                         (fallback: banner_url)
    //   - call_ringing_text:  texto que pisca em "chamando"
    //                         (fallback: default do frontend)
    //   - call_ringtone_url:  MP3 do toque (fallback: silêncio)
    //
    // Só vale pra produto-chamadinha (direct_call_video_url). Modo
    // "reusar do Remarketing" (video_call_id) NÃO usa esses campos —
    // a tabela video_calls fica intacta. Fallback p/ null nesse caso.
    // ─────────────────────────────────────────────────────────────
    `ALTER TABLE products ADD COLUMN IF NOT EXISTS call_photo_url TEXT`,
    `ALTER TABLE products ADD COLUMN IF NOT EXISTS call_ringing_text VARCHAR(120)`,
    `ALTER TABLE products ADD COLUMN IF NOT EXISTS call_ringtone_url TEXT`,

    // ─────────────────────────────────────────────────────────────
    // Fase J2 (mai/2026) — SISTEMA DE BRINDES/PRESENTES
    //
    // Admin pode dar produtos de presente pra qualquer email, com prazo
    // de expiração opcional. Funciona como user_access "virtual": não
    // ocupa slot na tabela user_access (preserva integridade de vendas
    // reais — não conta em métricas, não gera webhook, não pode dar
    // refund), mas aparece pro cliente no /library com badge "BRINDE".
    //
    // Decisões:
    //   - email NÃO tem FK pra customers — admin pode dar pra email que
    //     ainda nem cadastrou (cliente vê o brinde ao logar pela 1ª vez).
    //   - product_id tem FK CASCADE — se produto for deletado, o brinde
    //     vai junto (não faz sentido brinde sem produto).
    //   - expires_at NULL = não expira (vitalício).
    //   - Lazy expiration: a query do /library filtra por expires_at>NOW().
    //     Sem cron — economiza 1 worker e zero risco de cron falhar.
    //   - status soft-delete: nunca DELETE real, sempre marca 'revoked'.
    //     Permite auditoria + recuperar acidente em segundos.
    // ─────────────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS gifts (
        id              SERIAL PRIMARY KEY,
        email           VARCHAR(255) NOT NULL,
        product_id      INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        label           VARCHAR(120),
        expires_at      TIMESTAMPTZ,
        granted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        granted_by      VARCHAR(120),
        status          VARCHAR(20) NOT NULL DEFAULT 'active',
        revoked_at      TIMESTAMPTZ,
        metadata        JSONB DEFAULT '{}'::jsonb
    )`,
    `DO $migr$ BEGIN
        ALTER TABLE gifts ADD CONSTRAINT chk_gifts_status
            CHECK (status IN ('active','expired','revoked'));
    EXCEPTION WHEN duplicate_object THEN NULL; END $migr$`,
    // Índice principal: busca por email no /library (sempre filtrado por active).
    `CREATE INDEX IF NOT EXISTS idx_gifts_email_active
        ON gifts(LOWER(email)) WHERE status = 'active'`,
    // Índice secundário pra expiração lazy (filtragem rápida no JOIN do /library).
    `CREATE INDEX IF NOT EXISTS idx_gifts_expires
        ON gifts(expires_at) WHERE status = 'active' AND expires_at IS NOT NULL`,
    // Índice pro painel admin (listar por produto).
    `CREATE INDEX IF NOT EXISTS idx_gifts_product ON gifts(product_id)`,

    // ─────────────────────────────────────────────────────────────
    // customer_call_history.gift_id — pra brindes de vídeo-chamada
    // amarrarem consumo do mesmo jeito que user_access.
    //
    // UNIQUE atualizada: o consumo é único por TUPLA
    //   (email, video_call_id, user_access_id, gift_id)
    // Como NULL não conflita em UNIQUE no Postgres, isso significa:
    //   - Compra normal: gift_id=NULL, ua_id=N → unique por compra.
    //   - Brinde:         gift_id=N, ua_id=NULL → unique por brinde.
    //   - 2 compras + 1 brinde do mesmo produto = 3 slots independentes.
    //
    // Mantém o constraint antigo (sem gift_id) — Postgres permite múltiplos
    // UNIQUEs e a aplicação só insere via ON CONFLICT do novo. Mas pra
    // limpeza, dropamos o antigo se existir e plantamos o novo.
    // ─────────────────────────────────────────────────────────────
    `ALTER TABLE customer_call_history
        ADD COLUMN IF NOT EXISTS gift_id INTEGER
        REFERENCES gifts(id) ON DELETE SET NULL`,
    `CREATE INDEX IF NOT EXISTS idx_call_history_gift
        ON customer_call_history(gift_id) WHERE gift_id IS NOT NULL`,
    // Drop do UNIQUE antigo (sem gift_id) e cria o novo (com gift_id).
    // Em Postgres, NULL não conflita em UNIQUE, então o novo cobre os 2 casos
    // (compra e brinde) com 1 constraint só.
    `ALTER TABLE customer_call_history
        DROP CONSTRAINT IF EXISTS customer_call_history_unique_per_access`,
    `DO $migr$ BEGIN
        ALTER TABLE customer_call_history
            ADD CONSTRAINT customer_call_history_unique_per_slot
            UNIQUE (customer_email, video_call_id, user_access_id, gift_id);
    EXCEPTION WHEN duplicate_object THEN NULL; END $migr$`,

    // ─────────────────────────────────────────────────────────────
    // Fase K2 (mai/2026) — BRINDES EM MASSA + LINK MÁGICO
    //
    // 1) UNICIDADE VITALÍCIA POR (email, product_id):
    //    Antes (J2): a checagem era em JS (SELECT antes de INSERT) e o índice
    //    só protegia o caso "active+não-expirado". Em massa com ON CONFLICT
    //    isso fica frágil — race window + risco de duplicar pra um mesmo email.
    //    Agora: índice ÚNICO PARCIAL incluindo 'active' e 'expired' (tudo
    //    menos 'revoked'). Significa: 1 email + 1 produto = 1 brinde "que
    //    contou" pra sempre, exceto se o admin REVOGAR (revoked não conta).
    //    Tudo no nível do banco → ON CONFLICT DO NOTHING vira atômico,
    //    INSERT em paralelo vira seguro. Idempotente: IF NOT EXISTS.
    `CREATE UNIQUE INDEX IF NOT EXISTS gifts_unique_active_per_email_product
        ON gifts (LOWER(email), product_id)
        WHERE status != 'revoked'`,

    // 2) CAMPANHAS DE BRINDE (link mágico). Admin cria um código (slug),
    //    manda no Telegram/grupo, qualquer um que logar com aquele código
    //    em mãos ganha o brinde automaticamente no primeiro login.
    //    - code: identifica a campanha na URL (?campanha=CODE).
    //    - max_redemptions: limite total (NULL = ilimitado).
    //    - campaign_expires_at: quando o LINK deixa de funcionar (NULL = sempre).
    //    - expires_in_hours: duração do brinde que cada redemption cria (NULL = vitalício).
    `CREATE TABLE IF NOT EXISTS gift_campaigns (
        id                  SERIAL PRIMARY KEY,
        code                VARCHAR(40) NOT NULL UNIQUE,
        product_id          INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        expires_in_hours    INTEGER,
        campaign_expires_at TIMESTAMPTZ,
        max_redemptions     INTEGER,
        redemptions_count   INTEGER NOT NULL DEFAULT 0,
        label               VARCHAR(120),
        active              BOOLEAN NOT NULL DEFAULT true,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_by          VARCHAR(120)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_campaigns_code_active
        ON gift_campaigns(code) WHERE active = true`,
    `CREATE INDEX IF NOT EXISTS idx_campaigns_product ON gift_campaigns(product_id)`,

    // 3) AUDITORIA DE RESGATES — pra saber quem resgatou cada campanha,
    //    quando, e qual brinde foi gerado (ou pulado por já ter o brinde).
    //    gift_id pode ser NULL: quando o cliente já tinha o brinde do produto
    //    (ON CONFLICT pulou). Mesmo nesse caso a gente conta a tentativa pra
    //    o admin ter visão real ("X cliques no link, Y geraram brinde novo").
    `CREATE TABLE IF NOT EXISTS gift_campaign_redemptions (
        id              SERIAL PRIMARY KEY,
        campaign_id     INTEGER NOT NULL REFERENCES gift_campaigns(id) ON DELETE CASCADE,
        email           VARCHAR(255) NOT NULL,
        gift_id         INTEGER REFERENCES gifts(id) ON DELETE SET NULL,
        skipped         BOOLEAN NOT NULL DEFAULT false,
        redeemed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_redemp_campaign ON gift_campaign_redemptions(campaign_id)`,
    `CREATE INDEX IF NOT EXISTS idx_redemp_email ON gift_campaign_redemptions(LOWER(email))`,
    // Anti-double-redeem por email: o cliente só conta UMA VEZ por campanha.
    // Se ele recarregar o link e logar de novo, não infla redemptions_count.
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_redemp_unique_campaign_email
        ON gift_campaign_redemptions(campaign_id, LOWER(email))`,

    // ─────────────────────────────────────────────────────────────
    // Fase L (mai/2026) — LUCRO LÍQUIDO POR VENDA
    //
    // sale_amount = BRUTO (o que cliente pagou)
    // net_amount  = LÍQUIDO (o que cai pro produtor)
    //
    // Kirvano: extraído de fiscal.commission (validado em produção no Orion).
    // ⚠ fiscal.net_value é ENGANOSO — Kirvano coloca o BRUTO lá. Não usar.
    //
    // Vendas pré-Fase L têm net_amount=NULL. Dashboard usa o filtro
    // WHERE net_amount IS NOT NULL pra não inflar histórico chutando %.
    // ─────────────────────────────────────────────────────────────
    `ALTER TABLE user_access ADD COLUMN IF NOT EXISTS net_amount NUMERIC(10,2)`,
    `CREATE INDEX IF NOT EXISTS idx_user_access_granted_at_net
        ON user_access(granted_at DESC) WHERE net_amount IS NOT NULL`,

    // ─────────────────────────────────────────────────────────────
    // Fase L5 (mai/2026) — ENGAJAMENTO (heartbeat de presença)
    //
    // last_seen_at: atualizado a cada heartbeat do cliente (60s no front).
    //   - "online agora" = last_seen_at > NOW() - 5 min
    //   - "acessos hoje" = COUNT(distinct) com last_seen_at >= hoje
    // session_count: incrementa quando o heartbeat chega APÓS gap > 30 min.
    //   Pragmatismo: evita tabela customer_sessions separada (overkill MVP).
    //   Se precisar de granularidade tipo "duração média de sessão",
    //   aí vale criar tabela própria.
    // ─────────────────────────────────────────────────────────────
    `ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ`,
    `ALTER TABLE customers ADD COLUMN IF NOT EXISTS session_count INTEGER DEFAULT 0`,
    `CREATE INDEX IF NOT EXISTS idx_customers_last_seen
        ON customers(last_seen_at DESC) WHERE last_seen_at IS NOT NULL`,

    // ─────────────────────────────────────────────────────────────
    // Fase L13.2 (mai/2026) — Separacao AQUISICAO vs LTV
    //
    // Danilo opera 2 fluxos distintos:
    //   AQUISICAO: cliente vem de tráfego pago Meta Ads, cai em checkout
    //     Kirvano com frontend (29,99 / 49,99) + ate 2 bumps (19,90 / 9,99).
    //     Essa venda eh "custo coberto pelo Orion" — nao deveria poluir
    //     o painel da area de membros.
    //   LTV: cliente JA dentro do app compra produtos extras (recompra de
    //     vc, chamadinhas, etc). Esse eh o lucro adicional puro.
    //
    // is_acquisition: marca a oferta como "venda de aquisicao" — sera
    //   excluida dos dashboards de LTV (Analise de Lucro, Top Produtos,
    //   LTV vitalicio) e listada num bloco separado "Performance Frontends".
    //
    // acquisition_role: 'frontend' (venda principal) ou 'bump' (order bump).
    //   So faz sentido quando is_acquisition=true. Usado pra calcular take
    //   rate dos bumps (% de bump 1 / total de frontends).
    // ─────────────────────────────────────────────────────────────
    `ALTER TABLE product_offers ADD COLUMN IF NOT EXISTS is_acquisition BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE product_offers ADD COLUMN IF NOT EXISTS acquisition_role VARCHAR(20)`,
    `DO $migr$ BEGIN
        ALTER TABLE product_offers ADD CONSTRAINT chk_acquisition_role
            CHECK (acquisition_role IS NULL OR acquisition_role IN ('frontend','bump'));
    EXCEPTION WHEN duplicate_object THEN NULL; END $migr$`,
    // Index parcial: so ofertas marcadas como aquisicao. Usado nos cards
    // "Performance Frontends" e nos JOINs de filtragem do painel LTV.
    `CREATE INDEX IF NOT EXISTS idx_product_offers_acquisition
        ON product_offers(is_acquisition, acquisition_role)
        WHERE is_acquisition = true`,

    // ─────────────────────────────────────────────────────────────
    // Fase Prévia (jun/2026) — GALERIA DE PRÉVIA POR PRODUTO
    //
    // preview_enabled: liga a galeria de prévia pública do produto. Quando
    //   true, quem NÃO comprou vê a galeria — mídias marcadas como amostra
    //   aparecem nítidas, o resto aparece borrado (CSS) com cadeado → popup
    //   de compra. Default false: produto sem prévia se comporta como hoje.
    // product_media.is_locked: por mídia, define se é amostra livre (false)
    //   ou bloqueada (true). Default true (mídia nova entra bloqueada).
    // ─────────────────────────────────────────────────────────────
    `ALTER TABLE products ADD COLUMN IF NOT EXISTS preview_enabled BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE product_media ADD COLUMN IF NOT EXISTS is_locked BOOLEAN NOT NULL DEFAULT true`,

    // ─────────────────────────────────────────────────────────────
    // Funil 2.0 (jun/2026) — notificação com destino + push server-side
    //
    // funnel_steps.link_url: pra onde o clique na notificação leva
    //   (URL externa ou caminho interno). product_id continua valendo
    //   pra "abrir produto".
    // funnel_steps.type ganha o valor 'push': notificação web push
    //   enviada PELO SERVIDOR no horário agendado — chega mesmo com o
    //   app fechado (re-engajamento de lead que saiu).
    // funnel_scheduled_pushes: fila de envio. Criada quando o lead
    //   converte (digita o e-mail no funil). Worker (lib/push-worker.js)
    //   processa a cada 60s. Venda aprovada cancela os pendentes do
    //   e-mail (lead virou cliente — sai da sequência de venda).
    // ─────────────────────────────────────────────────────────────
    `ALTER TABLE funnel_steps ADD COLUMN IF NOT EXISTS link_url TEXT`,
    `CREATE TABLE IF NOT EXISTS funnel_scheduled_pushes (
        id              SERIAL PRIMARY KEY,
        funnel_id       INTEGER REFERENCES funnels(id) ON DELETE CASCADE,
        step_id         INTEGER REFERENCES funnel_steps(id) ON DELETE CASCADE,
        customer_email  VARCHAR(255) NOT NULL,
        title           VARCHAR(120) NOT NULL,
        message         TEXT,
        url             TEXT,
        send_at         TIMESTAMPTZ NOT NULL,
        status          VARCHAR(20) NOT NULL DEFAULT 'pending',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        sent_at         TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sched_pushes_due ON funnel_scheduled_pushes(status, send_at) WHERE status = 'pending'`,
    `CREATE INDEX IF NOT EXISTS idx_sched_pushes_email ON funnel_scheduled_pushes(LOWER(customer_email))`,
    // Evita fila duplicada se o lead converter 2x no mesmo funil
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_sched_push_step_email ON funnel_scheduled_pushes(step_id, LOWER(customer_email))`,

    // ─────────────────────────────────────────────────────────────
    // Funil 2.0b — DESTINO DE ENTRADA do funil
    //
    // entry_type: pra onde o cliente cai ao abrir /f/slug:
    //   'home'     → home do app (comportamento antigo)
    //   'product'  → direto na página do produto (entry_product_id)
    //   'category' → Explore filtrado na categoria (entry_category_id);
    //                entry_product_id opcional = produto EM FOCO (1º do grid)
    // ─────────────────────────────────────────────────────────────
    `ALTER TABLE funnels ADD COLUMN IF NOT EXISTS entry_type VARCHAR(20) NOT NULL DEFAULT 'home'`,
    `ALTER TABLE funnels ADD COLUMN IF NOT EXISTS entry_product_id INTEGER REFERENCES products(id) ON DELETE SET NULL`,
    `ALTER TABLE funnels ADD COLUMN IF NOT EXISTS entry_category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL`,
];

// Aplica schema.sql inteiro se o banco estiver vazio (primeiro deploy).
// Detecta vazio checando se a tabela `products` existe.
async function ensureBaseSchema() {
    try {
        const { rows } = await db.query(`
            SELECT EXISTS (
                SELECT 1 FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = 'products'
            ) AS exists
        `);
        if (rows[0]?.exists) {
            logger.info('[schema] tabelas base já existem — pulando schema.sql');
            return;
        }
        logger.info('[schema] banco vazio detectado — aplicando schema.sql completo...');
        const fs = require('fs');
        const path = require('path');
        const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
        const schema = fs.readFileSync(schemaPath, 'utf8');
        await db.query(schema);
        logger.info('[schema] schema.sql aplicado com sucesso.');

        // Cria admin inicial
        const bcrypt = require('bcryptjs');
        const username = process.env.ADMIN_USERNAME || 'admin';
        const password = process.env.ADMIN_INITIAL_PASSWORD || 'admin12345';
        const { rows: existing } = await db.query('SELECT id FROM admins WHERE username = $1', [username]);
        if (existing.length === 0) {
            const hash = await bcrypt.hash(password, 12);
            await db.query('INSERT INTO admins (username, password_hash) VALUES ($1, $2)', [username, hash]);
            logger.info(`[schema] admin "${username}" criado. Senha: ${password === 'admin12345' ? 'admin12345 (TROQUE!)' : '(definida via env)'}`);
        }
    } catch (err) {
        logger.error('[schema] falha ao aplicar schema base:', err.message);
        throw err;
    }
}

async function runMigrations() {
    // Primeiro garante que o schema base existe
    try {
        await ensureBaseSchema();
    } catch (err) {
        logger.error('[migrations] schema base falhou — abortando migrations incrementais');
        return;
    }

    let applied = 0;
    let failed = 0;
    for (const sql of MIGRATIONS) {
        try {
            await db.query(sql);
            applied++;
        } catch (err) {
            failed++;
            logger.warn(`[migration] falhou: ${err.message} | SQL: ${sql.slice(0, 80)}...`);
        }
    }
    logger.info(`[migrations] ${applied}/${MIGRATIONS.length} aplicadas (${failed} falharam)`);
}

module.exports = { runMigrations };
