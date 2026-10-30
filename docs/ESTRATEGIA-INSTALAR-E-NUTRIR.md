# Estratégia: INSTALAR + NOTIFICAÇÕES → NUTRIR O LEAD (áudio do dono, 29/10/2026)

> Documento-mestre da nova fase. Leia antes de mexer em instalação, notificações,
> rotina de push, quiz, chats novos ou funis novos. NADA aqui está codado ainda
> (dono pediu: conversar primeiro, sem código).

## A virada de pensamento

Hoje o app é focado na **conversão NA HORA** (lead clica no anúncio → funil → compra
em minutos). O dono acredita que **perde muito lead nesse processo**: o cara abre,
se distrai, sai — e some pra sempre.

Nova lógica = **igual tráfego pro WhatsApp**: o lead nem sempre compra na hora, mas
você tem o contato e reconecta depois **sem pagar de novo**. No app, esse "contato"
é: **app instalado + notificações ativadas**. Janela de venda passa de *alguns
minutos* para *15 dias*.

Vale pros dois públicos:
- **Não comprou** → nutrir até a 1ª compra (adesão).
- **Comprou** → recompra (não oferecer de novo o que já tem; oferecer conteúdo,
  chamada, liberar vídeos, live, grupo…).

Meta pessoal do dono: **1 milhão de pessoas comprando pelo menos 1 produto** no app.
Por isso o app tem que ser AMPLO (vários públicos: chamada, conteúdo, conversa,
putaria, relacionamento).

## ETAPA 1 — Instalar + ativar notificações (a base de tudo)

Objetivo: chegar perto de **90%+ de quem instala também ativar notificação** (ícone
perdido no celular não adianta; a notificação é o que traz ele de volta).

Ideias do dono:
- Já existe: foto de visualização única que pede instalação de forma sutil. Dono vai
  testar se está realmente instalando.
- **Transferir pro app depois de instalar** (como Mercado Livre abre o app quando
  você entra no site). Ex.: conversando com a Raquel → instalou → já continua DENTRO
  do app, quase sem perceber.
- Ao abrir o app pela 1ª vez: popup **sutil** de "ative as notificações", que o lead
  toca quase como se fosse fechar — mais forte que a barra atual.
- Espalhar o incentivo: na conversa, na roleta, em outras telas. **Sutil, sem
  repelir o lead.**
- Referência TikTok: link aberto no navegador mostra 3 botões "diferentes" e todos
  levam a abrir/instalar o app.
- **Travas pra quem JÁ comprou** (pra quem não comprou: facilitar ao máximo). Ex.:
  "pra assistir a chamada de vídeo, abra no app" — com saída discreta pelo site pra
  ninguém ficar desamparado.

## ETAPA 2 — Rotina de nutrição (10–15 dias)

- Lead que não comprou: recebe mensagens/conversas por dias até comprar, tentando
  ofertas diferentes (conteúdo → Encontros → conversa mais longa → grupo…).
- Lead que comprou: mesmo esquema focado em RECOMPRA, nunca ofertando o que ele já tem.
- Ritmo ideia: ~1–2 conversas novas por dia, além do grupo.
- Testar quais notificações convertem mais (como foi feito com a barra A/B/C).

## ETAPA 3 — Mais chats, segmentados, com rodízio + campeão

- Hoje o funil usa só ~3 conversas (Raquel/Eliene/Carolina). Ideia: +5 → 8.
- Achar o **campeão** (mais converte) e usar como principal, **sem deixar de mostrar
  os outros** — cada lead tem um interesse (chamada, conteúdo, conversa, putaria,
  relacionamento).
- Chats novos aprendendo com os que já vendem.
- **QUIZ** (já tem prévia aprovada, memória `projeto-quiz-funil`): 3–4 cliques pra
  descobrir o que o lead quer e entregar o chat/oferta certa.

## ETAPA 4 — Novos funis e novas fontes de tráfego

- Hoje: 1 anúncio só, pro funil chatonline2.
- Testar: anúncio pro quiz, pra outros chats, direto pro Encontros, direto pra um
  grupo específico.
- Novas fontes: Google, Kwai, sites/redes adultas (tráfego barato). Exige criativos e
  abordagens diferentes.

## Contínuo — Catálogo vivo

- Meta: **5–6 chamadas de vídeo novas por semana** (tem lead que compra todas).
- Otimizar: o que mais vende sobe pro topo / recebe incentivo.
- Sempre testando produtos novos.

## Depois de tudo redondo — IA no chat

- Dono acha que vai ser o divisor de águas (conversão e ROI).
- Com IA: testar **tickets altos** (R$300–500).

## Como a empresa trabalha (regra de todas as etapas)

Dados, métricas, referências de grandes empresas, comportamento humano → **teste
eficaz e mensurável** → o que ganha vira foco, o que perde não é descartado à toa.
Degrau por degrau, sem pressa, melhoria diária. Variações sempre no estilo do teste
da barra de notificação (várias abordagens que fazem sentido, rodando juntas, medindo).

O dono quer que o Claude **contribua com ideias**, não só execute: trazer o que a
programação permite e ele não sabe que existe.

## Notas técnicas (análise do Claude, 29/10 — a validar)

- **Abrir o app sozinho a partir do link (estilo Mercado Livre)**: no ANDROID com
  Chrome, um app instalado (WebAPK) captura links do nosso domínio quando o link é
  tocado FORA do navegador (WhatsApp, notificação, SMS). Dentro do navegador do
  Facebook/Instagram NÃO — lá não existe forma confiável de pular pro app. No iPhone
  não existe.
- **Saber se o lead já tem o app** estando no navegador: Chrome Android tem
  `getInstalledRelatedApps` → dá pra mostrar uma tela "ABRIR NO APP" (estilo TikTok)
  só pra quem já instalou.
- **iPhone**: só recebe notificação com o app adicionado à tela inicial (instalação
  manual, com tutorial).
- **Antes de tudo: medir a linha de base** — de quem entra, quantos instalam; de
  quem instala, quantos abrem o app; de quem abre, quantos ativam notificação. Sem
  esse número não dá pra saber se a mudança funcionou.
