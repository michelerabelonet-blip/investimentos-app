// Painel de mercado: cotações do dia, Focus do Banco Central e séries sem chave (Yahoo Finance como alternativa à brapi).
// Fontes: Yahoo Finance (cotações, uso não oficial), Banco Central (Focus, CDI, PTAX) e CoinGecko não é necessário: o Yahoo cobre o bitcoin.

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; investimentos-app/1.0)', Accept: 'application/json' };
const cache = new Map();
async function cached(key, ms, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.data;
  try {
    const data = await fn();
    cache.set(key, { at: Date.now(), data });
    return data;
  } catch (e) {
    if (hit) return hit.data; // falhou agora: devolve o último valor bom
    throw e;
  }
}
async function json(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw Object.assign(new Error(`Fonte indisponível (${r.status})`), { status: 502 });
  return r.json();
}

// ---------- Yahoo Finance ----------
async function yahooChart(symbol, range, interval, events) {
  const janela = typeof range === 'object' ? `period1=${range.p1}&period2=${range.p2}` : `range=${range}`;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${janela}&interval=${interval}${events ? '&events=div' : ''}`;
  const body = await json(url);
  const r = body.chart && body.chart.result && body.chart.result[0];
  if (!r) throw Object.assign(new Error('Ativo não encontrado'), { status: 404 });
  const ts = r.timestamp || [];
  const close = (r.indicators.quote[0] || {}).close || [];
  const pts = ts.map((t, i) => ({ t: t * 1000, v: close[i] })).filter((p) => p.v != null);
  return { meta: r.meta || {}, pts, divs: (r.events && r.events.dividends) ? Object.values(r.events.dividends) : [] };
}

const ATIVOS = [
  { id: 'ibov', grupo: 'Brasil', nome: 'Ibovespa', sym: '^BVSP', fmt: 'pts' },
  { id: 'dolar', grupo: 'Brasil', nome: 'Dólar comercial', sym: 'USDBRL=X', fmt: 'brl' },
  { id: 'euro', grupo: 'Brasil', nome: 'Euro', sym: 'EURBRL=X', fmt: 'brl' },
  { id: 'sp500', grupo: 'Bolsa americana', nome: 'S&P 500', sym: '^GSPC', fmt: 'pts' },
  { id: 'nasdaq', grupo: 'Bolsa americana', nome: 'Nasdaq', sym: '^IXIC', fmt: 'pts' },
  { id: 'dow', grupo: 'Bolsa americana', nome: 'Dow Jones', sym: '^DJI', fmt: 'pts' },
  { id: 'btc', grupo: 'Cripto e petróleo', nome: 'Bitcoin', sym: 'BTC-USD', fmt: 'usd' },
  { id: 'brent', grupo: 'Cripto e petróleo', nome: 'Petróleo Brent (barril)', sym: 'BZ=F', fmt: 'usd2' },
];

async function cotacao(a) {
  const { meta, pts } = await yahooChart(a.sym, '1mo', '1d');
  if (pts.length < 2) throw new Error('sem dados');
  const last = pts[pts.length - 1];
  const prev = pts[pts.length - 2];
  return {
    ...a, sym: undefined,
    nomeLongo: meta.longName || meta.shortName || null,
    valor: meta.regularMarketPrice ?? last.v,
    variacao: ((last.v / prev.v) - 1) * 100,
    data: new Date((meta.regularMarketTime ? meta.regularMarketTime * 1000 : last.t)).toISOString(),
    serie: pts.map((p) => ({ d: new Date(p.t).toISOString().slice(0, 10), v: p.v })),
  };
}

// IFIX: o Yahoo não tem; usa a brapi se houver chave.
async function ifix(token) {
  if (!token) return null;
  const r = await fetch('https://brapi.dev/api/quote/IFIX?range=1mo&interval=1d', { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const b = await r.json();
  const q = (b.results || [])[0];
  if (!q) return null;
  const pts = (q.historicalDataPrice || []).filter((p) => p.close != null).sort((a, b) => a.date - b.date);
  return {
    id: 'ifix', grupo: 'Brasil', nome: 'IFIX (fundos imobiliários)', fmt: 'pts',
    valor: q.regularMarketPrice, variacao: q.regularMarketChangePercent,
    data: q.regularMarketTime || new Date().toISOString(),
    serie: pts.map((p) => ({ d: new Date(p.date * 1000).toISOString().slice(0, 10), v: p.close })),
  };
}

async function mercado(token) {
  return cached('mercado', 15 * 60 * 1000, async () => {
    const res = await Promise.all(ATIVOS.map((a) => cotacao(a).catch(() => ({ ...a, sym: undefined, erro: true }))));
    const fx = await ifix(token).catch(() => null);
    if (fx) res.splice(3, 0, fx);
    return { atualizado: new Date().toISOString(), ativos: res };
  });
}

// ---------- Boletim Focus (Banco Central, API Olinda) ----------
const FOCUS = [
  { id: 'ipca', nome: 'IPCA (inflação)', ind: 'IPCA', fmt: 'pct' },
  { id: 'selic', nome: 'Selic (fim do ano)', ind: 'Selic', fmt: 'pct' },
  { id: 'cambio', nome: 'Dólar (fim do ano)', ind: 'Câmbio', fmt: 'brl' },
  { id: 'pib', nome: 'PIB (crescimento)', ind: 'PIB Total', fmt: 'pct' },
];
async function focus() {
  return cached('focus', 6 * 60 * 60 * 1000, async () => {
    const ano = new Date().getFullYear();
    const anos = [String(ano), String(ano + 1)];
    const ini = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    const linhas = await Promise.all(FOCUS.map(async (f) => {
      const filtro = `Indicador eq '${f.ind}' and baseCalculo eq 0 and Data ge '${ini}'`;
      const url = 'https://olinda.bcb.gov.br/olinda/servico/Expectativas/versao/v1/odata/ExpectativasMercadoAnuais'
        + `?$filter=${encodeURIComponent(filtro)}&$orderby=Data%20desc&$top=200&$format=json&$select=Indicador,Data,DataReferencia,Mediana`;
      const rows = (await json(url)).value || [];
      // Boletins são semanais (segundas). Pega a data mais recente e a de 7 dias antes.
      const datas = [...new Set(rows.map((r) => r.Data))].sort().reverse();
      const ultima = datas[0];
      const alvoAnt = ultima ? new Date(new Date(ultima).getTime() - 7 * 864e5).toISOString().slice(0, 10) : null;
      const anterior = datas.find((d) => d <= alvoAnt) || datas[1];
      const val = (d, a) => { const r = rows.find((x) => x.Data === d && String(x.DataReferencia) === a); return r ? r.Mediana : null; };
      return { ...f, ind: undefined, data: ultima, valores: anos.map((a) => ({ ano: a, atual: val(ultima, a), anterior: val(anterior, a) })) };
    }));
    return { anos, data: linhas.map((l) => l.data).filter(Boolean).sort().pop() || null, linhas };
  });
}

// ---------- CDI mensal (SGS 4391) ----------
async function cdi(anos) {
  return cached('cdi:' + anos, 6 * 60 * 60 * 1000, async () => {
    const fim = new Date();
    const ini = new Date(fim.getFullYear() - (anos || 10), fim.getMonth() - 1, 1);
    const fmt = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
    const rows = await json(`https://api.bcb.gov.br/dados/serie/bcdata.sgs.4391/dados?formato=json&dataInicial=${fmt(ini)}&dataFinal=${fmt(fim)}`);
    return rows.map((x) => { const [, m, y] = x.data.split('/'); return { mes: `${y}-${m}`, valor: Number(x.valor) }; });
  });
}

