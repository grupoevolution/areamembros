# Relatório de auditoria — lote 30/10 a 03/11/2026 (Fable 5.1)

> **Atualização 03/11:** M1, M2, B1 e B2 **corrigidos e re-testados** (commit seguinte a este arquivo). B3 é informativo; B4 fica como opcional.

## 1. Resumo (5 linhas)

1. **Pode ir pro deploy, com 1 correção pequena antes** (item M1 abaixo, 10 linhas de código) — ou logo depois, se preferir subir hoje.
2. Nada do que já existia quebrou nos testes: lista de conversas, grupos, venda normal (VIP/grupo), rolagem, migrações rodando 3x.
3. Velocidade igual à versão atual (60 acessos simultâneos: conversas ~0,26s, grupos ~0,38s). 150 pessoas abrindo a conversa da notificação ao mesmo tempo: 0,24s cada, sem erro, sem consulta lenta.
4. Achei **1 bug médio** (criação duplicada de conversa quando uma chamada NOVA termina pra várias pessoas ao mesmo tempo) e **1 limitação média** (lead que já conversou com a modelo da notificação não recebe mensagem nova).
5. O resto são pontos baixos / melhorias (índice no banco, estrelas após falha de vídeo, rotina de recepção VIP mais espalhada do que o planejado).

## 2. Problemas

### M1 — MÉDIO · Chamada nova cria conversas duplicadas em corrida
- **Onde:** `routes/user-chats.js`, função `trigModelChatFor` (bloco "CHAMADA NOVA sem conversa").
- **Exemplo prático:** o dono cadastra a chamada "Bia". No mesmo segundo, 6 leads terminam a chamada dela (ou 1 lead toca 2x). Testei exatamente isso: **nasceram 6 conversas "Bia"** em vez de 1. Cada lead passa a conversar com uma "Bia" diferente; o mapa do painel fica com a última. Não trava nada, mas bagunça.
- **Correção:** travar por produto antes de criar (lock do Postgres) e reler o mapa dentro da trava:
  ```js
  // dentro de trigModelChatFor, no lugar do bloco "CHAMADA NOVA sem conversa":
  return await db.transaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(884400, $1)`, [pid]);
      const { rows: [cfgRow] } = await client.query(`SELECT value FROM gamification_config WHERE key = 'chat_triggers'`);
      const again = parseInt((((cfgRow || {}).value || {}).pos_call || {}).map?.[String(pid)], 10);
      if (again) return again;                       // outro pedido criou enquanto esperávamos
      const { rows: [p] } = await client.query(`SELECT id, name, call_photo_url, banner_url FROM products WHERE id = $1 AND product_type = 'video_call'`, [pid]);
      const av = p && (p.call_photo_url || p.banner_url);
      if (!p || !av) return null;
      const { rows: [c] } = await client.query(`INSERT INTO chats (...) VALUES (...) RETURNING id`, [...]);   // igual ao atual
      await client.query(`UPDATE gamification_config SET value = jsonb_set(...) WHERE key = 'chat_triggers'`, [String(pid), c.id]);
      _trigCache = { at: 0, val: null };
      return c.id;
  });
  ```
  (`db.transaction` já existe e é usado em `consolidateSessions`.)

### M2 — MÉDIO · Notificação "te mandou mensagem" pra quem JÁ conversou com ela
- **Onde:** `lib/push-worker.js` (`loadBankForSlot` com `notif_chat_ids`) + `routes/user-chats.js` `/open` (só roda o roteiro quando a conversa está vazia).
- **Exemplo prático:** as 6 conversas escolhidas (Carla, Galega, Karen, Jessica, Luiza, Julia) já têm de 1.200 a 3.200 conversas antigas cada. Um lead que já falou com a Carla recebe "Carla te mandou mensagem", toca, e vê só a conversa velha — **nenhuma mensagem nova**. Mesma sensação de "mentira" que o dono quis acabar.
- **Correção (escolher 1):**
  - (a) *Leve, recomendada:* no `/open`, se a conversa já existe, o último bloco foi um CTA/fim de roteiro há mais de 24h e a modelo está na lista `notif_chat_ids`, inserir 1 mensagem curta sorteada ("oi sumido, lembrei de você 😏") e re-armar o roteiro no `wait_input`. 1 consulta a mais, só nessas 6 conversas.
  - (b) *Mais certeira, mais pesada:* no envio da rotina, sortear por aparelho só entre as modelos que o e-mail daquele aparelho ainda não conversou (1 consulta por lote de envio).

### B1 — BAIXO · Estrelas aparecem mesmo quando o vídeo da chamada falhou
- **Onde:** `public/app.html`, `VideoCall`: o "seguro de 9s" (vídeo não iniciou) chama `endCall()`, que dispara `MVGift.rate`.
- **Exemplo:** internet ruim, vídeo não carrega, tela fecha em 9s e aparece "Como foi a chamada?". Constrangedor.
- **Correção:** em `endCall`, só chamar `MVGift.rate` se `sec >= 15` (ou `v.currentTime > 5`).

### B2 — BAIXO · `pix_pending_notices` sem índice
- **Onde:** consulta do Pix → modelo roda a cada 15s e varre a tabela inteira (`Seq Scan` no EXPLAIN). Hoje é pequena; em 1 ano (~50 mil linhas) ainda é rápido, mas vale:
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pix_notices_recent ON pix_pending_notices (created_at) WHERE model_notified_at IS NULL;` (colocar em `BACKGROUND_INDEXES` de `lib/migrations.js`).

