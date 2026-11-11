// 볼트 보드 — bolts → units → construction stages; a unit's progress, documents and the live session.
import lite from '../../_runtime/lite.js'
const { t, esc, $, $$ } = lite
await lite.ready
const folder = lite.params.folder
let T = null
let sel = lite.params.unit || null
let U = null
let screenTimer = null
const STATE = { done: t('끝남', 'Done'), working: t('진행 중', 'In progress'), waiting: t('승인 대기', 'Awaiting approval'), ready: t('시작 가능', 'Ready'), blocked: t('의존 대기', 'Blocked'), pending: t('대기', 'Pending'), started: t('진행 중', 'In progress') }
const dur = (m) => (m == null ? '–' : m < 1 ? t('1분 미만', '<1m') : m < 60 ? `${Math.round(m)}${t('분', 'm')}` : `${(m / 60).toFixed(1)}${t('시간', 'h')}`)
const short = { 'functional-design': t('기능 설계', 'Functional'), 'nfr-requirements': t('NFR 요구', 'NFR req.'), 'nfr-design': t('NFR 설계', 'NFR design'), 'infrastructure-design': t('인프라', 'Infra'), 'code-generation': t('코드 생성', 'Code') }

async function load() {
  try { T = await lite.tool('bolts_open', { folder }) } catch (e) { $('#tree').innerHTML = `<p class="hint">${esc(e.message)}</p>`; return }
  $('#title').textContent = (T.intent?.project || T.intent?.slug || '').split(/(?<=[.!?。])\s|—/)[0].slice(0, 80)
  const nb = T.bolts.filter((b) => !b.loose).length, nu = T.bolts.reduce((n, b) => n + b.units.length, 0)
  $('#sub').textContent = `${T.intent?.slug || ''} · ${t(`볼트 ${nb}개 · 유닛 ${nu}개`, `${nb} bolt(s) · ${nu} unit(s)`)}`
  $('#now').innerHTML = T.now ? `${esc(t('지금 세션이 만드는 유닛', 'The session is on'))}<b>${esc(T.now.unit)} · ${esc(T.stageNames[T.now.stage] || T.now.stage)}</b>` : T.stage ? `${esc(t('지금 단계', 'Stage'))}<b>${esc(T.stage.name)}</b>` : ''
  $('#tree').innerHTML = T.bolts.length ? T.bolts.map(bolt).join('') : `<p class="hint">${esc(t('아직 볼트 계획(딜리버리 계획)이나 유닛이 없어요. 인셉션의 유닛 생성·딜리버리 계획이 끝나면 여기에 볼트와 유닛이 나타나요.', 'No bolt plan or units yet. They appear once units generation and delivery planning are done.'))}</p>`
  if (!sel && T.now) sel = T.now.unit
  if (sel) pick(sel, false)
  else $('#detail').innerHTML = `<p class="hint">${esc(t('유닛을 누르면 진척 요약과 그 유닛을 만드는 Claude Code 세션이 여기에 보여요.', 'Pick a unit to see its progress and the Claude Code session building it.'))}</p>`
}

function bolt(b) {
  return `<div class="bolt" data-test="bolts-bolt"><div class="bh"><span class="n">${b.loose ? esc(t('Bolt 밖 유닛', 'Units outside a bolt')) : 'Bolt ' + b.n}</span>${b.loose ? '' : `<span>${esc(b.name)}</span>`}${b.after?.length ? `<span class="after">← Bolt ${b.after.join(', ')}</span>` : ''}<span class="state ${b.status}">${esc(STATE[b.status] || b.status)}</span></div>
    ${b.units.map(unit).join('')}</div>`
}
function unit(u) {
  return `<div class="unit${u.running ? ' running' : ''}${sel === u.name ? ' sel' : ''}" data-unit="${esc(u.name)}" data-test="bolts-unit">
    <span class="live${u.running ? ' pulse' : ''}"></span>
    <div class="nm">${esc(u.name)}${u.kind ? `<span class="chip kind">${esc(u.kind)}</span>` : ''}<span class="state ${u.status}">${esc(STATE[u.status] || u.status)}</span></div>
    <div class="meta">${esc(t('AI', 'AI'))} ${dur(u.workMin)} · ${esc(t('사람', 'Human'))} ${dur(u.humanMin)}${u.checks?.ok || u.checks?.failed ? ` · ✓${u.checks.ok}${u.checks.failed ? ` ✗${u.checks.failed}` : ''}` : ''}</div>
    <div class="rail">${u.stages.map((s) => `<span class="s ${s.state}" title="${esc(T.stageNames[s.slug] || s.slug)} ${s.min != null ? dur(s.min) : ''}">${esc(short[s.slug] || s.slug)}</span>`).join('')}</div></div>`
}

