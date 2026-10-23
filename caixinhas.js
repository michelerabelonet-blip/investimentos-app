// Minhas caixinhas: CDBs com liquidez diária (ex.: Porquinho do Inter) rendendo um % do CDI.
// Guarda os lançamentos no Postgres (DATABASE_URL) ou, sem banco, em data.json (apagado a cada nova publicação no Render).
// Calcula saldo, rendimento e IR estimado com o CDI diário do Banco Central (série SGS 12).
const fs = require('fs');
const path = require('path');

const DATA_KEY = process.env.DATA_KEY || 'investimentos';
const FILE = path.join(process.env.DATA_DIR || __dirname, 'data.json');
let pool = null;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false } });
}
const persistente = Boolean(pool);

const SEMENTE = () => ({
  caixinhas: [
    { id: 'inss', nome: 'INSS', taxa: 100, meta: null, dataUso: null, aporteMensal: null, movimentos: [] },
    { id: 'fgts', nome: 'FGTS', taxa: 100, meta: null, dataUso: null, aporteMensal: null, movimentos: [] },
    { id: '13', nome: '13º salário', taxa: 100, meta: null, dataUso: null, aporteMensal: null, movimentos: [] },
    { id: 'ferias', nome: 'Férias', taxa: 100, meta: null, dataUso: null, aporteMensal: null, movimentos: [] },
  ],
});

async function load() {
  if (pool) {
    await pool.query('CREATE TABLE IF NOT EXISTS investimentos_app (id text PRIMARY KEY, dados jsonb NOT NULL)');
    const r = await pool.query('SELECT dados FROM investimentos_app WHERE id = $1', [DATA_KEY]);
    return r.rows[0] ? r.rows[0].dados : SEMENTE();
  }
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return SEMENTE(); }
}
async function save(s) {
  if (pool) {
    await pool.query('INSERT INTO investimentos_app (id, dados) VALUES ($2, $1) ON CONFLICT (id) DO UPDATE SET dados = EXCLUDED.dados', [JSON.stringify(s), DATA_KEY]);
    return;
  }
  fs.writeFileSync(FILE, JSON.stringify(s));
}
let estado = null, fila = Promise.resolve();
async function get() { if (!estado) estado = await load(); if (!estado.caixinhas) estado.caixinhas = []; return estado; }
function mudar(fn) {
  const p = fila.then(async () => { const s = await get(); const r = fn(s); await save(s); return r; });
  fila = p.catch(() => {});
  return p;
}

// ---------- validação ----------
const DIA = /^\d{4}-\d{2}-\d{2}$/;
const YM = /^\d{4}-(0[1-9]|1[0-2])$/;
const num = (v) => { const n = typeof v === 'string' ? Number(v.replace(',', '.')) : v; return typeof n === 'number' && isFinite(n) ? Math.round(n * 100) / 100 : NaN; };
const id = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const erro = (m) => Object.assign(new Error(m), { status: 400 });

function limparCaixinha(b, atual) {
  const nome = typeof b.nome === 'string' ? b.nome.trim().slice(0, 60) : '';
  if (!nome) throw erro('Dê um nome para a caixinha.');
  const taxa = b.taxa == null || b.taxa === '' ? 100 : num(b.taxa);
  if (!(taxa > 0 && taxa <= 200)) throw erro('Taxa deve ser um % do CDI entre 1 e 200.');
  const meta = b.meta == null || b.meta === '' ? null : num(b.meta);
  if (meta != null && !(meta > 0)) throw erro('Meta inválida.');
  const aporteMensal = b.aporteMensal == null || b.aporteMensal === '' ? null : num(b.aporteMensal);
  if (aporteMensal != null && !(aporteMensal >= 0)) throw erro('Aporte mensal inválido.');
  const dataUso = b.dataUso ? String(b.dataUso).slice(0, 7) : null;
  if (dataUso && !YM.test(dataUso)) throw erro('Data de uso inválida.');
  let vinculo = null;
  if (b.vinculo && typeof b.vinculo.key === 'string' && typeof b.vinculo.item === 'string') {
    vinculo = { key: b.vinculo.key.slice(0, 60), item: b.vinculo.item.slice(0, 60), desde: YM.test(b.vinculo.desde || '') ? b.vinculo.desde : null };
  }
  return { id: atual ? atual.id : id(), nome, taxa, meta, dataUso, aporteMensal, vinculo, movimentos: atual ? atual.movimentos : [] };
}
function limparMov(b) {
  const valor = num(b.valor);
  if (!(valor > 0)) throw erro('Informe um valor maior que zero.');
  if (!['aporte', 'resgate'].includes(b.tipo)) throw erro('Tipo inválido.');
  if (!DIA.test(b.data || '') || b.data > new Date().toISOString().slice(0, 10)) throw erro('Data inválida.');
  return { id: id(), tipo: b.tipo, valor, data: b.data, obs: typeof b.obs === 'string' ? b.obs.trim().slice(0, 80) : '' };
}

