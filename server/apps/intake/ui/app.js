// 작업 접수 — say what should be done; the plan proposed for it (scope, what it touches, what it collides with) is a
// card on the right; the people who take in work start it, stand it after the work in flight, or fold it in.
import lite from '../../_runtime/lite.js'
const { t, esc, $, $$ } = lite
await lite.ready
const folder = lite.params.folder
let V = null
let sel = lite.params.r || null
let pick = {}            // what the person chose on the open plan: { scope, mode, fast }
let editUnits = false
let sending = false
// inside a conversation (the chat called intake_propose): the one request's plan, as tall as it is
const card = !!lite.params.card
if (card) document.documentElement.classList.add('card')

const STATUS = { estimating: t('계획 세우는 중', 'Working out'), proposed: t('계획안', 'Plan ready'), inbox: t('접수 대기', 'Waiting'), queued: t('줄에 섬', 'In line'), started: t('시작됨', 'Started'),
  merged: t('합침', 'Folded in'), later: t('나중에', 'Later'), declined: t('받지 않음', 'Declined'), failed: t('계획 실패', 'Failed'), discarded: t('폐기됨', 'Discarded') }
// (a request whose bolts were all discarded reads as discarded, whatever was decided about it before)
const stOf = (r) => (r.discarded ? 'discarded' : r.status)
const KIND = { bug: t('버그', 'Bug'), feature: t('새 기능', 'Feature'), change: t('변경', 'Change'), security: t('보안', 'Security'), refactor: t('정리', 'Refactor'), question: t('질문', 'Question') }
const SCORE = { iae: t('요청의 모호함', 'Unclear intent'), csu: t('코드의 얽힘', 'Code coupling'), ve: t('확인 근거 부족', 'Weak evidence'), r: t('틀렸을 때 위험', 'Risk'), ua: t('숨은 가정', 'Assumptions') }
const WHY = { kind: (e) => t(`<b>${esc(KIND[e.kind] || e.kind)}</b> 요청이라 그 일에 맞춘 범위를 골랐어요.`, `A <b>${esc(KIND[e.kind] || e.kind)}</b> request: the scope made for it.`),
  small: () => t('한 유닛 안의 <b>작은 변경</b>이라 가장 가벼운 범위를 골랐어요.', 'A <b>small change</b> inside one unit: the lightest scope.'),
  size: () => t('여러 유닛에 걸치거나 새 유닛이 필요해 <b>기능 한 바퀴</b>를 도는 범위를 골랐어요.', 'It spans units or adds one: the <b>feature</b> lifecycle.'),
  nearest: () => t('엔진이 계산한 가장 가까운 범위예요.', 'The nearest scope the engine found.'),
  revert: () => t('끝난 작업을 <b>되돌리는</b> 요청이에요.', 'A request that <b>reverts</b> finished work.') }
const open_ = (r) => ['proposed', 'inbox', 'later', 'queued'].includes(r.status)
const boltOf = (key) => V.line.bolts.find((b) => b.key === key)
const toast = (text) => { const el = document.createElement('div'); el.className = 'toast'; el.textContent = text; document.body.append(el); setTimeout(() => el.remove(), 3200) }
const names = (list) => (list?.length ? list.join(', ') : t('폴더 소유자', 'the folder owners'))

async function load(keep = true) {
  try { V = await lite.tool('intake_open', { folder }) } catch (e) { $('#plan').innerHTML = `<p class="hint">${esc(e.message)}</p>`; return }
  if (sel && !V.requests.some((r) => r.id === sel)) sel = null
  if (!sel && !keep) sel = null
  draw()
}

function draw() {
  if (card) return drawPlan()
  drawAsk(); drawHead(); drawList(); drawPlan()
}

function drawAsk() {
  const el = $('#ask')
  // drawn once: what is being typed stays where it is
  if (el.querySelector('textarea')) return
  el.innerHTML = `<h3>${esc(t('새 작업 요청', 'Ask for work'))}</h3>
    <textarea id="body" data-test="intake-body" placeholder="${esc(t('무엇을 바꾸고 싶은지 그대로 적어 주세요. 예) 예약 알림 메일이 두 번 와요', 'Say what you want changed, in your own words.'))}"></textarea>
    <div class="who">${V.rights.intake ? `<span class="chip can" data-test="intake-right">${esc(t('접수 권한 있음 — 계획안을 보고 바로 정해요', 'You take in work'))}</span>`
      : `<span class="chip cannot" data-test="intake-right">${esc(t(`요청만 할 수 있어요 — 접수는 ${names(V.people.intake)}`, `You can ask — ${names(V.people.intake)} take it in`))}</span>`}
      <span class="right_"></span><button class="primary" id="send" data-test="intake-send">${esc(t('계획안 받기', 'Get a plan'))}</button></div>`
}

