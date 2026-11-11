// A Home panel as an MCP App (contract v2): the panel's own html and script — written by a model, or a ready-made
// AI-DLC dashboard — arrive as the entry tool's result and run here, in the sandboxed frame. What a panel may
// do is the old panel.* set, now tools of the panels server (and ui/open-link, ui/message of the standard).
import lite from '../../_runtime/lite.js'

await lite.ready
const p = lite.initial || {}
window.$ = (s) => document.querySelector(s)
window.panel = {
  data: p.data || {},
  save(o) { this.data = o; return lite.tool('panel_save', { id: p.id, data: o }) },
  fetch: (url) => lite.tool('panel_fetch', { url }),
  ask: (prompt) => lite.tool('panel_ask', { prompt }),
  open: (url) => lite.openLink(url),
  chat: (text) => lite.say(text),
  aidlc: (path) => lite.tool('panel_aidlc', { path }),
}
window.ui={
 days:ts=>ts.map(t=>new Date(typeof t==='number'&&t<1e12?t*1000:t).toLocaleDateString('en-US',{weekday:'short'})).filter((d,i,a)=>i===0||d!==a[i-1]),
 money:(n,c='')=>(c==='KRW'||c==='₩'?'₩':c==='USD'||c==='$'?'$':'')+Number(n).toLocaleString(undefined,{maximumFractionDigits:2}),
 ago:d=>{const s=(Date.now()-new Date(d))/1000;return s<60?'방금':s<3600?Math.floor(s/60)+'분 전':s<86400?Math.floor(s/3600)+'시간 전':Math.floor(s/86400)+'일 전'},
 spark(values,{labels=[],height=150}={}){values=values.filter(v=>v!=null&&isFinite(v));if(!values.length)return '';
  const W=320,H=height,R=40,B=24,min=Math.min(...values),max=Math.max(...values),pad=(max-min)*.1||1,lo=min-pad,hi=max+pad;
  const x=i=>i*(W-R)/(values.length-1||1),y=v=>(H-B)-(v-lo)/(hi-lo)*(H-B-8);
  const d=values.map((v,i)=>(i?'L':'M')+x(i).toFixed(1)+' '+y(v).toFixed(1)).join(' ');
  const ticks=[0,1,2,3].map(k=>lo+(hi-lo)*(k+.5)/4);
  const grid=ticks.map(t=>'<line x1="0" x2="'+(W-R)+'" y1="'+y(t)+'" y2="'+y(t)+'" stroke="var(--line)" stroke-dasharray="2 4"/><text x="'+(W-R+6)+'" y="'+(y(t)+4)+'">'+Math.round(t).toLocaleString()+'</text>').join('');
  const lab=labels.map((l,i)=>'<text x="'+(i*(W-R)/(labels.length-1||1))+'" y="'+(H-4)+'" text-anchor="'+(i===0?'start':i===labels.length-1?'end':'middle')+'">'+l+'</text>').join('');
  const last=values[values.length-1];
  return '<svg viewBox="-4 0 '+(W+4)+' '+H+'" width="100%" style="display:block;overflow:visible">'+grid+'<path d="'+d+'" fill="none" stroke="var(--tp)" stroke-width="1.6" stroke-linejoin="round"/><circle cx="'+x(values.length-1)+'" cy="'+y(last)+'" r="3.5" fill="var(--tp)"/>'+lab+'</svg>'}
};

document.getElementById('panel').innerHTML = p.html || ''
try {
  const AsyncFunction = (async () => {}).constructor
  await new AsyncFunction(p.script || '')()
} catch (e) { console.warn('[panel]', p.title, e); document.getElementById('panel').insertAdjacentHTML('beforeend', `<div class="p-muted">${lite.esc(e.message)}</div>`) }
