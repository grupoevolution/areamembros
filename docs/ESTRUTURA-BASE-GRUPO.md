# ESTRUTURA BASE dos roteiros de grupo (jul/2026)

Fonte de verdade pra gerar QUALQUER roteiro de grupo. O grupo VIP usa 100%
desta estrutura; grupos secundários usam a MESMA grade com volume menor
(~40%) e mais peso em mídia por assunto. Formato técnico do JSON:
`docs/PROMPT-AGENDA-GRUPO.md`.

## Números do dia (grupo VIP)

- **Volume:** ~1150 mensagens/dia no dia padrão. Dias fortes (sex/sáb) ~1300,
  fracos (seg-qua) ~900–1000. Ciclo de **7 dias** (day 0–6), sem dia em branco.
- **Conversa é ~70%** do volume: diálogos multi-pessoa (3–8 falas, 2–4
  pessoas), pergunta → resposta → réplica, piadas internas. Papo provocante
  domina; rotina real (café, trânsito, almoço, mercado, novela, academia,
  insônia) é o tempero de realismo.
- **Gênero nas falas: ~85% mulheres / ~15% homens.** Homens são coadjuvantes
  (reagem, elogiam, disputam atenção) — nunca dominam o papo.
- **Sem áudio por enquanto** (decisão do dono; os horários de áudio viraram
  conversa/mídia — quando ele gravar, os blocos entram por append na agenda).

## Grade horária (% do volume do dia — horários de Brasília, minutos VARIADOS)

| Faixa | % | O que rola |
|---|---|---|
| 00:00–01:30 | 7% | pós-pico: "quem tá acordado 👀", provocação pesada, 1 vonce |
| 01:30–03:00 | 3% | tensão esparsa, papo de insone |
| 03:00–05:30 | 1% | 1–2 blocos soltos (realismo) |
| 05:30–06:30 | 1% | madrugadores acordando |
| 06:30–08:00 | 5% | RITUAL bom dia em cascata + "acordei pensando em…" + foto `cotidiano` |
| 08:00–09:30 | 4% | café, indo trabalhar, provocação leve |
| 09:30–11:30 | 7% | papo + foto `academia` + apresentações |
| 11:30–13:30 | 7% | RITUAL almoço: foto `comida`, tédio, provocação |
| 13:30–15:30 | 6% | tarde morna: fofoca, piada interna |
| 15:30–17:30 | 7% | RITUAL confissão da tarde + 1 vonce + apresentações |
| 17:30–19:00 | 7% | saída do trabalho, "cheguei em casa", foto `banho` |
| 19:00–20:30 | 9% | esquenta: apresentações novas, mídia, diálogo subindo |
| 20:30–23:00 | **27%** | PICO: jogo da noite, álbuns, vídeos, vonce, apresentações |
| 23:00–00:00 | 9% | reta final quente + RITUAL boa noite em cascata |

**Rituais fixos diários** (âncoras de hábito, minutos variando por dia):
06:45 bom dia em cascata · 12:15 almoço · 15:30 confissão da tarde ·
18:30 "cheguei do trabalho" · 20:30 jogo/pergunta da noite (abre o pico) ·
22:00 hora da mídia pesada (álbum + vonce) · 23:40 boa noite em cascata ·
00:30 "quem tá acordado". Cada dia do ciclo ganha 1 tempero semanal (sexta do
fogo, domingo de resenha, segunda de confissão…).

## Mix de mídia por dia

| Tipo | Por dia | Regras |
|---|---|---|
| Apresentações MULHERES | 30–32 | espalhadas o dia todo; + 2–3 reações de boas-vindas cada; máx. 5/dia com {cidade} |
| Apresentações HOMENS | 3–5 no MÁXIMO | bem espalhadas; mulheres elogiam SUTIL |
| Fotos avulsas | ~32 | pasta casa com o momento: `bom-dia` manhã, `trabalho` comercial, `academia`, `sexy` (o grosso), `boa-noite` na reta final; + 1–2 reações |
| Álbuns | 3 (máx.) | `{t:"album", folder:"sexy", vfolder:"videos-sexy", fotos:3, videos:1}` — 1 tarde, 2 no pico |
| Vonce | 8 | **SEMPRE de mulher**, pasta `vonce` exclusiva; 1 madrugada, 2 tarde, 5 pico/reta final |
| Vídeos | ~12 | esquenta e pico; `videos-sexy` (+1 `videos-academia` de dia) |
| CTA | 1–2 | só no pico, alternando destino |

## Idades e apresentação

