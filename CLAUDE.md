# CLAUDE.md — Alinhamento para qualquer chat que trabalhar neste projeto

Este arquivo é lido automaticamente por qualquer sessão de IA aberta neste
repositório. Ele existe para que o dono (Iago) NÃO precise repetir o contexto a
cada novo chat. Leia tudo antes de mexer em qualquer coisa.

---

## O QUE É O SISTEMA

Área de membros que virou um **canal de vendas completo** para produtos adultos
(nicho de relacionamento/fantasia). Roda tráfego pago (Meta) → funil → o lead
entra num app estilo rede social (PWA) com **conversas simuladas, grupos, feed
de vídeos e catálogo**. O coração do faturamento recorrente são os **GRUPOS de
assinatura**.

- Stack: **Node.js/Express + Postgres**, front em **HTML/CSS/JS puro** (sem
  framework) em `public/app.html` (app do cliente) e `public/admin.html`
  (painel). Deploy: GitHub → **EasyPanel** (o dono faz o deploy; você só
  commita na `main`).
- Migrações automáticas idempotentes em `lib/migrations.js` (rodam no boot).
- Workers de background: `lib/push-worker.js`, `lib/chat-worker.js`.
- Público final: **homens brasileiros, 18–64, LEIGOS em internet, Android
  fraco, conexão ruim.** Tudo tem que ser ULTRA-LEVE, fluido e simples.

## A INTENÇÃO (o norte de toda decisão)

O sistema existe para **VENDER CADA VEZ MAIS**. Toda mudança deve servir a pelo
menos um destes: **mais conversão, melhor experiência do lead, acesso mais
fácil, mais recompra/cross-sell.** O que vende para este público é o **VISUAL**
(fotos, vídeos, mídia) e o **desejo/atração** — não argumento complexo. Mídia é
a estrela; texto é tempero.

## COMO CONVERSAR COM O DONO (obrigatório em toda sessão)

O dono é **LEIGO em programação**. Toda explicação precisa ser:
- **Simples e curta**, sem jargão técnico. Se usar um termo técnico, traduza na hora.
- **Com exemplo prático** do tipo "o lead abre a aba X → acontece Y → se Z falhar, ele vê W".
- Respostas resumidas; só alongue quando o assunto exigir, e mesmo assim de forma intuitiva.
- As ideias/decisões de negócio são dele; o caminho técnico (explicado simples) é seu.
- Não trate como falha o que é pedido dele: trava anti-desktop (anti-cópia de oferta —
  espiões da biblioteca de anúncios usam PC; não queima conta), login automático por
  link de funil sem senha, gamificação desligada por flag.

## COMO TRABALHAR (princípios que o dono pediu explicitamente)

1. **Sempre o caminho mais leve/viável que entrega o resultado.** Preocupe-se
   com sobrecarga do sistema E com a experiência que gera venda.
2. **Quando houver tradeoff, mostre os dois lados e deixe o DONO decidir.**
   Ex.: "caminho A = mais leve, perde X em qualidade; caminho B = mais rico,
   custa Y em performance." Nunca decida sozinho um meio-termo que sacrifica
   qualidade ou performance — apresente e pergunte.
3. **Seja proativo:** ao mexer numa área, sugira melhorias que façam sentido
   (mais venda, mais robustez), sempre analisando o sistema para **evitar
   erros/quebras**.
4. **Teste LOCALMENTE antes de commitar** (Postgres local `areamembros_test`,
   `.env` local, preview no navegador). O dono fica frustrado com entrega não
   testada. Commits pequenos por peça; push na `main` (ele faz 1 deploy).
5. **Divisão de trabalho:** o CONTEÚDO (conversas, cenas, textos, cópia) é do
   DONO. Você entrega a ESTRUTURA/sistema/painel/ferramentas para ele preencher.
6. **Compliance Meta:** o funil não pode ter comportamento que queime conta de
   anúncio. Não force navegador, não invente comportamento enganoso.

## ⚠️ TRAVA ANTI-DESKTOP (leia antes de diagnosticar "site fora do ar")

Em produção, acesso via DESKTOP recebe uma **página FALSA de erro 503**
idêntica à do Cloudflare (`lib/device-check.js`) — o site parece derrubado de
propósito (anti-clonagem; o público é mobile). O site NÃO está fora do ar.
- Mobile (User-Agent) passa direto. Rotas `/api/`, `/webhook/`, `/health`
  etc. são isentas.
- Desbloqueio no PC: abrir qualquer rota com `?devkey=CHAVE` (a chave é a env
  `DESKTOP_ACCESS_KEY`) — grava cookie `devbypass` por 30 dias e redireciona
  limpando a URL. Ex.: `/admin?devkey=...`. A chave NÃO vai no caminho.
