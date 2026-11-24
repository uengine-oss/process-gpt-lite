// A fictional company map and one case run straight from it (지도에서 바로 — lib/ontology/mapengine.js): 견적 요청 처리. Used by
// server/test/map-case-view.test.js and e2e/tests/feature/map-case-view.spec.js — the e2e seeds this case in the database the way the
// engine leaves one and draws its flowchart with the server's own code (mapengine.js flowFor) on this map in place of Ontological's.
// Names are made up.
import { END } from '../../lib/ontology/stats.js'

export const PROC = { key: 'p:quote-case-view', name: '견적 요청 처리' }
const AGENT = '---\nrunner: agent\n---\n단가표에서 품목별 단가를 찾아 정리한다'
// [task, role, definition] — 단가 조회 is an agent's step (its lane is 「업무 에이전트」)
export const TASKS = [['요청 검토', '영업'], ['단가 조회', '영업', AGENT], ['현장 실측', '설계'], ['견적서 작성', '영업'], ['정밀 견적', '재무'], ['고객 회신', '영업']]

export function quoteView() {
  const tasks = new Map(TASKS.map(([key, role, md]) => [key, { key, role, status: 'active', ...(md ? { definition_md: md } : {}) }]))
  const e = (from, to, p) => ({ from, to, p, n: Math.round(p * 20), status: 'active' })
  return {
    proc: { ...PROC, theta: 0.05, entries: ['요청 검토'], status: 'suggested' },
    tasks,
    edges: [e('요청 검토', '단가 조회', 1), e('단가 조회', '현장 실측', 1), e('현장 실측', '견적서 작성', 0.7), e('현장 실측', '정밀 견적', 0.3),
      e('견적서 작성', '고객 회신', 1), e('정밀 견적', '고객 회신', 1), e('고객 회신', END, 1)],
  }
}

// the case's steps so far, in the order the engine made them: its work item's status and who runs it (mine: the person viewing — the
// e2e's signed-in account — holds it). The map would go on to 고객 회신 (the flowchart's 「다음」).
export const STEPS = [
  { task: '요청 검토', status: 'DONE', kind: 'person', via: { how: 'entry', from: null } },
  { task: '단가 조회', status: 'DONE', kind: 'agent', via: { how: 'single', from: '요청 검토' } },
  { task: '현장 실측', status: 'DONE', kind: 'person', via: { how: 'single', from: '단가 조회' } },
  { task: '견적서 작성', status: 'IN_PROGRESS', kind: 'person', mine: true, via: { how: 'common', from: '현장 실측', p: 0.7, why: '지난 건의 70%가 이쪽으로 갔어요' } },
]
// the states the flowchart and the list must both show for them
export const EXPECTED = { '요청 검토': 'done', '단가 조회': 'done', '현장 실측': 'done', '견적서 작성': 'person', '고객 회신': 'next' }
export const REQUEST = { subject: '가람상사 교육장 인테리어 견적 요청', customer: '가람상사', sender: '서다온 <daon@garam.example.test>', body: '3층 교육장(30석) 인테리어 견적을 부탁드립니다.' }
