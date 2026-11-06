// Relatório diário do grupo de WhatsApp "D2 Estudos de Finanças e Investimentos".
// O WhatsApp não tem API oficial para ler grupos de uma conta pessoal, então o app lê a
// exportação da conversa ("Exportar conversa" → "Sem mídia"), em .txt (Android) ou .zip (iPhone).
// Para cada dia monta um relatório sem IA: assuntos, ativos citados, perguntas, destaques, links e participação.
const zlib = require('zlib');
const C = require('./caixinhas');

const GRUPO = process.env.GRUPO_NOME || 'D2 Estudos de Finanças e Investimentos';
const DIAS_GUARDADOS = 60;
const MAX_BYTES = 25 * 1024 * 1024;
const erro = (m, status = 400) => Object.assign(new Error(m), { status });
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const corta = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

// ---------- arquivo: .txt ou .zip ----------
function lerZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw erro('Arquivo .zip inválido.');
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entradas = [];
  for (let n = 0; n < total && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const metodo = buf.readUInt16LE(p + 10), tam = buf.readUInt32LE(p + 20);
    const ln = buf.readUInt16LE(p + 28), le = buf.readUInt16LE(p + 30), lc = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    entradas.push({ nome: buf.slice(p + 46, p + 46 + ln).toString('utf8'), metodo, tam, off });
    p += 46 + ln + le + lc;
  }
  const txt = entradas.filter((e) => /\.txt$/i.test(e.nome));
  const e = txt.find((x) => /_chat\.txt$|whatsapp|conversa/i.test(x.nome)) || txt[0];
  if (!e) throw erro('O .zip não tem a conversa (.txt). Exporte de novo escolhendo "Sem mídia".');
  const ini = e.off + 30 + buf.readUInt16LE(e.off + 26) + buf.readUInt16LE(e.off + 28);
  const dados = buf.slice(ini, ini + e.tam);
  if (e.metodo === 0) return dados.toString('utf8');
  if (e.metodo === 8) return zlib.inflateRawSync(dados).toString('utf8');
  throw erro('Compactação do .zip não suportada.');
}

// "Conversa do WhatsApp com X.txt", "WhatsApp Chat with X.txt", "WhatsApp Chat - X.zip"
function nomeDoArquivo(arq) {
  const m = String(arq || '').replace(/\.(txt|zip)$/i, '').match(/(?:conversa do whatsapp com|whatsapp chat with|whatsapp chat -|whatsapp chat com)\s*(.+)$/i);
  return m ? m[1].trim() : '';
}

// ---------- leitura das mensagens ----------
// Android: "05/11/2026 14:32 - Fulano: texto"   iPhone: "[05/11/2026, 14:32:10] Fulano: texto"
const CAB = /^‎?\[?(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::\d{2})?(?:\s*([ap])\.?\s?m\.?)?\]?\s*(?:[-–]\s)?(.*)$/i;

function mensagens(texto) {
  const linhas = texto.replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/[  ]/g, ' ').split('\n');
  const brutas = [];
  for (const l of linhas) {
    const m = l.match(CAB);
    if (m) brutas.push({ a: +m[1], b: +m[2], y: +m[3], h: +m[4], mi: +m[5], ap: (m[6] || '').toLowerCase(), resto: m[7] });
    else if (brutas.length) brutas[brutas.length - 1].resto += '\n' + l;
  }
  // dia/mês (Brasil) ou mês/dia (conta em inglês dos EUA)
  const mdy = !brutas.some((x) => x.a > 12) && brutas.some((x) => x.b > 12);
  return brutas.map((x) => {
    const dia = mdy ? x.b : x.a, mes = mdy ? x.a : x.b, ano = x.y < 100 ? 2000 + x.y : x.y;
    let h = x.h; if (x.ap === 'p' && h < 12) h += 12; if (x.ap === 'a' && h === 12) h = 0;
    const i = x.resto.indexOf(': ');
    let autor = '', txt = x.resto;
    if (i > 0 && i < 80 && !x.resto.slice(0, i).includes('\n')) { autor = x.resto.slice(0, i).replace(/[‎‏]/g, '').trim(); txt = x.resto.slice(i + 2); }
    const marcado = /^‎/.test(txt); // iPhone marca mídia e avisos do sistema com este caractere
    txt = txt.replace(/[‎‏]/g, '').replace(/\s*<(mensagem editada|this message was edited)>\s*$/i, '').trim();
    return { data: `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`, hora: h, hm: `${String(h).padStart(2, '0')}:${String(x.mi).padStart(2, '0')}`, autor, texto: txt, marcado };
  }).filter((m) => m.data.length === 10 && !m.data.includes('-00'));
}