- Antes de concluir que produção caiu: um 503 vindo com HTML "Cloudflare"
  perfeito é provavelmente ESTA trava (curl/robôs parecem desktop).

## ONDE MORA CADA COISA (mapa rápido)

- Vendas/webhooks: `routes/webhooks.js` + `lib/sales-processor.js` +
  `lib/gateways/{kirvano,perfectpay}.js`. Acesso liberado em `user_access`.
- Produtos/catálogo: `routes/admin-products.js`, `routes/user.js`.
- Chat (roteiro em blocos, fluxos, paywall): `routes/user-chats.js` +
  `routes/admin-chats.js` + `lib/chat-worker.js`.
- **GRUPOS** (o principal): `routes/user-groups.js` (cliente) +
  `routes/admin-groups.js` (painel). Ver seção abaixo.
- Funis `/f/:slug` + pressel `/p/:slug`: `server.js` + `routes/admin-funnels.js`
  + `public/pressel.html`.
- Push/notificações + relatório: `routes/admin-push.js`, `lib/push-worker.js`.
- Bunny (mídia): `lib/bunny.js` (Stream = vídeo; Storage = fotos/vídeos/áudio
  por pasta). Mídia fica no CDN do Bunny — **custo ZERO no servidor**.

## COMO OS GRUPOS FUNCIONAM (modelo mental correto)

Um grupo é um **canal ao vivo, universal e igual para todos** — como um grupo
de WhatsApp com centenas de pessoas. Não é conversa por lead.

- **A timeline é um ROTEIRO por dia×horário (Brasília)** que se repete a cada N
  dias (o "ciclo", 7–60 dias). O conteúdo do dia vai de 00:00 a 23:59.
- **Regra de visibilidade:** cada mensagem fica visível por **72h** (como um
  status dura 24h). Quem abre o grupo vê "o que está vivo agora" — mesma coisa
  para todos.
- **A camada por LEAD** (só isso é individual): as mensagens que o próprio lead
  manda, os gatilhos (boas-vindas ao entrar, reação quando ele fala, fim de
  trial → conversa privada com a oferta) e a `{cidade}` no texto (geo por IP).
- **Acesso:** `channel` (grupo grátis = canal, ninguém digita), `member`
  (comprou o produto do grupo ou o Passe Vitalício), `trial` (tempo grátis
  acumulado), `locked` (trial acabou → mensagens borradas + popup de planos).
- **Mídia por PASTAS do Bunny:** o dono cria pastas nomeadas por ASSUNTO
  (`academia`, `banho`, `cama`…), e o roteiro referencia a pasta pela chave. A
  organização por assunto garante que a foto casa com o texto (foto de
  `academia` + texto de academia) — sem precisar analisar imagem. Pastas de
  apresentação têm subpastas de gênero e faixa etária (`25-31`) e a `{idade}`
  do texto é gerada casando com a faixa.

### DECISÃO DE ARQUITETURA EM ANDAMENTO (jul/2026) — modelo "FITA"

Estamos migrando para: o roteiro é "assado" UMA vez na importação (resolve
nomes/idades/fotos em valores concretos → uma **fita fixa**), e no runtime o
sistema só **serve pelo relógio** (corta as últimas 72h) + troca `{cidade}` por
lead. Objetivo: aguentar volume ALTO (1000+ msgs/dia) sem recalcular por
requisição. **Mídia no modo A: carimbada na importação** (o sistema lista a
pasta do Bunny e crava as URLs; trocar fotos = re-importar). Se este parágrafo
ainda descreve "computado por requisição", o refactor da fita ainda não foi
concluído — confira o estado real do código em `routes/user-groups.js`.

### COMO MONTAR UM ROTEIRO DE GRUPO (formato + prompt)

O formato completo (JSON dia×horário×mensagens, tipos de bloco, variáveis
`{nome}`/`{idade}`/`{cidade}`, pastas) e um PROMPT pronto para gerar o roteiro
com IA estão em **`docs/PROMPT-AGENDA-GRUPO.md`**. Importa no painel:
Grupos → Editar grupo → 🗓 Agenda → Importar arquivo (JSON).

- **Grupo VIP** = o principal e mais completo: apresentação + diálogo + muita
  interação + mídia + vonce (isca).
- **Grupos secundários** = mais leves, focados em ENVIO DE MÍDIA por assunto,
  pouca/nenhuma apresentação. (É diferença de ROTEIRO, não de código.)
- Fluxo intenso concentrado nos picos (ex.: 19–22h e 22–01h), bom dia de
  manhã, madrugada como gatilho ("quem tá acordado"), etc.

## FLUXO DE DEPLOY

Commit pequeno por peça → push na `main`. O dono faz 1 deploy no EasyPanel. As
migrações rodam sozinhas no boot. Mensagem de commit em PT-BR, objetiva.

---

