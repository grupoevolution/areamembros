// TESTE DE CARGA — uso: node tools/loadtest.js http://localhost:3000 60 new
// Simula N leads abrindo o app ao mesmo tempo (lista cheia, lista leve 2x,
// grupos). Rodar com volume de produção no banco local ANTES de subir mudança
// grande (regra pós-incidente 27/10). Leads usados: visitor_id vload1..vload400.
// simula N leads ao mesmo tempo abrindo o app: lista de conversas (cheia),
// bolinha (light), grupos e Encontros — mede tempo de cada pedido
const base = process.argv[2], N = +process.argv[3] || 60, light = process.argv[4] === 'new';
const routes = (v) => [
  '/api/user/chats?visitor_id=' + v,
  '/api/user/chats?' + (light ? 'light=1&' : '') + 'visitor_id=' + v,
  '/api/user/chats?' + (light ? 'light=1&' : '') + 'visitor_id=' + v,
  '/api/user/groups?visitor_id=' + v,
];
(async () => {
  const times = {}, t0 = Date.now(); let errs = 0;
  await Promise.all([...Array(N).keys()].map(async i => {
    const v = 'vload' + (1 + (i % 400));
    for (const r of routes(v)) {
      const k = r.split('?')[0] + (r.includes('light=1') ? '(leve)' : '');
      const s = Date.now();
      try { const res = await fetch(base + r); await res.text(); if (!res.ok) errs++; } catch (_) { errs++; }
      (times[k] = times[k] || []).push(Date.now() - s);
    }
  }));
  const out = {};
  for (const [k, a] of Object.entries(times)) { a.sort((x, y) => x - y); out[k] = { n: a.length, mediana: a[Math.floor(a.length / 2)] + 'ms', p90: a[Math.floor(a.length * 0.9)] + 'ms', pior: a[a.length - 1] + 'ms' }; }
  console.log(JSON.stringify({ leads: N, total: (Date.now() - t0) + 'ms', erros: errs, out }, null, 1));
})();
