# Gerador da AGENDA dos grupos — formato + prompt

A AGENDA é a linha do tempo compartilhada do grupo: cada item acontece num
**dia do ciclo × horário (Brasília)**, igual pra todo mundo, e repete quando o
ciclo vira (ciclo de 7 a 60 dias — configurável no grupo; quanto maior, menos
repete).

## Como usar
1. Copie o PROMPT lá de baixo num chat de IA (Claude/ChatGPT).
2. Troque os colchetes: tema do grupo, nº de dias do ciclo e volume por dia.
3. Salve a resposta num arquivo `.json` e suba no painel:
   **Grupos → Editar grupo → 🗓 AGENDA → 📥 Importar arquivo (JSON)**.
4. Dá pra **⬇ Exportar** a agenda atual, editar fora e re-importar (marque
   "substituir a atual" pra trocar tudo).

## O formato (o que o motor entende)

Um array de ITENS. Cada item = um bloco de mensagens num dia × horário:

```json
[
  {
    "day": 0,
    "time": "09:30",
    "messages": [
      { "p": 1, "g": "f", "t": "text", "text": "bom diaaa grupo 🌞", "gap_s": 5 },
      { "p": 2, "g": "m", "t": "text", "text": "bom dia gata", "gap_s": 9 }
    ]
  },
  {
    "day": 0,
    "time": "21:15",
    "messages": [
      { "p": 1, "g": "f", "t": "presentation", "text": "oi gente, sou a {nome}, {idade} anos, casada, de {cidade} 🙈", "gap_s": 5 },
      { "p": 2, "g": "f", "t": "text", "text": "bem vinda {nome1}!! 😍", "gap_s": 8 },
      { "p": 3, "g": "m", "t": "text", "text": "chegou mais uma kkkk", "gap_s": 6 }
    ]
  }
]
```

### Campos do ITEM
| campo | valores | função |
|---|---|---|
| `day` | 0, 1, 2… (0 = dia 1 do ciclo) | dia do ciclo em que o bloco acontece |
| `time` | `"HH:MM"` (Brasília) | horário em que o bloco começa |
| `messages` | array | as mensagens, em ordem |

### Campos da MENSAGEM
| campo | valores | função |
|---|---|---|
| `p` | 1, 2, 3… | slot da pessoa (mesmo número = mesma pessoa no bloco) |
| `g` | `f` ou `m` | gênero do slot (opcional) |
| `t` | `text` · `image` · `video` · `audio` · `presentation` · `vonce` · `cta` · `album` | tipo |
| `text` | string | texto / legenda / rótulo do botão |
| `gap_s` | 2–600 | segundos depois da mensagem anterior |
| `folder` | chave de pasta | de QUAL pasta do grupo sai a mídia (`image`/`video`/`audio`/`vonce`/`album`) |
| `kind` | `foto` ou `video` | só no `vonce` (visualização única) |
| `fotos` / `videos` | 0–6 (soma 2–6) | só no `album`: quantas fotos e vídeos da pasta entram na grade agrupada (estilo Telegram); `text` vira a legenda |
| `label` | string (até 60) | só no `cta`: o texto DO botão (o `text` vira o texto em cima, opcional) |
| `link` / `pid` / `color` | url / id de produto / cor | só no `cta` (botão) |
| `admin` | `true` | mensagem do ADMINISTRADOR (selo dourado — canal free) |

### Variáveis no texto (o motor troca sozinho)
- `{nome}` = quem está falando (elenco automático, ~180 nomes BR)
- `{nome1}`, `{nome2}`… = a pessoa do slot 1, 2… (referência cruzada)
- `{idade}` = gerada CASANDO com a sub-pasta de faixa etária da foto de
  apresentação (ex.: sub-pasta `25-31` → idade entre 25 e 31)
- `{cidade}` = cidade do lead (geo por IP; sem geo cai numa capital)

### Regras que o motor aplica sozinho
- O sorteio de nomes/fotos/idades é DETERMINÍSTICO por ciclo: todo mundo vê o
  mesmo, e a cada volta do ciclo a mídia rotaciona sem repetir até esgotar a
  pasta.
- `image`/`video`/`audio` sem `folder` usam a galeria geral do grupo (só fotos).
- `presentation` pega a foto das pastas de APRESENTAÇÃO (a proporção
  mulher/homem configurada no grupo decide o gênero quando `g` não vem).
- `vonce` com `folder` = visualização única REAL pra membro (some depois de
  ver); sem `folder` = isca (não-membro cai no popup de planos).
- NÃO use nomes próprios fixos nos textos — sempre `{nome}`/`{nomeN}`.

---

## PROMPT (copie daqui pra baixo)

Você vai gerar a AGENDA de um GRUPO de WhatsApp simulado, em JSON. A agenda é
uma programação por dia × horário que roda em loop. O grupo é: **[TEMA DO
GRUPO — ex.: grupo adulto de casadas de SP procurando encontros discretos]**.
Público que vai LER: homens brasileiros, 18–55, leigos. Tom: informal
brasileiro real de WhatsApp — abreviações, kkk, erros leves de digitação, sem
pontuação certinha, emojis com moderação. Conteúdo provocante e tenso (sem
conteúdo ilegal).

Gere um array JSON válido cobrindo **[7] dias** (day 0 até [6]), com **[8 a
12] itens POR DIA**, seguindo EXATAMENTE este schema por item:
`{"day": N, "time": "HH:MM", "messages": [{"p": N, "g": "f|m", "t": "text|image|presentation|vonce|cta", "text": "...", "gap_s": N, "folder": "...", "kind": "foto|video"}]}`

Regras:
- `p` é o slot da pessoa (1, 2, 3…) — mesmo número = mesma pessoa dentro do
  item. NUNCA use nomes próprios: use `{nome}` (quem fala) e `{nome1}`/`{nome2}`
  (citar alguém do item).
- Horários REALISTAS espalhados pelo dia: manhã (07:00–11:30) papo leve e bom
  dia, tarde (12:30–17:30) provocações, noite (18:30–23:30) o conteúdo mais
  quente, madrugada (00:00–05:00) pouca coisa (1 item no máximo). VARIE os
  minutos (09:12, 21:47 — nada de horário redondo sempre).
- Mix por dia: 1 bom dia (2-3 msgs), 4-6 papos (3-6 msgs: assunto do dia,
  fofoca, provocação, tensão), 1-2 apresentações (1 msg `t:"presentation"` com
  texto tipo "oi gente, sou a {nome}, {idade} anos, casada, de {cidade}" + 2-3
  reações de boas-vindas), 1 mídia (1 msg `t:"image"` com `folder:"[CHAVE DA
  PASTA — ex.: academia]"` e legenda provocante + 2 reações), 1 isca
  `t:"vonce"` com `kind:"foto"` e texto curto ("mandei uma coisinha 🙈"), 1 boa
  noite. A cada 2-3 dias, 1 botão `t:"cta"` com `text` chamativo e `link`
  "[LINK — ex.: /?go=videos]".
- `gap_s` entre 4 e 40. Itens com 2 a 8 mensagens. Interação de verdade:
  pergunta → resposta → réplica, piadas internas, gente citando `{nome1}`.
- Pastas de mídia disponíveis (use no campo `folder`): **[LISTE AS CHAVES —
  ex.: academia, banho, espelho]**.
- Responda SÓ com o JSON, sem explicação, sem markdown.
