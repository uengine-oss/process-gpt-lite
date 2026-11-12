// 볼트 줄 — every bolt of the project in one line: lanes (the units) down, releases across (released, this
// release, the next, the tail where new work stacks), the dependencies drawn between them. A bolt is picked to
// see what it waits for; the people the project gave it to move it, hold it, discard it and release.
import lite from '../../_runtime/lite.js'
const { t, esc, $, $$ } = lite
await lite.ready
const folder = lite.params.folder
let V = null
let sel = lite.params.b || null
let work = null          // a piece of work picked in the strip: its bolts stand out
let blocked = null       // a move that would break a dependency: { key, bucket, blockers, together }

const STATE = { done: t('끝남', 'Done'), running: t('도는 중', 'Running'), planned: t('예정', 'Planned'), estimated: t('예상', 'Expected') }
const BUCKET = { shipped: t('출시됨', 'Released'), now: t('이번 릴리스', 'This release'), next: t('다음 릴리스', 'Next release'), tail: t('줄 끝 · 릴리스 미정', 'Tail · no release yet') }
const SHORT = { shipped: t('출시됨', 'released'), now: t('이번 릴리스', 'this release'), next: t('다음 릴리스', 'next release'), tail: t('줄 끝', 'the tail') }
const COLS = [['shipped', null], ['now', 'done'], ['now', 'running'], ['now', 'planned'], ['next', null], ['tail', null]]
const HUES = [212, 28, 268, 152, 338, 190, 46, 300]
const groupOf = (b) => b.intent || b.request
const bolt = (key) => V.line.bolts.find((b) => b.key === key)
const unitName = (b) => (b.unit === '*' ? t('프로젝트 전체', 'whole project') : b.unit)
const toast = (text) => { const el = document.createElement('div'); el.className = 'toast'; el.textContent = text; document.body.append(el); setTimeout(() => el.remove(), 3400) }
const names = (list) => (list?.length ? list.join(', ') : t('폴더 소유자', 'the folder owners'))
const hm = (d) => new Date(d).toLocaleString(lite.lang === 'en' ? 'en-US' : 'ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
let works = []

async function load() {
  try { V = await lite.tool('line_open', { folder }) } catch (e) { $('#grid').innerHTML = `<p class="hint">${esc(e.message)}</p>`; return }
  draw()
}

function draw() {
  // the pieces of work, in the order of their first bolt
  works = []
  for (const b of V.line.bolts) {
    const g = groupOf(b)
    let w = works.find((x) => x.key === g)
    if (!w) works.push(w = { key: g, no: works.length + 1, title: b.title, scope: b.scope, bolts: [], hue: HUES[works.length % HUES.length] })
    w.bolts.push(b)
  }
  if (sel && !bolt(sel)) sel = null
  if (work && !works.some((w) => w.key === work)) work = null
  if (blocked && !bolt(blocked.key)) blocked = null
  $('#title').textContent = t(`${V.folder.name} · 볼트 줄`, `${V.folder.name} · bolt line`)
  const alive = V.line.bolts.filter((b) => !b.discarded)
  $('#sub').textContent = t(`작업 ${works.length}건 · 볼트 ${alive.length}개 · 끝남 ${alive.filter((b) => b.state === 'done').length} · 도는 중 ${alive.filter((b) => b.state === 'running').length} · 기다림 ${alive.filter((b) => ['planned', 'estimated'].includes(b.state)).length}`,
    `${works.length} piece(s) of work · ${alive.length} bolts · ${alive.filter((b) => b.state === 'done').length} done · ${alive.filter((b) => b.state === 'running').length} running`)
  drawHead(); drawWorks(); drawGrid(); drawPicked(); drawRelease(); drawChange()
  requestAnimationFrame(drawArrows)
}

function drawHead() {
  const h = V.head
  const el = $('#head')
  el.className = `headbox${h.busy ? '' : ' free'}`
  const next = h.next && V.requests.find((r) => r.id === h.next)
  el.innerHTML = `${h.busy ? `<span class="live pulse"></span><div>${esc(t('지금 도는 작업', 'In flight'))} <b>${esc(h.intent?.title || t('시작하는 중', 'starting'))}</b><div>${esc([h.intent?.scope, h.intent?.stage, h.intent?.unit].filter(Boolean).join(' · '))}</div></div>`
    : next ? `<span class="live"></span><div>${esc(t('줄 앞이 비었어요', 'The head is free'))}<div>${esc(t('다음', 'Next'))}: <b>${esc(next.title)}</b></div></div>${V.rights.intake ? `<button class="primary" data-act="start" data-id="${next.id}" data-test="line-start">${esc(t('다음 작업 시작', 'Start the next work'))}</button>` : `<span class="small">${esc(t(`${names(V.people.intake)} 님이 시작해요`, `${names(V.people.intake)} start it`))}</span>`}`
      : `<span class="live"></span><div>${esc(t('도는 작업도, 기다리는 작업도 없어요', 'Nothing in flight, nothing waiting'))}</div>`}
    <button data-act="intake" data-test="line-to-intake">＋ ${esc(t('작업 접수', 'Work intake'))}</button>`
}

function drawWorks() {
  $('#works').innerHTML = works.map((w) => {
    const live = w.bolts.filter((b) => !b.discarded)
    const done = live.length && live.every((b) => b.state === 'done')
    return `<button class="work${work === w.key ? ' on' : ''}${done ? ' done' : ''}" style="--wc:hsl(${w.hue} 70% 52%)" data-work="${esc(w.key)}" data-test="line-work"><span class="no">${w.no}</span><b>${esc(w.title)}</b>${w.scope ? `<span class="chip">${esc(w.scope)}</span>` : ''}<span class="cnt">${esc(t(`볼트 ${live.length}`, `${live.length} bolt(s)`))}${done ? ' ✓' : ''}</span></button>`
  }).join('')
}

function card(b) {
  const w = works.find((x) => x.key === groupOf(b))
  const related = sel && sel !== b.key && (bolt(sel)?.deps.some((d) => d.key === b.key) || b.deps.some((d) => d.key === sel))
  const dim = (work && groupOf(b) !== work) || (sel && !work && sel !== b.key && !related && false)
  const cls = ['bolt', b.state, b.hold ? 'hold' : '', b.discarded ? 'gone' : '', sel === b.key ? 'sel' : '', related ? 'related' : '', dim ? 'dim' : ''].filter(Boolean).join(' ')
  const badges = [b.discarded ? `<span class="gone">${esc(t('폐기', 'discarded'))}</span>` : '', b.hold && !b.discarded ? `<span class="hold">⏸ ${esc(t('멈춤', 'held'))}</span>` : '',
    b.stop && !b.discarded ? `<span class="${b.stop.security ? 'sec' : 'stop'}">${esc(b.stop.security ? t('보안 멈춤', 'security stop') : t('멈춤 요청', 'stop asked'))}</span>` : '',
    b.revert ? `<span>↩ ${esc(t('되돌리기', 'revert'))}</span>` : '', b.isNew ? `<span>＋ ${esc(t('새 유닛', 'new unit'))}</span>` : '', b.fast ? `<span>⚡ ${esc(t('빠른 줄', 'fast'))}</span>` : ''].join('')
  return `<button class="${cls}" style="--wc:hsl(${w?.hue ?? 212} 70% 52%)" data-bolt="${esc(b.key)}" data-test="line-bolt" data-state="${b.state}" data-bucket="${b.bucket}" data-unit="${esc(b.unit)}"${b.discarded ? ' data-gone="1"' : ''}${b.hold ? ' data-hold="1"' : ''}>
    <div class="l1"><span class="bn">B${b.n}</span><span class="faint">${w ? `#${w.no}` : ''}</span><span class="st">${b.state === 'running' && !b.discarded ? '● ' : ''}${esc(b.discarded ? t('폐기', 'discarded') : STATE[b.state])}</span></div>
    <div class="ti">${esc(b.title)}</div>${badges ? `<div class="bd">${badges}</div>` : ''}</button>`
}

function drawGrid() {
  const L = V.line
  if (!L.bolts.length) { $('#grid').innerHTML = `<p class="hint" style="grid-column:1/-1">${esc(t('아직 줄에 볼트가 없어요. 작업 접수에서 요청을 접수하면 여기에 쌓여요.', 'No bolts yet. Work taken in stacks here.'))}</p>`; return }
  const bk = Object.fromEntries(L.buckets.map((x) => [x.key, x]))
  const out = [`<div></div><div class="gh shipped">${esc(BUCKET.shipped)} <span class="cnt">${bk.shipped.total}</span></div><div class="gh now">${esc(BUCKET.now)} <span class="cnt">${esc(t(`${bk.now.done}/${bk.now.total} 끝남`, `${bk.now.done}/${bk.now.total} done`))}</span></div><div class="gh next">${esc(BUCKET.next)} <span class="cnt">${bk.next.total}</span></div><div class="gh tail">${esc(BUCKET.tail)} <span class="cnt">${bk.tail.total}</span></div>`,
    `<div class="sh"></div><div class="sh"></div><div class="sh now first">${esc(STATE.done)}</div><div class="sh">${esc(STATE.running)}</div><div class="sh">${esc(STATE.planned)}</div><div class="sh"></div><div class="sh tail">${esc(t('새로 접수한 작업이 여기에 쌓여요', 'new work stacks here'))}</div>`]
  L.lanes.forEach((lane, li) => {
    const last = li === L.lanes.length - 1 ? ' last' : ''
    out.push(`<div class="lane${last}">${esc(lane || t('프로젝트 전체', 'whole project'))}</div>`)
    COLS.forEach(([bucket, st], ci) => {
      const mine = L.bolts.filter((b) => b.lane === lane && b.bucket === bucket && (!st || (st === 'planned' ? ['planned', 'estimated'].includes(b.state) : b.state === st)))
      out.push(`<div class="cell b-${bucket}${ci === 1 ? ' first' : ''}${last}" data-bucket="${bucket}">${mine.map(card).join('')}</div>`)
    })
  })
  $('#grid').innerHTML = out.join('')
}

// the dependencies, provider → consumer; the picked bolt's stand out
function drawArrows() {
  const svg = $('#arrows'), inner = $('#inner')
  if (!svg || !V) return
  const box = inner.getBoundingClientRect()
  const at = Object.fromEntries($$('.bolt[data-bolt]', inner).map((el) => { const r = el.getBoundingClientRect(); return [el.dataset.bolt, { x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height }] }))
  const parts = [`<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" style="fill:var(--tt);stroke:none"/></marker><marker id="ahh" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" style="fill:var(--accent);stroke:none"/></marker></defs>`]
  for (const b of V.line.bolts) {
    if (b.discarded) continue
    for (const d of b.deps) {
      const p = at[d.key], c = at[b.key]
      if (!p || !c || bolt(d.key)?.discarded) continue
      const hl = sel && (sel === b.key || sel === d.key)
      const off = (sel && !hl) || (work && groupOf(b) !== work && groupOf(bolt(d.key)) !== work)
      let x1, y1, x2, y2, path
      if (c.x > p.x + p.w - 4) { x1 = p.x + p.w; y1 = p.y + p.h / 2; x2 = c.x - 2; y2 = c.y + c.h / 2; const m = Math.max(18, (x2 - x1) / 2); path = `M${x1} ${y1} C${x1 + m} ${y1} ${x2 - m} ${y2} ${x2} ${y2}` }
      else if (c.y >= p.y) { x1 = p.x + p.w * .7; y1 = p.y + p.h; x2 = c.x + c.w * .7; y2 = c.y - 2; path = `M${x1} ${y1} C${x1} ${y1 + 14} ${x2} ${y2 - 14} ${x2} ${y2}` }
      else { x1 = p.x + p.w * .7; y1 = p.y; x2 = c.x + c.w * .7; y2 = c.y + c.h + 2; path = `M${x1} ${y1} C${x1} ${y1 - 14} ${x2} ${y2 + 14} ${x2} ${y2}` }
      const cls = [d.via === 'lane' ? 'lane' : '', d.met ? '' : 'unmet', hl ? 'hl' : '', off ? 'off' : ''].filter(Boolean).join(' ')
      parts.push(`<path class="${cls}" d="${path}" marker-end="url(#${hl ? 'ahh' : 'ah'})"/>`)
      if (d.via && !['lane', 'unit', 'revert'].includes(d.via)) parts.push(`<text class="${hl ? 'hl' : off ? 'off' : ''}" x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 4}" text-anchor="middle">${esc(d.via)}</text>`)
    }
  }
  svg.innerHTML = parts.join('')
}