// ---------- CDI diário ----------
let cdiCache = { at: 0, de: null, mapa: null, ultimo: null };
async function cdiDiario(de) {
  if (cdiCache.mapa && cdiCache.de <= de && Date.now() - cdiCache.at < 6 * 3600e3) return cdiCache;
  const [y, m, d] = de.split('-');
  const hoje = new Date();
  const url = `https://api.bcb.gov.br/dados/serie/bcdata.sgs.12/dados?formato=json&dataInicial=${d}/${m}/${y}&dataFinal=${String(hoje.getDate()).padStart(2, '0')}/${String(hoje.getMonth() + 1).padStart(2, '0')}/${hoje.getFullYear()}`;
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) { if (cdiCache.mapa) return cdiCache; throw Object.assign(new Error('CDI indisponível no Banco Central agora.'), { status: 502 }); }
  const rows = await r.json();
  const mapa = new Map();
  rows.forEach((x) => { const [dd, mm, yy] = x.data.split('/'); mapa.set(`${yy}-${mm}-${dd}`, Number(x.valor)); });
  const dias = [...mapa.keys()].sort();
  cdiCache = { at: Date.now(), de, mapa, dias, ultimo: dias.length ? { data: dias[dias.length - 1], taxa: mapa.get(dias[dias.length - 1]) } : null };
  return cdiCache;
}

// Fator acumulado entre duas datas (exclusive início, inclusive fim), a `taxa`% do CDI.
function fator(cdi, de, ate, taxa) {
  let f = 1;
  for (const d of cdi.dias) { if (d > de && d <= ate) f *= 1 + (cdi.mapa.get(d) / 100) * (taxa / 100); }
  return f;
}
const aliquotaIR = (dias) => (dias <= 180 ? 22.5 : dias <= 360 ? 20 : dias <= 720 ? 17.5 : 15);
const diasEntre = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const fimMesAnterior = (hoje) => { const d = new Date(hoje + 'T12:00:00Z'); d.setUTCDate(0); return d.toISOString().slice(0, 10); };

