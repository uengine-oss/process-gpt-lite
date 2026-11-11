// 검토 보드 — the stage's questions and findings as cards in role lanes; everyone reviews their own lane at
// once, sees who looks at what, leaves stances and comments with evidence; the stage's decider sends it all.
const { t, esc, $, $$ } = lite
const folder = encodeURIComponent(lite.params.folder)
let B = null          // the board from the server
let me = null
let open = lite.params.item || null // the card in the drawer
let tab = 'all'
let live = []         // [{ id, name, key, age, got }]
let found = {}        // key -> evidence hits
let attach = []       // evidence picked for the comment being written
let pendingForce = null // a send the server held back for cards still in dispute

const STATE = { open: t('열림', 'Open'), decided: t('정함', 'Decided'), discuss: t('논의 필요', 'In dispute'), sent: t('보냄', 'Sent') }
const STANCE = {
  agree: ['ok', t('추천대로', 'As recommended')], choose: ['ok', t('골랐어요', 'Chose')], accept: ['ok', t('위험 감수', 'Accept as risk')],
  fix: ['fix', t('고쳐 주세요', 'Fix it')], reject: ['bad', t('해당 없음', 'Does not apply')], object: ['bad', t('이의', 'Objects')], ask: ['bad', t('질문', 'Asks')],
}
const EYE = '<svg class="eye" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M12 5C6.5 5 2.7 9.4 1.6 11.4a1.2 1.2 0 0 0 0 1.2C2.7 14.6 6.5 19 12 19s9.3-4.4 10.4-6.4a1.2 1.2 0 0 0 0-1.2C21.3 9.4 17.5 5 12 5zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8z" fill="currentColor"/></svg>'
const say = (s) => { const el = $('#toast'); el.textContent = s; el.hidden = false; clearTimeout(say.t); say.t = setTimeout(() => { el.hidden = true }, 3200) }

async function load() {
  try { B = await lite.api(`${folder}/board`) } catch (e) { $('#empty').hidden = false; $('#empty').textContent = e.message; return }
  draw()
}
let reloadT = null
const reload = () => { clearTimeout(reloadT); reloadT = setTimeout(load, 250) }

// ---------- drawing ----------
function draw() {
  const s = B.stage
  $('#stage').textContent = s ? `${s.name}${B.unit ? ` · ${B.unit.unit}` : ''}` : t('AI-DLC 작업 없음', 'No AI-DLC work')
  $('#sub').textContent = [B.intent?.slug, s?.role && t(`결정: ${s.role}`, `decides: ${s.role}`), B.prompt?.title].filter(Boolean).join(' · ')
  const items = B.items
  const n = (st) => items.filter((i) => i.state === st).length
  const total = items.length || 1
  $('#progress').innerHTML = `<div class="bar">${['sent', 'decided', 'discuss'].map((st) => `<i class="${st}" style="width:${(n(st) / total) * 100}%"></i>`).join('')}</div>
    <div class="counts"><span>${t('정함', 'Decided')} <b>${n('decided') + n('sent')}</b>/${items.length}</span><span>${t('논의 필요', 'In dispute')} <b>${n('discuss')}</b></span><span>${t('열림', 'Open')} <b>${n('open')}</b></span></div>`
  drawLive()
  const mineN = items.filter((i) => B.me.reviews.includes(i.roleKey) && i.state !== 'sent').length
  const discussQ = items.filter((i) => i.kind === 'question' && i.state === 'discuss').length
  $('#tabs').innerHTML = [['all', t('전체', 'All') + ` ${items.length}`], ['mine', t('내 검토', 'Mine') + ` ${mineN}`], ['discuss', t('논의 필요', 'In dispute') + ` ${n('discuss')}`]]
    .map(([k, label]) => `<button data-tab="${k}" class="${tab === k ? 'on' : ''}">${esc(label)}</button>`).join('') +
    `<span class="sp"></span>${discussQ ? `<button class="act" data-act="mob" data-test="review-mob">${esc(t(`논의 필요 ${discussQ}개로 몹 회의`, `Mob meeting on ${discussQ} in dispute`))}</button>` : ''}` +
    (B.workroom ? `<button class="act" data-act="shell">⌨︎ ${esc(t('세션 보기', 'Session'))}</button>` : '')
  const show = items.filter((i) => tab === 'all' || (tab === 'mine' ? B.me.reviews.includes(i.roleKey) : i.state === 'discuss'))
  if (!items.length) {
    $('#lanes').innerHTML = ''
    $('#empty').hidden = false
    $('#empty').innerHTML = esc(t('지금 이 단계에는 검토할 질문이나 지적이 없어요. AI-DLC가 질문을 남기거나 승인을 기다리면 여기에 카드로 나타나요.', 'Nothing to review at this stage. When AI-DLC asks questions or waits for an approval, they show here as cards.'))
  } else {
    $('#empty').hidden = true
    $('#lanes').innerHTML = B.lanes.map((l) => {
      const cards = show.filter((i) => i.roleKey === l.roleKey)
      const all = items.filter((i) => i.roleKey === l.roleKey)
      const done = all.filter((i) => i.state === 'decided' || i.state === 'sent').length
      return `<section class="lane${B.me.reviews.includes(l.roleKey) ? ' mine' : ''}" data-test="review-lane" data-role="${esc(l.roleKey || '')}">
        <div class="lh"><b>${esc(l.role)}</b><span class="people">${l.people.map((p) => lite.avatar(p.name, { size: 20 }) + esc(p.name)).join(' ')}</span><span class="n">${done}/${all.length}</span></div>
        <div class="cards">${cards.map(card).join('')}</div></section>`
    }).join('')
  }
  drawSend()
  if (open) drawer()
}

