// Ready-made Home panels for one AI-DLC intent (D1–D6 of docs/robo-dlc/plan.md). They are ordinary
// pro_panels rows written without a model: fixed html + script against the panel runtime, reading
// the intent through panel.aidlc(path). panel.data holds which folder / space / intent to show.
import { q } from '../supa.js'
import { emit } from '../bus.js'
import { L } from '../lang.js'
import { safeName } from './record.js'

// shared helpers every preset script starts with (labels are put in at creation, in the current language)
const COMMON = (T) => `
const T=${JSON.stringify(T)};
const D=panel.data, base=encodeURIComponent(D.folder)+'/intents/'+encodeURIComponent(D.space)+'/'+encodeURIComponent(D.slug);
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const COLOR={done:'#34c759',waiting:'#ff9f0a',working:'#0a84ff',revising:'#bf5af2',skipped:'var(--tt)',pending:'var(--line)',ready:'#64d2ff',blocked:'var(--tt)'};
const dot=s=>'<span style="display:inline-block;width:9px;height:9px;border-radius:9px;background:'+(COLOR[s]||'var(--line)')+'"></span>';
const dur=m=>m==null?'-':m<1?T.lt1:m<60?Math.round(m)+T.min:m<1440?(m/60).toFixed(1)+T.hr:(m/1440).toFixed(1)+T.day;
const fail=e=>{document.body.innerHTML='<div class="p-muted">'+esc(T.err)+' '+esc(e.message||e)+'</div>'};
// read through panel.aidlc; the first failure says why, a failed refresh keeps what is on screen
let shown=false;
const get=p=>panel.aidlc(p).then(r=>{shown=true;return r},e=>{if(!shown)fail(e);return null});
// draw now, then every 20 s (AI-DLC moves while you look)
const every=fn=>{fn();setInterval(fn,20000)};
`

const LABELS = () => ({
  min: L('분', 'm'), hr: L('시간', 'h'), day: L('일', 'd'), lt1: L('1분 미만', '<1m'), err: L('불러오지 못했어요:', 'Could not load:'),
  waiting: L('승인 대기', 'Awaiting approval'), working: L('진행 중', 'In progress'), done: L('완료', 'Done'), revising: L('수정 중', 'Revising'),
  skipped: L('건너뜀', 'Skipped'), pending: L('대기', 'Pending'), ready: L('시작 가능', 'Ready'), blocked: L('의존 대기', 'Blocked'),
  current: L('지금 단계', 'Current stage'), next: L('다음 할 일', 'Next'), noWait: L('기다리는 승인이 없어요', 'Nothing is waiting for approval'),
  approvals: L('승인', 'Approvals'), rejects: L('반려', 'Rejections'), questions: L('열린 질문', 'Open questions'),
  ai: L('AI 작업', 'AI work'), human: L('사람 대기', 'Human wait'), totalAi: L('AI 작업 합계', 'Total AI work'), totalHuman: L('사람 대기 합계', 'Total human wait'),
  deps: L('의존', 'Needs'), work: L('작업', 'Work'), checks: L('검증', 'Checks'), none: L('없음', 'none'),
  sensors: L('센서', 'Sensors'), failed: L('실패', 'failed'), checkpoints: L('체크포인트 검증', 'Checkpoint checks'), openMajor: L('남은 Major', 'Open Major'),
  noQ: L('답을 기다리는 질문이 없어요', 'No question is waiting for an answer'), file: L('파일', 'File'),
  ev: {
    GATE_APPROVED: L('승인', 'Approved'), GATE_REJECTED: L('수정 요청', 'Changes requested'), STAGE_AWAITING_APPROVAL: L('승인 대기', 'Awaiting approval'),
    STAGE_STARTED: L('단계 시작', 'Stage started'), STAGE_COMPLETED: L('단계 완료', 'Stage completed'), QUESTION_REPLIED: L('답변', 'Answered'),
    QUESTION_ANSWERED: L('질문 답 기록', 'Answers recorded'), HUMAN_TURN: L('사람 입력', 'Human input'), SENSOR_FAILED: L('센서 실패', 'Sensor failed'),
    CHECKPOINT_VERIFICATION_RECORDED: L('검증', 'Verification'), UNIT_STARTED: L('유닛 시작', 'Unit started'), UNIT_COMPLETED: L('유닛 단계 완료', 'Unit stage done'),
    REVIEW_COMPLETED: L('검토 완료', 'Review done'), WORKFLOW_STARTED: L('작업 시작', 'Work started'), WORKFLOW_COMPLETED: L('작업 완료', 'Work completed'),
  },
})

