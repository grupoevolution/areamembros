# Prompt de revisão — mudanças de 30/10 a 03/11/2026

> Cole este texto inteiro no modelo revisor (Fable 5.1), aberto na pasta do projeto
> `areademembros2-0-main`. Ele tem acesso ao código; o painel de produção só via o
> Chrome do dono (não mexer em produção sem pedir).

---

Você vai fazer uma **auditoria independente** de um lote de mudanças num app em
produção que fatura ~R$100k/mês. Leia primeiro o `CLAUDE.md` inteiro (contexto,
regras, público, histórico de incidentes). O dono é leigo em programação: o seu
relatório final tem que ser em **PT-BR simples**, com exemplo prático
("o lead faz X → acontece Y"), e cada problema com **gravidade** (crítico / médio /
baixo) e **como corrigir**.

**Regras da revisão:**
- NÃO faça commit, push nem altere produção. Só leia, rode testes locais e reporte.
  Se achar algo crítico, descreva a correção exata (arquivo:linha + código), mas
  deixe o dono aprovar.
- Teste local: Postgres `areamembros_test`, `.env` local, `node server.js`
  (ou o preview do `.claude/launch.json`). Celular = viewport 390×844 e 375×812.
- Não confie no que o autor disse que testou — confira você mesmo.
- Histórico que NÃO pode se repetir: em 27/10 criar 250 chats fez a lista de
  conversas rodar ~2.000 consultas por abertura e travou o app; em 26/10 um popup
  ficou atrás do modal de e-mail do lead anônimo (interceptor de cliques em
  `public/app.html` — todo popup novo precisa de `data-mv-own-flow`); em 28 e 30/10
  o banco encheu a fila (27 e 108 pedidos) no pico das ~21h logo após a rotina de
  notificação das 20:30.

## Commits a revisar (do mais antigo ao mais novo)

`git log --oneline bc71238^..HEAD`

1. `bc71238` — pool do banco 20→35 (`db/index.js`) + "raio-x" no alarme de lentidão
   (`lib/ops-monitor.js`: soma por rota, top 8 rotas, últimos 10 min gravados em
   `ops_alerts.stats`; `routes/admin-push.js` devolve `stats`).
2. `f44e1bd` — app pede a lista de conversas 1x: `MV_chatsLight` (pedido leve
   compartilhado com cache de 8s), `loadList` sem duplicar, gatilhos
   foco/visibilidade/pageshow viram 1 (debounce 400ms). Arquivo: `public/app.html`
   (ChatApp: `lightChats`, `refreshUnreadDot(force)`, `loadList`/`loadListReal`;
   `mvRefreshChatList`; `pollChats` do notifyPoller; `ensureUnlock` do Encontros;
   `profileUpgrade`).
3. `b9fa465` — rolagem do grupo: CSS reserva espaço das fotos (`#gaBody img.photo`
   aspect-ratio 3/4) e o poll só desce a tela se o lead já está perto do fim
   (`nearBottom`).
