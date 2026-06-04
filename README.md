# Area de Membros 2.0

Sistema de acesso VIP com integração multi-gateway (Kirvano + PerfectPay).

## Status

**Fase atual:** 1 — Webhooks e CRUD de produtos

## Stack

- Node.js 20 + Express
- PostgreSQL 16
- HTML + CSS + JS puro
- Docker + EasyPanel

---

# Como atualizar da Fase 0 pra Fase 1

Se você já está rodando a Fase 0 na EasyPanel, siga estes passos para atualizar:

## Passo 1 — Atualizar o código no GitHub

1. Faça download do novo zip (Fase 1)
2. Descompacte
3. Substitua todos os arquivos no seu repositório GitHub
4. Commit + push:
   ```
   git add .
   git commit -m "Fase 1 — Webhooks e CRUD"
   git push
   ```

## Passo 2 — Gerar o segredo da Kirvano

Abra: https://generate-secret.vercel.app/32

Copie o valor gerado. Anote num bloco de notas como `KIRVANO_WEBHOOK_TOKEN`.

**Não me mostre esse valor.** Ele vai em 2 lugares: variável de ambiente + painel da Kirvano.

## Passo 3 — Configurar variáveis de ambiente

Na EasyPanel, no serviço `areademembros2-0`, aba Ambiente, **adicione ou preencha**:

```
KIRVANO_WEBHOOK_SECRET=<o valor do passo 2>
PERFECTPAY_WEBHOOK_SECRET=1d1c36b64b05c11c4620e7ead69ceefd
```

O token da PerfectPay é o "Public Token" que você já tem no painel deles (o mesmo `1d1c36b64b05c11c4620e7ead69ceefd`).

Salve.

## Passo 4 — Deploy

Clique em **Implantar** no serviço. A atualização é automática (não precisa rodar init-db de novo, o schema é compatível).

## Passo 5 — Cadastrar produto de teste

1. Entre no painel: `https://app.vipmembros.com/admin` (no celular ou com devkey no desktop)
2. Faça login
3. Vá na aba **Produtos**
4. Clique em **+ Novo Produto**
5. Preencha:
   - Nome, descrição
   - **Aba Kirvano:** cole o `offer_id` de um produto real da Kirvano
   - **Aba PerfectPay:** cole o `plan.code` de um produto real da PerfectPay
6. Salve

## Passo 6 — Configurar webhook na Kirvano

1. Entre no painel da Kirvano
2. Vá na seção de Webhooks / Integrações
3. **Edite** o webhook da área de membros (ou crie um novo):
   - **URL da integração:** `https://app.vipmembros.com/webhook/kirvano`
   - **Token:** cole o valor que você gerou no Passo 2 (`KIRVANO_WEBHOOK_TOKEN`)
   - **Eventos:** marque TODOS:
     - Venda aprovada
     - Reembolso  
     - Chargeback
     - Cancelamento (se tiver)
4. Salve

## Passo 7 — Configurar webhook na PerfectPay

1. Entre no painel da PerfectPay
2. Vá em ferramentas → webhook
3. **Edite** ou crie:
   - **URL do Webhook:** `https://app.vipmembros.com/webhook/perfectpay`
   - **Eventos:** marque todos (Aprovado, Reembolso, Chargeback, etc)
   - **Formato postback:** PerfectPay
   - **Public token:** deixa o que já está (`1d1c36b64b05c11c4620e7ead69ceefd`)
4. Salve

## Passo 8 — Testar sem venda real

1. No painel admin, aba **Simular**
2. Preencha:
   - Gateway: Kirvano (ou PerfectPay)
   - Evento: Venda aprovada
   - Email: seu email de teste
   - Offer ID: o mesmo que você cadastrou no produto
3. Clique em Simular Webhook
4. Veja a mensagem de sucesso
5. Vá na aba **Acessos** → seu email deve estar lá com o produto

## Passo 9 — Teste com venda real

1. Faça uma venda de R$ 1,00 (crie uma oferta barata de teste na Kirvano/PerfectPay)
2. Use seu email de teste
3. Pague
4. Em segundos, na aba **Webhooks** do admin, vai aparecer a notificação recebida
5. Em **Acessos**, seu email deve estar liberado

---

# Estrutura do projeto

