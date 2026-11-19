// Production meeting and team-room fixes (2026-11-18), without a model or a judge server where possible:
//   - a judge without its server: the LLM's pick becomes the server's probability shape (lib/judge.js)
//   - "관련 자료 좀 찾아줄래?" in a meeting is a request to the assistant; a task for people is not
//   - the transcription hint read back over silence is not a line of the record
//   - behind the gateway a person of the tenant is a teammate on first sight (a ProcessGPT room holds people
//     who never opened Lite) unless an administrator removed them — on the local database, cleaned up
// Run: node --test test/meetingTeamFixes.test.js
import test, { after } from 'node:test'
import assert from 'node:assert/strict'

const { spread } = await import('../lib/judge.js')
const { cue } = await import('../lib/meetings/intent.js')
const { promptEcho } = await import('../lib/meetings/transcribe.js')

test('판정: LLM 이 고른 답을 판정 서버와 같은 확률 모양으로', () => {
  const opts = [{ key: 'no' }, { key: 'yes' }]
  assert.deepEqual(spread(opts, 'yes', 0.9), { no: 0.09999999999999998, yes: 0.9 })
  const three = spread([{ key: 'a' }, { key: 'b' }, { key: 'c' }], 'b', 0.8)
  assert.equal(three.b, 0.8)
  assert.ok(Math.abs(three.a - 0.1) < 1e-9 && Math.abs(three.c - 0.1) < 1e-9)
  // a key that is not an option is no pick at all
  assert.deepEqual(spread(opts, 'maybe', 0.99), { no: 0.5, yes: 0.5 })
  assert.equal(spread(opts, 'yes', 7).yes, 1)
})

test('회의: 자료를 찾아 달라는 말은 비서에게 하는 부탁, 사람에게 맡기는 말은 아님', () => {
  assert.equal(cue('관련돼서 자료 좀 찾아줄래?').request, true)
  assert.equal(cue('경쟁사 사례 좀 조사해 줘').request, true)
  assert.equal(cue('견적서 5% 낮춰서 다시 만들어줘').request, true)
  assert.equal(cue('내일 아침까지 그 AI 관련 그루비어 관련 기획서를 다 제출해 주시기 바랍니다.').request, false)
  assert.equal(cue('제 화면 보이세요?').why, 'no-cue')
})

test('받아쓰기: 힌트를 그대로 읽은 것은 말이 아님', () => {
  const prompt = '회의 참석자: 장진영. 회의에 나올 수 있는 자료: .'
  assert.equal(promptEcho('회의 참석자: 장진영. 회의에 나올 수 있는 자료: .', prompt), true)
  assert.equal(promptEcho('회의 참석자: 장진영.', prompt), true)
  assert.equal(promptEcho('관련돼서 자료 좀 찾아줄래?', prompt), false)
  assert.equal(promptEcho('장진영', prompt), false, '이름 한마디는 힌트와 겹쳐도 말일 수 있음(6자 미만)')
  assert.equal(promptEcho('아무 말', ''), false)
})

// ---------- on the local database ----------
const { q, pool } = await import('../lib/supa.js')
const { config } = await import('../config.js')
const db = await q('select 1 from pro_team_members limit 1').then(() => true).catch(() => false)
const cleanup = []
after(async () => { for (const f of cleanup) await f().catch(() => {}); await pool.end() })

test('팀원: 게이트웨이 뒤에서는 회사 사람이면 처음 볼 때 팀원(관리자가 뺀 사람은 아님)', { skip: !db }, async () => {
  const { isMember } = await import('../lib/team/access.js')
  const T = config.tenantId
  const [u, v] = await q(`select u.id::text as id from users u where u.tenant_id=$1 and not coalesce(u.is_agent,false)
                          and not exists (select 1 from pro_team_members m where m.tenant_id=$1 and m.user_id=u.id)
                          and not exists (select 1 from pro_team_removed x where x.tenant_id=$1 and x.user_id=u.id) limit 2`, [T])
  if (!u || !v) return
  cleanup.push(() => q('delete from pro_team_members where tenant_id=$1 and user_id = any($2::uuid[])', [T, [u.id, v.id]]))
  cleanup.push(() => q('delete from pro_team_removed where tenant_id=$1 and user_id=$2', [T, v.id]))
  const was = config.tenantFromHeader
  try {
    config.tenantFromHeader = false
    assert.equal(await isMember(u.id), false, '혼자 설치판: 지금처럼 Lite 에 들어온 사람만')
    config.tenantFromHeader = true
    assert.equal(await isMember(u.id), true)
    assert.equal((await q('select 1 from pro_team_members where tenant_id=$1 and user_id=$2', [T, u.id])).length, 1, '명단에 들어감')
    await q('insert into pro_team_removed(tenant_id,user_id) values ($1,$2)', [T, v.id])
    assert.equal(await isMember(v.id), false, '관리자가 뺀 사람')
    assert.equal(await isMember('00000000-0000-0000-0000-000000000000'), false, '회사 사람이 아님')
  } finally { config.tenantFromHeader = was }
})