const depLine = (d, back) => {
  const x = bolt(d.key)
  if (!x) return ''
  const via = d.via === 'lane' ? t('같은 유닛의 앞 볼트', 'same unit, before') : d.via === 'unit' ? t('유닛 의존', 'unit dependency') : d.via === 'revert' ? t('되돌린 다음', 'after the revert') : `${d.via}${d.label ? ` · ${d.label}` : ''}`
  const met = back ? null : d.met
  return `<div class="dep" data-bolt="${esc(x.key)}"><b>B${x.n}</b> ${esc(x.title)} · ${esc(unitName(x))} <span class="via">${esc(via)}</span>${met == null ? '' : met ? `<span class="ok">✓ ${esc(t('끝남', 'done'))}</span>` : `<span class="wait">⏳ ${esc(SHORT[x.bucket])}</span>`}</div>`
}

function drawPicked() {
  const el = $('#picked')
  const b = sel && bolt(sel)
  if (!b) { el.innerHTML = `<h3>${esc(t('고른 볼트', 'The bolt picked'))}</h3><p class="muted small">${esc(t('볼트를 누르면 무엇을 기다리는지, 무엇이 이 볼트를 기다리는지 보여요. 화살표는 먼저 끝나야 하는 볼트에서 나와요.', 'Pick a bolt to see what it waits for and what waits for it. An arrow leaves the bolt that must finish first.'))}</p>`; return }
  const w = works.find((x) => x.key === groupOf(b))
  const after = V.line.bolts.filter((x) => !x.discarded && x.deps.some((d) => d.key === b.key)).map((x) => ({ key: x.key, via: x.deps.find((d) => d.key === b.key).via, label: x.deps.find((d) => d.key === b.key).label }))
  const req = b.request && V.requests.find((r) => r.id === b.request)
  const R = V.rights
  const canMove = R.intake && b.bucket !== 'shipped' && !b.discarded
  const live = b.state !== 'done' && !b.discarded
  const isNext = !V.head.busy && b.request && V.head.next === b.request
  const d = b.discarded
  const rs = d?.restored
  el.innerHTML = `<h3>${esc(t('고른 볼트', 'The bolt picked'))}</h3>
    <div class="pk-head" data-test="picked-head"><span class="bn">B${b.n}</span><b>${esc(b.title)}</b><span class="chip">${esc(unitName(b))}</span><span class="chip" data-test="picked-state">${esc(d ? t('폐기', 'discarded') : STATE[b.state])}</span><span class="chip" data-test="picked-bucket">${esc(SHORT[b.bucket])}</span></div>
    ${d ? `<div class="note bad" data-test="picked-discarded">${esc(t(`${d.by || ''} 님이 폐기했어요`, `Discarded by ${d.by || ''}`))} · ${esc(hm(d.at))}<br>${esc(d.reason)}${d.forTitle ? `<br>${esc(t(`「${d.forTitle}」 요청에 자리를 내줬어요`, `It gave way to "${d.forTitle}"`))}` : ''}${rs ? `<br>${esc(rs.error ? t(`파일을 되돌리지 못했어요: ${rs.error}`, `Files not put back: ${rs.error}`) : rs.moved ? t(`커밋 ${rs.moved.commits}개가 생겨 파일은 그대로 두었어요 — 사람이 되돌려야 해요`, `${rs.moved.commits} commit(s) since — left for a person to revert`) : t(`파일 ${rs.restored.length}개를 시작 전으로 되돌리고 새 파일 ${rs.removed.length}개를 치웠어요. AI-DLC 기록은 그대로예요.`, `${rs.restored.length} file(s) put back, ${rs.removed.length} new file(s) set aside. The AI-DLC record stays.`))}` : ''}</div>` : ''}
    ${b.stop && !d ? `<div class="note ${b.stop.security ? 'bad' : 'warn'}" data-test="picked-stop">${esc(b.stop.security ? t(`${b.stop.by} 님이 보안 사유로 멈췄어요`, `${b.stop.by} paused it for a security reason`) : t(`${b.stop.by} 님이 멈춰 달라고 요청했어요`, `${b.stop.by} asks for it to be stopped`))} · ${esc(hm(b.stop.at))}<br>${esc(b.stop.reason)}${R.stop ? '' : `<br><span class="muted">${esc(t(`${names(V.people.stop)} 님이 이어 갈지 폐기할지 정해요`, `${names(V.people.stop)} decide`))}</span>`}</div>` : ''}
    <div class="kvs">
      <span class="k">${esc(t('작업', 'Work'))}</span><span>#${w?.no || ''} ${esc(b.title)}${b.scope ? ` <span class="chip">${esc(b.scope)}</span>` : ''}${req ? ` · ${esc(t(`${req.asker.name} 요청`, `asked by ${req.asker.name}`))} <a data-act="request" data-id="${req.id}">${esc(t('요청 보기', 'the request'))}</a>` : ` · ${esc(t('접수 이전부터 있던 작업', 'from before the line'))}`}</span>
      <span class="k">${esc(t('기다리는 볼트', 'Waits for'))}</span><span data-test="picked-deps">${b.deps.map((x) => depLine(x)).join('') || `<span class="faint">${esc(t('없음 — 바로 시작할 수 있어요', 'nothing'))}</span>`}</span>
      <span class="k">${esc(t('이 볼트를 기다림', 'Waited for by'))}</span><span data-test="picked-after">${after.map((x) => depLine(x, true)).join('') || `<span class="faint">${esc(t('없음', 'nothing'))}</span>`}</span>
    </div>
    ${isNext && R.intake ? `<div class="acts"><button class="primary" data-act="start" data-id="${b.request}" data-test="picked-start">${esc(t('이 작업 시작', 'Start this work'))}</button></div>` : ''}
    ${canMove ? `<div class="acts"><span class="lbl">${esc(t('릴리스 옮기기', 'Move to'))}</span>${['now', 'next', 'tail'].filter((k) => k !== b.bucket).map((k) => `<button class="sm" data-act="move" data-to="${k}" data-test="picked-move-${k}">${esc(SHORT[k])}</button>`).join('')}</div>` : ''}
    ${blocked && blocked.key === b.key ? blockedNote() : ''}
    ${live ? `<div class="acts">${R.stop ? (b.hold ? `<button class="sm" data-act="resume" data-test="picked-resume">▶ ${esc(t('다시 진행', 'Carry on'))}</button>` : `<button class="sm" data-act="hold" data-test="picked-hold">⏸ ${esc(t('멈춰 두기', 'Hold'))}</button>`) : ''}
      ${R.stop ? '' : `<button class="sm" data-act="ask-stop" data-test="picked-ask-stop">✋ ${esc(t('멈춤 요청', 'Ask to stop'))}</button>`}
      ${R.stop ? `<button class="sm danger" data-act="discard" data-test="picked-discard">${esc(t('폐기', 'Discard'))}</button>` : ''}</div>` : ''}
    ${b.state === 'done' && !d && R.stop && b.bucket !== 'shipped' ? `<div class="acts"><button class="sm danger" data-act="discard" data-test="picked-discard">${esc(t('되돌리기 요청 만들기', 'Make a revert request'))}</button></div>` : ''}
    ${!R.stop && live ? `<p class="faint small" style="margin:8px 0 0">${esc(t(`멈추기·폐기는 ${names(V.people.stop)} 님이 할 수 있어요. 보안 문제라면 멈춤 요청에서 「보안」을 고르세요 — 바로 멈춰요.`, `${names(V.people.stop)} may hold and discard. For a security problem, tick "security" — it pauses at once.`))}</p>` : ''}`
}

