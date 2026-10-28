# Relatório — funil "Chats 2" (/p/chatonline2 → /f/chatonline2) — 28/10/2026

Teste feito como lead (celular Android simulado), 3 conversas até a trava de
pagamento (sem gerar Pix), + números do painel (últimos 7 dias, 21–27/10).

## Números (7 dias)
- Funil: 37.809 visitas → 4.524 e-mails (12%) → 1.580 instalaram o app (35% dos e-mails).
- Por chat (entraram → conversaram → compraram, venda carimbada chat_X):
  | Chat | Entraram | Conversaram | Vendas | % de quem conversou | Ticket |
  |---|---|---|---|---|---|
  | Raquel (7) | 13.650 | 2.695 (20%) | 37 | 1,37% | R$ 36 |
  | Carolina S. (73) | 2.324 | 1.589 (68%) | 19 | 1,20% | R$ 39 |
  | Eliene Souza (24) | 2.917 | 2.057 (71%) | 17 | 0,83% | R$ 35 |
- Raquel tem 4–5x mais "entradas" porque é a 1ª da lista e puxa conversa sozinha
  (auto_start 1 min) — 72% das sessões dela nunca mandaram mensagem. Quem conversa
  com ela vai fundo (60% chegam à trava). Parte do "Raquel vende mais" é POSIÇÃO.
- Vendas da semana por área: grupos 142 (43%), chat VIP 63, chat Premium 54,
  catálogo 24, chamadas 21, upgrade 17, passe 9. CLUBE DAS CASADAS = 46 vendas
  (22 carimbadas group_3) — é o grupo que a Eliene vende na conversa.
- Roleta: 2.333 giraram, 82 compraram depois (R$ 3.128). Convite: 83 visitas, 0 compras.
- Desconto ao desistir: 2.496 viram, 210 clicaram, 17 vendas.

