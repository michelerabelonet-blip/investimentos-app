// Análise de ações: indicadores por ticker (Yahoo Finance, mesma fonte da ficha) e a lista de setores/tickers do usuário.
// A lista é guardada junto com as caixinhas (Postgres, ou data.json sem banco).
const M = require('./mercado');
const C = require('./caixinhas');

const cache = new Map();
const TTL = 3 * 3600e3;
const TICKER = /^[A-Z0-9]{4,6}$/;
const CAMPOS = ['dy', 'cagr', 'pl', 'pvppl', 'margem', 'roe', 'divEbitda', 'infl'];

const pc = (v) => (v == null ? null : v * 100);

async function yahoo(tk) {
  const mods = 'price,summaryDetail,defaultKeyStatistics,financialData,incomeStatementHistory';
  let s = await M.yahooSessao(false);
  const url = () => `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(tk + '.SA')}?modules=${mods}&crumb=${encodeURIComponent(s.crumb)}`;
  let r = await fetch(url(), { headers: { ...M.UA, Cookie: s.cookie } });
  if (r.status === 401 || r.status === 403) { s = await M.yahooSessao(true); r = await fetch(url(), { headers: { ...M.UA, Cookie: s.cookie } }); }
  if (!r.ok) throw new Error(r.status === 404 ? 'Ativo não encontrado' : 'Indicadores indisponíveis agora');
  const x = (((await r.json()).quoteSummary || {}).result || [])[0];
  if (!x) throw new Error('Ativo não encontrado');
  const raw = M.raw;
  const p = x.price || {}, sd = x.summaryDetail || {}, ks = x.defaultKeyStatistics || {}, fd = x.financialData || {};

  // Dívida líquida / EBITDA = (dívida total − caixa) / EBITDA
  const divida = raw(fd.totalDebt), caixa = raw(fd.totalCash), ebitda = raw(fd.ebitda);
  const divEbitda = divida != null && caixa != null && ebitda > 0 ? (divida - caixa) / ebitda : null;

  // Crescimento anual composto do lucro líquido nos anos que o Yahoo traz (em geral 3 a 4 anos)
  const hist = (((x.incomeStatementHistory || {}).incomeStatementHistory) || [])
    .map((i) => ({ t: raw(i.endDate), v: raw(i.netIncome) })).filter((i) => i.t != null && i.v != null).sort((a, b) => a.t - b.t);
  let cagr = null, cagrAnos = null;
  if (hist.length >= 2 && hist[0].v > 0 && hist[hist.length - 1].v > 0) {
    cagrAnos = hist.length - 1;
    cagr = (Math.pow(hist[hist.length - 1].v / hist[0].v, 1 / cagrAnos) - 1) * 100;
  }

  return {
    ticker: tk,
    nome: p.longName || p.shortName || tk,
    preco: raw(p.regularMarketPrice),
    dy: pc(raw(sd.dividendYield) ?? raw(sd.trailingAnnualDividendYield)),
    cagr, cagrAnos,
    pl: raw(sd.trailingPE) ?? raw(ks.trailingPE),
    pvp: raw(ks.priceToBook),
    margem: pc(raw(fd.profitMargins)),
    roe: pc(raw(fd.returnOnEquity)),
    divEbitda,
    valorizacao12m: pc(raw(ks['52WeekChange'])),
    fonte: 'Yahoo Finance',
    atualizado: new Date().toISOString(),
  };
}

async function dados(lista) {
  const tickers = [...new Set(lista.map((t) => String(t).toUpperCase().trim()))].filter((t) => TICKER.test(t)).slice(0, 30);
  const resultados = {}, erros = {};
  await Promise.all(tickers.map(async (t) => {
    const hit = cache.get(t);
    if (hit && Date.now() - hit.at < TTL) { resultados[t] = hit.data; return; }
    try { const d = await yahoo(t); cache.set(t, { at: Date.now(), data: d }); resultados[t] = d; }
    catch (e) { if (hit) resultados[t] = hit.data; else erros[t] = e.message; }
  }));
  return { resultados, erros };
}

// ---------- lista de setores e ajustes manuais ----------
const erro = (m) => Object.assign(new Error(m), { status: 400 });
function limpar(b) {
  if (!b || !Array.isArray(b.setores) || b.setores.length > 12) throw erro('Lista de setores inválida.');
  const setores = b.setores.map((s) => {
    const nome = typeof s.nome === 'string' ? s.nome.trim().slice(0, 60) : '';
    if (!nome) throw erro('Dê um nome para o setor.');
    const tickers = [...new Set((Array.isArray(s.tickers) ? s.tickers : []).map((t) => String(t).toUpperCase().trim()))];
    if (tickers.length > 12 || tickers.some((t) => !TICKER.test(t))) throw erro('Tickers inválidos (máximo de 12 por setor).');
    return { id: String(s.id || Date.now()).slice(0, 20), nome, financeiro: Boolean(s.financeiro), tickers };
  });
  const manual = {};
  for (const [t, campos] of Object.entries(b.manual || {})) {
    if (!TICKER.test(t) || !campos || typeof campos !== 'object') continue;
    for (const k of CAMPOS) {
      const n = typeof campos[k] === 'string' ? Number(campos[k].replace(',', '.')) : campos[k];
      if (typeof n === 'number' && isFinite(n)) (manual[t] = manual[t] || {})[k] = n;
    }
  }
  const ip = b.ipca == null || b.ipca === '' ? null : typeof b.ipca === 'string' ? Number(b.ipca.replace(',', '.')) : b.ipca;
  return { setores, manual, ipca: typeof ip === 'number' && isFinite(ip) ? ip : '' };
}

async function rota(req, u, body) {
  if (u.pathname === '/api/analise/dados') return dados((u.searchParams.get('t') || '').split(','));
  if (req.method === 'PUT') { const cfg = limpar(body); await C.mudar((s) => { s.analise = cfg; }); return { ok: true }; }
  const s = await C.get();
  return { persistente: C.persistente, config: s.analise || null };
}

module.exports = { rota, dados, limpar };