function drawRelease() {
  const L = V.line
  const rows = ['now', 'next', 'tail'].map((k) => {
    const bk = L.buckets.find((x) => x.key === k)
    const mine = L.bolts.filter((b) => b.bucket === k && !b.discarded)
    // a bolt this release waits for that sits in a later one
    const broken = mine.filter((b) => b.deps.some((d) => { const p = bolt(d.key); return p && !p.discarded && ['shipped', 'now', 'next', 'tail'].indexOf(p.bucket) > ['shipped', 'now', 'next', 'tail'].indexOf(k) }))
    const ready = bk.total > 0 && bk.done === bk.total && !broken.length
    const text = !bk.total ? t('볼트 없음', 'no bolts') : broken.length ? t(`뒤 릴리스의 볼트를 기다리는 볼트 ${broken.length}개`, `${broken.length} bolt(s) wait for a later release`) : ready ? t(`볼트 ${bk.total}개가 모두 끝났어요`, `all ${bk.total} bolt(s) done`)
      : t(`${bk.done}/${bk.total} 끝남${bk.running ? ` · 도는 중 ${bk.running}` : ''}${bk.held ? ` · 멈춤 ${bk.held}` : ''}`, `${bk.done}/${bk.total} done${bk.running ? ` · ${bk.running} running` : ''}${bk.held ? ` · ${bk.held} held` : ''}`)
    return `<div class="rel" data-test="release-${k}" data-ready="${ready ? 1 : 0}"><span class="mk ${!bk.total ? '' : ready ? 'ok' : 'no'}">${!bk.total ? '–' : ready ? '✓' : '!'}</span><span class="nm">${esc(SHORT[k])}</span>${k === 'now' && V.rights.intake ? `<button class="sm${ready ? ' primary' : ''}" data-act="release"${ready ? '' : ' disabled'} data-test="release-go">${esc(t('내보내기', 'Release'))}</button>` : '<span></span>'}<span class="ds">${esc(text)}</span></div>`
  })
  const shipped = L.buckets.find((x) => x.key === 'shipped').total
  $('#release').innerHTML = `<h3>${esc(t('릴리스 확인', 'Release check'))}</h3>${rows.join('')}<p class="faint small" style="margin:8px 0 0">${esc(t(`출시된 볼트 ${shipped}개 · 한 릴리스의 볼트는 서로 기다리는 것까지 같은 릴리스나 앞 릴리스에 있어야 내보낼 수 있어요.`, `${shipped} bolt(s) released · a release needs everything its bolts wait for in it or before it.`))}</p>`
}

