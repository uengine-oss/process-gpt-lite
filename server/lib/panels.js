// Panel = a small vibe-coded app on Home. The model writes HTML + a script against a
// tiny runtime that the client injects into a sandboxed iframe:
//   panel.data           persisted JSON state      panel.save(obj)
//   panel.fetch(url)     GET a public JSON API through the server proxy
//   panel.ask(prompt)    one-shot LLM answer (string)
//   panel.open(url)      open link in a new tab    panel.chat(text)  send text to the chat
//   ui.spark(values,{labels})  -> SVG line chart;  ui.money(n), ui.ago(date)
// CSS classes available: .p-row .p-cell .p-k .p-v .p-big .p-sub .p-list .p-item .p-btn .p-muted .p-nav
import { chatJson } from './llm.js'
import { q } from './supa.js'
import { emit } from './bus.js'
import { isEn } from './lang.js'

const SYSTEM = `You build small Home "panels" (mini-apps) for a personal work assistant UI.
Return JSON: {"title": "짧은 한국어 제목", "icon": "single emoji", "html": "...", "script": "...", "data": {...}}
Rules:
- html is a body fragment only. Use the provided CSS classes; no <style>, no external CSS/JS.
  .p-row (flex row gap 8) .p-cell (rounded tile) .p-k (small label) .p-v (value 28px) .p-big (36px number)
  .p-sub (secondary text) .p-list/.p-item (list rows) .p-btn (full-width pill button) .p-muted .p-nav (prev/title/next header)
- script is plain JS run after html loads. Available globals: $(selector) -> element, panel {data, save(obj), fetch(url)->Promise<json>, ask(prompt)->Promise<string>, open(url), chat(text)}, ui {spark(values,{labels}), days(timestamps), money(n), ago(date)}.
- For live data use free public JSON APIs via panel.fetch, e.g.
  stocks/indices: https://query1.finance.yahoo.com/v8/finance/chart/{SYMBOL}?range=7d&interval=1h  (KOSPI ^KS11, KOSDAQ ^KQ11, Samsung 005930.KS, Tesla TSLA)
  weather: https://api.open-meteo.com/v1/forecast?latitude=..&longitude=..&current=temperature_2m,weather_code
  fx: https://open.er-api.com/v6/latest/USD
- Personal data the user types (to-dos, logs, goals) lives in panel.data and is saved with panel.save.
- Korean UI text. Keep it compact: the panel is 356px wide. Handle loading/error states quietly.
- Chart x labels must be short (weekday like Mon/Tue): use ui.days(timestamps) for labels, at most 7.
- Never request passwords or payment info.
Example (stock tracker) html:
<div class="p-nav"><button id="prev">‹</button><span id="ttl"></span><button id="next">›</button></div>
<div class="p-big" id="price">…</div><div class="p-sub" id="chg"></div><div id="chart" style="margin-top:12px"></div>
script:
const list=[{s:'^KS11',n:'코스피'},{s:'TSLA',n:'테슬라'}];let i=panel.data.i||0;
async function show(){const it=list[i];$('#ttl').textContent=it.n;const j=await panel.fetch('https://query1.finance.yahoo.com/v8/finance/chart/'+encodeURIComponent(it.s)+'?range=7d&interval=1h');
const r=j.chart.result[0],c=r.indicators.quote[0].close,v=c.filter(x=>x!=null);$('#price').textContent=ui.money(v.at(-1));
const d=v.at(-1)-v[0];$('#chg').textContent=(d>=0?'+':'')+d.toFixed(2)+' in the last 7 days';$('#chart').innerHTML=ui.spark(v,{labels:ui.days(r.timestamp)})}
$('#prev').onclick=()=>{i=(i+list.length-1)%list.length;panel.save({i});show()};$('#next').onclick=()=>{i=(i+1)%list.length;panel.save({i});show()};show()`

// English mode (lib/lang.js): the same prompt asking for an English title and English UI text
const system = () => (isEn()
  ? SYSTEM.replace('"title": "짧은 한국어 제목"', '"title": "short English title"').replace('- Korean UI text.', '- English UI text (labels, buttons, messages, dates in en-US).')
    .replace("const list=[{s:'^KS11',n:'코스피'},{s:'TSLA',n:'테슬라'}]", "const list=[{s:'^KS11',n:'KOSPI'},{s:'TSLA',n:'Tesla'}]")
  : SYSTEM)

export async function generatePanel({ userId, description }) {
  const spec = await chatJson(system(), description)
  const [p] = await q(
    `insert into pro_panels(user_id,title,icon,spec,data) values ($1,$2,$3,$4,$5) returning *`,
    [userId, spec.title, spec.icon, { html: spec.html, script: spec.script, description }, spec.data || {}])
  emit(userId, 'panel', p)
  return p
}

export async function revisePanel({ userId, id, instruction }) {
  const [p] = await q('select * from pro_panels where id=$1 and user_id=$2', [id, userId])
  if (!p) throw new Error('panel not found')
  const spec = await chatJson(system(), `Current panel JSON:\n${JSON.stringify({ title: p.title, icon: p.icon, html: p.spec.html, script: p.spec.script, data: p.data })}\n\nChange request: ${instruction}`)
  const [n] = await q(`update pro_panels set title=$3, icon=$4, spec=$5, updated_at=now() where id=$1 and user_id=$2 returning *`,
    [id, userId, spec.title, spec.icon, { ...p.spec, html: spec.html, script: spec.script }])
  emit(userId, 'panel', n)
  return n
}

export async function savePanelData(userId, id, data) {
  const [p] = await q('update pro_panels set data=$3, updated_at=now() where id=$1 and user_id=$2 returning id', [id, userId, data])
  return p
}

// Server-side GET proxy for panel scripts (public JSON only, no cookies, small bodies).
export async function proxyFetch(url) {
  const u = new URL(url)
  if (!/^https:$/.test(u.protocol)) throw new Error('https only')
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(u.hostname)) throw new Error('private address')
  const res = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 pgpt-pro-panel' }, redirect: 'follow' })
  const text = await res.text()
  if (text.length > 2_000_000) throw new Error('too large')
  try { return JSON.parse(text) } catch { return { text: text.slice(0, 20000) } }
}
