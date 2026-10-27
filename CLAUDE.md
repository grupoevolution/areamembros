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

---

## ESTADO ATUAL (atualizado em 26/10/2026) — leia antes de mexer

**Números (set/2026):** ~R$93k faturamento/mês, ~R$50k lucro, ROI ~1,56–1,58,
conversão ~2%, ticket médio ~R$22–23, ~10 mil visitantes/dia, 98% Pix.
**Meta:** ROI ≥ 1,8–2 com ~R$5k/dia de tráfego; conversão 3%; ticket 28–30
(via RECOMPRA, não só preço). Foco = lucro constante, base recorrente.

**Fluxo de trabalho que o dono exige:** nada entra sem ele pedir → mudança
visual vira PRÉVIA primeiro (página separada / mockup) → OK dele → código no
app → TESTE LOCAL em tamanho de celular (390×844 e 375×812) → push → ele
deploya FORA do pico (pico = 19h–01h). Erro que já aconteceu e não pode
repetir: botão escondido atrás do rodapé porque testei em viewport fixo.

**No ar (GitHub + produção):**
- Painel: filtro de datas livres na Visão Geral; fila de banco separada pra
  relatórios (`db.reportQuery`); índices criados em 2º plano no boot; blocos
  "Vendas e recompra" (por PESSOA), Roleta (c/ convite), Conversão por chat
  do funil, Desconto ao desistir, Encontros; Passe separado dos Grupos na
  pizza; fatia "Encontros" (utm `enc_*`).
- Roleta turbinada: 2 amigos = 1 giro, teto/dia (config no painel), convite
  pelo WhatsApp (`wa.me`) com texto editável, convidado ganha giro.
- Desconto ao desistir (`lib/exit-discount.js`, `routes/user-discount.js`):
  1 desconto por lead NA VIDA, acesso (VIP/Premium) OU grupo (link universal
  — libera o grupo do carimbo `group_<id>`), liga/desliga por tipo no
  painel; Pix gerado espera N min; quem pagou não vê.
- Preços atuais: VIP 24,90 (desc. 14,90), Premium 49,90 (desc. 29,90),
  grupos 19,90 (desc. 9,90), passe 67,90.
- ENCONTROS (estilo Tinder) — `lib/encounters.js`, `routes/user-encounters.js`,
  módulo `window.Enc` no app. Chave geral em Configurações do App →
  Encontros (DESLIGADA por padrão: app fica idêntico ao antigo). "E-mails de
  teste" (`lib/testers.js`) veem recursos desligados. Perfis = chats com
  `enc_enabled` (idade, etiqueta "dia | noite", ordem). Regras: 25 curtidas
  grátis → trava 3h dobrando; perfil após 3 cards (e-mail obrigatório se não
  logou); curtida de volta 3 min / 25 min, nunca de madrugada, 30% match;
  match abre o chat (2 msgs grátis em chat VIP); botão verde "enviar
  mensagem" = só Premium; voltar card = Premium; funil com entrada "Aba
  Encontros". Com a chave ligada o rodapé muda: Encontros no centro, Minhas
  Compras à direita (Perfil dentro dela).

