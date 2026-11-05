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
