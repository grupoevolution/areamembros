# Briefing — ROTEIRO do GRUPO VIP (7 dias, intenso)

Este arquivo é o pedido pronto pra uma IA construir o roteiro do **grupo VIP** —
o principal e mais completo. Leia na ordem e siga à risca.

## Passo 0 — entenda o sistema (obrigatório antes de gerar)

Leia estes dois arquivos do repositório:
1. **`CLAUDE.md`** (raiz) — o que é o sistema, a intenção (vender via desejo/
   visual, público leigo) e como os GRUPOS funcionam (timeline compartilhada
   por dia×horário, mensagem visível 72h, modelo "fita", mídia por pasta).
2. **`docs/PROMPT-AGENDA-GRUPO.md`** — o **formato EXATO** do roteiro (JSON
   dia×horário×mensagens), todos os tipos de bloco, as variáveis
   `{nome}`/`{nome1}`/`{idade}`/`{cidade}` e como as pastas de mídia funcionam.

O roteiro que você vai gerar é importado em: Painel → Grupos → Editar grupo →
🗓 Agenda → 📥 Importar arquivo (JSON).

## Passo 1 — ANTES do dia 0, entregue a seção "PASTAS E MÍDIAS"

O grupo VIP é movido a MÍDIA por ASSUNTO. Você vai referenciar pastas do Bunny
pela chave (campo `folder` nas mensagens). Antes de gerar qualquer dia, liste:

- **Pastas de assunto** que o roteiro vai usar (chaves curtas, minúsculas), ex.:
  `academia`, `banho`, `cama`, `comida`, `cotidiano`, `espelho`, `praia`,
  `provocante`. Escolha as que combinam com o tema do VIP (mulheres reais,
  casadas/solteiras, dia a dia sensual). Para cada pasta, diga o assunto e
  quantas fotos/vídeos recomenda (mínimo ~25 por pasta pra não repetir na
  semana — quanto mais, menos repete).
- **Pastas de apresentação** (as "carnes novas" que se apresentam):
  - `apresentação MULHERES` com subpastas por faixa etária: `18-24`, `25-31`,
    `32-40` (o sistema gera a `{idade}` casando com a subpasta).
  - `apresentação HOMENS` (menos usado): `25-35`.
  - Recomende ~20 fotos por subpasta.
- No fim, um **resumo**: total de pastas e total aproximado de mídias que o dono
  precisa subir no Bunny.

> No painel do grupo, o dono mapeia as pastas de assunto em "Pastas de mídia"
> (chave = caminho no Bunny) e as de apresentação nos campos "Apresentação
> mulheres/homens". As mensagens `t:"presentation"` NÃO usam `folder` — o
> sistema puxa das pastas de apresentação sozinho (respeitando o gênero).

## Passo 2 — o FLUXO VIP INTENSO (o que gerar por dia)

Cada dia (day 0 a 6) tem que parecer um grupo de WhatsApp FERVENDO. Horário de
Brasília, de 00:00 a 23:59. Distribua ~**30 a 40 blocos por dia** assim:

| Período | Blocos | O que rola |
|---|---|---|
| **Madrugada** 00:00–02:30 | 3–4 | "quem tá acordado 👀", provocação pesada, tensão |
| 02:30–06:00 | 1 | esparso, alguém sem sono |
| **Bom dia** 06:30–09:00 | 2–3 | bom dia + "acordei pensando em..." + 1 foto (`cotidiano`/`cama`) |
| Manhã 09:00–12:00 | 3–4 | papo, foto de `academia`, 1–2 apresentações |
| Almoço 12:00–13:30 | 2 | provocação de tédio |
| Tarde 14:00–17:30 | 4–5 | tesão subindo, fotos por assunto, apresentações, 1 vonce |
| Esquenta 18:00–20:00 | 3–4 | movimento voltando, apresentações novas |
| **PICO** 20:00–23:30 | 10–14 | o auge: provocação pesada, MUITA mídia, apresentações, vonce, áudio/vídeo |
| Boa noite 23:30 | 1 | "boa noite pra quem merece 😏" |

Regras de composição por dia:
- **Apresentações: MUITAS** — ~12 a 18 por dia, sendo ~80% mulheres e ~20%
  homens. Cada apresentação = 1 msg `t:"presentation"` (texto tipo "oi gente,
  sou a {nome}, {idade} anos, casada, de {cidade} 🙈") + 2–3 reações de
  boas-vindas de outras pessoas (`{nome1}` citando quem chegou).
- **Fotos por assunto**: ~8–12 por dia, cada uma `t:"image"` com o `folder` do
  assunto + legenda provocante + 1–2 reações. Espalhe os assuntos pelos horários
  que fazem sentido (academia de manhã/tarde, banho/cama à noite, comida no
  almoço, etc.).
- **Vonce (isca de visualização única)**: 2–3 por dia, mais concentradas à
  noite. Use `t:"vonce"` com `kind:"foto"` e `folder` do assunto + texto curto
  ("mandei uma coisinha só pra vocês 🙈"). É o que empurra a venda.
- **Áudio e vídeo**: 1–2 por dia cada, à noite (`t:"audio"`/`t:"video"` com
  `folder`), pra dar aquele ar premium.
- **Papos/conversas**: o tecido que liga tudo — assuntos do dia, fofoca,
  provocação, tensão sexual. Interação REAL: pergunta → resposta → réplica,
  piadas internas, gente citando `{nome1}`.
- **Saudações**: bom dia de manhã, boa noite provocativa; madrugada é gatilho
  ("quem tá acordado"), não saudação.
- 1 **botão** (`t:"cta"`) a cada 2 dias no pico, chamando pra outra coisa do app
  (ex.: `label:"VER OS VÍDEOS 🔥"`, `link:"/?go=videos"`).

Tom: WhatsApp brasileiro real — abreviações, kkk, erros leves, sem pontuação
certinha, emojis com moderação. Provocante e tenso, sem conteúdo ilegal. NUNCA
use nomes próprios fixos — sempre `{nome}`/`{nome1}`.

## Passo 3 — FORMATO DE SAÍDA (crítico)

- Gere **UM DIA POR VEZ**. Termine o dia, PARE, e espere o dono dizer
  "próximo dia". (7 dias de uma vez estoura o limite e corta no meio.)
- Cada dia = **um array JSON puro e válido**, só daquele dia, importável direto
  — SEM markdown, SEM comentário junto do JSON, SEM ```. Só o array.
- Varie os minutos dos horários (09:12, 21:47 — nada de horário redondo sempre).
- Confira antes de entregar: `day` correto (0 no 1º dia, 1 no 2º...), `time`
  no formato "HH:MM", cada `folder` é uma das chaves que você listou no Passo 1.

## Passo 4 — como o dono importa (explique a ele no fim do dia 0)

1. Cria as pastas no Bunny (Passo 1) e mapeia no painel do grupo.
2. Importa o **dia 0** com a opção "substituir a atual" MARCADA.
3. Importa **dia 1 a 6**, cada um com "substituir" DESMARCADA (vai appendando).
4. Confere no calendário da agenda que os 7 dias ficaram preenchidos.

Comece agora pelo **Passo 1 (Pastas e mídias)** e, em seguida, o **dia 0**.