**Incidente 26/10 (corrigido):** o popup de DESCONTO travava a tela de quem
ainda não tinha dado e-mail (lead do funil): o "interceptor do modo anônimo"
(app.html, `document.addEventListener('click', …, true)`) sequestrava todo
toque e abria o modal de e-mail ATRÁS do desconto (z-index menor). Regra:
TODO popup/tela nova que o lead anônimo usa precisa entrar na lista de
exceções desse interceptor (hoje: #mvPaywall, #mvdOv, #encounters, .enc-ov,
#encMatch…) e ser testado com TOQUE REAL como anônimo. Roleta: botão virou
"CONVIDAR AMIGOS" com a folha de compartilhar do celular (texto+link num
campo só); sem suporte → api.whatsapp.com na mesma aba.

**Pronto pra deploy (27/10):**
- Convite da roleta com CARTÃO DE FOTO no WhatsApp: `/?convite=` entrega
  etiquetas og:* (foto/título/texto em Configurações → Roleta → "Cartão com
  foto"). Robôs de prévia (WhatsApp/Facebook/Telegram…) recebem uma página
  mínima ANTES da trava anti-desktop (server.js) — senão levavam o 503 falso.
  Foto atual: sensual SEM nudez (decisão do dono; nudez pode marcar o domínio
  na Meta se alguém colar o link no Face/Insta). Texto padrão do convite
  trocado pelo do dono.
- Notificações com FOTO DA MODELO: banco `push_phrases` (64 frases, manhã/
  tarde/noite/madrugada; tipos chat/midia/encontros), editável no painel
  (Growth → "Frases das notificações com foto", 1 por linha "tipo | título |
  texto", `{nome}`). Rotina: 4 horários com `bank_period` (09:30, 14:30,
  20:30, 23:30); a migração PAUSOU os horários antigos de texto fixo (1 vez).
  Frase do dia gira em ciclo; modelo sorteada POR APARELHO entre chats ativos,
  listados, não-suporte, com foto. Foto só aparece no Android (iOS = ícone).
- Barra fixa no TOPO pedindo "Ative as notificações" para TODO app instalado
  (Android + iPhone) — o pedido automático de 90s era ignorado pelo Chrome.
  Volta a cada abertura até ativar; some ao tocar fora dela (não fica tampando
  o topo); bloqueado → instrução de como liberar, no máx. 1x/dia.
  Está na lista de exceções do interceptor anônimo (#mvPushBar).

**Auditoria 27/10 — corrigido (vai no mesmo deploy):**
- Lead anônimo não trava mais em: prévia de vídeo do grupo, ver-uma-vez,
  status das modelos, popup da amostra, planos, quiz. REGRA NOVA: toda tela/
  popup nova leva o atributo `data-mv-own-flow` (o interceptor ignora). O
  modal de e-mail fica SEMPRE no topo (z-index máximo) e tem tempo máximo de
  12s; 2ª falha de conexão no modo compra → vai pro checkout assim mesmo.
- Página do produto: "COMPRAR AGORA" agora passa pelo `MV_buy` (pede e-mail,
  carimba `product_<id>`, mesma guia). Antes abria aba nova SEM e-mail.
- Salvar produto atualiza as ofertas NO LUGAR (antes apagava/recriava e
  quem já pagou perdia o vínculo da oferta).
- Vendas: tabela `processed_sales` (gateway, venda, produto) — reenvio,
  reprocesso e 2 cópias simultâneas do webhook não contam como compra nova;
  Pix pendente que chega depois do aprovado é ignorado; renovação do Premium
  renova os bônus; desconto "já pagou" olha qualquer venda (sale_id).
- Carimbo `group_`/`desc_` sobrescreve utm_content do link (grupo com
  desconto não chega mais sem grupo); PerfectPay passa a ler utm_content.
- Peso: lista de conversas em lotes paralelos + 1 consulta a menos por chat;
  índices novos em 2º plano; polls de chat/grupo param com o app em 2º plano;
  Encontros desligado para de consultar; app.html com no-cache + ETag (304).
- Push: worker não empilha rodadas, timeout de 10s por envio, resgate de
  push preso roda todo minuto (claimed_at); toque na notificação abre na hora.
- Painel: aviso "alguns números não carregaram" em vez de 0 falso; bloco de
  vendas órfãs usava coluna inexistente (sempre 0) — corrigido.
- NÃO mexido de propósito (explicado ao dono): IP real p/ limites/bloqueio
  do login admin (depende do proxy EasyPanel/Cloudflare — errar bloquearia
  clientes reais); compra de chamada apagando prêmio da roleta não usado
  (exige mudar a contagem de chamadas); volta instantânea do checkout
  (bfcache) — desconto/roleta dependem do recarregar; faixa "instalar" da
  home segue escondida (nunca apareceu; religar = decisão do dono).

**27/10 (noite) — aprovado e pronto pra deploy:**
- Push "Pagamento confirmado" na hora da venda NOVA (abre Minhas Compras,
  `/?go=compras`) — `sendUserPush` em lib/chat-worker.js.
- Lembrete do Pix: 1x, ~15 min depois de gerar, se não pagou (janela
  15–40 min; `pix_pending_notices.reminded_at`); abre o chat de suporte.
- Fim da prévia de VÍDEO do grupo virou tela de venda (aprovada em prévia):
  quadro do vídeo desfocado + cartão do grupo (membros/preço) + "LIBERAR O
  GRUPO AGORA" → `MV_buy` direto no plano em destaque do grupo de destino
  (`GET /api/user/groups/:id/offer`, só leitura). Sem plano/já membro →
  tela antiga.
- Notificações com foto sorteiam só modelos ONLINE no rodízio.
- Corrigido: `?go=encontros` era ignorado (push de curtida abria a home).
- Dono decidiu MANTER: login do painel como está (já exige código),
  chamada x prêmio da roleta, recarregar ao voltar do checkout.

**Fila combinada:** ajustes da área de membros (dono vai listar); rotina de
STATUS (7–8 modelos/dia); criar chats por padrão; IA no chat via API barata
(Central IA em ~/Downloads/central-ia já pronta, falta deploy + integração);
depois app duplicado pra Europa (idiomas, Stripe).
