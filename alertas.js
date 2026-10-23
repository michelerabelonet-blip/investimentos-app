// Alertas de preço com notificação no celular (Web Push).
// Um agendamento externo (GitHub Actions) chama /api/alertas/verificar a cada 30 min nos dias úteis;
// o app também verifica sempre que alguém abre a aba Mercado.
const C = require('./caixinhas');
const M = require('./mercado');
let webpush = null;
const VAPID_PUBLIC = process.env.VAPID_PUBLIC || '', VAPID_PRIVATE = process.env.VAPID_PRIVATE || '';
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush = require('web-push');
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'https://investimentos-app-zt7g.onrender.com', VAPID_PUBLIC, VAPID_PRIVATE);
}

const INDICES = { ibov: 'Ibovespa', dolar: 'Dólar', euro: 'Euro', sp500: 'S&P 500', nasdaq: 'Nasdaq', dow: 'Dow Jones', btc: 'Bitcoin', brent: 'Petróleo Brent' };
const CONDS = { acima: 'passar de', abaixo: 'ficar abaixo de', alta: 'subir no dia', queda: 'cair no dia' };
const erro = (m, status = 400) => Object.assign(new Error(m), { status });
const id = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const num = (v) => { const n = typeof v === 'string' ? Number(v.replace(',', '.')) : v; return typeof n === 'number' && isFinite(n) ? n : NaN; };

function limpar(b) {
  const alvo = String(b.alvo || '').trim();
  const ehIndice = Object.prototype.hasOwnProperty.call(INDICES, alvo);
  if (!ehIndice && !/^[A-Z0-9]{4,7}$/.test(alvo)) throw erro('Escolha o ativo do alerta.');
  if (!CONDS[b.cond]) throw erro('Escolha a condição.');
  const valor = num(b.valor);
  if (!(valor > 0)) throw erro('Informe um valor maior que zero.');
  return { id: id(), alvo, nome: ehIndice ? INDICES[alvo] : alvo, cond: b.cond, valor, ativo: true, criado: new Date().toISOString(), disparado: null };
}

const nf = (d) => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
function texto(a, q) {
  const v = a.alvo === 'ibov' || ['sp500', 'nasdaq', 'dow'].includes(a.alvo) ? nf(0).format(q.valor) + ' pts'
    : a.alvo === 'btc' ? 'US$ ' + nf(0).format(q.valor) : a.alvo === 'brent' ? 'US$ ' + nf(2).format(q.valor)
    : 'R$ ' + nf(a.alvo === 'dolar' || a.alvo === 'euro' ? 3 : 2).format(q.valor);
  const d = (q.variacao >= 0 ? '+' : '−') + nf(2).format(Math.abs(q.variacao)) + '%';
  if (a.cond === 'acima') return `${a.nome} passou de ${nf(2).format(a.valor)}: agora ${v} (${d} no dia).`;
  if (a.cond === 'abaixo') return `${a.nome} ficou abaixo de ${nf(2).format(a.valor)}: agora ${v} (${d} no dia).`;
  if (a.cond === 'alta') return `${a.nome} sobe ${d} hoje (alerta de alta de ${nf(1).format(a.valor)}%). Agora ${v}.`;
  return `${a.nome} cai ${d} hoje (alerta de queda de ${nf(1).format(a.valor)}%). Agora ${v}.`;
}
function bateu(a, q) {
  if (!q || q.erro || q.valor == null) return false;
  if (a.cond === 'acima') return q.valor >= a.valor;
  if (a.cond === 'abaixo') return q.valor <= a.valor;
  if (a.cond === 'alta') return q.variacao >= a.valor;
  return q.variacao <= -a.valor;
}