function tipoMidia(t) {
  const n = norm(t);
  if (/^<?(midia oculta|arquivo de midia oculto|media omitted)>?$/.test(n)) return 'outros';
  if (/^(imagem ocultada|imagem omitida|image omitted)$/.test(n)) return 'imagens';
  if (/^(audio ocultado|audio omitido|audio omitted)$/.test(n)) return 'áudios';
  if (/^(video omitido|video ocultado|video omitted)$/.test(n)) return 'vídeos';
  if (/^(figurinha omitida|sticker omitted)$/.test(n)) return 'figurinhas';
  if (/^(gif omitido|gif omitted)$/.test(n)) return 'gifs';
  if (/^(documento omitido|document omitted)$/.test(n) || /^.{0,120}• ?\d+ paginas? documento omitido$/.test(n)) return 'documentos';
  const anexo = n.match(/^<(?:anexado|attached): (.+)>$/) || n.match(/^(.+\.\w{2,4}) \((?:arquivo anexado|file attached)\)/);
  if (anexo) {
    const f = anexo[1];
    if (/photo|img-|\.(jpe?g|png|heic)$/.test(f)) return 'imagens';
    if (/audio|ptt-|\.(opus|m4a|mp3|ogg)$/.test(f)) return 'áudios';
    if (/video|vid-|\.(mp4|mov)$/.test(f)) return 'vídeos';
    if (/sticker|stk-|\.webp$/.test(f)) return 'figurinhas';
    return 'documentos';
  }
  return null;
}
const APAGADA = /^(mensagem apagada|esta mensagem foi apagada|voce apagou esta mensagem|this message was deleted|you deleted this message|null)$/;