4. `5f4a111` + `5b82b9c` + `b0485d5` + `5da14f4` + `c9bcc84` + `b89bb0b` + `3d8d899`
   + `9259f00` — **GATILHOS DE CONVERSA + PRESENTES + GRUPO DA CIDADE** (o grosso):
   - `routes/user-chats.js` (seção "GATILHOS DE CONVERSA", perto do fim):
     `triggersConfig`, `trigVariant`, `trigJob`, `trigScheduleOpen`,
     `trigModelChatFor` (cria conversa da modelo sozinha p/ chamada nova),
     `onCallEnded`, `onGiftPurchased`, `onPurchaseClearsPix`, `_trigDeliver`,
     `processChatTriggers`, rotas `POST /api/user/calls/ended` e
     `GET /api/user/gifts`; recepção VIP com público "só Premium"
     (`scheduleVipReception`).
   - `lib/chat-worker.js` — chama `processChatTriggers` a cada ~15s e manda push.
   - `lib/sales-processor.js` — presente (`utm_content` = `gift_<chatId>`) agradece
     mesmo sem produto cadastrado (antes do loop de itens); venda aprovada apaga a
     cobrança de Pix da modelo (`onPurchaseClearsPix`).
   - `lib/push-worker.js` — `loadBankForSlot`: se a config tiver
     `notif_chat_ids`, a notificação da rotina usa SÓ essas conversas.
   - `lib/migrations.js` — tabela `chat_trigger_jobs`, coluna
     `pix_pending_notices.model_notified_at`, e um `WITH ins AS (INSERT … ON CONFLICT
     DO NOTHING) UPDATE groups SET active = true WHERE id = 14 …` que deve rodar
     **1 vez só** no 1º boot (semeia a config `chat_triggers` e liga o grupo 14).
     Esse JSON já quebrou uma vez (faltava a chave `"gifts"`) — valide de novo.
   - `routes/admin-gamification.js` — chave `chat_triggers` + limpa cache ao salvar.
   - `routes/admin-chats.js` — `GET /api/admin/chats/triggers`.
   - `public/admin.html` — card "Gatilhos de conversa" (load/save), opção "Só
     Premium" na Recepção VIP.
   - `public/app.html` — `window.MVGift` (estrelas `rate()` e presentes `open()`,
     SVGs, CSS com animações, 6º quadrado dourado "Conquiste o coração dela" R$500),
     `endCall()` do VideoCall chama `MVGift.rate` quando `paidProductId` (chamada
     comprada) ou `giftChatId` (chamada que a modelo faz no chat), `mvNavigate`
     aceita `/?gift=<chatId>`, `MV_stampUtm` força o carimbo `gift_`.
   - `routes/user-groups.js` — `groupDisplayName`: nome com `{cidade}` vira a cidade
     do lead (geo por IP) na lista, no `/open` e no `/offer`.
   - `docs/roteiro-vip/gerador/entradas.js`, `themes.js`, `group-build.js` —
     recepções próprias por grupo + tema da cidade.

## Mudanças feitas DIRETO em produção pelo painel (não estão no git — confira pela API admin, só leitura)

- Produto 50 "GRUPINHO DA SUA CIDADE" R$24,90 (oferta Kirvano b44cb2f5…), grupo 14
  "Grupinho de {cidade} 📍" (fixado, nasce inativo, roteiro copiado do grupo 5,
  cenas próprias, convite chat 367 Rafaela, fim do trial chat 368 Tati).
- Cenas (entrada/novato/reação) substituídas nos grupos 3–12; `members_count`
  variado (eram todos 248).
- Chats 8,10,11,13,15,17 viraram `access=free`, `reply_mode=vip`, fora do rodízio,
  com roteiro curto (saudação → espera → foto → convite com botão).
- Chats 369–384 criados (conversa da modelo de cada chamada à venda, sem roteiro).
- Chat 65 Renildes: roteiro com chamada grátis + fechamento; chat 378 Jessica:
  oferece a própria chamada (produto 23); 370 Suzy (+20h) e 383 Aninha (+44h) com
  `trigger_product_ids` = produtos de chamada e delay inicial.
- Chats 97,98,99,101,102,103,105 com roteiros de upsell VIP→Premium / boas-vindas
  Premium; config `vip_reception` com 9 entradas (públicos vip/both/premium).
- Textos de tudo: `docs/ROTEIROS-PARA-REVISAR.html`.

## O que eu quero que você verifique (checklist)

**A. Não quebrou o que já existia**
1. Lista de conversas, aba Grupos, abrir conversa, abrir grupo, chamada do funil
   (Eliene/Raquel/Carolina), roleta, desconto ao desistir, planos, Minhas Compras,
   Encontros — tudo funciona igual, como lead ANÔNIMO, lead com e-mail sem compra,
   VIP e Premium. Toque real (clique de verdade), em 390×844 e 375×812.
2. `MV_chatsLight`: a bolinha de não-lidas e o aviso de mensagem nova continuam
   atualizando? Cache de 8s pode atrasar algo importante (ex.: depois de ler a
   conversa a bolinha some?). `refreshUnreadDot(true)` pula o cache?
3. Venda: webhook aprovado/pendente/reembolso de VIP, Premium, grupo, chamada e
   presente — acesso liberado igual antes, sem dupla contagem, sem erro novo.
   Presente não tem produto cadastrado: isso gera "venda órfã"/erro no resumo do
   webhook? A Kirvano recebe 200?
4. A recepção VIP com 9 entradas e fila cumulativa: o VIP recebe as certas e o
   Premium as dele? Alguma conversa repete ou chega fora de ordem?
