# Gerador de cenas pros GRUPOS — formato + prompt

## Como usar
1. Copie o PROMPT lá de baixo num chat de IA (Claude/ChatGPT).
2. Troque os colchetes: tema do grupo, elenco e quantidade.
3. Cole o JSON gerado no painel: **Grupos → Editar grupo → Cenas (JSON) → Importar**.

## O formato (o que o motor entende)

Um array de CENAS. Cada cena é uma mini-conversa entre personas:

```json
[
  {
    "category": "papo",
    "period": "noite",
    "weight": 2,
    "messages": [
      { "p": 1, "g": "f", "t": "text", "text": "gente que tédio hoje", "gap_s": 6 },
      { "p": 2, "g": "m", "t": "text", "text": "vem cá que eu resolvo teu tédio kkk", "gap_s": 9 },
      { "p": 1, "t": "text", "text": "atrevido kkkk gostei", "gap_s": 7 }
    ]
  }
]
```

### Campos da CENA
| campo | valores | função |
|---|---|---|
| `category` | `papo` · `pesado` · `apresentacao` · `midia` · `cta` · `reacao` · `bomdia` · `boanoite` | tipo da cena (o motor sorteia por tipo) |
| `period` | `any` · `manha` · `tarde` · `noite` · `madrugada` | horário em que pode aparecer |
| `weight` | 1–100 | peso no sorteio (maior = aparece mais) |
| `messages` | array | as mensagens, em ordem |

### Campos da MENSAGEM
| campo | valores | função |
|---|---|---|
| `p` | 1, 2, 3… | slot da persona (mesmo número = mesma pessoa na cena) |
| `g` | `f` ou `m` | gênero exigido do slot (opcional) |
| `t` | `text` · `image` · `presentation` · `cta` | tipo. `image` = foto aleatória da galeria do grupo; `presentation` = foto de apresentação do gênero da persona; `cta` = botão |
| `text` | string | o texto (ou legenda da foto / rótulo do botão) |
| `gap_s` | 2–600 | segundos depois da mensagem anterior |
| `link` / `pid` | url / id de produto | destino do botão `cta` (opcional) |

### Regras que o motor aplica sozinho
- Os slots viram personas REAIS do elenco do grupo (sorteadas, respeitando o gênero).
- `reacao` NUNCA aparece sozinha — só dispara quando o lead manda mensagem.
- `bomdia`/`boanoite` são saudações; use `period` de acordo.
- Foto de `presentation` sai do banco de fotos de apresentação (homens/mulheres) do painel.

---

## PROMPT (copie daqui pra baixo)

Você vai gerar cenas de conversa pra um GRUPO de WhatsApp simulado, em JSON. O grupo é: **[TEMA DO GRUPO — ex.: grupo adulto de casadas de SP procurando encontros discretos]**. Público que vai LER: homens brasileiros, 18–55, leigos. Tom: informal brasileiro real de WhatsApp — abreviações, kkk, erros leves de digitação, sem pontuação certinha, emojis com moderação. Conteúdo provocante e tenso (sem conteúdo ilegal).

Gere um array JSON válido com **[40] cenas** seguindo EXATAMENTE este schema por cena:
`{"category": "...", "period": "...", "weight": N, "messages": [{"p": N, "g": "f|m", "t": "text|image|presentation|cta", "text": "...", "gap_s": N}]}`

Regras:
- `p` é o slot da persona (1, 2, 3…) — mesmo número = mesma pessoa dentro da cena. Use `g:"f"` ou `g:"m"` pra definir o gênero de cada slot. NÃO use nomes próprios nos textos (as personas reais entram no lugar dos slots).
- `gap_s` entre 4 e 40 (conversa natural).
- Distribua assim: 12 cenas `papo` (assuntos do dia, provocações leves, fofoca do grupo), 8 `pesado` (teor sexual explícito em texto, tensão alta), 6 `apresentacao` (novato(a) chega e se apresenta: use 1 mensagem `t:"presentation"` com texto tipo "oi gente, sou casado, 34, de SP, buscando algo discreto" — o gênero do slot define a foto), 5 `midia` (alguém posta foto: 1 mensagem `t:"image"` com legenda provocante + 2-3 reações), 4 `bomdia` (period manha) e 2 `boanoite` (period noite), 3 `reacao` (respostas a um NOVATO que acabou de mandar mensagem no grupo: "chegou gente nova 👀", "bem-vindo gato", perguntas pra ele — 2 a 4 mensagens curtas).
- `period`: espalhe entre manha/tarde/noite/madrugada de forma realista (safadeza mais pesada à noite/madrugada, papo leve de dia). Use `any` quando servir sempre.
- Cenas com 3 a 8 mensagens (reacao: 2 a 4). Interação de verdade: pergunta → resposta → réplica; uma pessoa some e voltam a citar; piadas internas.
- Responda SÓ com o JSON, sem explicação, sem markdown.