test('제안: 실패한 것은 요청받은 사람이 다시 시작할 수 있다', async () => {
  const { view } = await import('../lib/team/assist.js')
  const s = (state) => ({ id: 's', room_id: 'r', chat_uuid: 'minutes:m:0', audience: ['u'], dismissed: [], state, work: 'CreateDocument', title: '관련 자료 찾기', reason: '' })
  assert.equal(view('u', s('failed')).canStart, true)
  assert.equal(view('u', s('open')).canStart, true)
  assert.equal(view('u', s('running')).canStart, false)
  assert.equal(view('u', s('done')).canStart, false)
  assert.equal(view('other', s('failed')).canStart, false, '요청받지 않은 사람')
})

test('받아쓰기: 첫 모델이 답하지 않으면 다른 모델로, 둘 다 안 되면 이유를 말한다', async () => {
  const T = await import('../lib/meetings/transcribe.js')
  const real = globalThis.fetch
  process.env.PRO_TRANSCRIBE_API_KEY ||= 'test-key'
  const models = []
  try {
    globalThis.fetch = async (url, opts) => {
      const model = opts.body.get('model'); models.push(model)
      if (model === 'gpt-4o-mini-transcribe') throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
      return { ok: true, json: async () => ({ text: '관련된 자료 좀 줘봐봐' }) }
    }
    const r = await T.transcribe(Buffer.alloc(4000), { prompt: '' })
    assert.deepEqual(models, ['gpt-4o-mini-transcribe', 'whisper-1'])
    assert.deepEqual([r.text, r.model], ['관련된 자료 좀 줘봐봐', 'whisper-1'])
    assert.equal(T.lastError.model, 'gpt-4o-mini-transcribe')
    assert.match(T.lastError.message, /no answer/)
    globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => 'Incorrect API key provided' })
    await assert.rejects(T.transcribe(Buffer.alloc(4000), {}), (e) => e.status === 503 && /응답하지 않아요|not answering/.test(e.message))
    assert.match(T.lastError.message, /401/)
  } finally { globalThis.fetch = real }
})

test('Drive 산출물: 링크에서 파일 ID, 저장된 자격 증명 읽기', async () => {
  const { driveIdOf, parseCredentials } = await import('../lib/driveOutputs.js')
  assert.equal(driveIdOf('https://docs.google.com/document/d/1XDEYzmxn5BA_uqsyE9gRxqrcWwWl-8dO/edit?usp=drivesdk&rtpof=true&sd=true'), '1XDEYzmxn5BA_uqsyE9gRxqrcWwWl-8dO')
  assert.equal(driveIdOf('https://drive.google.com/file/d/1XDEYzmxn5BA_uqsyE9gRxqrcWwWl-8dO/view?usp=drivesdk'), '1XDEYzmxn5BA_uqsyE9gRxqrcWwWl-8dO')
  assert.equal(driveIdOf('https://drive.google.com/open?id=1XDEYzmxn5BA_uqsyE9gRxqrcWwWl-8dO'), '1XDEYzmxn5BA_uqsyE9gRxqrcWwWl-8dO')
  assert.equal(driveIdOf('https://evil.example/d/1XDEYzmxn5BA_uqsyE9gRxqrcWwWl-8dO'), null)
  assert.equal(driveIdOf('https://gjdyydowgrinjjkfkwtl.supabase.co/storage/v1/object/public/files/a.docx'), null)
  const inner = { refresh_token: 'r', client_id: 'c' }
  assert.deepEqual(parseCredentials(JSON.stringify(JSON.stringify(inner))), inner, 'JSON 안의 JSON 문자열')
  assert.deepEqual(parseCredentials(JSON.stringify(inner)), inner)
  assert.deepEqual(parseCredentials(inner), inner)
  assert.equal(parseCredentials('not json'), null)
})
