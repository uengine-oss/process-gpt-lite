---
name: live-data-sources
description: Free public JSON endpoints a panel can read through panel.fetch for live outside values (stock and index prices, weather, exchange rates), with a worked example. Read it when the panel shows such a live value.
---

# Live data for a panel

Read these through `panel.fetch(url)` (the server proxy: public HTTPS JSON only). Handle loading and errors quietly.

## Stocks and indices — Yahoo Finance chart

`https://query1.finance.yahoo.com/v8/finance/chart/{SYMBOL}?range=7d&interval=1h`

- Symbols: KOSPI `^KS11`, KOSDAQ `^KQ11`, a KRX stock by its code with `.KS` (Samsung Electronics `005930.KS`), a US stock by its ticker (Tesla `TSLA`).
- The answer: `chart.result[0]` — `timestamp[]` and `indicators.quote[0].close[]` (some entries are null: drop them).

## Weather — Open-Meteo

`https://api.open-meteo.com/v1/forecast?latitude=..&longitude=..&current=temperature_2m,weather_code`

## Exchange rates — ExchangeRate-API (open access)

`https://open.er-api.com/v6/latest/USD`

## Example: a stock tracker

The names in `list` are UI text: write them in the panel's language.

html:

```html
<div class="p-nav"><button id="prev">‹</button><span id="ttl"></span><button id="next">›</button></div>
<div class="p-big" id="price">…</div><div class="p-sub" id="chg"></div><div id="chart" style="margin-top:12px"></div>
```

script:

```js
const list=[{s:'^KS11',n:'KOSPI'},{s:'TSLA',n:'Tesla'}];let i=panel.data.i||0;
async function show(){const it=list[i];$('#ttl').textContent=it.n;const j=await panel.fetch('https://query1.finance.yahoo.com/v8/finance/chart/'+encodeURIComponent(it.s)+'?range=7d&interval=1h');
const r=j.chart.result[0],c=r.indicators.quote[0].close,v=c.filter(x=>x!=null);$('#price').textContent=ui.money(v.at(-1));
const d=v.at(-1)-v[0];$('#chg').textContent=(d>=0?'+':'')+d.toFixed(2)+' in the last 7 days';$('#chart').innerHTML=ui.spark(v,{labels:ui.days(r.timestamp)})}
$('#prev').onclick=()=>{i=(i+list.length-1)%list.length;panel.save({i});show()};$('#next').onclick=()=>{i=(i+1)%list.length;panel.save({i});show()};show()
```