// ---------- vocabulário ----------
const TEMAS = {
  'Renda fixa': ['renda fixa', 'cdb', 'cdbs', 'lci', 'lca', 'lcis', 'lcas', 'tesouro', 'tesouro direto', 'selic', 'prefixado', 'pre-fixado', 'ipca+', 'ipca +', 'debenture', 'debentures', 'cri', 'cra', 'poupanca', 'cdi', 'porquinho', 'caixinha', 'caixinhas', 'lft', 'ntn-b'],
  'Fundos imobiliários': ['fii', 'fiis', 'fundo imobiliario', 'fundos imobiliarios', 'ifix', 'vacancia', 'fundo de tijolo', 'fundo de papel', 'fiagro'],
  'Ações e bolsa': ['acao', 'acoes', 'bolsa', 'ibovespa', 'ibov', 'b3', 'small caps', 'small cap', 'balanco', 'balancos', 'resultado do trimestre', 'p/l', 'p/vp', 'valuation', 'home broker', 'day trade'],
  'Dividendos e proventos': ['dividendo', 'dividendos', 'provento', 'proventos', 'jcp', 'juros sobre capital', 'dy', 'dividend yield', 'data com', 'data-com', 'rendimento mensal', 'renda passiva'],
  'Exterior e dólar': ['dolar', 'exterior', 'stocks', 'etf', 'etfs', 'reit', 'reits', 'bdr', 'bdrs', 's&p', 'sp500', 's&p 500', 'nasdaq', 'avenue', 'nomad', 'eua', 'cambio', 'euro'],
  'Cripto': ['bitcoin', 'btc', 'cripto', 'criptomoeda', 'criptomoedas', 'ethereum', 'blockchain', 'binance', 'stablecoin', 'usdt'],
  'Economia e juros': ['inflacao', 'juros', 'copom', 'fed', 'pib', 'fiscal', 'boletim focus', 'banco central', 'recessao', 'desemprego', 'taxa de juros', 'arcabouco', 'ipca', 'igp-m', 'eleicao', 'eleicoes', 'governo'],
  'Impostos e IR': ['imposto', 'impostos', 'imposto de renda', 'darf', 'isencao', 'isento', 'isenta', 'declaracao', 'receita federal', 'come-cotas', 'come cotas', 'tributacao', 'aliquota', 'iof'],
  'Previdência e aposentadoria': ['previdencia', 'pgbl', 'vgbl', 'aposentadoria', 'aposentar', 'inss', 'fgts'],
  'Planejamento e reserva': ['reserva de emergencia', 'reserva', 'orcamento', 'planejamento', 'planejamento financeiro', 'metas', 'gastos', 'dividas', 'divida', 'economizar', 'independencia financeira', 'liberdade financeira', 'aporte', 'aportes', 'aportar', 'carteira', 'diversificar', 'diversificacao', 'rebalancear'],
  'Cursos e materiais': ['curso', 'aula', 'aulas', 'live', 'livro', 'livros', 'ebook', 'planilha', 'material', 'podcast', 'webinar', 'mentoria', 'encontro', 'reuniao'],
};
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const RX_TEMAS = Object.entries(TEMAS).map(([nome, kws]) => ({ nome, rx: new RegExp('(?:^|[^a-z0-9])(?:' + kws.map(esc).join('|') + ')(?=$|[^a-z0-9])') }));
const RX_TICKER = /(?:^|[^A-Za-z0-9])([A-Za-z]{4}(?:3|4|5|6|11|31|32|33|34|35|39))(?![A-Za-z0-9])/g;
const RX_LINK = /https?:\/\/[^\s<>"]+/gi;
const PARADAS = new Set(('a o e é de da do das dos em no na nos nas um uma uns umas para pra pro por pelo pela pelos pelas com sem que se mas mais menos muito muita muitos muitas como quando onde qual quais quem porque pois isso isto esse essa esses essas este esta estes estas aquele aquela aqueles aquelas aqui ali la lá ja já nao não sim ou eu tu ele ela nos nós vos eles elas voce você voces vocês meu minha meus minhas seu sua seus suas nosso nossa dele dela deles delas me te lhe lhes ser estar ter haver foi era sao são esta está estao estão tem têm tinha temos vai vou vamos fazer faz feito pode posso podem acho achei sobre entre ate até depois antes ainda tambem também so só bem bom boa dia dias hoje ontem amanha amanhã agora entao então tudo todo toda todos todas nada algo algum alguma alguns algumas outro outra outros outras mesmo mesma vez vezes cada tipo coisa coisas gente pessoal galera obrigado obrigada obg valeu blz beleza sera será seria pode pois tá ta tô to né ne aí ai ok okay sim nao kkk kkkk rs rsrs haha hahaha opa olá ola oi tarde noite noites manha manhã bom-dia boa-tarde boa-noite link http https www com br mensagem apagada ocultada omitida oculta mídia midia anexado arquivo'.split(' ')).map(norm));
const RISO = /^(k+|(ha)+h?|(he)+h?|(rs)+|a+h+|u+a+)$/;

// ---------- relatório de um dia ----------
function relatorio(data, lista) {
  const r = { data, total: 0, pessoas: 0, apagadas: 0, midias: {}, horas: Array(24).fill(0), de: null, ate: null, participantes: [], temas: [], tickers: [], palavras: [], perguntas: [], destaques: [], links: [], enquetes: [], eventos: [] };
  const porAutor = new Map(), temas = new Map(), tickers = new Map(), palavras = new Map(), links = new Map();
  const texto = [];
  for (const m of lista) {
    if (!m.autor) { if (r.eventos.length < 15) r.eventos.push({ hora: m.hm, texto: corta(m.texto, 160) }); continue; }
    const midia = tipoMidia(m.texto);
    const sistema = m.marcado && !midia;
    if (sistema) { if (r.eventos.length < 15) r.eventos.push({ hora: m.hm, texto: corta(m.texto, 160) }); continue; }
    r.total++; r.horas[m.hora]++;
    if (!r.de) r.de = m.hm; r.ate = m.hm;
    porAutor.set(m.autor, (porAutor.get(m.autor) || 0) + 1);
    if (APAGADA.test(norm(m.texto))) { r.apagadas++; continue; }
    if (midia) { r.midias[midia] = (r.midias[midia] || 0) + 1; continue; }
    if (/^enquete:/i.test(m.texto) || /^poll:/i.test(m.texto)) {
      const [, perg, ...ops] = m.texto.split('\n');
      r.enquetes.push({ autor: m.autor, hora: m.hm, pergunta: corta((perg || '').trim(), 200), opcoes: ops.map((o) => o.replace(/^(opcao|opção|option):\s*/i, '').trim()).filter(Boolean).slice(0, 8).map((o) => corta(o, 100)) });
      continue;
    }
    const semLink = m.texto.replace(RX_LINK, ' ').replace(/[ \t]{2,}/g, ' ').trim();
    const item = { autor: m.autor, hora: m.hm, texto: m.texto, limpo: semLink, n: norm(semLink) };
    texto.push(item);
    for (const u of m.texto.match(RX_LINK) || []) {
      const url = u.replace(/[).,;!?]+$/, '');
      if (links.has(url)) continue;
      let dominio = ''; try { dominio = new URL(url).hostname.replace(/^www\./, ''); } catch (e) { continue; }
      links.set(url, { url: corta(url, 300), dominio, autor: m.autor, hora: m.hm, contexto: corta(semLink, 160) });
    }
    for (const t of RX_TEMAS) if (t.rx.test(item.n)) { const x = temas.get(t.nome) || { nome: t.nome, n: 0, itens: [] }; x.n++; x.itens.push(item); temas.set(t.nome, x); }
    const vistos = new Set();
    for (const mt of semLink.matchAll(RX_TICKER)) {
      const tk = mt[1].toUpperCase();
      if (vistos.has(tk)) continue; vistos.add(tk);
      const x = tickers.get(tk) || { ticker: tk, n: 0, autores: new Set(), exemplo: null };
      x.n++; x.autores.add(m.autor); if (!x.exemplo && semLink.length >= 25) x.exemplo = { autor: m.autor, hora: m.hm, texto: corta(semLink, 220) };
      tickers.set(tk, x);
    }
    const ws = new Set(item.n.split(/[^a-z0-9+&/-]+/).filter((w) => w.length >= 4 && !PARADAS.has(w) && !RISO.test(w) && !/^\d+$/.test(w) && !/^[a-z]{4}\d{1,2}$/.test(w)));
    for (const w of ws) palavras.set(w, (palavras.get(w) || 0) + 1);
    if (semLink.includes('?') && semLink.length >= 20) r.perguntas.push({ autor: m.autor, hora: m.hm, texto: corta(semLink, 280) });
  }
  // quem respondeu cada pergunta: mensagens de outras pessoas nos 30 minutos seguintes
  const minutos = (hm) => +hm.slice(0, 2) * 60 + +hm.slice(3);
  r.perguntas = r.perguntas.map((p) => {
    const t0 = minutos(p.hora);
    const resp = new Set(texto.filter((x) => x.autor !== p.autor && minutos(x.hora) >= t0 && minutos(x.hora) <= t0 + 30 && x.limpo.length >= 15).map((x) => x.autor));
    return { ...p, respostas: resp.size };
  }).slice(0, 15);

  r.pessoas = porAutor.size;
  r.participantes = [...porAutor].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([nome, n]) => ({ nome, n }));
  const exemplos = (itens, k) => itens.filter((x) => x.limpo.length >= 40).sort((a, b) => b.limpo.length - a.limpo.length).slice(0, k)
    .sort((a, b) => a.hora.localeCompare(b.hora)).map((x) => ({ autor: x.autor, hora: x.hora, texto: corta(x.limpo, 280) }));
  r.temas = [...temas.values()].sort((a, b) => b.n - a.n).map((t) => ({ nome: t.nome, n: t.n, exemplos: exemplos(t.itens, 3) }));
  r.tickers = [...tickers.values()].sort((a, b) => b.n - a.n || b.autores.size - a.autores.size).slice(0, 20).map((t) => ({ ticker: t.ticker, n: t.n, pessoas: t.autores.size, exemplo: t.exemplo }));
  r.palavras = [...palavras].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([p, n]) => ({ p, n }));
  r.destaques = exemplos(texto.filter((x) => x.limpo.length >= 150), 6).map((x) => ({ ...x, texto: corta(texto.find((y) => y.hora === x.hora && y.autor === x.autor).limpo, 600) }));
  r.links = [...links.values()].slice(0, 25);
  r.resumo = frase(r);
  return r;
}