function watchersOf(key) { return live.filter((p) => p.key === key && p.id !== me?.id) }
function drawLive() {
  const here = live.filter((p) => p.id !== me?.id)
  $('#live').innerHTML = here.length ? `${EYE}<span>${esc(t('지금 함께 보는 중', 'Here now'))}</span><span class="avs">${here.map((p) => lite.avatar(p.name, { size: 26, ring: true })).join('')}</span>` : ''
  for (const c of $$('.card')) {
    const w = watchersOf(c.dataset.key)
    const el = c.querySelector('.watch')
    if (el) el.innerHTML = w.length ? `${EYE}${w.map((p) => lite.avatar(p.name, { size: 18, ring: true })).join('')}` : ''
  }
  if (open) { const el = $('#watchers'); if (el) el.innerHTML = watchersHtml(open) }
}
const watchersHtml = (key) => { const w = watchersOf(key); return w.length ? `${EYE}${w.map((p) => lite.avatar(p.name, { size: 20, ring: true }) + esc(p.name)).join(' ')} ${esc(t('보는 중', 'looking'))}` : '' }

function stances(i) {
  return i.marks.map((m) => `<span class="st ${STANCE[m.stance]?.[0] || ''}" title="${esc(m.note || '')}">${lite.avatar(m.name, { size: 18 })}${esc(STANCE[m.stance]?.[1] || m.stance)}${m.stance === 'choose' ? ' ' + esc(m.choice) : ''}</span>`).join('')
}
function card(i) {
  const rec = i.kind === 'question'
    ? (i.sent ? `<b>${esc(t('답', 'Answer'))}: ${esc(i.answer)}</b>` : i.recommended ? `<b>${esc(t('AI 추천', 'AI suggests'))} ${esc(i.recommended)}</b>${i.why ? ' · ' + esc(i.why) : ''}` : esc(t('추천 없음', 'No suggestion')))
    : `<span class="sev ${esc(String(i.severity).toLowerCase())}">${esc(i.severity)}</span> · ${esc(i.refs.map((r) => r.label).join(', ') || i.location)}`
  return `<div class="card s-${i.state}${open === i.key ? ' open' : ''}" data-key="${esc(i.key)}" data-test="review-card" data-id="${esc(i.id)}" data-state="${i.state}">
    <div class="ch"><span class="id">${esc(i.id)}</span>${i.tag ? `<span class="chip">${esc(i.tag)}</span>` : ''}<span class="state ${i.state}">${esc(STATE[i.state])}</span><span class="watch"></span></div>
    <div class="ct">${esc(i.text)}</div><div class="rec">${rec}</div>
    <div class="stances">${stances(i)}${i.comments.length ? `<span class="cm">💬 ${i.comments.length}</span>` : ''}</div></div>`
}