- Mulheres: **19 a 55**, maioria esmagadora 22–36. Homens: **35 a 60** (a
  idade do público — o lead se enxerga neles).
- O motor sorteia a faixa etária **ponderada pelo nº de fotos da subpasta** —
  a proporção de idades é controlada pelo UPLOAD, não pelo roteiro.
- Estilo da apresentação feminina (referência: canal Telegram do dono): curta
  e direta, tipo "34 anos, casada 🔥 buscando só diversão aqui 🔞 pv
  liberado". Mix de solteiras/casadas/maduras.
- Apresentação MASCULINA: as mulheres elogiam de forma SUTIL ("chegou bonito
  hoje kkk", "gostei desse 👀") — nunca exageradas.
- **{cidade}: no MÁXIMO 5 apresentações femininas por dia** usam "de
  {cidade}". As demais NÃO citam cidade nenhuma — raridade = credibilidade.

## Pastas no Bunny (reformulação jul/2026 — por MOMENTO do dia, não assunto)

Pasta-mãe por grupo (real: `IAGO GRUPOS/GRUPO VIP/`). **FOTOS no Bunny
STORAGE; VÍDEOS nas collections do Bunny STREAM** (setup real do dono): a
chave de vídeo usa o prefixo `stream:` com os NOMES das collections separados
por vírgula (`videos-sexy` → `stream:PRIVE,MDC,LB,AVULSOS`); a library é a do
campo "Mídias do grupo" (media_video_library_id). Vídeo do Stream toca via
thumb + player embed do Bunny (funciona em qualquer Android). No roteiro:
`t:"video"` usa `folder:"videos-sexy"`; álbum misto usa `folder:"sexy"`
(fotos) + `vfolder:"videos-sexy"` (vídeos). Apresentação aponta só a
pasta-mãe (subpastas de faixa detectadas sozinhas).

Consumo REAL do roteiro `semana-vip.json` (gerado jul/2026, ~1200 msgs/dia):
"Mínimo" = pool que garante ZERO repetição dentro das 72h visíveis (uso de 3
dias); "Ideal" = zero repetição nos 7 dias do ciclo. Com menos que o ideal, o
rodízio repete entre os dias sem quebrar nada.

| Pasta | Uso/dia | Mínimo (72h) | Ideal (7 dias) |
|---|---|---|---|
| `bom-dia` | 4 | 12 | 28 |
| `trabalho` | 4 | 12 | 28 |
| `academia` | 2 | 6 | 14 |
| `sexy` (fotos avulsas + galerias) | ~42 | 130 | 300 |
| `boa-noite` | 4 | 12 | 28 |
| `vonce` (fotos exclusivas) | 10 | 30 | 70 |
| vídeos: `stream:PRIVE,MDC,LB,AVULSOS` (collections do Bunny STREAM, por nome — rajadas + galerias + vonce vídeo) | ~62 | 190 | 440 |
| apresentação mulheres (5 faixas) | 62 | 190 | 435 (20/145/145/80/45) |
| apresentação homens `35-60` | 4 | 12 | 30 |
| **TOTAL** | | **~590** | **~1.370** |

A fita pega mídia nova das pastas a cada 30 min, sem re-importar — dá pra
abrir com o mínimo e engordar com o grupo rodando.

## Mídia → conversa (regra de ouro)

TODA mídia puxa interação: bom dia → respostas; foto sexy → reações + réplica
da autora; vonce → desespero de quem viu + curiosidade de quem não viu;
apresentação → boas-vindas. Mensagem de mídia solta sem reação não existe.

## Entrada do lead (camada pessoal, 1x por lead)

1. Pill de sistema "Você entrou no grupo" (automática, motor).
2. Cena `entrada` (painel → cenas): boas-vindas + **vonce de isca** ("mandei
   uma coisinha só pra galera de agora 🙈") + reações enlouquecidas + "quem
   chegou agora conseguiu abrir?" — não-membro toca e cai no popup de planos.

## Visualização

- Janela de **72h** (mensagem "viva" por 3 dias — contador de não lidas explode).
- Abertura desce as últimas **400 mensagens** (~6–8h de fervo). Fase 2
  planejada: paginação pra rolar até as 72h.
- **Pós-trial**: o corpo do grupo fica todo BORRADO + cartão "⏳ 00:00 seu
  tempo grátis acabou" com botão pros planos. A conversa segue por trás
  (movimento visível, ilegível).
- O `semana-vip.json` carrega o mapeamento de pastas junto: importar com
  "substituir" configura as pastas do grupo E reinicia o ciclo pra hoje.
