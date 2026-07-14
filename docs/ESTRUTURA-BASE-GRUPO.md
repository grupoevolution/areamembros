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
| Apresentações MULHERES | 30–32 | espalhadas o dia todo; + 2–3 reações de boas-vindas cada |
| Apresentações HOMENS | 3–5 no MÁXIMO | bem espalhadas (1 manhã, 1 tarde, 1–2 noite) |
| Fotos avulsas | ~48 | assunto casa com horário; + 1–2 reações |
| Álbuns | 3 (máx.) | `{t:"album", folder, fotos:3, videos:1}` — 1 tarde, 2 no pico |
| Vonce | 8 | **SEMPRE de mulher**; 1 madrugada, 2 tarde, 5 pico/reta final |
| Vídeos | ~12 | esquenta e pico; saem das pastas de assunto |
| CTA | 1–2 | só no pico, alternando destino |

## Idades e apresentação

- Mulheres: **19 a 55**, maioria esmagadora 22–36. Homens: **35 a 60** (a
  idade do público — o lead se enxerga neles).
- O motor sorteia a faixa etária **ponderada pelo nº de fotos da subpasta** —
  a proporção de idades é controlada pelo UPLOAD, não pelo roteiro.

## Pastas no Bunny (zero repetição no ciclo de 7 dias — ~800 mídias)

Uma pasta-mãe por grupo (ex.: `grupo-vip/`), subpastas dentro. Assuntos são
mapeados 1 a 1 em "Pastas de mídia" (chave = caminho); apresentação aponta só
a pasta-mãe (subpastas de faixa são detectadas sozinhas). Vídeos moram DENTRO
das pastas de assunto (o motor filtra por tipo).

| Pasta | Fotos | Vídeos |
|---|---|---|
| `cotidiano` | 45 | 6 |
| `academia` | 40 | 8 |
| `comida` | 30 | – |
| `espelho` | 40 | 10 |
| `banho` | 40 | 15 |
| `cama` | 50 | 20 |
| `lingerie` | 45 | 10 |
| `provocante` | 50 | 20 |
| `praia` | 35 | 5 |
| `trabalho` | 30 | – |
| `festa` | 40 | 6 |
| `rua` | 15 | – |
| apresentação mulheres `19-21` | 15 | – |
| apresentação mulheres `22-28` | 70 | – |
| apresentação mulheres `29-36` | 70 | – |
| apresentação mulheres `37-45` | 35 | – |
| apresentação mulheres `46-55` | 20 | – |
| apresentação homens `35-60` | 30 | – |
| **TOTAL** | **700** | **100** |

Dá pra começar com menos e engordar: a fita reassa a cada 30 min e pega mídia
nova das pastas sem re-importar. O que NÃO pode é repetir dentro de 72h (a
janela visível); repetir entre ciclos é invisível.

## Entrada do lead (camada pessoal, 1x por lead)

1. Pill de sistema "Você entrou no grupo" (automática, motor).
2. Cena `entrada` (painel → cenas): boas-vindas + **vonce de isca** ("mandei
   uma coisinha só pra galera de agora 🙈") + reações enlouquecidas + "quem
   chegou agora conseguiu abrir?" — não-membro toca e cai no popup de planos.

## Visualização

- Janela de **72h** (mensagem "viva" por 3 dias — contador de não lidas explode).
- Abertura desce as últimas **150 mensagens** (~2–3h de fervo). Fase 2
  planejada: paginação pra rolar até as 72h.