## Roteiros (resumo)
- Raquel: 118 blocos, ~15 min, digitação (12 respostas). Moça comum de óculos,
  "dodinha", 26 anos, loja, de folga. Esquenta devagar (conversa normal → "gosta de
  conversa quente?") → 1º vídeo ver-uma-vez GRÁTIS (topless) → 2º com e-mail →
  3º → "vou gravar um vídeo melada" → trava "Seja VIP" → "tá aí? cadê vc" → "ligando".
- Eliene: 59 blocos, ~6 min, BOTÕES (sem digitar). Casada, marido viaja, "responsável
  pelo grupinho das Casadas". Áudio + foto → "quer entrar no grupo?" → fotos nuas
  ver-uma-vez (e-mail na 1ª) → chamada de vídeo nua grátis → trava → 2ª chamada.
- Carolina: 37 blocos, ~4 min, 4 respostas. "Vc é daqui de {cidade}?" → 2 áudios →
  foto → 2 nudes ver-uma-vez SEM pedir e-mail → trava → chamada. E-mail só no comprar.

## Furos encontrados
1. Raquel trava se o lead mandar só 1 mensagem depois de "me fala mais sobre vc"
   (blocos 250 e 260 = 2 esperas seguidas). Dados confirmam abandono em 4–6 msgs.
2. Raquel não tem chamada configurada: mostra "Raquel está te ligando..." e nada toca.
3. Eliene vende o GRUPO a conversa toda, mas a trava mostra "Assinatura do Chat".
4. Checkout Premium: resumo R$ 50,89 (anunciado 49,90); order bump "Vídeo chamada
   R$ 24,90" em plano que já diz incluir chamadas; e-mail não vem preenchido.
5. Nome do lead (perguntado pela Raquel) não é guardado → suporte chama de "amor".
6. Etiqueta do Suporte VIP escrita "SUPOTE".
7. Pressel anima Fabi/Gaby/Leyla, mas o funil abre Raquel/Eliene/Carolina.
8. Depois do e-mail, voltando do checkout pela home, Eliene/Carolina somem da lista
   (são listed=false) se o lead não tinha começado com elas.
9. "tá aí? cadê vc" chega 6s depois da trava, com o lead ainda olhando os planos.
10. Na Carolina a tela de planos abre por cima da chamada tocando.
11. Volta do checkout = roleta + desconto em seguida (2 popups).
12. Métrica "compradores" do funil conta acessos de brinde (roleta etc.) — 2.092
    "compradores" pra 4.524 e-mails; e a consulta leva ~20s no banco principal.
13. Texto "hoje to de folga" às 1h da manhã; "pueta" (erro de digitação).

## Parte 2 — Cleia + grupos (teste 28/10 manhã)
Caminho: Eliene → e-mail (teste.claude.cleia@teste.com) → Cleia chega sozinha →
Clube das Casadas → Carol chama em 25s → Grupo VIP → Jaqueline em 15s → Vizinhas → Suellen em 25s.

Roteiros:
- Cleia (74): boas-vindas → foto "32 anos, casada liberal" → nude → ver-uma-vez →
  SÓ DEPOIS DE ABRIR o ver-uma-vez: "to te esperando no grupinho das casadas" + botão ENTRAR NO GRUPO.
- Carol (70, convite do Casadas): "vai entrar no grupinho das casadas?" → "de onde?" →
  [lead responde] → foto "casada... sou de {cidade}" → trava do GRUPO (mensal 19,90 / vitalício 29,90 em destaque).
- Jaqueline (68, convite do Grupo VIP): "vc de onde? vai entrar?" → [resposta] → foto → trava
  (mensal 19,90 / vitalício 49,90 "WhatsApp particular da Eliane").
- Suellen (69, convite do Vizinhas): "é daqui de {cidade}? vi que entrou no grupo" → foto → trava (19,90 / 29,90). Sem pergunta.
- Fim do teste do Grupo VIP → chama a Eliene (24).

Vendas carimbadas por chat (30 dias): Raquel 335 (R$11.247) · CAROL 278 (R$6.470) ·
Eliene 160 · Carolina 147 · Suellen 137 (R$2.420) · Jaqueline 37 (R$816) · Cleia 3.
7 dias: Raquel 48 · Carol 29 · Eliene 24 · Carolina 21 · Suellen 9 · Jaqueline 7.
Respostas: Carol 157/200 sessões responderam (78%), Jaqueline 156/200, Suellen 30/200 (não pergunta nada).
Cleia: só ~1/3 aperta ENTRAR NO GRUPO.

Furos novos:
14. Botão da Cleia só aparece se o lead abrir o ver-uma-vez — quem não abre nunca vê o convite.
15. Popup de desconto (VIP/Premium) abriu DENTRO do grupo junto com a Suellen chamando, e a trava dela não abriu sozinha.
16. Jaqueline vende vitalício de 49,90 prometendo "WhatsApp particular da Eliane" (nome errado + promessa de WhatsApp).
17. Faixa da Suellen diz "seja VIP" mas abre o plano do grupo.
18. Só 3 dos 12 grupos têm modelo chamando no privado.

## Parte 3 — Recepção VIP (pós-compra → upgrade)
- Renildes (65, só VIP, 0–1 min): "Oii bb, tá aí??" → [resposta] → foto "vamo de chamadinha?" → LIGA (chamada 6).
  VIP não pode atender → "aff... vc não consegue atender pq não é vip né?" → "vou ver se acho outro online" →
  "vc é de onde? manda foto" → FIM. Sem botão/oferta de upgrade.
- Deisyele (66, VIP+Premium, 1–2 min): foto "Deisy, 34, casada, faço o marido de corno" → [resposta] → 2 fotos →
  "amo dar o cuzinho..." → "vc tb tem nojo?" → [resposta] → "tá no grupo das casadas? manda foto" → FIM. Sem oferta.
- Leads respondem MUITO (Renildes 141/200, Deisyele 161/200) e ficam falando sozinhos ("sumiu gata", "??", "posso te ligar").
- Vendas carimbadas 30 dias: Renildes 0 · Deisyele 3 (R$160).
Furos: 19. nenhuma das duas oferece o upgrade; 20. Renildes diz "não é VIP" pra quem ACABOU de comprar o VIP
(o certo é Premium); 21. conversa termina em pergunta sem resposta → cliente pago fica no vácuo;
22. o "Testar recepção" do painel não dá VIP ao e-mail, então não dá pra ver como VIP de verdade.

## Direção do dono (28/10)
- Toda venda nasce no CHAT (até a de grupo). Foco máximo = chats.
- Testes A/B de roteiro (como o da barra de notificação) para funil, grupos e recepção VIP/upgrade.
- Upgrade tem que subir ticket SEM frustrar o cliente (frustração = reembolso e perde a recompra).
- Meta: 5% (sonho 10%) dos leads comprando em 10–15 dias (hoje ~2%).
- Novos rastreios no app são bem-vindos se forem leves.
