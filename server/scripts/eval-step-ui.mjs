// 단계 입력 화면(lib/stepUi)을 실제 모델로 만들어 본다 — 지어낸 회사 일 몇 개(한국어 다섯 · 영어 하나)를 프롬프트 · 카탈로그 그대로
// 넣고, 검사를 통과했는지 · 몇 번 물었는지 · 걸린 시간 · 칸 수 · 비밀 판정이 읽혔는지를 적는다. 데이터베이스에는 쓰지 않는다.
//   node scripts/eval-step-ui.mjs [--runs 2] [--out ../.scratch/step-ui-eval.json]
// 모델 · 게이트웨이는 server/.env(PRO_LLM_*)의 것.
process.env.DOTENV_CONFIG_QUIET = 'true'
import fs from 'node:fs'
import path from 'node:path'

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const runs = Number(arg('--runs', 1))
const effort = arg('--effort', null) // reasoning effort to try (low · medium · high); default: the skill's stepUi.effort
const out = arg('--out', null)
const { config } = await import('../config.js')
const { makeSurface } = await import('../lib/stepUi/generate.js')
const { settings } = await import('../lib/stepUi/index.js')
const { oddsOf, readingStatus } = await import('../lib/decide.js')
const { withLang } = await import('../lib/lang.js')
const { inputsOf } = await import('../lib/stepUi/values.js')

const today = new Date().toISOString().slice(0, 10)
const CASES = [
  { lang: 'ko', step: '견적 검토', role: '영업', definition: { description: '고객에게 보낼 견적의 금액 · 납기 · 조건을 확인하고 진행 여부를 정한다', instruction: '단가표와 맞지 않으면 금액을 조정하고 까닭을 남긴다', outputs: ['검토 결과', '확정 금액', '납기'], checkpoints: ['단가표와 대조', '할인율 20% 이하'] },
    request: { subject: '한빛상사 2층 교육장 인테리어 견적 요청', body: '40석 교육장 인테리어 견적을 부탁드립니다. 다음 달 10일까지 완료를 원합니다.', from: '윤태호 <yoon@hanbit.example.test>', customer: '한빛상사' },
    earlier: [{ step: '견적서 작성', title: '견적서 초안', text: '설계비 3,000,000원 · 시공비 23,070,000원 · 합계 26,070,000원 · 유효기간 30일' }] },
  { lang: 'ko', step: '출장비 정산 승인', role: '팀장', definition: { description: '팀원의 출장비 정산 요청을 보고 승인하거나 반려한다', instruction: '영수증 합계와 규정 한도(1일 15만 원)를 확인한다', outputs: ['승인 여부', '승인 금액', '의견'], checkpoints: ['영수증 첨부 확인', '규정 한도 이내'] },
    request: { subject: '[정산] 부산 고객사 방문 출장비', body: '11월 18~19일 부산 출장 교통비 118,400원, 숙박 89,000원, 식비 54,000원 정산 요청드립니다.', from: '서하린 <seo@example.test>', customer: '' }, earlier: [] },
  { lang: 'ko', step: '납품 일정 확정', role: '생산관리', definition: { description: '주문 수량과 생산 계획을 보고 납품일과 분할 납품 여부를 정한다', instruction: '', outputs: ['납품일', '분할 납품 여부', '1차 수량'], checkpoints: ['자재 재고 확인'] },
    request: { subject: '브래킷 부품 1,200개 발주', body: '품번 BK-220 브래킷 1,200개를 12월 15일까지 납품 부탁드립니다. 가능하면 600개는 먼저 받고 싶습니다.', from: '구매팀 박지원 <park@client.example.test>', customer: '한결정밀' },
    earlier: [{ step: '주문 접수', title: '주문 요약', text: 'BK-220 1,200개 · 희망 납기 12/15 · 분할 희망(600 선납)' }] },
  { lang: 'ko', step: '특강 신청 확인', role: '교육 담당', definition: { description: '특강 신청 내용을 확인하고 강사 · 강의실 · 일정을 정해 회신 준비를 한다', instruction: '인원이 강의실 정원을 넘으면 큰 강의실로', outputs: ['특강 일시', '강의실', '강사', '회신에 넣을 말'], checkpoints: ['강사 일정 확인'] },
    request: { subject: '[특강 요청] AI 활용 특강 3시간', body: '예시대학교 경영학과입니다. 다음 달 학생 40명 대상 3시간 특강을 부탁드립니다.', from: '김지원 교수 <kim@example-univ.test>', customer: '예시대학교' },
    earlier: [], draft: { title: '특강 준비 메모', summary: '40명 · 3시간 · 12월 첫째 주 제안', text: '인원 40명이라 A동 대강의실(50석)을 권해요. 12월 3일(수) 오후 2시~5시를 제안하고, 강사는 윤태호 책임이 가능한지 확인이 필요해요.' } },
  { lang: 'ko', step: '용역 계약서 법무 검토', role: '법무', definition: { description: '용역 계약서의 주요 조항(대금 · 지체상금 · 손해배상 · 비밀유지)을 검토해 수정 요청을 정리한다', instruction: '지체상금이 1일 0.1%를 넘으면 수정 요청', outputs: ['검토 결과', '수정 요청 조항', '의견'], checkpoints: ['지체상금 비율', '손해배상 한도', '비밀유지 기간'] },
    request: { subject: '그린리프공방 매장 리뉴얼 디자인 용역 계약 검토 요청', body: '계약 금액 12,000,000원, 지체상금 1일 0.3%, 손해배상 한도 없음으로 되어 있습니다.', from: '한울디자인 영업팀', customer: '그린리프공방' }, earlier: [] },
  { lang: 'en', step: 'Purchase request approval', role: 'Team lead', definition: { description: 'Review a purchase request and approve or reject it', instruction: 'Requests over 3,000,000 KRW need a reason', outputs: ['Decision', 'Approved amount', 'Comment'], checkpoints: ['Budget line checked'] },
    request: { subject: 'Purchase: 4 monitors for the design team', body: 'Four 27-inch monitors at 420,000 KRW each, total 1,680,000 KRW.', from: 'Harin Seo <seo@example.test>', customer: '' }, earlier: [] },
]