async function enviar(s, titulo, corpo) {
  if (!webpush || !(s.subs || []).length) return 0;
  let ok = 0; const mortas = [];
  await Promise.all(s.subs.map(async (sub) => {
    try { await webpush.sendNotification(sub, JSON.stringify({ titulo, corpo }), { TTL: 6 * 3600 }); ok++; }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) mortas.push(sub.endpoint); }
  }));
  if (mortas.length) await C.mudar((st) => { st.subs = (st.subs || []).filter((x) => !mortas.includes(x.endpoint)); });
  return ok;
}

let ultimaVerificacao = 0;
async function verificar(forcar) {
  if (!forcar && Date.now() - ultimaVerificacao < 5 * 60 * 1000) return { pulado: true };
  ultimaVerificacao = Date.now();
  const s = await C.get();
  const ativos = (s.alertas || []).filter((a) => a.ativo);
  if (!ativos.length) return { verificados: 0, disparados: [] };
  const mapa = new Map();
  if (ativos.some((a) => INDICES[a.alvo])) (await M.mercado(process.env.BRAPI_TOKEN || '')).ativos.forEach((q) => mapa.set(q.id, q));
  const tks = ativos.filter((a) => !INDICES[a.alvo]).map((a) => a.alvo);
  if (tks.length) (await M.cotacoes(tks)).forEach((q) => mapa.set(q.ticker, q));
  const disparados = [];
  for (const a of ativos) {
    const q = mapa.get(a.alvo);
    if (!bateu(a, q)) continue;
    // variação do dia só dispara uma vez por dia
    disparados.push({ id: a.id, msg: texto(a, q) });
  }
  if (disparados.length) {
    const quando = new Date().toISOString();
    await C.mudar((st) => { (st.alertas || []).forEach((a) => { const d = disparados.find((x) => x.id === a.id); if (d) { a.ativo = false; a.disparado = quando; a.mensagem = d.msg; } }); });
    for (const d of disparados) await enviar(await C.get(), 'Alerta: Investimentos', d.msg);
  }
  return { verificados: ativos.length, disparados };
}

async function listar() {
  const s = await C.get();
  return { alertas: s.alertas || [], push: Boolean(webpush), vapidPublic: VAPID_PUBLIC, aparelhos: (s.subs || []).length };
}

async function rota(req, u, body) {
  const partes = u.pathname.split('/').filter(Boolean); // api alertas [id|verificar|teste]
  const aid = partes[2];
  if (req.method === 'GET' && !aid) { await verificar(false).catch(() => {}); return listar(); }
  if (req.method === 'POST' && !aid) { const a = limpar(body); await C.mudar((s) => { s.alertas = s.alertas || []; if (s.alertas.length >= 30) throw erro('Limite de 30 alertas.'); s.alertas.push(a); }); return listar(); }
  if (req.method === 'POST' && aid === 'inscrever') {
    const sub = body && body.endpoint && body.keys ? { endpoint: String(body.endpoint).slice(0, 600), keys: { p256dh: String(body.keys.p256dh || '').slice(0, 200), auth: String(body.keys.auth || '').slice(0, 100) } } : null;
    if (!sub || !/^https:\/\//.test(sub.endpoint)) throw erro('Inscrição inválida.');
    await C.mudar((s) => { s.subs = (s.subs || []).filter((x) => x.endpoint !== sub.endpoint); s.subs.push(sub); if (s.subs.length > 10) s.subs = s.subs.slice(-10); });
    return listar();
  }
  if (req.method === 'POST' && aid === 'teste') { const n = await enviar(await C.get(), 'Investimentos', 'Notificações ativadas neste aparelho.'); return { ...(await listar()), enviados: n }; }
  if (req.method === 'PUT' && aid) { await C.mudar((s) => { const a = (s.alertas || []).find((x) => x.id === aid); if (!a) throw erro('Alerta não encontrado', 404); a.ativo = true; a.disparado = null; a.mensagem = null; }); return listar(); }
  if (req.method === 'DELETE' && aid) { await C.mudar((s) => { s.alertas = (s.alertas || []).filter((x) => x.id !== aid); }); return listar(); }
  throw erro('Não encontrado', 404);
}

module.exports = { rota, verificar };