export const PRESETS = [
  {
    kind: 'status', icon: '🧭', title: () => L('AI-DLC 작업 현황', 'AI-DLC status'),
    html: `<div class="p-sub" id="proj"></div><div class="p-cell" style="margin-top:8px"><div class="p-k" id="k1"></div><div class="p-v" id="cur"></div><div class="p-sub" id="role"></div></div>
<div id="rail" style="display:flex;flex-wrap:wrap;gap:5px;margin:12px 2px"></div><div class="p-cell" id="wait"></div>
<div class="p-row" style="margin-top:8px"><div class="p-cell"><div class="p-k" id="ka"></div><div class="p-v" id="na"></div></div><div class="p-cell"><div class="p-k" id="kr"></div><div class="p-v" id="nr"></div></div><div class="p-cell"><div class="p-k" id="kq"></div><div class="p-v" id="nq"></div></div></div>
<div class="p-muted" id="nx" style="margin-top:10px"></div>`,
    script: `
async function draw(){const s=await get(base+'/summary'); if(!s) return;
$('#proj').textContent=(s.project||s.slug).slice(0,70)+' · '+(s.scope||'');
$('#k1').textContent=T.current; $('#cur').textContent=s.current?s.current.name:(s.runStatus||'-');
$('#role').innerHTML=s.current?esc(s.current.role||'')+' · '+esc(s.runStatus||''):'';
$('#rail').innerHTML=s.rail.filter(r=>r.status!=='skipped'&&r.phase!=='initialization').map(r=>'<span title="'+esc(r.number+' '+r.name+' · '+(T[r.status]||r.status))+'">'+dot(r.status)+'</span>').join('');
$('#wait').innerHTML=s.waiting.length?s.waiting.map(w=>dot('waiting')+' <b>'+esc(w.name)+'</b> · '+esc(w.role||'')+' · '+dur(w.minutes)).join('<br>'):'<span class="p-muted">'+esc(T.noWait)+'</span>';
$('#ka').textContent=T.approvals;$('#na').textContent=s.counts.approvals;$('#kr').textContent=T.rejects;$('#nr').textContent=s.counts.rejections;$('#kq').textContent=T.questions;$('#nq').textContent=s.questions.open;
$('#nx').textContent=s.nextAction?T.next+': '+s.nextAction:'';
}
every(draw);`,
  },
  {
    kind: 'wait', icon: '⏳', title: () => L('사람 대기', 'Human wait'),
    html: `<div class="p-row"><div class="p-cell"><div class="p-k" id="ka"></div><div class="p-v" id="ta"></div></div><div class="p-cell"><div class="p-k" id="kh"></div><div class="p-v" id="th"></div></div></div><div class="p-list" id="list" style="margin-top:10px"></div>`,
    script: `
async function draw(){const s=await get(base+'/summary'); if(!s) return;
const rows=s.stages.filter(r=>r.aiMin||r.humanMin).sort((a,b)=>b.humanMin-a.humanMin);
const ta=rows.reduce((n,r)=>n+r.aiMin,0), th=rows.reduce((n,r)=>n+r.humanMin,0), max=Math.max(1,...rows.map(r=>Math.max(r.aiMin,r.humanMin)));
$('#ka').textContent=T.totalAi;$('#ta').textContent=dur(ta);$('#kh').textContent=T.totalHuman;$('#th').textContent=dur(th);
const bar=(v,c)=>'<div style="height:6px;border-radius:6px;background:'+c+';width:'+Math.max(2,v/max*100)+'%"></div>';
$('#list').innerHTML=rows.map(r=>'<div class="p-item" style="flex-direction:column;align-items:stretch;gap:4px"><div style="display:flex;justify-content:space-between"><span>'+(r.state==='waiting'?dot('waiting')+' ':'')+esc(r.name)+'</span><span class="p-muted">'+esc(r.role||'')+(r.rejects?' · '+T.rejects+' '+r.rejects:'')+'</span></div>'+
 '<div class="p-muted">'+T.ai+' '+dur(r.aiMin)+'</div>'+bar(r.aiMin,'#0a84ff')+'<div class="p-muted">'+T.human+' '+dur(r.humanMin)+'</div>'+bar(r.humanMin,'#ff9f0a')+'</div>').join('');
}
every(draw);`,
  },
  {
    kind: 'bolts', icon: '🧱', title: () => L('볼트 보드', 'Bolt board'),
    html: `<div class="p-list" id="list"></div>`,
    script: `
async function draw(){const s=await get(base+'/summary'); if(!s) return;
$('#list').innerHTML=s.units.length?s.units.map(u=>'<div class="p-item" style="flex-direction:column;align-items:stretch;gap:3px"><div style="display:flex;justify-content:space-between"><span>'+dot(u.status)+' <b>'+esc(u.name)+'</b></span><span class="p-muted">'+esc(T[u.status]||u.status)+'</span></div>'+
 '<div class="p-muted">'+T.deps+': '+esc(u.dependsOn.join(', ')||T.none)+'</div><div class="p-muted">'+T.work+' '+dur(u.workMin)+' · '+T.human+' '+dur(u.humanMin)+' · '+T.checks+' ✓'+u.checks.ok+(u.checks.failed?' ✗'+u.checks.failed:'')+'</div></div>').join(''):'<div class="p-muted">'+T.none+'</div>';
}
every(draw);`,
  },
  {
    kind: 'quality', icon: '🔎', title: () => L('품질', 'Quality'),
    html: `<div class="p-row"><div class="p-cell"><div class="p-k" id="ks"></div><div class="p-v" id="ns"></div></div><div class="p-cell"><div class="p-k" id="kc"></div><div class="p-v" id="nc"></div></div></div><div class="p-list" id="list" style="margin-top:10px"></div>`,
    script: `
async function draw(){const s=await get(base+'/summary'); if(!s) return; const c=s.counts;
$('#ks').textContent=T.sensors;$('#ns').innerHTML=c.sensorsFired+(c.sensorsFailed?' <span class="p-muted">'+T.failed+' '+c.sensorsFailed+'</span>':'');
$('#kc').textContent=T.checkpoints;$('#nc').innerHTML='✓'+c.checkpoints.ok+(c.checkpoints.failed?' <span class="p-muted">✗'+c.checkpoints.failed+'</span>':'');
$('#list').innerHTML=s.quality.reviews.map(r=>'<div class="p-item"><span>'+dot(r.verdict==='READY'?'done':'waiting')+' '+esc(r.stage)+(r.unit?' · '+esc(r.unit):'')+'</span><span class="p-muted">'+esc(r.verdict)+(r.rounds>1?' ×'+r.rounds:'')+(r.openMajor?' · '+T.openMajor+' '+r.openMajor:'')+'</span></div>').join('');
}
every(draw);`,
  },
  {
    kind: 'timeline', icon: '🕘', title: () => L('감사 타임라인', 'Audit timeline'),
    html: `<div class="p-list" id="list"></div>`,
    script: `
async function draw(){const KINDS=['WORKFLOW_STARTED','WORKFLOW_COMPLETED','STAGE_AWAITING_APPROVAL','GATE_APPROVED','GATE_REJECTED','QUESTION_REPLIED','SENSOR_FAILED','CHECKPOINT_VERIFICATION_RECORDED','UNIT_STARTED'];
const ev=await get(base+'/timeline?limit=400'); if(!ev) return;
$('#list').innerHTML=ev.filter(e=>KINDS.includes(e.event)).slice(0,12).map(e=>'<div class="p-item" style="flex-direction:column;align-items:stretch;gap:2px"><div style="display:flex;justify-content:space-between"><b>'+esc(T.ev[e.event]||e.title)+'</b><span class="p-muted">'+esc(ui.ago(e.ts))+'</span></div><div class="p-muted">'+esc([e.stage,e.unit].filter(Boolean).join(' · '))+(e.detail?' — '+esc(e.detail):'')+'</div></div>').join('');
}
every(draw);`,
  },
  {
    kind: 'questions', icon: '❓', title: () => L('질문함', 'Questions'),
    html: `<div class="p-list" id="list"></div>`,
    script: `
async function draw(){const fs=await get(base+'/questions'); if(!fs) return;
const open=[];fs.forEach(f=>f.questions.filter(q=>!q.answer).forEach(q=>open.push({f,q})));
$('#list').innerHTML=open.length?open.slice(0,8).map(({f,q})=>'<div class="p-item" style="flex-direction:column;align-items:stretch;gap:3px"><div class="p-muted">'+esc(f.stageName)+(f.unit?' · '+esc(f.unit):'')+' · '+esc(f.role||'')+' · '+esc(q.id)+(q.tag?' ['+esc(q.tag)+']':'')+'</div><div>'+esc(q.text)+'</div>'+(q.options.length?'<div class="p-muted">'+q.options.map(o=>esc(o.key+'. '+o.text)).join('<br>')+'</div>':'')+'<div class="p-muted">'+T.file+': '+esc(f.path)+'</div></div>').join(''):'<div class="p-muted">'+esc(T.noQ)+'</div>';
}
every(draw);`,
  },
]

// the full panel spec of one preset (what goes into pro_panels)
export function presetSpec(kind, { folder, space, slug }) {
  const p = PRESETS.find((x) => x.kind === kind)
  if (!p) throw Object.assign(new Error('unknown panel kind'), { status: 400 })
  const description = `AI-DLC ${kind}: ${folder}/${space}/${slug}`
  return { title: `${p.title()} · ${slug}`, icon: p.icon, spec: { html: p.html, script: COMMON(LABELS()) + p.script, description, aidlc: kind }, data: { folder, space, slug } }
}

export async function createPresetPanels(userId, { folder, space, slug, kinds }) {
  safeName(folder); safeName(space); safeName(slug)
  const want = Array.isArray(kinds) && kinds.length ? kinds : PRESETS.map((p) => p.kind)
  const out = []
  for (const kind of want) {
    const s = presetSpec(kind, { folder, space, slug })
    const [p] = await q('insert into pro_panels(user_id,title,icon,spec,data) values ($1,$2,$3,$4,$5) returning *', [userId, s.title, s.icon, s.spec, s.data])
    emit(userId, 'panel', p)
    out.push(p)
  }
  return out
}