// ---------- the drawer: one card, everything about it ----------
function drawer() {
  const i = B.items.find((x) => x.key === open)
  const d = $('#drawer')
  if (!i) { d.hidden = true; open = null; return }
  d.hidden = false
  const lane = B.lanes.find((l) => l.roleKey === i.roleKey)
  const reviewer = lane?.people.some((p) => p.id === me?.id)
  const keep = { note: $('#note')?.value || '', cbody: $('#cbody')?.value || '', other: $('#other')?.value || '' }
  let body = `<div class="dh"><span class="id">${esc(i.id)}</span>${i.tag ? `<span class="chip">${esc(i.tag)}</span>` : ''}${i.severity ? `<span class="chip sev ${esc(String(i.severity).toLowerCase())}">${esc(i.severity)}</span>` : ''}<span class="state ${i.state}">${esc(STATE[i.state])}</span><button class="x" data-act="close" aria-label="close">✕</button></div>
    <div class="watchers" id="watchers">${watchersHtml(i.key)}</div>
    <div class="muted small">${esc(t('검토', 'Reviewer'))}: ${esc(lane?.role || '')} — ${esc((lane?.people || []).map((p) => p.name).join(', '))}</div>`
  if (i.kind === 'question') {
    body += `<div class="dq">${esc(i.text)}</div>${i.note ? `<p class="why">${esc(t('왜 묻나요', 'Why it asks'))} — ${esc(i.note)}</p>` : ''}
      <div class="opts">${i.options.map((o) => {
        const chosen = i.sent ? String(i.answer).startsWith(o.key) : i.decision && ((i.decision.stance === 'agree' && o.key === i.recommended) || i.decision.choice === o.key)
        return `<div class="opt${o.rec ? ' rec' : ''}${chosen ? ' chosen' : ''}"><span class="k">${esc(o.key)}</span><span>${o.rec ? `<span class="badge">${esc(t('AI 추천', 'AI suggests'))}</span>` : ''}${esc(o.text)}</span>
          ${reviewer && !i.sent && o.key !== 'X' && o.key !== i.recommended ? `<button data-act="choose" data-choice="${esc(o.key)}">${esc(t('이걸로', 'Pick'))}</button>` : ''}</div>`
      }).join('')}</div>`
    if (!i.sent) {
      body += `<div class="acts">${reviewer && i.recommended ? `<button class="go" data-act="agree" data-test="review-agree">✓ ${esc(t(`추천대로 (${i.recommended})`, `As recommended (${i.recommended})`))}</button>` : ''}
        <button class="warn" data-act="object" data-test="review-object">✋ ${esc(t('이의 있어요', 'I object'))}</button><button data-act="ask">？ ${esc(t('질문 있어요', 'I have a question'))}</button>
        ${reviewer ? `<button data-act="other">${esc(t('다른 답 (X)', 'Another answer (X)'))}</button>` : ''}</div>
        <textarea class="note" id="note" placeholder="${esc(t('이의·질문·다른 답의 이유를 적어 주세요', 'Say why (an objection, a question, another answer)'))}"></textarea>`
    }
  } else {
    body += `<div class="refs">${i.refs.map((r) => `<button class="ref" data-doc="${esc(r.path)}" data-focus="${esc(r.focus)}" data-test="review-ref">📄 ${esc(r.label)} · ${esc(t('원본 보기', 'Open original'))}</button>`).join('') || `<span class="muted small">${esc(i.location)}</span>`}</div>
      <div class="box"><div class="k">${esc(t('지적', 'Finding'))}</div>${esc(i.text)}</div><div class="box"><div class="k">${esc(t('고칠 일', 'Required action'))}</div>${esc(i.action)}</div>
      <div class="acts">${reviewer ? `<button class="go" data-act="accept" data-test="review-accept">✓ ${esc(t('위험 감수(승인)', 'Accept as risk'))}</button><button class="red" data-act="fix" data-test="review-fix">✎ ${esc(t('고쳐 주세요', 'Fix it'))}</button><button class="warn" data-act="reject">⊘ ${esc(t('해당 없음', 'Does not apply'))}</button>` : ''}
        <button data-act="object">✋ ${esc(t('이의 있어요', 'I object'))}</button></div>
      <textarea class="note" id="note" placeholder="${esc(t('고칠 것·해당 없는 이유·이의를 적어 주세요', 'What to fix, why it does not apply, or your objection'))}"></textarea>`
  }
  if (i.marks.length) body += `<div class="sec">${esc(t('의견', 'Stances'))}</div><div class="marks">${i.marks.map((m) => `<div class="mk">${lite.avatar(m.name, { size: 22 })}<div><span class="what">${esc(m.name)} · ${esc(STANCE[m.stance]?.[1] || m.stance)}${m.choice ? ' ' + esc(m.choice) : ''}</span>${m.note ? `<div>${esc(m.note)}</div>` : ''}<div class="faint small">${esc(lite.ago(m.updated_at))}</div></div></div>`).join('')}</div>`
  const hits = found[i.key]
  body += `<div class="sec">${esc(t('근거', 'Evidence'))}<button data-act="find" data-test="review-find">🔎 ${esc(t('근거 찾기', 'Find evidence'))}</button></div>
    <div class="ev">${hits ? (hits.length ? hits.map((h, n) => `<div class="hit${attach.some((a) => a.path === h.path && a.focus === h.focus) ? ' on' : ''}"><div class="where">📄 ${esc(h.label)}<a data-doc="${esc(h.path)}" data-focus="${esc(h.focus)}">${esc(t('원본 보기', 'Open'))}</a><a data-act="attach" data-n="${n}">${esc(t('의견에 붙이기', 'Attach'))}</a></div>${h.snippet ? `<div class="q">“${esc(h.snippet)}”</div>` : ''}</div>`).join('') : `<span class="muted small">${esc(t('기록에서 찾지 못했어요.', 'Nothing found in the record.'))}</span>`) : ''}</div>`
  body += `<div class="sec">${esc(t('대화', 'Comments'))} ${i.comments.length}</div><div class="thread">${i.comments.map((c) => `<div class="cmt">${lite.avatar(c.name, { size: 24 })}<div class="b"><div class="who"><b>${esc(c.name)}</b> · ${esc(lite.ago(c.created_at))}</div>${esc(c.body)}
      ${(c.evidence || []).length ? `<div class="refs">${c.evidence.map((e) => e.url ? `<button class="ref" data-url="${esc(e.url)}">🔗 ${esc(e.label)}</button>` : `<button class="ref" data-doc="${esc(e.path)}" data-focus="${esc(e.focus)}">📄 ${esc(e.label)}</button>`).join('')}</div>` : ''}</div></div>`).join('')}</div>
    <div class="compose"><textarea class="note" id="cbody" placeholder="${esc(t('의견을 남겨요 (근거를 붙일 수 있어요)', 'Leave a comment (attach evidence)'))}" data-test="review-comment"></textarea>
      <div class="att">${attach.map((a, n) => `<span class="chip">📄 ${esc(a.label)} <a data-act="unattach" data-n="${n}">✕</a></span>`).join('')}</div>
      <div class="row"><span class="faint small">${esc(t('링크 붙이기: 글에 https:// 주소를 쓰면 근거가 돼요', 'A https:// address in the text becomes evidence'))}</span><button class="primary" data-act="comment" data-test="review-comment-send">${esc(t('남기기', 'Post'))}</button></div></div>`
  d.innerHTML = body
  if ($('#note')) $('#note').value = keep.note
  if ($('#cbody')) $('#cbody').value = keep.cbody
  for (const c of $$('.card')) c.classList.toggle('open', c.dataset.key === open)
}