const R = { ...(await settings()), ...(effort ? { effort } : {}) }
const rows = []
console.log(`model ${config.llm.model} · ${CASES.length} activities × ${runs}`)
for (let r = 0; r < runs; r++) {
  for (const [i, c] of CASES.entries()) {
    const input = { today, ...c, earlier: c.earlier || [] }
    const t0 = Date.now()
    let res
    try {
      res = await withLang(c.lang, () => makeSurface(input, { surfaceId: `step_eval${i}r${r}`, R, odds: oddsOf }))
    } catch (e) { res = { msg: null, tries: 0, errors: [e.message], ms: Date.now() - t0 } }
    const ins = res.msg ? inputsOf(res.msg.createSurface).map(({ c: x, key }) => `${x.component}:${key}`) : []
    const row = { run: r, step: c.step, lang: c.lang, ok: !!res.msg, tries: res.tries, ms: res.ms, inputs: ins.length, buttons: res.buttons || 0, fields: ins, errors: res.errors || [], retried: res.retried || [], refused: !!res.refused,
      labels: res.msg ? res.msg.createSurface.components.filter((x) => typeof x.label === 'string').map((x) => x.label) : [], screen: res.msg }
    rows.push(row)
    console.log(`${row.ok ? '✓' : '✗'} ${c.step} (${c.lang}) — ${row.tries}번 · ${row.ms}ms · 칸 ${row.inputs} · 버튼 ${row.buttons}${row.ok ? ` · ${row.labels.join(' / ')}` : ` · ${row.errors.join(' / ').slice(0, 300)}`}`)
    for (const e of row.retried) console.log(`    첫 답이 걸린 까닭: ${e.join(' / ').slice(0, 400)}`)
    if (!row.ok && res.lastAnswer) row.lastAnswer = res.lastAnswer
  }
}
const ok = rows.filter((x) => x.ok)
const ms = rows.map((x) => x.ms).sort((a, b) => a - b)
const summary = { model: config.llm.model, effort: R.effort || null, at: new Date().toISOString(), n: rows.length, valid: ok.length, firstTry: rows.filter((x) => x.ok && x.tries === 1).length,
  medianMs: ms[Math.floor(ms.length / 2)], maxMs: ms.at(-1), judge: readingStatus() }
console.log(JSON.stringify({ ...summary, judge: { state: summary.judge.state, model: summary.judge.model } }))
if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify({ summary, rows }, null, 1)) }
process.exit(0)
