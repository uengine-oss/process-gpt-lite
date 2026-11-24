'use strict'
// The server did not answer (no network, the server down, a gateway's 5xx, a tunnel's gate): say so, and try again —
// on 「다시 시도」, when the network comes back, and quietly every 20 seconds.
$('#title').textContent = STR.offTitle
$('#retry').textContent = STR.retry
$('#change').textContent = STR.change
$('#auto').textContent = STR.auto
$('#retry').addEventListener('click', () => window.pglLocal.retry())
$('#change').addEventListener('click', () => window.pglLocal.changeServer())

window.pglLocal.state().then((s) => {
  const f = s?.failure
  $('#where').textContent = f?.url || s?.server || ''
  if (f?.http && f.code === 401) $('#detail').textContent = STR.offAuth
  else if (f?.http) $('#detail').textContent = STR.offHttp(`${f.code}${f.desc ? ' ' + f.desc : ''}`)
  else if (f) $('#detail').textContent = `${f.desc || ''} (${f.code})`
  // a gate's password is not fixed by waiting
  if (f?.code === 401) return
  // (quietly: the page is left only once the server answers again — no blank flash every time)
  window.addEventListener('online', () => window.pglLocal.retry(true))
  setInterval(() => { if (navigator.onLine) window.pglLocal.retry(true) }, 20000)
})