function drawHead() {
  const h = V.head
  const el = $('#head')
  el.className = `headbox${h.busy ? '' : ' free'}`
  el.innerHTML = h.busy
    ? `<span class="live pulse"></span><div>${esc(t('지금 진행 중', 'In flight'))} · <b>${esc(h.intent?.title || t('시작하는 중', 'starting'))}</b>${h.intent?.scope ? ` <span class="chip">${esc(h.intent.scope)}</span>` : ''}<div class="muted small">${esc([h.intent?.stage, h.intent?.unit].filter(Boolean).join(' · '))}</div></div><a data-act="line" data-test="intake-to-line">${esc(t('볼트 줄 보기', 'Bolt line'))} →</a>`
    : `<span class="live"></span><div>${esc(t('진행 중인 작업이 없어요. 접수하면 바로 시작할 수 있어요.', 'Nothing in flight: work taken in can start now.'))}</div><a data-act="line" data-test="intake-to-line">${esc(t('볼트 줄 보기', 'Bolt line'))} →</a>`
}

const GROUPS = [
  ['inbox', t('접수를 기다리는 요청', 'Waiting to be taken in'), (r) => r.status === 'inbox'],
  ['mine', t('계획안', 'Plans'), (r) => ['estimating', 'proposed', 'failed'].includes(r.status)],
  ['queued', t('줄에 선 작업', 'In line'), (r) => r.status === 'queued'],
  ['going', t('시작한 작업', 'Started'), (r) => ['started', 'merged'].includes(r.status)],
  ['off', t('나중에 · 받지 않음', 'Later · declined'), (r) => ['later', 'declined'].includes(r.status)],
]
function drawList() {
  const out = []
  for (const [key, name, f] of GROUPS) {
    const rows = V.requests.filter(f).sort((a, b) => String(b.at).localeCompare(String(a.at)))
    if (!rows.length) continue
    out.push(`<div class="grp ${key}" data-test="intake-group-${key}"><div class="gh">${esc(name)} <span class="n">${rows.length}</span></div>${rows.map(row).join('')}</div>`)
  }
  $('#list').innerHTML = out.join('') || `<p class="hint">${esc(t('아직 요청이 없어요. 위에 하고 싶은 일을 적어 보세요.', 'No requests yet. Say what you want done above.'))}</p>`
}
function row(r) {
  const clash = (r.estimate?.conflicts || []).filter((c) => !c.compatible && boltOf(c.bolt) && !boltOf(c.bolt).discarded).length
  return `<div class="req${sel === r.id ? ' sel' : ''}" data-req="${r.id}" data-test="intake-req" data-status="${r.status}">${lite.avatar(r.asker.name || '?', { size: 26 })}
    <div class="ti">${esc(r.title)}</div><div class="me">${esc(r.asker.name)} · ${esc(lite.ago(r.at))}${clash ? ` · <span class="clash">${esc(t(`볼트 ${clash}개와 충돌`, `clashes with ${clash}`))}</span>` : ''}</div>
    <div class="st"><span class="chip ${stOf(r)}">${r.status === 'estimating' ? '<span class="spin"></span>' : ''}${esc(STATUS[stOf(r)] || r.status)}</span>${r.scope ? `<span class="chip">${esc(r.scope)}</span>` : ''}</div></div>`
}