// a move that would break a dependency is answered where it was asked: under the buttons of the bolt picked
function blockedNote() {
  const b = bolt(blocked.key)
  const n = blocked.together.length
  return `<div class="blocked">
      <div class="note warn" data-test="move-blocked">${esc(t(`B${b.n} ${unitName(b)} 볼트만 ${SHORT[blocked.bucket]}(으)로 옮길 수는 없어요.`, `B${b.n} ${unitName(b)} cannot move to ${SHORT[blocked.bucket]} alone.`))}</div>
      <ul class="blk">${blocked.blockers.map((x) => `<li data-test="move-blocker"><span class="bn">B${x.n}</span> ${esc(x.title)} · ${esc(x.unit === '*' ? '' : x.unit)} — ${esc(x.why === 'provider' ? t(`먼저 끝나야 하는데 ${SHORT[x.bucket]}에 남아요`, `must finish first but stays in ${SHORT[x.bucket]}`) : t(`이 볼트를 기다리는데 ${SHORT[x.bucket]}에 남아요`, `waits for it but stays in ${SHORT[x.bucket]}`))}${x.via && !['lane', 'unit'].includes(x.via) ? ` <span class="chip">${esc(x.via)}</span>` : ''}</li>`).join('')}</ul>
      <div class="acts">${n ? `<button class="primary" data-act="move-together" data-test="move-together">${esc(t(`볼트 ${n}개를 함께 옮기기`, `Move all ${n} together`))}</button>` : `<span class="small muted">${esc(t('이미 출시된 볼트에 묶여 있어 함께 옮길 수도 없어요', 'Tied to a released bolt'))}</span>`}<button data-act="move-cancel" data-test="move-cancel">${esc(t('그대로 두기', 'Leave it'))}</button></div></div>`
}

