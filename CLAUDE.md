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
