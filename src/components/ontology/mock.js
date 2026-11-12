// 개발용 가짜 응답(?mock=…) — 실제 데이터가 쌓이기 전에 화면을 만들고 찍어 보려고. 개발 서버에서만 불러온다
// (ProcessMapView 가 import.meta.env.DEV 일 때만 동적으로 import 하므로 운영 빌드에는 들어가지 않는다).
//   ?mock=1         지도
//   ?mock=empty     처음 화면 → 「지난 메일 읽기」를 누르면 빠르게 읽고 그린 뒤 지도
//   ?mock=progress  메일 읽는 중(412통 중 280통부터)
//   ?mock=build     지도 그리는 중
// mock-map.json 은 서버 stats.js 로 만든 숫자다(가상의 인테리어 설계 회사, 90일).
import data from './mock-map.json'

const wait = (ms) => new Promise((ok) => setTimeout(ok, ms))
export function mockApi(kind) {
  const t0 = Date.now()
  let built = kind === '1' || kind === 'map'
  let mail = kind === 'progress' ? { id: 'mock-mail', kind: 'mail_history', status: 'running', total: 412, done: 280, kept: 96, found: 12, t0, rate: 3, from: 280 } : null
  let build = kind === 'build' ? { id: 'mock-build', kind: 'build', status: 'running', detail: { weeks: 6 }, t0, hold: true } : null
  const tickMail = () => {
    if (!mail || mail.status !== 'running') return mail
    const s = Math.floor((Date.now() - mail.t0) / 1000)
    mail.done = Math.min(mail.total, mail.from + s * mail.rate)
    mail.found = mail.from ? Math.min(14, 12 + Math.floor(s / 4)) : Math.min(14, Math.round((mail.done / mail.total) * 14))
    if (mail.done >= mail.total) {
      mail.status = 'done'
      build = { id: `mock-build-${Date.now()}`, kind: 'build', status: 'running', detail: { weeks: 0 }, t0: Date.now() }
    }
    return mail
  }
  const tickBuild = () => {
    if (!build || build.status !== 'running' || build.hold) return build
    const s = (Date.now() - build.t0) / 1000
    build.detail = { weeks: Math.min(10, Math.floor(s * 4)) }
    if (s > 2.5) { build.status = 'done'; built = true }
    return build
  }
  const empty = { at: null, tasks: [], edges: [], processes: [], meta: null }
  return async function call(path, { method = 'GET' } = {}) {
    await wait(120)
    const [p, qs] = path.split('?')
    const q = new URLSearchParams(qs || '')
    if (p === '/ontology/status') { tickMail(); tickBuild(); return { enabled: true, admin: true, mail, build, meta: built ? data.now.meta : null } }
    if (p.startsWith('/ontology/jobs/')) { const id = p.split('/').pop(); return id === mail?.id ? tickMail() : tickBuild() }
    if (p === '/ontology/mail-history' && method === 'POST') {
      mail = { id: 'mock-mail', kind: 'mail_history', status: 'running', total: 412, done: 0, kept: 0, found: 0, t0: Date.now(), rate: 70, from: 0 }
      return { job: mail.id }
    }
    if (p === '/ontology/build' && method === 'POST') { build = { id: `mock-build-${Date.now()}`, kind: 'build', status: 'running', detail: {}, t0: Date.now() }; return { job: build.id } }
    if (p === '/ontology/labels') return data.labels
    if (p === '/ontology/map') {
      if (!built) return empty
      const at = q.get('at')
      if (!at) return data.now
      const keys = Object.keys(data.past).sort()
      return { ...data.past[keys.filter((d) => d <= at).pop() || keys[0]], at }
    }
    throw Object.assign(new Error(`mock: ${method} ${path}`), { status: 404 })
  }
}