function drawPlan() {
  const el = $('#plan')
  const r = V.requests.find((x) => x.id === sel)
  // (a narrow screen shows one column: the picked plan comes first, the list after it)
  document.documentElement.classList.toggle('picked', !!r)
  if (!r && card) { el.innerHTML = `<p class="hint">${esc(t('이 요청은 거두었거나 더 이상 없어요.', 'This request was withdrawn or is gone.'))}</p>`; return }
  if (!r) {
    el.innerHTML = `<p class="hint">${esc(t('요청을 고르면 Lite 가 세운 계획안이 여기에 보여요. 계획안에는 어떤 범위로 돌릴지, 어느 유닛과 계약을 건드리는지, 줄에 있는 볼트와 부딪히는지가 근거와 함께 들어 있어요.', 'Pick a request to see the plan proposed for it: the scope, the units and contracts it touches, and whether it collides with a bolt in the line.'))}</p>${ledger()}`
    return
  }
  const e = r.estimate
  const head = `<div class="p-head"><div><div class="tt" data-test="plan-title">${esc(r.title)}</div></div>${e?.ars ? `<div class="ars" title="ARS"><div class="num" data-test="plan-ars">${Math.round(e.ars.total)}</div><div class="lab">ARS · ${esc(e.ars.label || '')}</div></div>` : ''}</div>
    <div class="p-sub">${lite.avatar(r.asker.name || '?', { size: 20 })} ${esc(r.asker.name)} · ${esc(lite.ago(r.at))}${e?.kind ? ` <span class="chip">${esc(KIND[e.kind] || e.kind)}</span>` : ''}<span class="chip ${stOf(r)}" data-test="plan-status">${esc(STATUS[stOf(r)] || r.status)}</span>${r.source === 'chat' ? `<span class="chip">${esc(t('채팅에서', 'from chat'))}</span>` : ''}</div>
    <div class="body">${esc(r.body)}</div>`
  if (r.status === 'estimating') { el.innerHTML = `${head}<div class="note"><span class="spin"></span>${esc(t('프로젝트의 기록과 코드를 읽고 계획을 세우고 있어요. 1분쯤 걸려요. 아무것도 바꾸지 않아요.', 'Reading the project’s record and code to work out a plan — about a minute. Nothing is changed.'))}</div>`; return }
  if (r.status === 'failed') {
    el.innerHTML = `${head}<div class="note bad" data-test="plan-failed">${esc(t('계획을 세우지 못했어요', 'The plan could not be worked out'))}${r.note ? `: ${esc(r.note)}` : ''}</div>
      <div class="acts">${r.mine || V.rights.intake ? `<button class="primary" data-act="again" data-test="plan-again">${esc(t('다시 세우기', 'Try again'))}</button>` : ''}${r.mine ? `<button data-act="withdraw">${esc(t('요청 거두기', 'Withdraw'))}</button>` : ''}</div>`
    return
  }
  if (!e) { el.innerHTML = head; return }
  const p = pick[r.id] = pick[r.id] || { scope: r.scope || e.scope, mode: r.startMode || (V.head.busy ? 'after' : 'now'), fast: r.fast }
  if (p.mode === 'now' && V.head.busy && V.head.intent?.request !== r.id) p.mode = 'after'
  if (p.mode === 'merge' && !V.head.busy) p.mode = 'now'
  const can = V.rights.intake && open_(r)
  const sc = V.scopes.find((s) => s.name === p.scope)
  const changed = p.scope !== e.scope
  const scope = `<div class="scope"><div><div class="muted small">${esc(t('이 범위로 돌려요', 'Scope'))}</div><div class="nm" data-test="plan-scope">${esc(p.scope || '–')}</div></div>
    <div class="why">${changed ? esc(t('사람이 바꾼 범위예요.', 'Changed by a person.')) : (WHY[e.scopeWhy] || WHY.nearest)(e)}${sc?.description ? `<div>${esc(sc.description)}</div>` : ''}</div>
    ${can && V.scopes.length ? `<select id="scope" data-test="plan-scope-select">${V.scopes.map((s) => `<option value="${esc(s.name)}"${s.name === p.scope ? ' selected' : ''}>${esc(s.name)}${s.name === e.scope ? ` · ${esc(t('추천', 'suggested'))}` : ''}</option>`).join('')}</select>` : ''}</div>`
  const scores = e.scores ? `<div class="sec">${esc(t('어떻게 가늠했나 — 높을수록 살필 것이 많아요', 'How it was sized — higher means more to look into'))}</div>${Object.keys(SCORE).map((k) => {
    const s = e.scores[k] || { score: 0, why: '' }
    return `<div class="metric"><span>${esc(SCORE[k])}</span><div class="bar"><i class="${s.score >= .66 ? 'high' : s.score >= .4 ? 'mid' : ''}" style="width:${Math.round(s.score * 100)}%"></i></div><span class="v">${s.score.toFixed(2)}</span><span class="why">${esc(s.why)}</span></div>`
  }).join('')}` : ''
  const tc = e.touches || { units: [], contracts: [], requirements: [], paths: [] }
  const dropped = Object.values(e.dropped || {}).flat()
  const touches = `<div class="sec">${esc(t('건드리는 곳', 'What it touches'))}${V.rights.impact && open_(r) ? `<a class="more" data-act="units" data-test="plan-impact-edit">${esc(e.confirmed ? t('다시 확인', 'Confirm again') : t('영향 범위 확인', 'Confirm the impact'))}</a>` : ''}</div>
    <div class="trow"><div class="tags"><span class="k">${esc(t('유닛', 'Units'))}</span>${tc.units.map((u) => `<span class="chip unit" data-test="plan-unit">${esc(u)}</span>`).join('') || `<span class="faint small">${esc(t('없음', 'none'))}</span>`}${(e.newUnits || []).map((u) => `<span class="chip new" title="${esc(u.why || '')}">＋ ${esc(u.name)}</span>`).join('')}</div></div>
    ${tc.contracts.length ? `<div class="trow"><div class="tags"><span class="k">${esc(t('계약', 'Contracts'))}</span>${tc.contracts.map((c) => `<span class="chip contract">${esc(c)}</span>`).join('')}</div></div>` : ''}
    ${tc.requirements.length ? `<div class="trow"><div class="tags"><span class="k">${esc(t('요구사항', 'Requirements'))}</span>${tc.requirements.map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div></div>` : ''}
    ${tc.paths.length ? `<div class="trow"><div class="tags"><span class="k">${esc(t('코드', 'Code'))}</span>${tc.paths.map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div></div>` : ''}
    ${dropped.length ? `<div class="trow"><div class="tags"><span class="k">${esc(t('뺀 이름', 'Dropped'))}</span>${dropped.map((c) => `<span class="chip drop" title="${esc(t('기록에 없는 이름이라 뺐어요', 'not in the record'))}">${esc(c)}</span>`).join('')}</div></div>` : ''}
    ${e.confirmed ? `<div class="confirmed" data-test="plan-confirmed">✓ ${esc(t(`${e.confirmed.name} 님이 영향 범위를 확인했어요`, `${e.confirmed.name} confirmed the impact`))}${e.confirmed.was ? ` · ${esc(t(`고치기 전: ${e.confirmed.was.join(', ') || '없음'}`, `was: ${e.confirmed.was.join(', ') || 'none'}`))}` : ''}${e.confirmed.note ? ` · ${esc(e.confirmed.note)}` : ''}</div>` : ''}
    ${editUnits ? unitsEdit(tc.units) : ''}`
  const conflicts = (e.conflicts || []).map((c) => {
    const b = boltOf(c.bolt)
    const gone = !b || b.discarded
    return `<div class="conf${c.compatible || gone ? ' ok' : ''}" data-test="plan-conflict" data-bolt="${esc(c.bolt)}"><div class="ch">${b ? `<span class="bn">B${b.n}</span> ${esc(b.title)}${b.unit !== '*' ? ` · ${esc(b.unit)}` : ''}` : esc(c.bolt)}
      <span class="chip">${esc(gone ? t('폐기됨', 'discarded') : b.state === 'running' ? t('도는 중', 'running') : b.state === 'done' ? t('끝남', 'done') : t('시작 전', 'not started'))}</span>${c.compatible ? `<span class="chip">${esc(t('함께 갈 수 있음', 'both can stand'))}</span>` : gone ? '' : `<span class="chip" style="color:var(--bad)">${esc(t('둘 중 하나만', 'only one can stand'))}</span>`}</div>
      <div class="q"><span>${esc(t('이 요청', 'This request'))}</span><i>“${esc(c.requestQuote)}”</i><span>${esc(t('그 볼트', 'That bolt'))}</span><i>“${esc(c.recordQuote)}”</i></div><div class="why">${esc(c.why)}</div>
      ${gone ? '' : `<div class="acts"><button data-act="see-bolt" data-key="${esc(c.bolt)}">${esc(t('볼트 줄에서 보기', 'See it in the line'))}</button>${!c.compatible && V.rights.stop ? `<button class="danger" data-act="discard" data-key="${esc(c.bolt)}" data-test="plan-discard">${esc(t('그 볼트를 폐기하고 이 요청으로', 'Discard that bolt for this request'))}</button>` : ''}</div>`}</div>`
  }).join('')
  const live = (e.conflicts || []).filter((c) => !c.compatible && boltOf(c.bolt) && !boltOf(c.bolt).discarded).length
  const near = e.ars?.nearest?.length ? `<div class="sec">${esc(t('엔진이 본 가까운 범위', 'Nearest scopes by the engine'))}</div><div class="near">${e.ars.nearest.map((n) => `<span class="chip">${esc(n.scope)} · ${esc(t(`단계 차이 ${n.diff}`, `${n.diff} stage(s) apart`))}</span>`).join('')}<span class="chip">${esc(t(`실행 단계 ${e.ars.stages}개`, `${e.ars.stages} stages`))}</span></div>` : ''
  let foot = ''
  if (can) {
    const busy = V.head.busy
    const modes = [
      ['now', t('지금 시작', 'Start now'), busy ? t('진행 중인 작업이 있어 지금은 못 해요', 'Work is in flight') : t('세션에 바로 넘겨요', 'Hand it to the session'), busy],
      ['after', busy ? t('앞 작업 뒤에 세우기', 'After the work in flight') : t('줄 끝에 세우기', 'Stand it in line'), t('볼트 줄 끝에 쌓여요. 시작은 사람이 눌러요', 'Stacks at the tail; a person starts it'), false],
      ['merge', t('지금 작업에 합치기', 'Fold into it'), busy ? t('진행 중인 세션에 추가 요청으로 말해요', 'Said to the session as an added request') : t('진행 중인 작업이 없어요', 'Nothing in flight'), !busy],
    ]
    foot = `<div class="sec">${esc(t('언제 시작할까요', 'When'))}</div><div class="modes">${modes.map(([k, a, b, off]) => `<button class="mode${p.mode === k ? ' on' : ''}" data-mode="${k}" data-test="plan-mode-${k}"${off ? ' disabled' : ''}><b>${esc(a)}</b><span>${esc(b)}</span></button>`).join('')}</div>
      ${p.mode === 'after' ? `<label class="fast"><input type="checkbox" id="fast"${p.fast ? ' checked' : ''}> ${esc(t('빠른 줄 — 기다리는 작업들 맨 앞에 세워요(급한 버그·보안)', 'Fast lane — in front of the waiting work'))}</label>` : ''}
      ${live ? `<div class="note warn" data-test="plan-clash-note">${esc(t(`줄에 있는 볼트 ${live}개와 부딪혀요. 그대로 접수하면 둘 다 진행돼요 — 위에서 그 볼트를 폐기하거나, 이 요청을 나중으로 미룰 수 있어요.`, `It clashes with ${live} bolt(s) in the line. Taken in as is, both go on.`))}</div>` : ''}
      <div class="acts"><button class="primary go" data-act="approve" data-test="plan-approve">${esc(p.mode === 'now' ? t('이 계획으로 시작', 'Start with this plan') : p.mode === 'merge' ? t('지금 작업에 합치기', 'Fold it in') : r.status === 'queued' ? t('이대로 줄에 두기', 'Keep it in line') : t('이 계획으로 줄에 세우기', 'Stand it in line'))}</button>
      <span class="sp"></span><button data-act="later" data-test="plan-later">${esc(t('나중에', 'Later'))}</button><button class="danger" data-act="decline" data-test="plan-decline">${esc(t('받지 않기', 'Decline'))}</button></div>`
  } else if (open_(r)) {
    foot = `<div class="note" data-test="plan-waiting">${esc(r.status === 'queued' ? t(`${r.decidedBy || ''} 님이 줄에 세웠어요. 앞 작업이 끝나면 접수 권한이 있는 사람이 시작해요.`, `${r.decidedBy || ''} stood it in line.`) : r.status === 'later' ? t('나중에 하기로 한 요청이에요.', 'Put off for later.') : t(`접수를 기다리고 있어요. ${names(V.people.intake)} 님이 계획안을 보고 시작·대기·합치기를 정해요.`, `Waiting: ${names(V.people.intake)} decide.`))}${r.note ? ` — ${esc(r.note)}` : ''}</div>
      ${r.mine ? `<div class="acts"><button data-act="withdraw" data-test="plan-withdraw">${esc(t('요청 거두기', 'Withdraw'))}</button></div>` : ''}`
  } else {
    foot = `<div class="note ${r.status === 'declined' || r.discarded ? 'bad' : 'good'}" data-test="plan-outcome">${esc(r.discarded && r.status !== 'declined' ? t('이 작업의 볼트는 모두 폐기됐어요.', 'Every bolt of this work was discarded.') : r.status === 'started' ? t(`${r.decidedBy || ''} 님이 시작했어요${r.done ? ' · 끝났어요' : ''}.`, `${r.decidedBy || ''} started it${r.done ? ' · finished' : ''}.`) : r.status === 'merged' ? t(`${r.decidedBy || ''} 님이 진행 중이던 작업에 합쳤어요.`, `${r.decidedBy || ''} folded it into the work in flight.`) : t(`${r.decidedBy || ''} 님이 받지 않기로 했어요.`, `${r.decidedBy || ''} declined it.`))}${r.note ? ` — ${esc(r.note)}` : ''}
      ${['started', 'merged'].includes(r.status) ? ` <a data-act="line">${esc(t('볼트 줄에서 보기', 'See the line'))} →</a>` : ''}</div>`
  }
  if (can && r.note && ['later', 'inbox'].includes(r.status)) foot = `<div class="note">${esc(r.note)}</div>${foot}`
  el.innerHTML = `${head}${scope}<p class="sum" data-test="plan-summary">${esc(e.summary)}</p>${touches}${conflicts ? `<div class="sec">${esc(t('줄에 있는 볼트와 부딪히는 곳', 'Where it collides with the line'))}</div>${conflicts}` : ''}${card ? '' : `${scores}${near}`}${foot}${card && (scores || near) ? `<p class="small" style="margin:10px 2px 0"><a data-act="large" data-test="plan-large">${esc(t('어떻게 가늠했는지 · 다른 요청 보기', 'How it was sized · the other requests'))} →</a></p>` : ''}${e.cost && !e.cost.stub ? `<p class="faint small" style="margin-top:14px">${esc(t(`계획 세우는 데 ${Math.round(e.cost.ms / 1000)}초 · ${e.cost.turns}턴 · $${Number(e.cost.usd || 0).toFixed(2)}`, `Planned in ${Math.round(e.cost.ms / 1000)} s · ${e.cost.turns} turns · $${Number(e.cost.usd || 0).toFixed(2)}`))}</p>` : ''}`
}

function unitsEdit(on) {
  const all = [...new Set(V.line.bolts.filter((b) => b.kind === 'intent' && b.unit !== '*').map((b) => b.unit))]
  return `<div class="units-edit" data-test="plan-impact-box">${all.map((u) => `<label><input type="checkbox" value="${esc(u)}"${on.includes(u) ? ' checked' : ''}> ${esc(u)}</label>`).join('')}
    <div class="row"><input type="text" id="impact-note" placeholder="${esc(t('한마디(선택)', 'A note (optional)'))}"><button class="primary" data-act="impact" data-test="plan-impact-save">${esc(t('이대로 확인', 'Confirm'))}</button><button data-act="units">${esc(t('닫기', 'Close'))}</button></div></div>`
}

function ledger() {
  if (!V.ledger?.length) return ''
  return `<div class="sec">${esc(t('최근 결정', 'Lately decided'))}</div><ul class="ledger" data-test="intake-ledger">${V.ledger.slice(0, 12).map((d) => `<li><span class="faint">${esc(lite.ago(d.at))}</span><span><b>${esc(d.who || '')}</b> · ${esc(d.question || '')} — ${esc(d.choice || '')}${d.note ? ` <span class="faint">(${esc(d.note)})</span>` : ''}</span></li>`).join('')}</ul>`
}

// ---------- dialogs ----------
function dialog(html) {
  $('#dlg').innerHTML = `<div class="veil"><div class="dlg" data-test="dialog">${html}</div></div>`
  $('#dlg').querySelector('textarea, input')?.focus()
}
const closeDialog = () => { $('#dlg').innerHTML = '' }
function reasonDialog({ title, text, placeholder, ok, danger, act }) {
  dialog(`<h2>${esc(title)}</h2><p>${esc(text)}</p><textarea id="why" data-test="dialog-reason" placeholder="${esc(placeholder)}"></textarea>
    <div class="acts"><button data-act="close">${esc(t('닫기', 'Close'))}</button><button class="${danger ? 'danger' : 'primary'}" data-act="${act}" data-test="dialog-ok">${esc(ok)}</button></div>`)
}
async function discardDialog(key) {
  let pv
  try { pv = await lite.tool('intake_discard_preview', { folder, key }) } catch (e) { return toast(e.message) }
  const b = boltOf(key)
  const what = { revert: t('이미 끝난 볼트예요. 폐기하면 되돌리는 작업 요청이 새로 만들어져요.', 'This bolt is finished: discarding makes a request that reverts it.'),
    stop: t('지금 돌고 있는 볼트예요. 세션을 멈추고, 이 볼트가 바꾼 파일을 시작 전으로 되돌려요. AI-DLC 기록은 그대로 남아요.', 'This bolt is running: the session is stopped and the files it changed are put back. The AI-DLC record stays.'),
    drop: t('아직 시작하지 않은 볼트예요. 쓴 것이 없으니 줄에서 빼기만 해요.', 'This bolt has not started: it only leaves the line.') }[pv.kind]
  const f = pv.files
  dialog(`<h2>${esc(t(`B${b?.n || ''} ${pv.bolt.title} 폐기`, `Discard B${b?.n || ''} ${pv.bolt.title}`))}</h2><p>${esc(what)}</p>
    ${f ? (f.moved ? `<div class="note warn">${esc(t(`시작한 뒤 커밋이 ${f.moved.commits}개 생겼어요. 파일은 건드리지 않고, 되돌리기는 사람이 해야 해요.`, `${f.moved.commits} commit(s) were made since: nothing is put back.`))}</div>` : `<div class="small muted">${esc(t(`되돌릴 파일 ${f.changed.length}개 · 치울 새 파일 ${f.made.length}개`, `${f.changed.length} file(s) to put back · ${f.made.length} new file(s) to set aside`))}</div>${f.changed.length + f.made.length ? `<div class="files">${[...f.changed, ...f.made.map((x) => `+ ${x}`)].slice(0, 40).map(esc).join('<br>')}</div>` : ''}`) : ''}
    ${pv.dependents.length ? `<div class="small" style="margin-top:8px">${esc(t(`이 볼트를 기다리는 볼트 ${pv.dependents.length}개:`, `${pv.dependents.length} bolt(s) wait for it:`))} ${pv.dependents.map((d) => `B${d.n} ${esc(d.unit)}`).join(', ')}</div>
      <label class="opt"><input type="radio" name="dep" value="hold" checked> ${esc(t('멈춰 두기(권장)', 'Hold them (suggested)'))}</label><label class="opt"><input type="radio" name="dep" value="discard"> ${esc(t('함께 폐기', 'Discard them too'))}</label><label class="opt"><input type="radio" name="dep" value="keep"> ${esc(t('그대로 두기', 'Leave them'))}</label>` : ''}
    <textarea id="why" data-test="dialog-reason" placeholder="${esc(t('폐기하는 까닭(필수) — 요청한 사람과 원장에 남아요', 'The reason (required) — kept in the ledger'))}"></textarea>
    <div class="acts"><button data-act="close">${esc(t('닫기', 'Close'))}</button><button class="danger" data-act="discard-go" data-key="${esc(key)}" data-test="dialog-ok">${esc(t('폐기', 'Discard'))}</button></div>`)
}

// ---------- doing ----------
async function act(name, args, done) {
  try { const out = await lite.tool(name, { folder, ...args }); const said = typeof done === 'function' ? done(out) : done; if (said) toast(said); return out } catch (e) { toast(e.message); return null } finally { await load() }
}

document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-req], [data-act], [data-mode]')
  if (!el) return
  if (el.dataset.req) { sel = el.dataset.req; editUnits = false; drawList(); drawPlan(); window.scrollTo({ top: 0 }); return }
  if (el.dataset.mode) { if (!el.disabled) { pick[sel].mode = el.dataset.mode; drawPlan() } return }
  const a = el.dataset.act
  const r = V.requests.find((x) => x.id === sel)
  if (a === 'line') return lite.openApp('line')
  if (a === 'large') return lite.openApp('intake', { r: sel })
  if (a === 'see-bolt') return lite.openApp('line', { b: el.dataset.key })
  if (a === 'close') return closeDialog()
  if (a === 'units') { editUnits = !editUnits; return drawPlan() }
  if (a === 'impact') {
    const units = $$('.units-edit input[type=checkbox]').filter((x) => x.checked).map((x) => x.value)
    editUnits = false
    return act('intake_impact', { id: sel, units, note: $('#impact-note')?.value || '' }, t('영향 범위를 확인했어요', 'Impact confirmed'))
  }
  if (a === 'again') return act('intake_again', { id: sel })
  if (a === 'withdraw') return act('intake_triage', { id: sel, action: 'withdraw' }, t('요청을 거뒀어요', 'Withdrawn'))
  if (a === 'approve' || a === 'trust-go') {
    const p = pick[sel]
    el.disabled = true
    if (a === 'trust-go') closeDialog()
    const out = await act('intake_approve', { id: sel, scope: p.scope, mode: p.mode, fast: !!p.fast, trust: a === 'trust-go' }, (o) => (o.status === 'trust' ? '' : o.status === 'started' ? t('세션에 넘겼어요. 볼트 줄에서 진행을 볼 수 있어요', 'Handed to the session') : o.status === 'merged' ? t('진행 중인 작업에 합쳤어요', 'Folded in') : t('볼트 줄 끝에 세웠어요', 'Standing in line')))
    // Claude Code has not opened this folder before: its own safety question, answered by the person
    if (out?.status === 'trust') dialog(`<h2>${esc(t('이 폴더를 믿고 시작할까요?', 'Trust this folder and start?'))}</h2>
      <p>${esc(t(`Claude Code 가 「${V.folder.name}」 폴더를 처음 열어서, 믿을 수 있는 프로젝트인지 먼저 묻고 있어요. 믿는다고 답하면 이 폴더의 파일을 읽고 고치고 실행할 수 있어요.`, `Claude Code opens "${V.folder.name}" for the first time and asks whether the project is trusted. Trusted, it can read, edit and run files there.`))}</p>
      ${out.preApproved ? `<div class="note warn" data-test="trust-pre">${esc(t(`이 폴더의 설정이 도구 ${out.preApproved}개를 미리 허용해 두었어요. 그 도구들은 묻지 않고 실행돼요.`, `This folder's settings pre-approve ${out.preApproved} tool permissions: those run without asking.`))}</div>` : ''}
      <p class="small muted">${esc(t('답한 사람과 시각이 원장에 남아요.', 'Who answered, and when, is kept in the ledger.'))}</p>
      <div class="acts"><button data-act="close">${esc(t('닫기', 'Close'))}</button><button class="primary" data-act="trust-go" data-test="dialog-ok">${esc(t('믿고 시작', 'Trust and start'))}</button></div>`)
    return
  }
  if (a === 'later') return reasonDialog({ title: t('나중에 하기', 'Later'), text: t(`「${r.title}」 요청을 지금은 줄에 세우지 않아요. 까닭은 요청한 사람에게 전해져요.`, `"${r.title}" is not taken in now. The asker is told why.`), placeholder: t('까닭', 'The reason'), ok: t('나중에', 'Later'), act: 'later-go' })
  if (a === 'decline') return reasonDialog({ title: t('받지 않기', 'Decline'), text: t(`「${r.title}」 요청을 받지 않아요. 까닭은 요청한 사람에게 전해져요.`, `"${r.title}" is declined. The asker is told why.`), placeholder: t('까닭', 'The reason'), ok: t('받지 않기', 'Decline'), danger: true, act: 'decline-go' })
  if (a === 'later-go' || a === 'decline-go') {
    const note = $('#why').value.trim()
    if (note.length < 2) return toast(t('까닭을 적어 주세요', 'Give the reason'))
    closeDialog()
    return act('intake_triage', { id: sel, action: a === 'later-go' ? 'later' : 'decline', note }, t('요청한 사람에게 알렸어요', 'The asker was told'))
  }
  if (a === 'discard') return discardDialog(el.dataset.key)
  if (a === 'discard-go') {
    const reason = $('#why').value.trim()
    if (reason.length < 2) return toast(t('폐기하는 까닭을 적어 주세요', 'Give the reason'))
    const dependents = document.querySelector('input[name=dep]:checked')?.value || 'hold'
    closeDialog()
    return act('intake_discard', { key: el.dataset.key, reason, dependents, forRequest: sel }, (o) => (o.kind === 'revert' ? t('되돌리는 요청을 만들었어요', 'A revert request was made') : t('볼트를 폐기했어요. 이제 이 요청을 접수할 수 있어요', 'Discarded: this request can be taken in now')))
  }
})
document.addEventListener('change', (ev) => {
  if (ev.target.id === 'scope') { pick[sel].scope = ev.target.value; drawPlan() }
  if (ev.target.id === 'fast') pick[sel].fast = ev.target.checked
})
document.addEventListener('click', async (ev) => {
  if (ev.target.id !== 'send' || sending) return
  const body = $('#body').value.trim()
  if (body.length < 4) return toast(t('무엇을 하고 싶은지 적어 주세요', 'Say what you want done'))
  sending = true; ev.target.disabled = true
  try {
    const r = await lite.tool('intake_propose', { folder, body })
    $('#body').value = ''
    sel = r.id
  } catch (e) { toast(e.message) }
  sending = false; $('#send').disabled = false
  await load()
})

// someone asked, a plan came out, the line changed
let again = null
lite.on('aidlc.intake', () => { clearTimeout(again); again = setTimeout(load, 300) })
lite.on('aidlc.waits', () => { clearTimeout(again); again = setTimeout(load, 300) })
// (a plan that is being worked out in another process: look again while one is)
setInterval(() => { if (V?.requests.some((r) => r.status === 'estimating') && !$('#dlg').innerHTML) load() }, 5000)

V = lite.initial && lite.initial.requests ? lite.initial : null
if (V) draw(); else await load()
