// Builds the srcdoc for a sandboxed panel iframe: CSS kit + runtime + the panel's own html/script.
const KIT_CSS = `
:root{--tp:rgb(245 245 247);--ts:rgba(245 245 247/.5);--tt:rgba(245 245 247/.3);--cell:rgba(255 255 255/.05);--btn:rgba(255 255 255/.08);--line:rgba(255 255 255/.12)}
:root[data-theme=light]{--tp:rgb(29 29 31);--ts:rgba(29 29 31/.5);--tt:rgba(29 29 31/.3);--cell:rgba(255 255 255/.6);--btn:rgba(255 255 255/.85);--line:rgba(0 0 0/.08)}
*{box-sizing:border-box}html,body{margin:0;background:transparent;color:var(--tp);font:15px/1.4 'Pretendard Variable',Pretendard,-apple-system,system-ui,sans-serif;-webkit-font-smoothing:antialiased;overflow:hidden}
button{font:inherit;color:inherit;border:0;cursor:pointer;background:var(--btn);border-radius:12px;min-height:32px;padding:0 12px}
input:not([type=checkbox]):not([type=radio]),textarea,select{font:inherit;color:inherit;background:var(--cell);border:0;outline:0;border-radius:12px;min-height:40px;padding:0 12px}
input[type=checkbox]{accent-color:var(--tp);width:18px;height:18px}
.p-row{display:flex;gap:6px}.p-row>*{flex:1;min-width:0}
.p-cell{background:var(--cell);border-radius:12px;padding:12px 14px}
.p-k{font-size:14px;color:var(--ts)}.p-v{font-size:26px;letter-spacing:-.02em}
.p-big{font-size:30px;letter-spacing:-.02em;margin:6px 0 2px}.p-sub{font-size:15px;color:var(--ts)}
.p-muted{color:var(--tt);font-size:13px}
.p-list{display:flex;flex-direction:column;gap:8px}
.p-item{background:var(--cell);border-radius:14px;padding:12px 14px;display:flex;gap:10px;align-items:center;justify-content:space-between}
.p-btn{width:100%;height:40px;border-radius:12px;background:var(--btn);font-weight:500;font-size:15px;margin-top:10px}
.p-nav{display:flex;align-items:center;justify-content:space-between;margin:2px 0 10px}
.p-nav button{flex:none;width:32px;height:32px;border-radius:99px;background:var(--cell)}.p-nav>:not(button){flex:1;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
input.p-in{width:100%;height:40px;border-radius:12px;border:0;outline:0;padding:0 12px;background:var(--cell)}
svg text{fill:var(--ts);font-size:12px}
`

const RUNTIME = `
const __p={};let __s=0;
const __call=(type,payload)=>new Promise((res,rej)=>{const id=++__s;__p[id]={res,rej};parent.postMessage({__panel:1,id,type,payload},'*')});
addEventListener('message',e=>{const m=e.data||{};if(m.__reply&&__p[m.id]){m.error?__p[m.id].rej(new Error(m.error)):__p[m.id].res(m.result);delete __p[m.id]}if(m.__theme)document.documentElement.dataset.theme=m.__theme});
window.panel={data:__DATA__,save(o){this.data=o;return __call('save',o)},fetch:u=>__call('fetch',u),ask:p=>__call('ask',p),open:u=>__call('open',u),chat:t=>__call('chat',t)};
window.$=s=>document.querySelector(s);
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
addEventListener('DOMContentLoaded',()=>new ResizeObserver(()=>parent.postMessage({__panel:1,type:'height',payload:document.documentElement.scrollHeight},'*')).observe(document.body));
addEventListener('error',e=>parent.postMessage({__panel:1,type:'error',payload:String(e.message)},'*'));
`

export function panelDoc(p, theme) {
  const data = JSON.stringify(p.data || {}).replace(/</g, '\\u003c')
  const script = (p.spec?.script || '').replace(/<\/script/gi, '<\\/script')
  return `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable.min.css">
<style>${KIT_CSS}</style><script>${RUNTIME.replace('__DATA__', data)}<\/script></head>
<body>${p.spec?.html || ''}<script>(async()=>{try{${script}\n}catch(e){parent.postMessage({__panel:1,type:'error',payload:String(e)},'*')}})()<\/script></body></html>`
}
