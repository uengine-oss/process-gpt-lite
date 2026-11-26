// 약속 알림 재검토 반영(PR #95 재검토) — 실제 DB, 모델은 대본(판정 · 읽기)과 이 시험의 가짜 모델 서버(메일 비서). 회사는 이 시험만의 것(agenda-rv2),
// 사람은 무작위 id, 끝나면 지운다. 고치기 전 코드에서 먼저 돌려 실패를 확인한 시험이다.
//   R2-I-01 (#1) 같은 스레드의 다른 사람이 링크를 바꾸면, 카드의 「보낸 사람」은 그 사람(처음 정한 사람이 아님)
//   R2-I-02 (#2) 메일링 리스트 · 자동 발송처럼 함께 쓰는 주소의 메일은 같은 스레드에서만 약속을 바꾼다 — 같은 주소만으로는 안 된다.
//           함께 쓰는 주소에서 온 약속은 그 주소의 다른 스레드 메일이 머리 없이 와도 바꾸지 못한다
//   R2-I-03 (#4) 메일 비서의 카드 하나를 넣다 실패해도 그 메일의 약속은 읽는다
// Run: node --test --test-concurrency=1 test/agenda-review2.integration.test.js
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'

const TENANT = 'agenda-rv2'
// the mail assistant answers a card the database refuses (no verb): the card insert throws; the gate says yes, the reading makes one plan
const model = { calls: [] }
const llm = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    const b = JSON.parse(raw || '{}')
    const sys = String(b.messages?.[0]?.content || '')
    const answer = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(o) }, finish_reason: 'stop' }] })) }
    if (b.max_tokens === 1 && b.logprobs) {
      model.calls.push('gate')
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ choices: [{ message: { content: 'A' }, logprobs: { content: [{ token: 'A', top_logprobs: [{ token: 'A', logprob: Math.log(0.95) }, { token: 'B', logprob: Math.log(0.05) }] }] } }] }))
    }
    if (sys.startsWith("You read a user's newest emails")) {
      model.calls.push('triage')
      const mails = JSON.parse(b.messages?.[1]?.content || '[]')
      return answer({ actions: mails.map((m) => ({ mail_id: m.id, verb: null, kind: 'calendar', text: null, due: null, prompt: '' })), brief: '', drafts: [] })
    }
    if (sys.startsWith('대화방의 새 메시지나 새 메일에서')) {
      model.calls.push('read')
      return answer({ ops: [{ op: 'create', title: '연말 워크숍', date: '2026-12-10', start: '10:00', location: '본사 7층' }] })
    }
    answer({})
  })
})
await new Promise((ok) => llm.listen(0, '127.0.0.1', ok))

process.env.PRO_TENANT_ID = TENANT
delete process.env.PRO_TENANT_FROM_HEADER
process.env.PRO_TENANT_HOSTS = ''
process.env.PRO_BACKGROUND = '0'
process.env.PRO_LLM_BASE_URL = `http://127.0.0.1:${llm.address().port}/v1`
process.env.PRO_LLM_API_KEY = 'test'
process.env.PRO_LLM_ODDS_MODEL = ''
process.env.PRO_CONTEXT_ROUTER_URL = ''
process.env.PRO_JUDGE_URL = ''
process.env.PRO_ONTOLOGY_BOLT_URL = ''
process.env.PRO_AGENDA_ROOMS = '0'

const { q, pool } = await import('../lib/supa.js')
const up = await q('select 1 from pro_agenda_rooms where seen is not null limit 1').then(() => true, () => false)
const S = await import('../lib/agenda/store.js')
const AM = await import('../lib/agenda/mail.js')
const E = await import('../lib/calendarEvent.js')

const NOW = E.zonedToUtc('2026-11-26', '14:00', 'Asia/Seoul')
const id = () => crypto.randomUUID()
const HY = { id: id(), email: 'hy@agenda-rv2.test', name: '정하윤' }
function script({ ops = [] } = {}) {
  const calls = { gate: 0, read: [] }
  return {
    calls,
    decide: async () => { calls.gate++; return { choice: 'plan', probabilities: { plan: 0.9, none: 0.1 }, confidence: 0.9, strategy: 'logprob', model: 'scripted' } },
    json: async (system, user) => { const input = JSON.parse(user); calls.read.push(input); return { ops: typeof ops === 'function' ? ops(input) : ops } },
  }
}
const read = (mail, ops) => { const s = script({ ops }); return AM.fromMail(HY.id, { id: `m-${id()}`, date: NOW, subject: '일정', text: '…', ...mail }, { deps: { now: NOW, decide: s.decide, json: s.json } }).then((r) => ({ r, s })) }
const planOf = async (title) => (await q(`select id, link, location, status, source from pro_agenda_items where tenant_id=$1 and mail_owner=$2 and title=$3`, [TENANT, HY.id, title]))[0]

async function clean() {
  await q('delete from pro_agenda_items where tenant_id=$1', [TENANT])
  for (const t of ['pro_actions', 'pro_demo_mail', 'pro_mail_seen', 'pro_mail_accounts']) await q(`delete from ${t} where user_id=$1`, [HY.id])
  await q('delete from pro_mail_archive where tenant_id=$1', [TENANT])
  await q('delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)', [HY.id])
  await q('delete from pro_threads where user_id=$1', [HY.id])
  await q('delete from pro_profile where user_id=$1', [HY.id])
}
before(async () => { if (!up) return; await q(`insert into tenants (id) values ($1) on conflict (id) do nothing`, [TENANT]); await clean() })
after(async () => {
  if (up) { await clean(); await q('delete from tenants where id=$1', [TENANT]) }
  llm.close()
  await pool.end().catch(() => {})
})
const skip = !up && 'no database with sql/067 (seen)'