// ---------- the send bar (the stage's decider) ----------
function drawSend() {
  const f = $('#send')
  if (!B.me.canSend) { f.hidden = true; return }
  if (pendingForce) {
    f.hidden = false
    f.innerHTML = `<div class="msg"><b>⚠︎ ${esc(pendingForce.msg)}</b></div><button data-act="force-no">${esc(t('기다릴게요', 'Wait'))}</button><button class="primary" data-act="force-yes">${esc(t('그래도 보내기', 'Send anyway'))}</button>`
    return
  }
  const qs = B.items.filter((i) => i.kind === 'question' && !i.sent)
  const fs = B.items.filter((i) => i.kind === 'finding')
  if (qs.length) {
    const undecided = qs.filter((i) => i.state === 'open').length, dispute = qs.filter((i) => i.state === 'discuss').length
    f.hidden = false
    f.innerHTML = `<div class="msg"><b>${esc(t(`질문 ${qs.length}개`, `${qs.length} question(s)`))}</b> — ${esc(t(`정함 ${qs.length - undecided - dispute} · 논의 필요 ${dispute} · 열림 ${undecided}`, `decided ${qs.length - undecided - dispute} · in dispute ${dispute} · open ${undecided}`))}</div>
      ${undecided ? `<button data-act="send-q" data-rec="1">${esc(t('나머지는 AI 추천대로 채워 보내기', 'Send, recommended for the rest'))}</button>` : ''}
      <button class="primary" data-act="send-q" ${undecided ? 'disabled' : ''} data-test="review-send-questions">${esc(t('답을 질문 파일에 적고 세션에 알리기', 'Write the answers and tell the session'))}</button>`
  } else if (fs.length && B.prompt?.kind === 'approval') {
    const undecided = fs.filter((i) => i.state === 'open').length
    const fix = fs.filter((i) => i.decision?.stance === 'fix'), rej = fs.filter((i) => i.decision?.stance === 'reject')
    const pre = fix.length ? `Request Changes: ${fix.map((i) => i.id + (i.decision.note ? ' — ' + i.decision.note : '')).join('; ')}` : rej.length ? `Approve · ${t('해당 없음', 'does not apply')}: ${rej.map((i) => i.id).join(', ')}` : 'Approve'
    f.hidden = false
    f.innerHTML = `<div class="msg"><b>${esc(t(`지적 ${fs.length}개`, `${fs.length} finding(s)`))}</b> — ${esc(t(`정함 ${fs.length - undecided} · 열림 ${undecided}`, `decided ${fs.length - undecided} · open ${undecided}`))}<span class="preview" data-test="review-preview">${esc(pre)}</span></div>
      <button class="primary" data-act="send-f" ${undecided ? 'disabled' : ''} data-test="review-send-findings">${esc(t('결정을 묶어 세션에 넣기', 'Put the decision into the session'))}</button>`
  } else f.hidden = true
}