5. Chats que viraram free (8,10,11,13,15,17): quem é VIP e já conversava com elas
   continua normal? Lead sem compra consegue avançar o roteiro (wait_input com
   reply_mode=vip)? Depois do botão, a próxima mensagem dele abre os planos?

**B. Performance / sobrecarga (prioridade alta)**
6. Conte as consultas ao banco por abertura de lista de conversas e de grupos
   (antes × depois). O grupo 14 a mais e `groupDisplayName` (resolveCity) pesam?
7. `processChatTriggers` a cada 15s: as queries usam índice? (`chat_trigger_jobs`
   tem índice parcial em `run_at WHERE done_at IS NULL`; `pix_pending_notices`
   filtra por `created_at`/`model_notified_at` — precisa de índice?)
8. `onPurchaseClearsPix` faz `DELETE FROM chat_messages WHERE meta->>'trig'='pix'
   AND session_id IN (…)` em TODA venda — plano de execução ok com a tabela grande?
9. Notificação da rotina das 20:30 (~28 mil aparelhos, espalhada em 12 min) agora
   manda todo mundo pra 6 conversas free → cada toque cria sessão + roda roteiro.
   Simule carga (ex.: 60–200 aberturas simultâneas de `/?chat=8`) e veja fila do
   banco/pool (35). Existe risco de repetir o alarme das 21h?
10. Pool 20→35: o Postgres de produção aguenta (max_connections, outros serviços na
    mesma VPS, conexão só-leitura do Argos)?

**C. Lógica dos gatilhos**
11. Pix → modelo: janela 5–7 min (`delay_min*60 + id%121`), 1x por Pix, não manda
    se já pagou, some ao pagar, escolhe a conversa certa (checkout_intents.chat_id →
    mapa → conversa de convite do grupo). E se o lead não tem e-mail?
12. Pós-chamada: dispara 1x por produto por dia; variação nunca repete pro mesmo
    lead até acabar o banco (`trigVariant` + contagem por `id <`); frases com
    `[presente]` só quando presentes ligados.
13. 1ª chamada paga da vida → Renildes (65) em 3 min + Jessica (378) 30 min depois.
    Só na 1ª? E se o lead já conversou com a 65/378 (não pode reiniciar)?
14. `trigModelChatFor` cria chat sozinho pra chamada nova: pode criar duplicado em
    corrida (2 eventos ao mesmo tempo)? O `jsonb_set` no mapa está correto?
15. Presente: `utm_content` gift_<id> chega no webhook da Kirvano/PerfectPay?
    Agradece 1x por venda? Lista de exclusão (2,24,64,7,59,73) funciona?
16. Estrelas: aparecem SÓ no fim de chamada assistida (paga ou do chat), nunca em
    chamada recusada/borrada (gateAnswer) nem nas do funil. Ficam por cima do
    modal de e-mail/outros popups? Têm `data-mv-own-flow`?
17. Migração do 1º boot: roda 1x, liga o grupo 14 só se o nome tem `{cidade}`, e
    não religa se o dono desligar. Teste rodando `runMigrations()` 2–3 vezes.

**D. Grupos**
18. `groupDisplayName` em todos os lugares onde o nome do grupo aparece pro lead
    (popup de planos, notificação, Minhas Compras, convite do canal free, push)?
    Algum lugar ainda mostra "{cidade}" cru?
19. Cenas novas (`entradas.js`): formato aceito pelo `cleanMessages`, `{cidade}`
    trocado, `p`/`g` corretos, vonce com pasta existente nos grupos.
20. Rolagem: com fotos de verdade e vídeo, a conversa ainda pula? E quando o lead
    está no fim e chega mídia, ele continua vendo a última mensagem?

**E. Segurança/compliance básicos**
21. `POST /api/user/calls/ended` e `GET /api/user/gifts` aceitam qualquer
    `product_id`/`chat_id` — dá pra abusar (spam de jobs, enumerar chats)?
22. Nada disso fere as regras do CLAUDE.md (Meta, anti-desktop, interceptor
    anônimo, "cada modelo só vende a própria chamada").

## Entregável

Um relatório em PT-BR simples com:
1. **Resumo em 5 linhas**: está seguro pro deploy / o que precisa corrigir antes.
2. **Lista de problemas** (gravidade, onde, exemplo prático, correção sugerida).
3. **O que você testou e como** (comandos, números de carga, prints).
4. **Melhorias opcionais** (separadas, sem misturar com bug).
