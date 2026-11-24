'use strict'
// First run and 「서버 바꾸기…」: which Lite server the window opens (main.js pgl:connect checks it before saving).
$('#logo').innerHTML = LOGO
for (const [id, k] of [['title', 'setupTitle'], ['lead', 'setupLead'], ['company', 'company'], ['company-hint', 'companyHint'], ['local', 'local'], ['gate-label', 'gate'], ['connect', 'connect'], ['cancel', 'cancel'], ['foot', 'foot']]) $(`#${id}`).textContent = STR[k]
$('#url').placeholder = STR.placeholder
$('#user').placeholder = STR.user
$('#pass').placeholder = STR.pass
const url = $('#url')
const status = (text, err) => { $('#status').textContent = text || ''; $('#status').classList.toggle('err', !!err) }
let localDefault = 'http://localhost:18080'

function choose(which) {
  $('#pick-company').classList.toggle('on', which === 'company')
  $('#pick-local').classList.toggle('on', which === 'local')
}
$('#pick-company').addEventListener('click', () => {
  choose('company')
  // the company address is suggested, not typed in for the person: a pasted whole address must not end up after a prefilled https://
  if (!/^https:\/\/.+\.process-gpt\.io/.test(url.value)) url.value = ''
  url.placeholder = STR.companyPh
  url.focus()
  url.setSelectionRange(url.value.length, url.value.length)
})
$('#pick-local').addEventListener('click', () => { choose('local'); url.value = localDefault; url.focus() })
url.addEventListener('input', () => { status(''); choose(/localhost|127\.0\.0\.1/.test(url.value) ? 'local' : url.value ? 'company' : '') })
$('#cancel').addEventListener('click', () => window.pglLocal.cancel())

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault()
  if (!url.value.trim()) return status(STR.empty, true)
  $('#connect').disabled = true
  status(STR.checking)
  const r = await window.pglLocal.connect({ url: url.value, user: $('#user').value.trim(), pass: $('#pass').value }).catch(() => ({ ok: false, reason: 'unreachable' }))
  $('#connect').disabled = false
  if (r.ok) return status('')
  status(STR[r.reason] || STR.unreachable, true)
  if (r.reason === 'auth') $('#gate').open = true
})

window.pglLocal.state().then((s) => {
  if (!s) return
  localDefault = s.localDefault || localDefault
  $('#local-hint').textContent = localDefault
  url.value = s.server || ''
  choose(!s.server ? '' : /localhost|127\.0\.0\.1/.test(s.server) ? 'local' : 'company')
  $('#cancel').hidden = !s.server
  if (s.gateUser) { $('#user').value = s.gateUser; $('#gate').open = true }
  if (s.hasGatePass) $('#pass').placeholder = STR.passKept
  for (const r of (s.recent || []).filter((x) => x !== s.server)) {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = r
    b.title = r
    b.addEventListener('click', () => { url.value = r; choose(/localhost|127\.0\.0\.1/.test(r) ? 'local' : 'company') })
    $('#recent').append(b)
  }
  url.focus()
})