// ---------- Busca e séries sem chave da brapi (Yahoo) ----------
async function buscarYahoo(q) {
  return cached('yb:' + q.toLowerCase(), 6 * 60 * 60 * 1000, async () => {
    const b = await json(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=12&newsCount=0&lang=pt-BR&region=BR`);
    return (b.quotes || [])
      .filter((x) => /\.SA$/.test(x.symbol || ''))
      .map((x) => ({ ticker: x.symbol.replace(/\.SA$/, ''), nome: x.longname || x.shortname || '', tipo: x.quoteType, setor: x.sector || null, preco: null, logo: null }));
  });
}

const RANGE = { 2: '2y', 5: '5y', 10: '10y' };
async function serieYahoo(ticker, anos) {
  const range = RANGE[anos] || '5y';
  return cached(`ys:${ticker}:${range}`, 6 * 60 * 60 * 1000, async () => {
    const sym = ticker.startsWith('^') ? ticker : ticker + '.SA';
    const { meta, pts, divs } = await yahooChart(sym, range, '1mo', true);
    const precos = pts.map((p) => ({ data: new Date(p.t).toISOString().slice(0, 10), fechamento: p.v })).sort((a, b) => a.data.localeCompare(b.data));
    const proventos = divs.map((d) => ({ dataCom: new Date(d.date * 1000).toISOString().slice(0, 10), valor: d.amount, tipo: 'Provento' }));
    return { ticker, nome: meta.longName || meta.shortName || ticker, logo: null, precos, proventos };
  });
}

// Série de cada ativo do painel entre duas datas (AAAA-MM-DD), para o filtro de período.
// Favoritos: cotação do dia de ações/FIIs da B3 escolhidos pelo usuário.
const TK = /^[A-Z0-9]{4,7}$/;
const limparTickers = (s) => [...new Set(String(s || '').toUpperCase().split(',').map((x) => x.trim()).filter((x) => TK.test(x)))].slice(0, 20);
async function cotacoes(lista) {
  const out = await Promise.all(limparTickers(lista.join(',')).map((tk) => cached('cot:' + tk, 15 * 60 * 1000, async () => {
    const c = await cotacao({ id: tk, grupo: 'Meus favoritos', nome: tk, sym: tk + '.SA', fmt: 'brl2' });
    return { ...c, ticker: tk };
  }).catch(() => ({ id: tk, ticker: tk, grupo: 'Meus favoritos', nome: tk, fmt: 'brl2', erro: true }))));
  return out;
}

async function periodo(de, ate, extras) {
  const ini = Date.parse(de + 'T00:00:00Z'), fim = Date.parse(ate + 'T23:59:59Z');
  if (!(ini < fim)) throw Object.assign(new Error('Período inválido'), { status: 400 });
  const dias = (fim - ini) / 864e5;
  const interval = dias <= 95 ? '1d' : dias <= 800 ? '1wk' : '1mo';
  const lista = [...ATIVOS, ...limparTickers((extras || []).join(',')).map((tk) => ({ id: tk, sym: tk + '.SA' }))];
  return cached(`per:${de}:${ate}:${lista.map((a) => a.id).join(',')}`, 30 * 60 * 1000, async () => {
    const out = {};
    await Promise.all(lista.map(async (a) => {
      try {
        const { pts } = await yahooChart(a.sym, { p1: Math.floor(ini / 1000), p2: Math.floor(fim / 1000) }, interval);
        if (pts.length > 1) out[a.id] = pts.map((p) => ({ d: new Date(p.t).toISOString().slice(0, 10), v: p.v }));
      } catch (e) { /* sem dados para esse ativo */ }
    }));
    return { de, ate, interval, series: out };
  });
}

module.exports = { mercado, focus, cdi, buscarYahoo, serieYahoo, periodo, cotacoes, limparTickers };
