// Investimentos — comparador de rentabilidade de ações da B3
// Servidor sem dependências (Node 18+). Dados: brapi.dev (ações e Ibovespa) e Banco Central (IPCA).
const http = require('http');
const fs = require('fs');
const path = require('path');
const M = require('./mercado');
const C = require('./caixinhas');
const A = require('./alertas');
const PIN = process.env.APP_PIN || '';

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.BRAPI_TOKEN || '';
const BRAPI = 'https://brapi.dev/api';
const CACHE_MS = 6 * 60 * 60 * 1000; // 6 horas
const cache = new Map();

async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const data = await fn();
  cache.set(key, { at: Date.now(), data });
  return data;
}

async function getJSON(url) {
  const r = await fetch(url, { headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {} });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { message: text.slice(0, 200) }; }
  if (!r.ok) {
    const err = new Error(body.message || `Erro ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return body;
}

const RANGE = { 2: '2y', 5: '5y', 10: '10y' };

// Busca por nome ou código: /api/buscar?q=itau
async function buscar(q) {
  const url = `${BRAPI}/quote/list?search=${encodeURIComponent(q)}&limit=12&sortBy=volume&sortOrder=desc`;
  const body = await cached('busca:' + q.toLowerCase(), () => getJSON(url));
  return (body.stocks || []).map((s) => ({ ticker: s.stock, nome: s.name, tipo: s.type, setor: s.sector, preco: s.close, logo: s.logo }));
}

// Série mensal de um ativo: /api/serie?ticker=ITUB4&anos=5
async function serie(ticker, anos) {
  const range = RANGE[anos] || '5y';
  const url = `${BRAPI}/quote/${encodeURIComponent(ticker)}?range=${range}&interval=1mo&dividends=true`;
  const body = await cached(`serie:${ticker}:${range}`, () => getJSON(url));
  const r = (body.results || [])[0];
  if (!r) throw Object.assign(new Error('Ativo não encontrado'), { status: 404 });
  const precos = (r.historicalDataPrice || [])
    .filter((p) => p.close != null)
    .map((p) => ({ data: new Date(p.date * 1000).toISOString().slice(0, 10), fechamento: p.close }))
    .sort((a, b) => a.data.localeCompare(b.data));
  const proventos = ((r.dividendsData && r.dividendsData.cashDividends) || [])
    .map((d) => ({ dataCom: (d.lastDatePrior || d.paymentDate || '').slice(0, 10), valor: d.rate, tipo: d.label }))
    .filter((d) => d.dataCom && d.valor);
  return { ticker: r.symbol, nome: r.longName || r.shortName || r.symbol, logo: r.logourl || null, precos, proventos };
}

// IPCA mensal do Banco Central (série SGS 433)
async function ipca(anos) {
  const fim = new Date();
  const ini = new Date(fim.getFullYear() - (anos || 10), fim.getMonth() - 1, 1);
  const fmt = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  const url = `https://api.bcb.gov.br/dados/serie/bcdata.sgs.433/dados?formato=json&dataInicial=${fmt(ini)}&dataFinal=${fmt(fim)}`;
  const rows = await cached(`ipca:${anos}`, async () => {
    const r = await fetch(url);
    if (!r.ok) throw new Error('IPCA indisponível no Banco Central');
    return r.json();
  });
  return rows.map((x) => { const [d, m, y] = x.data.split('/'); return { mes: `${y}-${m}`, valor: Number(x.valor) }; });
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': type.startsWith('application/json') ? 'no-store' : 'public, max-age=300' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/saude') return send(res, 200, { ok: true, token: Boolean(TOKEN) });
    if (u.pathname === '/api/buscar') {
      const q = (u.searchParams.get('q') || '').trim();
      if (q.length < 2) return send(res, 200, []);
      if (!TOKEN) return send(res, 200, await M.buscarYahoo(q));
      return send(res, 200, await buscar(q).catch(() => M.buscarYahoo(q)));
    }
    if (u.pathname === '/api/serie') {
      const t = (u.searchParams.get('ticker') || '').trim().toUpperCase();
      if (!/^[A-Z0-9^.]{2,12}$/.test(t)) return send(res, 400, { erro: 'Código inválido' });
      const anos = Number(u.searchParams.get('anos')) || 5;
      if (!TOKEN) return send(res, 200, await M.serieYahoo(t, anos));
      return send(res, 200, await serie(t, anos).catch(() => M.serieYahoo(t, anos)));
    }
    if (u.pathname === '/api/mercado') return send(res, 200, await M.mercado(TOKEN));
    // Chamado pelo agendamento do GitHub; sem PIN, mas no máximo uma verificação a cada 5 min.
    if (u.pathname === '/api/alertas/verificar') return send(res, 200, await A.verificar(false));
    if (u.pathname.startsWith('/api/alertas')) {
      if (PIN && req.headers['x-pin'] !== PIN) return send(res, 401, { erro: 'PIN incorreto', pin: true });
      let body = {};
      if (req.method === 'POST' || req.method === 'PUT') {
        let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 10000) return send(res, 413, { erro: 'Muito grande' }); }
        try { body = JSON.parse(raw || '{}'); } catch (e) { return send(res, 400, { erro: 'JSON inválido' }); }
      }
      return send(res, 200, await A.rota(req, u, body));
    }
    if (u.pathname.startsWith('/api/caixinhas')) {
      if (PIN && req.headers['x-pin'] !== PIN) return send(res, 401, { erro: 'PIN incorreto', pin: true });
      let body = {};
      if (req.method === 'POST' || req.method === 'PUT') {
        let raw = '';
        for await (const chunk of req) { raw += chunk; if (raw.length > 100000) return send(res, 413, { erro: 'Muito grande' }); }
        try { body = JSON.parse(raw || '{}'); } catch (e) { return send(res, 400, { erro: 'JSON inválido' }); }
      }
      return send(res, 200, await C.rota(req, u, body));
    }
    if (u.pathname === '/api/cotacoes') return send(res, 200, await M.cotacoes((u.searchParams.get('t') || '').split(',')));
    if (u.pathname === '/api/ficha') return send(res, 200, await M.ficha(u.searchParams.get('t') || '', TOKEN));
    if (u.pathname === '/api/proventos') return send(res, 200, await M.proventos((u.searchParams.get('t') || '').split(',')));
    if (u.pathname === '/api/cotas' && req.method === 'PUT') {
      if (PIN && req.headers['x-pin'] !== PIN) return send(res, 401, { erro: 'PIN incorreto', pin: true });
      let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 2000) return send(res, 413, { erro: 'Muito grande' }); }
      let b; try { b = JSON.parse(raw || '{}'); } catch (e) { return send(res, 400, { erro: 'JSON inválido' }); }
      const tk = M.limparTickers(String(b.ticker || ''))[0], qtd = Math.floor(Number(b.qtd) || 0);
      if (!tk || qtd < 0 || qtd > 1e7) return send(res, 400, { erro: 'Dados inválidos' });
      return send(res, 200, await C.salvarCotas(tk, qtd));
    }
    if (u.pathname === '/api/favoritos') {
      if (PIN && req.headers['x-pin'] !== PIN) return send(res, 401, { erro: 'PIN incorreto', pin: true });
      if (req.method === 'PUT') {
        let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 5000) return send(res, 413, { erro: 'Muito grande' }); }
        let b; try { b = JSON.parse(raw || '{}'); } catch (e) { return send(res, 400, { erro: 'JSON inválido' }); }
        return send(res, 200, await C.salvarFavoritos(M.limparTickers((b.tickers || []).join(','))));
      }
      return send(res, 200, await C.favoritos());
    }
    if (u.pathname === '/api/periodo') {
      const de = u.searchParams.get('de') || '', ate = u.searchParams.get('ate') || '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(de) || !/^\d{4}-\d{2}-\d{2}$/.test(ate)) return send(res, 400, { erro: 'Datas inválidas' });
      return send(res, 200, await M.periodo(de, ate, (u.searchParams.get('t') || '').split(',')));
    }
    if (u.pathname === '/api/focus') return send(res, 200, await M.focus());
    if (u.pathname === '/api/cdi') return send(res, 200, await M.cdi(Number(u.searchParams.get('anos')) || 10));
    if (u.pathname === '/api/ipca') return send(res, 200, await ipca(Number(u.searchParams.get('anos')) || 10));
    if (u.pathname === '/' || u.pathname === '/index.html') {
      return send(res, 200, fs.readFileSync(path.join(__dirname, 'public', 'index.html')), 'text/html; charset=utf-8');
    }
    const STATIC = { '/manifest.json': 'application/manifest+json', '/sw.js': 'text/javascript; charset=utf-8', '/icon-192.png': 'image/png', '/icon-512.png': 'image/png' };
    if (STATIC[u.pathname]) return send(res, 200, fs.readFileSync(path.join(__dirname, 'public', u.pathname.slice(1))), STATIC[u.pathname]);
    return send(res, 404, { erro: 'Não encontrado' });
  } catch (e) {
    const status = e.status || 502;
    let msg = e.message;
    if (status === 401 || status === 403) msg = 'A chave da brapi não permite esse dado. O histórico de anos e os dividendos exigem um plano pago da brapi.dev. (' + e.message + ')';
    return send(res, status, { erro: msg });
  }
});

server.listen(PORT, () => console.log(`Investimentos rodando na porta ${PORT} (token brapi: ${TOKEN ? 'sim' : 'não'})`));
