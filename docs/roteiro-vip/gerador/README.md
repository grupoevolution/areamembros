# Geradores dos roteiros de grupo

Scripts que produzem os JSON de agenda importáveis (Grupos → Agenda → Importar).
São Node puro, sem dependências. Rodar de dentro desta pasta.

## Grupo VIP (7 dias, ~1200 msgs/dia, diálogo pesado)
```
node week-build.js semana-vip.json
```
Fontes: `p1..p6.js` (diálogos-semente do dia 0), `pools-a.js` (reações,
saudações, legendas, apresentações), `pools-b.js` (jogos/confissões/diálogos
únicos), `h.js` (helpers). Saída traz `folders`, apresentação, `scenes`
(saudação) e `trial_seconds`.

## Canal FREE (7 dias, só o ADMIN, anuncia a família de grupos)
```
node free-week-build.js free-semana.json
```
Avisos "fulana ONLINE no {grupo}", teasers (foto borrada / vídeo 5s), CTAs.
Edita o array `GROUPS` pra mudar quais grupos são anunciados e os links.

## Grupos temáticos secundários (7 dias, menos diálogo, mais mídia)
```
node group-build.js "CLUBE DAS CASADAS" saida.json
```
Os temas (id do grupo, apresentações, legendas, vonce, saudação) ficam em
`themes.js`. Reusam o acervo de mídia do VIP (mesmas pastas + `stream:*`).
Pra criar um grupo novo: adiciona um tema no `themes.js` e roda.

## Mapa dos grupos em produção (jul/2026)
- 1 GRUPINHO FREE (canal) · 2 GRUPO VIP
- 3 Casadas · 4 Cornos · 5 Vizinhas · 6 Nudes · 7 Novinhas
- 8 Encontros · 9 Só Conversar · 10 Crentes · 11 Putaria · 12 Namoro

Import via painel OU via API (ver `import-all.js` no scratchpad da sessão).