function calcular(c, cdi, hoje) {
  // Resgates saem dos aportes mais antigos primeiro (como nos CDBs de liquidez diária).
  const movs = [...c.movimentos].sort((a, b) => a.data.localeCompare(b.data));
  const lotes = [];
  for (const m of movs) {
    if (m.tipo === 'aporte') { lotes.push({ data: m.data, principal: m.valor, cotas: m.valor / fator(cdi, '0000-00-00', m.data, c.taxa) }); continue; }
    let falta = m.valor / fator(cdi, '0000-00-00', m.data, c.taxa); // em "cotas"
    for (const l of lotes) {
      if (falta <= 0) break;
      const tira = Math.min(l.cotas, falta);
      l.principal *= (l.cotas - tira) / l.cotas || 0;
      l.cotas -= tira; falta -= tira;
    }
  }
  const fHoje = fator(cdi, '0000-00-00', hoje, c.taxa), fMes = fator(cdi, '0000-00-00', fimMesAnterior(hoje), c.taxa);
  let saldo = 0, principal = 0, ir = 0;
  for (const l of lotes) {
    if (l.cotas <= 1e-9) continue;
    const v = l.cotas * fHoje, rend = Math.max(0, v - l.principal);
    saldo += v; principal += l.principal; ir += rend * aliquotaIR(diasEntre(l.data, hoje)) / 100;
  }
  // Rendeu no mês: saldo hoje − (saldo no fim do mês anterior + aportes − resgates do mês)
  const iniMes = hoje.slice(0, 8) + '01';
  const saldoMesAnt = lotesAte(movs, fimMesAnterior(hoje), cdi, c.taxa) * fMes;
  const fluxoMes = movs.filter((m) => m.data >= iniMes).reduce((s, m) => s + (m.tipo === 'aporte' ? m.valor : -m.valor), 0);
  const rendeuMes = saldo - saldoMesAnt - fluxoMes;
  return { saldo: r2(saldo), investido: r2(principal), rendimento: r2(saldo - principal), irEstimado: r2(ir), liquido: r2(saldo - ir), rendeuMes: r2(rendeuMes) };
}
// Cotas existentes numa data (para o saldo do fim do mês anterior)
function lotesAte(movs, ate, cdi, taxa) {
  let cotas = 0;
  for (const m of movs) { if (m.data > ate) break; const q = m.valor / fator(cdi, '0000-00-00', m.data, taxa); cotas += m.tipo === 'aporte' ? q : -q; }
  return Math.max(0, cotas);
}
const r2 = (v) => Math.round(v * 100) / 100;

// Projeção mês a mês até a data de uso, com o CDI de hoje e o aporte mensal planejado.
function projetar(c, saldo, cdi) {
  if (!c.dataUso || !cdi.ultimo) return null;
  const hoje = new Date();
  const [y, m] = c.dataUso.split('-').map(Number);
  const meses = (y - hoje.getFullYear()) * 12 + (m - (hoje.getMonth() + 1));
  if (meses < 0) return { meses, valor: saldo };
  const anual = Math.pow(1 + cdi.ultimo.taxa / 100, 252) - 1;
  const mensal = Math.pow(1 + anual * c.taxa / 100, 1 / 12) - 1;
  let v = saldo;
  for (let i = 0; i < meses; i++) v = v * (1 + mensal) + (c.aporteMensal || 0);
  return { meses, valor: r2(v), cdiAnual: r2(anual * 100) };
}

// ---------- Farol Financeiro (mesmo banco) ----------
// Cada mês em que o investimento vinculado foi marcado como pago no Farol vira um aporte automático (dia 5 do mês).
const FAROL_KEYS = (process.env.FAROL_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean);
async function farolLinhas() {
  if (!pool) return [];
  try {
    const r = FAROL_KEYS.length
      ? await pool.query('SELECT id, dados FROM farol_financeiro WHERE id = ANY($1)', [FAROL_KEYS])
      : await pool.query('SELECT id, dados FROM farol_financeiro');
    return r.rows;
  } catch (e) { return []; } // tabela do Farol ainda não existe
}
async function farolOpcoes() {
  const rows = await farolLinhas();
  return rows.map((r) => ({
    key: r.id,
    itens: ((r.dados && r.dados.itens) || []).filter((i) => i.tipo === 'investimento').map((i) => ({ id: i.id, desc: i.desc, valor: i.valor, inicio: i.inicio, fim: i.fim || null })),
  })).filter((x) => x.itens.length);
}
function aportesFarol(dados, v, hoje) {
  const it = ((dados && dados.itens) || []).find((i) => i.id === v.item);
  if (!it) return { movs: [], desc: null };
  const movs = [];
  for (const [mes, pagos] of Object.entries((dados && dados.pagos) || {})) {
    if (!pagos || pagos[it.id] !== true) continue;
    if (v.desde && mes < v.desde) continue;
    let data = mes + '-05'; if (data > hoje) data = hoje;
    movs.push({ id: 'farol-' + mes, tipo: 'aporte', valor: it.valor, data, obs: 'Farol: ' + it.desc, auto: true });
  }
  return { movs, desc: it.desc };
}