## PROJETO FUTURO: IA NAS CONVERSAS (planejado jul/2026 — NÃO é fechado, aceita ajustes)

Ideia alinhada com o dono, **ainda não implementada** (pausada por outra demanda +
limite semanal). Pode e deve passar por ajustes/otimizações antes/durante a execução.

**Objetivo:** IA conversa com os leads no chat das modelos (retenção pós-compra;
o roteiro de VENDA continua 100% programado). Depois: suporte e grupos (no grupo
ela seria vários personagens — fase futura, mais complexa).

**Arquitetura decidida:**
- **Sistema SEPARADO** (novo projeto, pasta própria, sobe na mesma VPS via EasyPanel).
  Login ÚNICO (dono + sócio usam o mesmo) — dentro dele há "perfis" tipo atendentes
  de WhatsApp; cada perfil tem um **token/código** pra conectar no sistema-aplicativo
  de cada um. Ambos rodam o MESMO sistema-base (só cor/detalhes diferentes).
- **Integração via API** entre o app e o sistema-de-IA (adiada — decidir formato
  depois; provável: assíncrono estilo webhook, com chave por perfil).
- No painel da IA: **biblioteca de personas** + **PROMPT MESTRE universal** (é aqui
  que mora TODA a complexidade: regras de aço, arquétipos, anti-erro). Visão geral
  de consumo (mensagens enviadas/recebidas, por perfil, comparar consumo).
- No app de cada um (mudança mínima, dentro da seção Chats): escolher a **persona**
  daquele chat + dados básicos (nome, idade, cidade, rotina) + liga/desliga da IA.
  **Mídia (pastas Bunny) e links de oferta continuam no app** — a IA só decide
  "cabe uma foto de X agora / hora de ofertar"; o app escolhe o arquivo/link.

**Motor (rodar LOCAL na VPS, sem pagar token, sem censura):**
- VPS: Hostinger KVM8 (8 vCPU, 33,7GB RAM, dividida com sócio). Consumo atual BAIXO
  (~6,5GB RAM, CPU 2-5%) → **cabe com folga** (~10GB pra IA + picos de CPU só ao gerar).
- Modelo nº 1 (testar): **`mradermacher/Nemo_RolePlay_PTBR_new-i1-GGUF` Q4_K_M** (~7GB)
  — base Mistral Nemo 12B, feito pra roleplay adulto em PT-BR, sem censura.
- Reservas: `MN-12B-Mag-Mell-R1` (RP consagrado, PT da base); `huihui_ai/gemma3-abliterated:12b`
  (melhor PT nativo + LÊ IMAGEM — reagir à foto do lead; prosa menos "quente").
- Rodar via **Ollama em Docker** (NUM_PARALLEL 1-2, KEEP_ALIVE alto, 1 modelo, limitar
  cpus do container). **1º passo de execução: benchmark de velocidade na VPS real**
  (vCPU compartilhada varia; decide o titular com número, não achismo).
- Plano B (só se o local decepcionar): API OpenRouter (ToS permite adulto) ~R$7/mês
  no volume atual; ou Featherless/Arli (flat ~R$50-130/mês). Nunca DeepSeek/Together/Novita
  (proíbem no ToS = risco de ban).

**Detalhes de comportamento combinados:**
- Delays HUMANOS (a lentidão de CPU vira realismo): lead manda → ela "vê" após 40s-2min
  → digita (tempo ~ tamanho da resposta) → responde. Delays inteligentes: às vezes
  some 20-40min e volta com desculpa ligada à ROTINA da persona (dormindo/academia).
- **Janela de agrupamento:** lead manda "oi"/"tudo bem"/"fazendo o quê" picado →
  espera ~30-40s de silêncio, JUNTA tudo numa mensagem só → 1 resposta (mais real +
  economiza CPU).
- **"Aprendizado" (expectativa a alinhar):** IA local NÃO se re-treina sozinha. O
  efeito de "melhora com o tempo" vem de: (a) **memória por lead** (resumo do que ela
  sabe do cliente, reenviado nas próximas conversas — cria vínculo/recompra); (b)
  **prompt afinado** com o que converte (medido no painel). Dia 1 boa; semana 4 parece
  muito melhor porque conhece cada lead + prompt turbinado.
- Regras de aço no prompt: nunca admitir que é IA, nunca marcar encontro real, nunca
  inventar mídia, resposta curta estilo WhatsApp, teto diário por lead ("fica ocupada").
- Ler foto: só o modelo de visão (Gemma) faz; custa +10-30s por foto em CPU — decidir
  no teste (ou fallback: reage sem ver, "que foto é essa 🙈 me conta").
- Painel da IA: DESIGN caprichado, estilo SaaS futurista/tech (ÍCONES SVG, nunca emoji).

Detalhes completos e histórico: memória `projeto-ia-chat.md`.