function frase(r) {
  const nf = (n) => n.toLocaleString('pt-BR');
  if (!r.total) return 'Nenhuma mensagem neste dia.';
  const pico = r.horas.indexOf(Math.max(...r.horas));
  const partes = [`${nf(r.total)} ${r.total === 1 ? 'mensagem' : 'mensagens'} de ${r.pessoas} ${r.pessoas === 1 ? 'pessoa' : 'pessoas'}, com mais movimento por volta das ${pico}h.`];
  const ts = r.temas.slice(0, 3).map((t) => t.nome.toLowerCase());
  if (ts.length) partes.push(`${ts.length === 1 ? 'O assunto principal foi' : 'Os assuntos principais foram'} ${ts.length > 1 ? ts.slice(0, -1).join(', ') + ' e ' + ts[ts.length - 1] : ts[0]}.`);
  const tk = r.tickers.slice(0, 4).map((t) => `${t.ticker} (${t.n})`);
  if (tk.length) partes.push(`${tk.length === 1 ? 'Ativo citado' : 'Ativos mais citados'}: ${tk.join(', ')}.`);
  const extra = [];
  if (r.perguntas.length) extra.push(`${r.perguntas.length} ${r.perguntas.length === 1 ? 'pergunta' : 'perguntas'}`);
  if (r.links.length) extra.push(`${r.links.length} ${r.links.length === 1 ? 'link compartilhado' : 'links compartilhados'}`);
  if (r.enquetes.length) extra.push(`${r.enquetes.length} ${r.enquetes.length === 1 ? 'enquete' : 'enquetes'}`);
  const md = Object.values(r.midias).reduce((s, n) => s + n, 0);
  if (md) extra.push(`${md} ${md === 1 ? 'mídia' : 'mídias'} (fotos, áudios, arquivos)`);
  if (extra.length) partes.push(`Teve ${extra.length > 1 ? extra.slice(0, -1).join(', ') + ' e ' + extra[extra.length - 1] : extra[0]}.`);
  return partes.join(' ');
}

