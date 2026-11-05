// 메일로 자동 시작한 프로세스 화면의 두 가지(2026-11-05):
// 1) 시작 시각 — completion 은 bpm_proc_inst / todolist 의 시각을 Asia/Seoul 벽시계로 시간대 없는 컬럼에 쓴다.
//    서버가 UTC 인 운영 파드에서 pg 가 그 값을 UTC 로 읽어 "오전 2:08 시작"(실제 오후 5:08)으로 9시간 늦게 보였다.
//    서버 시간대와 상관없이 서울 시각으로 읽는지, UTC 로 띄운 별도 프로세스에서 본다.
// 2) 메일을 프로세스로 넘길 때의 안내 — 평면도·제안서 단계가 없는 프로세스에도 "평면도·제안서·견적서는…"이
//    나왔다. 문장이 그 프로세스 정의의 단계에서 나오는지 본다.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const supa = pathToFileURL(path.join(here, '../lib/supa.js')).href

test('엔진 시각은 서버가 UTC 여도 서울 시각으로 읽는다', () => {
  const script = `
    const pg = (await import('pg')).default
    await import(${JSON.stringify(supa)})
    const parse = pg.types.getTypeParser(pg.types.builtins.TIMESTAMP)
    console.log(JSON.stringify({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      at: parse('2026-11-04 17:08:28.123456').toISOString(), none: parse(null) }))
    process.exit(0)
  `
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: path.join(here, '..'), env: { ...process.env, TZ: 'UTC' }, encoding: 'utf8' })
  const r = JSON.parse(out.trim().split('\n').pop())
  assert.equal(r.tz, 'UTC')
  // 오후 5:08 KST = 08:08 UTC (예전 코드는 17:08 UTC = 다음 날 오전 2:08 KST)
  assert.equal(r.at, '2026-11-04T08:08:28.123Z')
  assert.equal(r.none, null)
})

const step = (kind, name, role) => ({ id: name, kind, name, role })
const def = (name, steps) => ({ name, steps: [step('start', '요청 메일 도착', '영업 담당'), ...steps, step('end', '회신 완료', '영업 담당')] })

test('안내 문장은 그 프로세스의 단계와 역할로 쓴다', async () => {
  const { routeNote } = await import('../lib/mining/service.js')
  // 평면도·제안서가 없는 프로세스 (운영 다과 견적·재무 검토와 같은 구성)
  const snack = routeNote('한빛이벤트', '다과 견적·재무 검토', def('다과 견적·재무 검토', [
    step('human', '요청 메일 접수', '영업 담당'), step('agent', '견적서 작성', '견적 에이전트'),
    step('human', '재무 검토', '재무 담당'), step('human', '고객 회신', '영업 담당')]))
  assert.equal(snack, "한빛이벤트 메일은 정식 등록된 '다과 견적·재무 검토' 프로세스로 처리할게요. 견적서 작성은 견적 에이전트가, 재무 검토는 재무 담당이, 고객 회신은 영업 담당이 맡아요.")
  assert.doesNotMatch(snack, /평면도|제안서/)

  // 평면도·제안서가 있는 프로세스, 분기와 같은 역할 연속 단계
  const design = routeNote('달빛커피', '설계 제안', def('설계 제안', [
    step('human', '요청 메일 접수', '영업 담당'), { id: 'g', kind: 'gateway', name: 'g', role: '' },
    step('agent', '평면도 작성', '도면 에이전트'), step('agent', '제안서 작성', '제안서 에이전트'),
    step('human', '재무 검토', '재무 담당'), step('human', '단가 확인', '재무 담당')]))
  assert.match(design, /평면도 작성은 도면 에이전트가, 제안서 작성은 제안서 에이전트가, 재무 검토·단가 확인은 재무 담당이 맡아요\.$/)

  // 정의를 못 읽으면 단계를 지어내지 않는다
  assert.equal(routeNote('고객', '어떤 프로세스', null), "고객 메일은 정식 등록된 '어떤 프로세스' 프로세스로 처리할게요.")
})