function drawChange() {
  const el = $('#change')
  el.innerHTML = `<h3>${esc(t('최근 결정', 'Lately decided'))}</h3>${V.ledger?.length ? `<ul class="ledger" data-test="line-ledger">${V.ledger.slice(0, 9).map((d) => `<li><span class="tm">${esc(lite.ago(d.at))}</span><span><b>${esc(d.who || '')}</b> · ${esc(d.question || '')} — ${esc(d.choice || '')}${d.note ? ` <span class="faint">(${esc(d.note)})</span>` : ''}</span></li>`).join('')}</ul>` : `<p class="muted small">${esc(t('접수·줄 바꾸기·멈춤·폐기는 누가 왜 했는지 여기에 남아요.', 'Who took in, moved, stopped or discarded what, and why, is kept here.'))}</p>`}`
}

// ---------- dialogs ----------
function dialog(html) { $('#dlg').innerHTML = `<div class="veil"><div class="dlg" data-test="dialog">${html}</div></div>`; $('#dlg').querySelector('textarea, input[type=text]')?.focus() }
const closeDialog = () => { $('#dlg').innerHTML = '' }
async function discardDialog(key) {
  let pv
  try { pv = await lite.tool('line_discard_preview', { folder, key }) } catch (e) { return toast(e.message) }
  const b = bolt(key)
  const what = { revert: t('이미 끝난 볼트예요. 끝난 작업은 지우지 않아요 — 되돌리는 작업 요청이 새로 만들어져 줄에 서요.', 'This bolt is finished. Finished work is not erased: a request that reverts it is made.'),
    stop: t('지금 돌고 있는 볼트예요. 세션을 멈추고, 이 볼트가 바꾼 파일을 시작 전으로 되돌려요. AI-DLC 기록(무엇을 묻고 정했는지)은 그대로 남아요.', 'This bolt is running: the session is stopped and the files it changed are put back. The AI-DLC record stays.'),
    drop: t('아직 시작하지 않은 볼트예요. 쓴 것이 없으니 줄에서 빼기만 해요.', 'This bolt has not started: it only leaves the line.') }[pv.kind]
  const f = pv.files
  dialog(`<h2>${esc(t(`B${b.n} ${pv.bolt.title} · ${unitName(b)} 폐기`, `Discard B${b.n} ${pv.bolt.title} · ${unitName(b)}`))}</h2><p data-test="discard-kind" data-kind="${pv.kind}">${esc(what)}</p>
    ${pv.kind === 'stop' && !pv.snapshot ? `<div class="note warn">${esc(t('이 볼트가 시작할 때의 파일 상태를 잡아 두지 못했어요. 파일은 건드리지 않아요.', 'No snapshot was taken when this bolt started: files are left as they are.'))}</div>` : ''}
    ${f ? (f.moved ? `<div class="note warn">${esc(t(`시작한 뒤 커밋이 ${f.moved.commits}개 생겼어요. 파일은 건드리지 않고, 되돌리기는 사람이 해야 해요.`, `${f.moved.commits} commit(s) were made since: nothing is put back.`))}</div>` : `<div class="small muted" data-test="discard-files">${esc(t(`되돌릴 파일 ${f.changed.length}개 · 치울 새 파일 ${f.made.length}개`, `${f.changed.length} file(s) to put back · ${f.made.length} new file(s) to set aside`))}</div>${f.changed.length + f.made.length ? `<div class="files">${[...f.changed, ...f.made.map((x) => `+ ${x}`)].slice(0, 40).map(esc).join('<br>')}</div>` : ''}`) : ''}
    ${pv.dependents.length ? `<div class="small" style="margin-top:10px" data-test="discard-dependents">${esc(t(`이 볼트를 기다리는 볼트 ${pv.dependents.length}개`, `${pv.dependents.length} bolt(s) wait for it`))}: ${pv.dependents.map((d) => `B${d.n} ${esc(d.unit)}`).join(', ')}</div>
      <label class="opt"><input type="radio" name="dep" value="hold" checked> ${esc(t('멈춰 두기(권장) — 다시 정할 때까지 시작하지 않아요', 'Hold them (suggested)'))}</label><label class="opt"><input type="radio" name="dep" value="discard"> ${esc(t('함께 폐기', 'Discard them too'))}</label><label class="opt"><input type="radio" name="dep" value="keep"> ${esc(t('그대로 두기', 'Leave them'))}</label>` : ''}
    ${pv.whole && pv.rights.archive && pv.kind !== 'revert' ? `<label class="opt"><input type="checkbox" id="archive"> ${esc(t('이 작업의 마지막 볼트예요 — AI-DLC 기록에서도 인텐트를 보관함으로 옮기기', 'Its last bolt — archive the intent in the AI-DLC record too'))}</label>` : ''}
    <textarea id="why" data-test="dialog-reason" placeholder="${esc(t('폐기하는 까닭(필수) — 요청한 사람에게 전해지고 원장에 남아요', 'The reason (required) — told to the asker and kept in the ledger'))}"></textarea>
    <div class="acts"><button data-act="close">${esc(t('닫기', 'Close'))}</button><button class="danger" data-act="discard-go" data-key="${esc(key)}" data-test="dialog-ok">${esc(pv.kind === 'revert' ? t('되돌리기 요청 만들기', 'Make the revert request') : t('폐기', 'Discard'))}</button></div>`)
}
function stopDialog(b) {
  dialog(`<h2>${esc(t(`B${b.n} ${b.title} 멈춤 요청`, `Ask to stop B${b.n} ${b.title}`))}</h2><p>${esc(t(`${names(V.people.stop)} 님에게 알려요. 이어 갈지 폐기할지는 그분들이 정해요.`, `${names(V.people.stop)} are told and decide.`))}</p>
    <label class="opt"><input type="checkbox" id="security" data-test="stop-security"> <b>${esc(t('보안 문제예요', 'A security problem'))}</b> — ${esc(t('세션을 바로 멈춰요', 'the session is paused at once'))}</label>
    <textarea id="why" data-test="dialog-reason" placeholder="${esc(t('왜 멈춰야 하나요(필수)', 'Why it should stop (required)'))}"></textarea>
    <div class="acts"><button data-act="close">${esc(t('닫기', 'Close'))}</button><button class="primary" data-act="ask-stop-go" data-test="dialog-ok">${esc(t('요청', 'Ask'))}</button></div>`)
}
function holdDialog(b) {
  dialog(`<h2>${esc(t(`B${b.n} ${b.title} 멈춰 두기`, `Hold B${b.n} ${b.title}`))}</h2><p>${esc(b.state === 'running' ? t('세션을 멈추고, 다시 진행을 누를 때까지 기다려요. 파일은 그대로 둬요.', 'The session is paused until it is let go on. Files stay.') : t('다시 진행을 누를 때까지 이 볼트는 시작하지 않아요.', 'This bolt does not start until it is let go on.'))}</p>
    <textarea id="why" data-test="dialog-reason" placeholder="${esc(t('까닭(선택)', 'The reason (optional)'))}"></textarea>
    <div class="acts"><button data-act="close">${esc(t('닫기', 'Close'))}</button><button class="primary" data-act="hold-go" data-test="dialog-ok">${esc(t('멈춰 두기', 'Hold'))}</button></div>`)
}

