// 기다리는 동안 보이는 말(온보딩): 지난 메일을 읽고 지도를 셈하는 작업이 그때그때 찾은 것을 한 줄씩 남긴다 —
// 「새 일 「견적서 작성」을 찾았어요」, 「반복되는 흐름 4개를 찾았어요」. 작업(pro_onto_jobs)의 detail.feed 에 쌓고, 화면은
// 마지막 몇 줄을 보인다(components/ontology/FirstRun.vue).
import { q } from '../supa.js'

export async function say(jobId, text) {
  if (!jobId || !text) return
  await q(`update pro_onto_jobs set detail = jsonb_set(coalesce(detail, '{}'::jsonb), '{feed}', coalesce(detail->'feed', '[]'::jsonb) || $2::jsonb) where id=$1`,
    [jobId, JSON.stringify([{ at: new Date().toISOString(), text: String(text).slice(0, 160) }])]).catch(() => {})
}

// a small sayer for one job: the same line once, and at most `cap` lines of one kind (a mailbox can hold hundreds of works)
export function sayer(jobId, cap = 14) {
  const said = new Set(), kinds = new Map()
  return async (text, kind = 'note') => {
    if (said.has(text)) return
    const n = kinds.get(kind) || 0
    if (n >= cap) return
    said.add(text); kinds.set(kind, n + 1)
    await say(jobId, text)
  }
}