async function listar() {
  const s = await get();
  const hoje = new Date().toISOString().slice(0, 10);
  // junta os aportes automáticos do Farol aos lançamentos manuais
  const vinc = s.caixinhas.filter((c) => c.vinculo);
  const farol = vinc.length ? new Map((await farolLinhas()).map((r) => [r.id, r.dados])) : new Map();
  const comFarol = s.caixinhas.map((c) => {
    if (!c.vinculo) return c;
    const { movs, desc } = aportesFarol(farol.get(c.vinculo.key), c.vinculo, hoje);
    return { ...c, vinculo: { ...c.vinculo, desc, encontrado: Boolean(desc) }, movimentos: [...c.movimentos, ...movs] };
  });
  const datas = comFarol.flatMap((c) => c.movimentos.map((m) => m.data));
  const de = datas.length ? datas.sort()[0] : hoje;
  let cdi = { dias: [], mapa: new Map(), ultimo: null }, aviso = null;
  try { cdi = await cdiDiario(de < hoje ? de : hoje.slice(0, 8) + '01'); } catch (e) { aviso = e.message; }
  const caixinhas = comFarol.map((c) => {
    const calc = calcular(c, cdi, hoje);
    return { ...c, movimentos: [...c.movimentos].sort((a, b) => b.data.localeCompare(a.data)), ...calc, projecao: projetar(c, calc.saldo, cdi) };
  });
  const tot = (k) => r2(caixinhas.reduce((x, c) => x + c[k], 0));
  return {
    persistente, aviso, hoje,
    cdi: cdi.ultimo ? { data: cdi.ultimo.data, diario: cdi.ultimo.taxa, anual: r2((Math.pow(1 + cdi.ultimo.taxa / 100, 252) - 1) * 100) } : null,
    total: { saldo: tot('saldo'), investido: tot('investido'), rendimento: tot('rendimento'), irEstimado: tot('irEstimado'), liquido: tot('liquido'), rendeuMes: tot('rendeuMes') },
    caixinhas,
  };
}

// ---------- rotas ----------
async function rota(req, u, body) {
  const partes = u.pathname.split('/').filter(Boolean); // api caixinhas [id] [mov] [movId]
  const [, , cid, sub, mid] = partes;
  if (req.method === 'GET' && !cid) return listar();
  if (req.method === 'GET' && cid === 'farol') return { persistente, opcoes: await farolOpcoes() };
  if (req.method === 'POST' && !cid) { await mudar((s) => { s.caixinhas.push(limparCaixinha(body)); }); return listar(); }
  const achar = (s) => { const c = s.caixinhas.find((x) => x.id === cid); if (!c) throw Object.assign(new Error('Caixinha não encontrada'), { status: 404 }); return c; };
  if (req.method === 'PUT' && cid && !sub) { await mudar((s) => { const c = achar(s); Object.assign(c, limparCaixinha(body, c)); }); return listar(); }
  if (req.method === 'DELETE' && cid && !sub) { await mudar((s) => { achar(s); s.caixinhas = s.caixinhas.filter((x) => x.id !== cid); }); return listar(); }
  if (req.method === 'POST' && sub === 'mov') { await mudar((s) => { achar(s).movimentos.push(limparMov(body)); }); return listar(); }
  if (req.method === 'DELETE' && sub === 'mov' && mid) { await mudar((s) => { const c = achar(s); c.movimentos = c.movimentos.filter((m) => m.id !== mid); }); return listar(); }
  throw Object.assign(new Error('Não encontrado'), { status: 404 });
}

// Favoritos (ações/FIIs acompanhados na aba Mercado), no mesmo registro das caixinhas.
async function favoritos() { const s = await get(); return { persistente, tickers: s.favoritos || [] }; }
async function salvarFavoritos(lista) { await mudar((s) => { s.favoritos = lista; }); return favoritos(); }

module.exports = { rota, persistente, favoritos, salvarFavoritos };