// ---------- doing ----------
async function act(name, args, done) {
  try { const out = await lite.tool(name, { folder, ...args }); const said = typeof done === 'function' ? done(out) : done; if (said) toast(said); return out } catch (e) { toast(e.message); return null } finally { await load() }
}
async function move(key, bucket, together = false) {
  let out
  try { out = await lite.tool('line_move', { folder, key, bucket, together }) } catch (e) { toast(e.message); blocked = null; return load() }
  if (out.moved.length) { blocked = null; toast(out.moved.length > 1 ? t(`볼트 ${out.moved.length}개를 ${SHORT[bucket]}(으)로 옮겼어요`, `${out.moved.length} bolts moved to ${SHORT[bucket]}`) : t(`${SHORT[bucket]}(으)로 옮겼어요`, `Moved to ${SHORT[bucket]}`)) }
  else blocked = { key, bucket, blockers: out.blockers, together: out.together }
  await load()
}

document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-act], [data-bolt], [data-work]')
  if (!el) { return }
  const a = el.dataset.act
  if (!a && el.dataset.bolt) { sel = sel === el.dataset.bolt && el.classList.contains('bolt') ? null : el.dataset.bolt; blocked = null; draw(); return }
  if (!a && el.dataset.work) { work = work === el.dataset.work ? null : el.dataset.work; draw(); return }
  const b = sel && bolt(sel)
  if (a === 'close') return closeDialog()
  if (a === 'intake') return lite.openApp('intake')
  if (a === 'request') return lite.openApp('intake', { r: el.dataset.id })
  if (a === 'start' || a === 'trust-go') {
    el.disabled = true
    if (a === 'trust-go') closeDialog()
    const out = await act('line_start', { id: el.dataset.id, trust: a === 'trust-go' }, (o) => (o.status === 'trust' ? '' : t('세션에 넘겼어요', 'Handed to the session')))
    // Claude Code has not opened this folder before: its own safety question, answered by the person
    if (out?.status === 'trust') dialog(`<h2>${esc(t('이 폴더를 믿고 시작할까요?', 'Trust this folder and start?'))}</h2>
      <p>${esc(t(`Claude Code 가 「${V.folder.name}」 폴더를 처음 열어서, 믿을 수 있는 프로젝트인지 먼저 묻고 있어요. 믿는다고 답하면 이 폴더의 파일을 읽고 고치고 실행할 수 있어요.`, `Claude Code opens "${V.folder.name}" for the first time and asks whether the project is trusted. Trusted, it can read, edit and run files there.`))}</p>
      ${out.preApproved ? `<div class="note warn" data-test="trust-pre">${esc(t(`이 폴더의 설정이 도구 ${out.preApproved}개를 미리 허용해 두었어요. 그 도구들은 묻지 않고 실행돼요.`, `This folder's settings pre-approve ${out.preApproved} tool permissions: those run without asking.`))}</div>` : ''}
      <p class="small muted">${esc(t('답한 사람과 시각이 원장에 남아요.', 'Who answered, and when, is kept in the ledger.'))}</p>
      <div class="acts"><button data-act="close">${esc(t('닫기', 'Close'))}</button><button class="primary" data-act="trust-go" data-id="${esc(el.dataset.id)}" data-test="dialog-ok">${esc(t('믿고 시작', 'Trust and start'))}</button></div>`)
    return
  }
  if (a === 'move') return move(sel, el.dataset.to)
  if (a === 'move-together') return move(blocked.key, blocked.bucket, true)
  if (a === 'move-cancel') { blocked = null; return drawPicked() }
  if (a === 'release') { el.disabled = true; return act('line_release', { bucket: 'now' }, (o) => t(`볼트 ${o.released.length}개를 내보냈어요`, `${o.released.length} bolt(s) released`)) }
  if (a === 'hold') return holdDialog(b)
  if (a === 'hold-go') { const reason = $('#why').value.trim(); closeDialog(); return act('line_hold', { key: sel, hold: true, reason }, t('멈춰 두었어요', 'Held')) }
  if (a === 'resume') return act('line_hold', { key: sel, hold: false }, t('다시 진행해요', 'Carrying on'))
  if (a === 'ask-stop') return stopDialog(b)
  if (a === 'ask-stop-go') {
    const reason = $('#why').value.trim()
    if (reason.length < 2) return toast(t('까닭을 적어 주세요', 'Give the reason'))
    const security = $('#security').checked
    closeDialog()
    return act('line_stop_request', { key: sel, reason, security }, (o) => (o.held ? (o.paused ? t('세션을 바로 멈추고 알렸어요', 'Paused at once, and told') : t('멈춰 두고 알렸어요', 'Held, and told')) : t('멈춰 달라고 알렸어요', 'Asked')))
  }
  if (a === 'discard') return discardDialog(sel)
  if (a === 'discard-go') {
    const reason = $('#why').value.trim()
    if (reason.length < 2) return toast(t('폐기하는 까닭을 적어 주세요', 'Give the reason'))
    const dependents = document.querySelector('input[name=dep]:checked')?.value || 'hold'
    const archive = !!$('#archive')?.checked
    closeDialog()
    return act('line_discard', { key: el.dataset.key, reason, dependents, archive }, (o) => (o.kind === 'revert' ? t('되돌리는 요청을 만들었어요. 작업 접수에서 볼 수 있어요', 'A revert request was made') : o.kind === 'stop' ? t('멈추고 폐기했어요', 'Stopped and discarded') : t('줄에서 뺐어요', 'Taken off the line')))
  }
})

let again = null
const soon = () => { clearTimeout(again); again = setTimeout(() => { if (!$('#dlg').innerHTML) load() }, 300) }
lite.on('aidlc.intake', soon)
lite.on('aidlc.waits', soon)
// the record moves on while the session works (a unit starts, a bolt finishes): look again now and then
setInterval(() => { if (!$('#dlg').innerHTML && !document.hidden) load() }, 20000)
window.addEventListener('resize', () => requestAnimationFrame(drawArrows))
$('#board').addEventListener('scroll', () => {}, { passive: true })

V = lite.initial && lite.initial.line ? lite.initial : null
if (V) draw(); else await load()