test('R2-I-01 같은 스레드의 다른 사람이 링크를 바꾸면 카드의 보낸 사람은 그 사람', { skip }, async () => {
  await read({ from: '김 대리 <kim@partner.example>', thread: 't-1' }, [{ op: 'create', title: '파트너 미팅', date: '2026-12-01', start: '15:00', link: 'https://meet.partner.example/a' }])
  let p = await planOf('파트너 미팅')
  assert.equal(p.source.linkFrom, 'kim@partner.example', '처음 링크를 준 사람')
  await read({ from: '박 과장 <park@partner.example>', subject: 'Re: 파트너 미팅', thread: 't-1' }, [{ op: 'update', plan: 'P1', link: 'https://meet.partner.example/b' }])
  p = await planOf('파트너 미팅')
  assert.equal(p.link, 'https://meet.partner.example/b')
  assert.equal(p.source.linkFrom, 'park@partner.example')
  assert.equal(p.source.sender, 'kim@partner.example', '누가 바꿀 수 있는지의 기준은 그대로')
  const [v] = await S.upcoming(HY, { now: NOW })
  assert.equal(v.linkFrom, 'park@partner.example')
  // a change that leaves the link alone keeps who gave it
  await read({ from: '김 대리 <kim@partner.example>', subject: '장소', thread: 't-1' }, [{ op: 'update', plan: 'P1', location: '파트너사 3층' }])
  assert.equal((await planOf('파트너 미팅')).source.linkFrom, 'park@partner.example')
})

test('R2-I-02 함께 쓰는 주소의 메일은 같은 스레드에서만 약속을 바꾼다', { skip }, async () => {
  const LIST = { from: '동호회 공지 <notice@club.example>', listId: '<club.lists.example>' }
  await read({ ...LIST, thread: 't-7', subject: '12월 정기 모임' }, [{ op: 'create', title: '정기 모임', date: '2026-12-03', start: '18:30', location: '한우정' }])
  const made = await planOf('정기 모임')
  assert.equal(made.source.shared, true)
  // the same list, another thread: it does not see the plan
  const other = await read({ ...LIST, thread: 't-8', subject: '다른 공지' }, [])
  assert.deepEqual(other.s.calls.read[0].plans, [])
  // a later mail of that address without the list's headers, in another thread: still not
  const bare = await read({ from: '동호회 공지 <notice@club.example>', thread: 't-9', subject: '장소 변경' }, [])
  assert.deepEqual(bare.s.calls.read[0].plans, [])
  // the same thread may move it
  const same = await read({ ...LIST, thread: 't-7', subject: 'Re: 12월 정기 모임' }, [{ op: 'update', plan: 'P1', location: '을지로' }])
  assert.equal(same.s.calls.read[0].plans.length, 1)
  assert.equal((await planOf('정기 모임')).location, '을지로')
  // a person's own address sending a newsletter (List-Unsubscribe) in another thread: not by the address alone
  const own = await read({ from: '김 대리 <kim@partner.example>', thread: 't-1', subject: '확인' }, [])
  assert.equal(own.s.calls.read[0].plans.length, 1)
  const news = await read({ from: '김 대리 <kim@partner.example>', listUnsubscribe: '<mailto:leave@partner.example>', thread: 't-3', subject: '뉴스레터' }, [])
  assert.deepEqual(news.s.calls.read[0].plans, [])
  // and the store refuses it too
  const p = await planOf('파트너 미팅')
  const done = await S.applyOps({ kind: 'mail', owner: HY.id, mail: { id: 'm-x', subject: 'x', from: 'kim@partner.example', sender: 'kim@partner.example', shared: true, thread: 't-3' } },
    [{ op: 'cancel', id: p.id }], { now: NOW })
  assert.deepEqual(done, [])
})

test('R2-I-03 메일 비서의 카드 하나를 넣다 실패해도 그 메일의 약속은 읽는다', { skip }, async () => {
  const { pollUser } = await import('../lib/mail.js')
  await q(`insert into pro_mail_accounts (user_id, provider, address) values ($1, 'demo', $2) on conflict (user_id) do update set provider='demo'`, [HY.id, HY.email])
  await pollUser(HY.id).catch(() => {})
  await q('insert into pro_demo_mail (user_id, mail_id, sender, subject, body) values ($1,$2,$3,$4,$5)',
    [HY.id, `demo-${id()}`, '기획팀 <plan@hq.example>', '연말 워크숍 안내', '12월 10일 오전 10시 본사 7층에서 연말 워크숍을 합니다.'])
  model.calls.length = 0
  await assert.rejects(pollUser(HY.id))
  let found = null
  for (let i = 0; i < 60 && !found; i++) { found = await planOf('연말 워크숍'); if (!found) await new Promise((ok) => setTimeout(ok, 200)) }
  assert.ok(found, `카드는 실패했지만 약속은 생긴다 (모델: ${model.calls.join(',')})`)
})