```
areademembros2-0/
├── public/
│   ├── index.html              Tela de status
│   ├── admin.html              Painel admin completo
│   └── assets/
├── routes/
│   ├── admin.js                Login admin, dashboard
│   ├── admin-products.js       CRUD de produtos
│   ├── admin-access.js         Gestão de acessos e webhooks
│   ├── user.js                 API do app cliente
│   ├── webhooks.js             Recebimento de webhooks
│   └── health.js
├── lib/
│   ├── auth.js                 Login com bcrypt + JWT
│   ├── device-check.js         Bloqueio desktop
│   ├── logger.js               Logger com mascaramento
│   ├── rate-limit.js
│   ├── sales-processor.js      Processador central de vendas
│   └── gateways/
│       ├── kirvano.js          Adaptador Kirvano
│       └── perfectpay.js       Adaptador PerfectPay
├── db/
│   ├── index.js                Conexão Postgres
│   └── schema.sql              Schema com 10 tabelas
├── scripts/
│   └── init-db.js
├── server.js
├── Dockerfile
└── package.json
```

---

# Endpoints

## Públicos
| Método | Rota | Descrição |
|---|---|---|
| GET | `/` | Tela de status |
| GET | `/health` | Health check |
| GET | `/admin` | Painel admin |

## Webhooks
| Método | Rota | Descrição |
|---|---|---|
| POST | `/webhook/kirvano` | Recebe webhooks da Kirvano |
| POST | `/webhook/perfectpay` | Recebe webhooks da PerfectPay |

## API Admin (exige autenticação)
| Método | Rota | Descrição |
|---|---|---|
| POST | `/api/admin/login` | Login |
| POST | `/api/admin/logout` | Logout |
| GET | `/api/admin/me` | Dados do admin logado |
| GET | `/api/admin/dashboard` | Stats gerais |
| GET | `/api/admin/products` | Lista produtos |
| POST | `/api/admin/products` | Cria produto |
| PUT | `/api/admin/products/:id` | Edita produto |
| DELETE | `/api/admin/products/:id` | Exclui produto |
| GET | `/api/admin/products/meta/categories` | Lista categorias |
| GET | `/api/admin/access` | Lista acessos |
| POST | `/api/admin/access/grant` | Libera acesso manual |
| POST | `/api/admin/access/:id/revoke` | Revoga acesso |
| GET | `/api/admin/webhooks` | Lista logs de webhook |
| GET | `/api/admin/webhooks/:id` | Detalhes de um webhook |
| POST | `/api/admin/webhooks/:id/reprocess` | Reprocessa webhook |
| POST | `/api/admin/webhooks/simulate` | Simula webhook (teste) |

## API Cliente
| Método | Rota | Descrição |
|---|---|---|
| POST | `/api/user/products` | Retorna produtos do cliente + catálogo |

---

# Recursos implementados

## Webhooks
- Validação de token/assinatura em ambos gateways
- Idempotência (mesma venda 2x não duplica)
- Tratamento de aprovação, reembolso, chargeback, cancelamento
- Tratamento de expiração de assinatura (PerfectPay)
- Log completo de todos webhooks (com payload)
- Reprocessamento manual de webhooks falhos
- Simulação de webhook pra teste

## Admin
- Login seguro (bcrypt + JWT + rate limit + lockout)
- CRUD de produtos com múltiplas ofertas por gateway
- Listagem e gestão de acessos
- Liberação manual de acesso
- Revogação manual de acesso
- Visualização de logs de webhook com filtros
- Simulador de webhook

## Segurança
- Senhas com bcrypt (12 rounds)
- JWT com expiração de 8h
- Rate limit em login e API
- Lockout após 5 tentativas falhas
- Validação de assinatura em webhooks
- Headers de segurança (Helmet)
- Logs com mascaramento de PII
- Bloqueio desktop (ativo em produção)

---

# Próximas fases

- **Fase 2** — Login do cliente com validação de email, magic link opcional
- **Fase 3** — App cliente com visual estilo Netflix (mockup antes!)
- **Fase 4** — Switch de gateway, estatísticas avançadas, dashboard bonito
- **Fase 5** — Blindagem desktop completa, anti-cópia, anti-devtools, go-live

---

# Desenvolvimento local

```bash
git clone <repo-url>.git
cd areademembros2-0
npm install
cp .env.example .env   # edite .env
npm run init-db
npm run dev
```

Em `NODE_ENV=development`, o bloqueio desktop fica desativado automaticamente.