async function pick(name, redraw = true) {
  sel = name
  for (const el of $$('.unit')) el.classList.toggle('sel', el.dataset.unit === name)
  try { U = await lite.tool('bolts_unit', { folder, name }) } catch (e) { $('#detail').innerHTML = `<p class="hint">${esc(e.message)}</p>`; return }
  const u = U.unit
  $('#detail').innerHTML = `<div class="d-head"><b>${esc(u.name)}</b>${u.kind ? `<span class="chip">${esc(u.kind)}</span>` : ''}<span class="state ${u.status}">${esc(STATE[u.status] || u.status)}</span></div>
    ${u.dependsOn?.length ? `<div class="muted small">${esc(t('의존', 'Depends on'))}: ${esc(u.dependsOn.join(', '))}</div>` : ''}
    <div class="kv"><div><div class="k">${esc(t('단계', 'Stages'))}</div><div class="v">${U.stages.filter((s) => s.state === 'done' || s.state === 'skipped').length}/${U.stages.length}</div></div><div><div class="k">${esc(t('AI 작업', 'AI work'))}</div><div class="v">${dur(u.workMin)}</div></div><div><div class="k">${esc(t('사람 대기', 'Human wait'))}</div><div class="v">${dur(u.humanMin)}</div></div></div>
    <div class="sec">${esc(t('세션', 'Session'))}</div><div id="shell"></div>
    <div class="stg">${U.stages.map((s) => { const now = U.running && U.now?.stage === s.slug; return `<div class="row${now ? ' working' : ''}"><span class="dot" style="background:${s.state === 'done' ? 'var(--ok)' : now || s.state === 'working' ? 'var(--accent)' : 'var(--line)'}"></span>${esc(s.name)} <span class="faint small">${esc(s.role || '')}</span><span class="t">${now ? esc(t('지금', 'now')) + ' · ' : ''}${dur(s.min)}</span></div>` }).join('')}</div>
    ${U.docs.length ? `<div class="sec">${esc(t('이 유닛의 산출물', 'This unit’s artifacts'))}</div>${[...new Set(U.docs.map((d) => d.stage))].map((st) => `<div class="dstage">${esc(st)}</div><div class="docs">${U.docs.filter((d) => d.stage === st && !/-questions\.md$|^review-\d+\.md$|^memory\.md$/.test(d.name)).map((d) => `<button class="doc" data-doc="${esc(d.path)}">📄 ${esc(d.name)}</button>`).join('')}</div>`).join('')}` : ''}
    ${U.events.length ? `<div class="sec">${esc(t('최근 일', 'Lately'))}</div><ul class="ev">${U.events.map((e) => `<li><span class="tm">${esc(new Date(e.ts).toLocaleTimeString(lite.lang === 'en' ? 'en-US' : 'ko-KR', { hour: '2-digit', minute: '2-digit' }))}</span><span>${esc(e.what)} · ${esc(e.stage)}${e.detail ? ' · ' + esc(e.detail) : ''}</span></li>`).join('')}</ul>` : ''}`
  shell()
}

// the session's screen for the unit it is building now; refreshed every 3 s while that unit is open
async function shell() {
  clearTimeout(screenTimer)
  const box = $('#shell')
  if (!box || !U) return
  if (!U.running) {
    box.innerHTML = `<div class="shellbar"><span class="muted">${esc(U.unit.status === 'done' ? t('이 유닛은 끝났어요. 세션은 다른 일을 하고 있어요.', 'This unit is done; the session is on other work.') : t('세션이 아직 이 유닛을 만들고 있지 않아요.', 'The session is not on this unit yet.'))}</span>${T.session.running ? `<button data-act="open">${esc(t('작업실에서 열기', 'Open in the workroom'))}</button>` : ''}</div>`
    return
  }
  let s
  try { s = await lite.tool('bolts_screen', { folder, lines: 26 }) } catch { s = null }
  if (!$('#shell') || sel !== U.unit.name) return
  box.innerHTML = `<div class="shellbar"><span class="muted">${s?.prompt ? '⏳ ' + esc(s.prompt.title) : esc(t('Claude Code 가 이 유닛을 만들고 있어요 — 3초마다 갱신', 'Claude Code is building this unit — refreshed every 3 s'))}</span><button class="primary" data-act="open" data-test="bolts-open-shell">${esc(t('작업실에서 열기', 'Open in the workroom'))}</button></div>
    <pre class="screen" data-test="bolts-screen">${esc(s?.running ? s.text : t('세션이 떠 있지 않아요.', 'The session is not running.'))}</pre>`
  const pre = box.querySelector('.screen'); if (pre) pre.scrollTop = pre.scrollHeight
  screenTimer = setTimeout(shell, 3000)
}

document.addEventListener('click', (e) => {
  const u = e.target.closest('[data-unit]')
  if (u) return pick(u.dataset.unit)
  const d = e.target.closest('[data-doc]')
  if (d) return lite.openApp('artifact', { path: d.dataset.doc })
  const a = e.target.closest('[data-act]')
  if (a?.dataset.act === 'open') return lite.navigate(T.session.workroom)
})
lite.on('aidlc.waits', load)
setInterval(() => { if (!document.hidden) load() }, 20000)
load()