### B3 — BAIXO · Recepção VIP é em FILA (soma), não em horário absoluto
- A config nova tem 9 entradas; a janela de cada uma conta **a partir da anterior**. Resultado real pro VIP: Rosana +1–2h, Olívia +4–7h, Lorrane +14–22h, Débora +34–46h, Marta +54–70h (e não "+20–24h cada", como o texto do CLAUDE.md sugere). Não é bug — até espalha bem ao longo de 3 dias — mas o dono deve saber.

### B4 — BAIXO · `POST /api/user/calls/ended` aceita qualquer `product_id`
- Lead logado que descobrir o endereço pode disparar o pós-chamada e a chamada grátis da Renildes sem ter comprado. Público leigo, dano = 1 conversa grátis. Correção opcional: no `onCallEnded`, exigir `user_access` ativo pro produto (ou `customer_call_history`) antes de agendar.

## 3. O que testei e como

| Teste | Método | Resultado |
|---|---|---|
| Sintaxe de todo o código (app, painel, servidor) | `node -c` em todos os .js + `scripts/check-html-js.js` | 0 erros |
| Velocidade antes × depois | 2 servidores locais (commit antigo `f44e1bd` × HEAD), 60 simultâneos × 8 rodadas em /chats, /chats?light, /groups, /gifts, / | iguais: chats p50 0,26s · groups 0,38s · light 0,13s · 0 erros |
| Carga da notificação | 150 visitantes distintos abrindo a mesma conversa free ao mesmo tempo (`POST /chats/:id/open`) | total 268ms, p90 244ms, 0 erros, 0 "query lenta" |
| Lead sem compra na conversa free (A5) | conversa espelho das 6 (free, reply_mode vip, roteiro igual) via API | abre com a 1ª msg · responde no wait_input · recebe foto+texto+botão · texto depois do botão → `vip_required` (planos) ✓ |
| Fluxo de venda (A3/C11/C15) | `processSale` simulado: pending → 8/12 min → worker → approved → presente sem produto → webhook repetido | modelo cobra só depois de 12 min (janela 5–7 + jitter) · não cobra 2x · ao pagar some · presente agradece 1x · venda normal libera acesso |
| Variação de frases (C12) | 3 jobs do mesmo lead | 3 frases diferentes ✓ |
| Migração do 1º boot (C17) | `runMigrations()` 3x; grupo 14 desligado manualmente entre rodadas | config criada 1x · grupo liga 1x · **não religa** ✓ · JSON validado (6 presentes, especial R$500, exclusão 2,24,64,7,59,73) |
| Corrida na chamada nova (C14) | 6 `onCallEnded` simultâneos p/ produto sem mapa | **6 conversas criadas** ✗ → M1 |
| Nome com {cidade} (D18) | `/groups` com IP de Vila Velha e sem IP | "Grupinho de Vila Velha" / "Grupinho da sua região"; `/open` e `/offer` também passam por `groupDisplayName`; não achei "{cidade}" cru em push, planos ou Minhas Compras (produto tem nome próprio) |
| Estrelas/presentes (C16) | toque real 390×844 no app local | só no `ended` do vídeo ou no fallback de 9s (→ B1); recusar/gateAnswer não dispara; popup tem `data-mv-own-flow`; exclusão por chat retorna `rating:false` ✓ |
| Rolagem do grupo (D20) | 12 fotos placeholder + rolar pra cima enquanto chegam mensagens | não pula; só desce quando está no fim. **Não testei com mídia real do Bunny/vídeo** |
| Plano de execução (B8) | `EXPLAIN` do DELETE de `onPurchaseClearsPix` | usa índice de sessão (`idx_chat_messages_session`) ✓ |

**Não consegui testar daqui:** o pico real das 21h com 28 mil aparelhos; `max_connections` do Postgres de produção com o pool 35 + Argos (conferir com `SHOW max_connections` — local é 100); webhook real da Kirvano devolvendo `utm_content=gift_…` (o mesmo mecanismo já funciona pra `group_`/`desc_`); clique-por-clique completo como VIP e Premium reais em produção.

## 4. Melhorias opcionais (não são bugs)

- Presentes como **produtos ocultos** no painel: hoje a venda entra como "órfã" (webhook responde 200, só avisa) e **não soma no faturamento** do painel.
- `GET /api/user/gifts` cria a conversa da modelo como efeito colateral de um GET; mover a criação só pro `onCallEnded`/worker.
- Painel: mostrar no card "Gatilhos" quantas mensagens cada gatilho mandou e quantas viraram venda (hoje só os eventos `gift_open`/`gift_click`/`call_rating` são gravados).
- Barra de notificação: a notificação da rotina poderia alternar entre as 6 modelos por aparelho (hoje é sorteio puro — o mesmo lead pode receber a Carla 3 dias seguidos).