// 3) 견적 단계 지시문 — 평면도 없는 프로세스(송년회 다과 비용표)에도 "설계비·실별 인테리어 공사·화장실…" 견적을 시켜
//    다과 견적이 인테리어 공사 견적(65,890,000원)으로 나왔다. 앞 단계가 남긴 값(평면도의 실별 면적)이 있을 때만 그 틀을 쓴다.
test('견적 단계는 평면도가 있을 때만 인테리어 견적 틀을 쓴다', async () => {
  const { quotePrompt } = await import('../lib/mining/worker.js')
  const snack = quotePrompt({ subject: '송년회 다과 비용표 부탁드립니다', body: '12월 송년회(80명) 다과·음료 비용' }, '한빛이벤트 견적서.xlsx')
  assert.doesNotMatch(snack, /인테리어|설계비|평면도|제안서/)
  assert.match(snack, /메일이 요청한 품목/)
  const design = quotePrompt({ subject: '매장 설계 제안', body: '30평', rooms: '홀 | 40㎡ | 좌석\n주방 | 12㎡ | 조리', floor_plan: { name: 'a.dxf' }, proposal: { name: 'b.hwpx' } }, 'x.xlsx')
  assert.match(design, /평면도의 실별 면적: 홀 \| 40㎡ \| 좌석 \/ 주방 \| 12㎡ \| 조리/)
  assert.match(design, /실별 인테리어 공사/)
  assert.match(design, /\(평면도와 제안서는 앞 단계에서 이미 만들었으니 만들지 마세요\.\)/)
})

// 4) 검토 카드의 앞 단계 산출물 — 운영 completion 은 단계 결과 문서를 Google Docs 링크(output_url)로 남긴다.
//    링크 끝 조각을 파일 이름으로 써서 칩이 "edit?usp=drivesdk&ouid=…"로 보였다.
test('파일 이름이 없는 결과 문서 링크는 "<단계> 결과 문서"로 보인다', async () => {
  const { urlName } = await import('../lib/processes.js')
  assert.equal(urlName('https://docs.google.com/document/d/1gWVpXa2/edit?usp=drivesdk&ouid=1085&rtpof=true&sd=true', '요청 메일 접수 결과 문서'), '요청 메일 접수 결과 문서')
  assert.equal(urlName('https://x.supabase.co/storage/v1/object/public/files/pgpt-pro/u/%ED%95%9C%EB%B9%9B%EC%9D%B4%EB%B2%A4%ED%8A%B8%20%EA%B2%AC%EC%A0%81%EC%84%9C.xlsx', 'x'), '한빛이벤트 견적서.xlsx')
  assert.equal(urlName('not a url', '결과'), '결과')
})

// 5) 메일 초안이 "에이전트에 연결하지 못했어요"로 끝나던 것 — 운영(2026-11-05)에서 같은 설치의 첫 초안은 되고 다음
//    초안들은 곧바로 실패했다. 턴이 시작되지 않은 실패(연결 거부, 502/503/504)는 잠시 뒤 다시 시도하고, 그래도 안 되면
//    안내 끝에 원인(상태 코드·네트워크 오류)을 붙여 로그를 볼 수 없는 운영에서도 이유가 보이게 한다.
test('에이전트 연결: 일시 실패는 다시 시도하고, 다른 응답은 그대로, 원인은 안내에 붙는다', async () => {
  const { connect, causeOf } = await import('../lib/agent.js')
  const seq = (...xs) => { let i = 0; const calls = []; return { calls, open: async () => { const x = xs[Math.min(i++, xs.length - 1)]; calls.push(x); if (x instanceof Error) throw x; return { status: x, ok: x < 400 } } } }
  const netErr = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
  let s = seq(503, 200); assert.equal((await connect(s.open, () => false, [1, 1])).status, 200); assert.equal(s.calls.length, 2)
  s = seq(netErr, 502, 200); assert.equal((await connect(s.open, () => false, [1, 1])).status, 200); assert.equal(s.calls.length, 3)
  s = seq(500); assert.equal((await connect(s.open, () => false, [1, 1])).status, 500); assert.equal(s.calls.length, 1)
  s = seq(401); assert.equal((await connect(s.open, () => false, [1, 1])).status, 401); assert.equal(s.calls.length, 1)
  s = seq(503); assert.equal((await connect(s.open, () => false, [1, 1])).status, 503); assert.equal(s.calls.length, 3)
  s = seq(503, 200); assert.equal((await connect(s.open, () => true, [1, 1])).status, 503) // stopped by the person
  s = seq(netErr); await assert.rejects(connect(s.open, () => false, [1, 1]), /fetch failed/)
  assert.equal(causeOf(new Error('deepagents 503')), 'deepagents 503')
  assert.equal(causeOf(netErr), 'ECONNREFUSED')
})