// ---------- doing ----------
async function mark(stance, extra = {}) {
  const note = ($('#note')?.value || '').trim()
  try {
    await lite.api(`${folder}/mark`, { method: 'POST', body: { key: open, stance, note: note || null, ...extra } })
    if ($('#note')) $('#note').value = ''
    await load()
  } catch (e) { say(e.message) }
}
async function send(what, rec, force = false) {
  try {
    const out = await lite.api(`${folder}/send`, { method: 'POST', body: { what, useRecommended: !!rec, force } })
    say(what === 'questions' ? t(`답 ${Object.keys(out.answers).length}개를 적고 세션에 알렸어요.`, `Wrote ${Object.keys(out.answers).length} answer(s) and told the session.`) : t(`세션에 넣었어요: ${out.text || 'Approve'}`, `Put into the session: ${out.text || 'Approve'}`))
    await load()
  } catch (e) {
    // (a sandboxed page has no confirm(): the bar asks instead)
    if (e.status === 409 && /논의|dispute/.test(e.message)) { pendingForce = { what, rec, msg: e.message }; return drawSend() }
    say(e.message)
  }
}

document.addEventListener('click', async (e) => {
  const tb = e.target.closest('[data-tab]')
  if (tb) { tab = tb.dataset.tab; return draw() }
  const doc = e.target.closest('[data-doc]')
  if (doc) return lite.openApp('artifact', { path: doc.dataset.doc, focus: doc.dataset.focus || '' })
  const url = e.target.closest('[data-url]')
  if (url) return lite.open(url.dataset.url)
  const a = e.target.closest('[data-act]')
  if (a) {
    const act = a.dataset.act
    if (act === 'close') { open = null; $('#drawer').hidden = true; attach = []; beat(); return draw() }
    if (act === 'agree' || act === 'accept') return mark(act)
    if (act === 'choose') return mark('choose', { choice: a.dataset.choice })
    if (act === 'other') { if (!($('#note')?.value || '').trim()) return say(t('다른 답을 적어 주세요.', 'Write the other answer.')); return mark('choose', { choice: 'X' }) }
    if (['object', 'ask', 'fix', 'reject'].includes(act)) { if (!($('#note')?.value || '').trim()) { $('#note')?.focus(); return say(t('이유를 적어 주세요.', 'Say why.')) } return mark(act) }
    if (act === 'find') { try { found[open] = (await lite.api(`${folder}/evidence`, { method: 'POST', body: { key: open } })).hits } catch (err) { say(err.message) } return drawer() }
    if (act === 'attach') { const h = found[open]?.[Number(a.dataset.n)]; if (h && !attach.some((x) => x.path === h.path && x.focus === h.focus)) attach.push(h); return drawer() }
    if (act === 'unattach') { attach.splice(Number(a.dataset.n), 1); return drawer() }
    if (act === 'comment') {
      const body = ($('#cbody')?.value || '').trim()
      if (!body) return
      const urls = [...body.matchAll(/https?:\/\/\S+/g)].map((m) => ({ url: m[0], label: m[0].replace(/^https?:\/\//, '').slice(0, 60) }))
      try { await lite.api(`${folder}/comment`, { method: 'POST', body: { key: open, body, evidence: [...attach, ...urls] } }); $('#cbody').value = ''; attach = []; await load() } catch (err) { say(err.message) }
      return
    }
    if (act === 'force-no') { pendingForce = null; return drawSend() }
    if (act === 'force-yes') { const p = pendingForce; pendingForce = null; return send(p.what, p.rec, true) }
    if (act === 'send-q') return send('questions', a.dataset.rec)
    if (act === 'send-f') return send('findings')
    if (act === 'mob') { try { const out = await lite.api(`${folder}/mob`, { method: 'POST' }); say(t(`몹 회의 대화방에 질문 ${out.questions.length}개를 올렸어요.`, `Put ${out.questions.length} question(s) in the mob room.`)) } catch (err) { say(err.message) } return }
    if (act === 'shell') return lite.navigate(B.workroom)
  }
  const c = e.target.closest('.card')
  if (c) { if (open !== c.dataset.key) attach = []; open = c.dataset.key; beat(); return draw() }
})

// ---------- live ----------
// I look at the board (or one card): said every 5 s; the others' last word is good for 15 s
async function beat() {
  try { const out = await lite.api(`${folder}/presence`, { method: 'POST', body: { key: open } }); setLive(out.users) } catch { /* offline: try again */ }
}
function setLive(users) { const now = Date.now(); live = users.map((u) => ({ ...u, got: now - (u.age || 0) })); drawLive() }
setInterval(beat, 5000)
setInterval(() => { const now = Date.now(); const before = live.length; live = live.filter((p) => now - p.got < 15000); if (live.length !== before) drawLive() }, 3000)
lite.on('presence', (d) => setLive(d.users || []))
lite.on('changed', reload)
lite.on('aidlc.waits', reload)
setInterval(load, 20000) // in case an event was missed

;(async () => { me = await lite.me().catch(() => null); await load(); beat() })()