// ---------- importação ----------
function analisar(buf, arquivo) {
  const zip = buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
  const texto = zip ? lerZip(buf) : buf.toString('utf8');
  const msgs = mensagens(texto);
  if (!msgs.length) throw erro('Não encontrei mensagens nesse arquivo. Ele precisa ser a conversa exportada pelo WhatsApp (.txt ou .zip).');
  const nome = nomeDoArquivo(arquivo);
  const chave = norm(GRUPO).split(/\s+/).slice(0, 2).join(' ');
  if (nome && chave && !norm(nome).includes(chave)) throw erro(`Esse arquivo é da conversa "${nome}", não do grupo ${GRUPO}.`);
  const porDia = new Map();
  for (const m of msgs) { if (!porDia.has(m.data)) porDia.set(m.data, []); porDia.get(m.data).push(m); }
  const datas = [...porDia.keys()].sort();
  const recentes = datas.slice(-DIAS_GUARDADOS);
  return { nome: nome || GRUPO, datas: recentes, relatorios: recentes.map((d) => relatorio(d, porDia.get(d))), mensagens: msgs.length, primeiro: datas[0], ultimo: datas[datas.length - 1] };
}

async function importar(buf, arquivo) {
  const a = analisar(buf, arquivo);
  const ultima = a.relatorios[a.relatorios.length - 1];
  await C.mudar((s) => {
    const g = s.grupo || { dias: {} };
    a.relatorios.forEach((r) => { g.dias[r.data] = r; });
    const manter = Object.keys(g.dias).sort().slice(-DIAS_GUARDADOS);
    g.dias = Object.fromEntries(manter.map((d) => [d, g.dias[d]]));
    g.nome = a.nome; g.atualizado = new Date().toISOString(); g.ultimaMensagem = `${ultima.data} ${ultima.ate}`;
    s.grupo = g;
  });
  return { ...(await listar()), ok: true, mensagens: a.mensagens, diasLidos: a.datas.length, primeiro: a.primeiro, ultimo: a.ultimo };
}

async function listar() {
  const s = await C.get();
  const g = s.grupo || { dias: {} };
  const dias = Object.values(g.dias).sort((a, b) => b.data.localeCompare(a.data)).map((r) => ({ data: r.data, total: r.total, ate: r.ate }));
  return { grupo: g.nome || GRUPO, atualizado: g.atualizado || null, ultimaMensagem: g.ultimaMensagem || null, persistente: C.persistente, dias };
}

async function rota(req, u) {
  const sub = u.pathname.replace(/^\/api\/grupo\/?/, '');
  if (req.method === 'GET' && !sub) return listar();
  if (req.method === 'GET' && sub === 'dia') {
    const d = u.searchParams.get('d') || '';
    const g = (await C.get()).grupo;
    const r = g && g.dias[d];
    if (!r) throw erro('Dia não encontrado. Importe a conversa de novo.', 404);
    return r;
  }
  if (req.method === 'POST' && sub === 'importar') {
    const partes = []; let tam = 0;
    for await (const ch of req) { tam += ch.length; if (tam > MAX_BYTES) throw erro('Arquivo muito grande (máx. 25 MB). Exporte "Sem mídia".', 413); partes.push(ch); }
    if (!tam) throw erro('Nenhum arquivo enviado.');
    let arquivo = ''; try { arquivo = decodeURIComponent(req.headers['x-arquivo'] || ''); } catch (e) {}
    return importar(Buffer.concat(partes), arquivo);
  }
  if (req.method === 'DELETE' && !sub) { await C.mudar((s) => { delete s.grupo; }); return listar(); }
  throw erro('Não encontrado', 404);
}

module.exports = { rota, analisar, mensagens, relatorio };
