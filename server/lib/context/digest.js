// 맥락 요약(spec pgpt-pro_team-activity · pgpt-pro_context-visibility): 맥락마다 요약·결정·열린 질문(요약 깊이에 보이는 것),
// 작업 유형 분포, 프롬프트 유형(뜻이 가까운 요청끼리)과 요청마다 바꿔 쓴 한 줄을 미리 만든다. LLM 은 여기서만 — 맥락마다 한 번.
// 팀 활동 카드·자동 참고는 보는 사람의 깊이만큼 이 요약을 조립만 한다. 맥락이 바뀌면(라우터가 턴을 더하면) 다시 만든다.
import { q } from '../supa.js'
import { config } from '../../config.js'
import { chatJson } from '../llm.js'
import { vectors, cosine } from './embed.js'
import { turnsOf } from './items.js'
import { scanOwner } from './sensitive.js'

export const WORK_KINDS = ['조사', '문서 작성', '분석·계산', '코드', '회의 준비', '메일·연락', '기타']
// 프롬프트 유형 묶기: 완전 연결(무리 안 모든 쌍이 이 값 이상). bge-m3 로 잰 값 — 같은 유형 쌍의 중앙값 0.70, 다른 유형 쌍의 상위 10% 0.62
// (한장 PoC 에서 유형 8개·29문장 사례로 정함: 0.60 이 F1 0.78, 0.85 는 글자까지 같은 반복만 묶음)
export const CLUSTER_MIN = 0.6
const T = () => config.tenantId
const short = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t }
const norm = (s) => String(s || '').replace(/\s+/g, '').replace(/[.!?。~]+$/, '')

// 끝 동사가 일의 종류를 정하는 경우(써 줘·찾아 줘·계산해 줘)를 먼저, 모호한 동사(정리해·만들어)는 목적어 낱말로 가른다.
export const KIND_RULES = [
  ['코드', /코드|함수|스크립트|파이썬|python|자바스크립트|javascript|타입스크립트|typescript|sql|쿼리|정규식|버그|디버그|리팩터|판다스|pandas|엑셀 수식|매크로/i],
  ['메일·연락', /메일|회신|답장|문자 보내|메신저|카톡|연락|초대장/],
  ['회의 준비', /회의|안건|아젠다|미팅|워크숍|발표 준비/],
  ['기타', /설명해|가르쳐|공부|뜻이 뭐|의미가 뭐|추천해/],
  ['분석·계산', /계산|분석|비교표|표로|비교해|인상률|증감|평균|합계|비율|시나리오|추정|예측|통계|손익/],
  ['조사', /조사|찾아|검색|알아봐|살펴봐|모니터/],
  ['문서 작성', /써 ?줘|써 ?주|작성|초안|다듬|교정|번역|체크리스트|목차|질문지|문단|보고서/],
  ['조사', /달라진|바뀐|동향|사례|발표|공지|변화|현황/],
  ['문서 작성', /정리|만들어|요약|문서/],
]
export function classifyKind(prompt) {
  const t = String(prompt || '')
  for (const [k, re] of KIND_RULES) if (re.test(t)) return k
  return '기타'
}
export const kindOf = (source, prompt) => (WORK_KINDS.includes(source?.kind) ? source.kind : classifyKind(prompt))

// 묶음 요약의 첫 문장(제목 깊이에는 나가지 않는다)
export function firstSentence(s, max = 120) {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  const m = t.match(/^.+?[.!?。](?=\s|$)/)
  return short(m ? m[0] : t, max)
}

// ── 프롬프트 유형: 같은 문장은 먼저 하나로, 그다음 완전 연결 응집(무리 안 모든 쌍 ≥ T) ──────────────
// vecs 가 없으면(judge 가 꺼짐) 같은 문장끼리만 묶는다. 반환: 무리마다 texts 의 순번들(큰 무리부터)
export function clusterPrompts(texts, vecs = null, T = CLUSTER_MIN) {
  const uniq = new Map()
  texts.forEach((t, i) => { const k = norm(t); if (!uniq.has(k)) uniq.set(k, []); uniq.get(k).push(i) })
  const cs = [...uniq.values()].map((idx) => ({ idx, on: true }))
  if (vecs && cs.length > 1) {
    const n = cs.length
    const L = cs.map((a, i) => cs.map((b, j) => (i === j ? 1 : cosine(vecs[a.idx[0]], vecs[b.idx[0]]))))
    for (;;) {
      let best = -1, bi = -1, bj = -1
      for (let a = 0; a < n; a++) if (cs[a].on) for (let b = a + 1; b < n; b++) if (cs[b].on && L[a][b] > best) { best = L[a][b]; bi = a; bj = b }
      if (bi < 0 || best < T) break
      cs[bi].idx = [...cs[bi].idx, ...cs[bj].idx]; cs[bj].on = false
      for (let k = 0; k < n; k++) L[bi][k] = L[k][bi] = Math.min(L[bi][k], L[bj][k])   // 완전 연결: 가장 먼 쌍
    }
  }
  return cs.filter((c) => c.on).map((c) => c.idx.sort((a, b) => a - b)).sort((a, b) => b.length - a.length || a[0] - b[0])
}

// LLM 이 없을 때의 유형 이름: 가장 짧은 문장의 목적어(을/를 앞) 끝 두 낱말 + 작업 유형 꼬리
const SUFFIX = { 조사: '조사 요청', '문서 작성': '작성 요청', '분석·계산': '계산 요청', 코드: '코드 요청', '회의 준비': '회의 준비', '메일·연락': '메일 요청', 기타: '요청' }
export function fallbackName(texts, kind = '기타') {
  const t = [...texts].map((s) => String(s).replace(/\s+/g, ' ').trim()).sort((a, b) => a.length - b.length)[0] || ''
  const parts = t.split(/(?:을|를)\s/)
  const obj = parts.length > 1 ? parts.slice(0, -1).join(' ') : t.replace(/\s*(해\s?)?(줘|주세요|줄래)\s*$/, '')
  const head = obj.split(' ').filter(Boolean).slice(-2).join(' ').slice(0, 14)
  return `${head} ${SUFFIX[kind] || '요청'}`.replace(/\s+/g, ' ').trim()
}
// 바꿔 쓴 한 줄이 프롬프트 문장을 그대로 옮긴 것이면 버린다(요약 깊이에 프롬프트 문장이 나가면 안 된다)
export function echoes(gist, prompt) {
  const a = norm(gist).replace(/(달라고|해달라고)?함$/, ''), b = norm(prompt).replace(/(해)?(줘|주세요)$/, '')
  if (!a) return true
  return b.includes(a) || a.includes(b)
}


// 맥락 하나의 요약을 만든다(회사 게이트웨이 모델 한 번). 실패하면 요약은 비우고 유형 이름은 규칙으로.
export async function buildDigest(owner, conv) {
  const [t] = await q(`select title, created_at, updated_at from context_threads where tenant_id = $1 and user_id = $2 and conversation_id = $3`, [T(), owner, conv])
  if (!t) return null
  const turns = await turnsOf(owner, conv, { since: new Date(new Date(t.created_at).getTime() - 60000), limit: 200 })
  const asks = turns.filter((x) => x.prompt).map((x) => ({ text: short(x.prompt, 300), kind: classifyKind(x.prompt), at: x.at }))
  const kinds = {}
  for (const a of asks) kinds[a.kind] = (kinds[a.kind] || 0) + 1
  let vecs = null
  try { if (asks.length > 1) vecs = await vectors(asks.map((a) => a.text)) } catch { vecs = null }
  const groups = clusterPrompts(asks.map((a) => a.text), vecs).map((idx) => ({ idx, asks: idx.map((i) => asks[i]) }))
  const uniq = [...new Set(asks.map((a) => a.text))].slice(0, 40)
  let j = null
  if (turns.length) {
    const TT = groups.slice(0, 12).map((g, i) => `T${i + 1} (${g.idx.length}회): ${[...new Set(g.asks.map((a) => a.text))].slice(0, 4).map((s) => `「${short(s, 120)}」`).join(' ')}`).join('\n')
    const P = uniq.map((s, i) => `P${i + 1}: ${short(s, 160)}`).join('\n')
    const convo = turns.slice(-16).map((x, i) => `#${i + 1} 요청: ${short(x.prompt, 200)}\n답: ${short(x.answer, 400)}`).join('\n')
    j = await chatJson('너는 업무 대화를 정리하는 비서다. 대화에 실제로 있는 내용만 쓰고 JSON 하나로만 답한다.', `대화 맥락 「${short(t.title, 60)}」의 요청과 답이다.

${convo}

1) summary: 이 맥락에서 무엇을 하고 있는지 2~3문장. 요청·답의 문장을 그대로 옮기지 말고 다른 말로 줄인다. 숫자·고유명사는 결정에 필요한 것만.
2) decisions: 이 대화에서 정해진 것(없으면 빈 배열), 각 40자 안.
3) questions: 아직 열린 질문(없으면 빈 배열), 각 40자 안.
4) types: 뜻이 가까운 요청 무리(T)마다 6~14자 명사구 유형 이름(「~ 요청」「~ 작성」「~ 조사」), 회사 이름·숫자는 빼고. 예: 「경쟁사 가격 비교 요청」
5) lines: 요청(P)마다 무엇을 해 달라고 했는지 25자 안의 다른 말로, 「~아/어 달라고 함」으로 끝낸다.

무리:
${TT || '(없음)'}

요청:
${P || '(없음)'}

답 형식: {"summary": "", "decisions": [], "questions": [], "types": {"T1": ""}, "lines": {"P1": ""}}`, { timeoutMs: 90000, maxTokens: 2400, temperature: 0.1, think: false }).catch((e) => { console.warn('[context] digest', conv.slice(0, 8), e.message); return null })
  }
  const gists = new Map()
  uniq.forEach((s, i) => { const g = String(j?.lines?.[`P${i + 1}`] || '').replace(/[「」"']/g, '').trim(); if (g && g.length <= 60 && !echoes(g, s)) gists.set(norm(s), g) })
  const prompt_types = groups.map((g, gi) => {
    const freq = new Map()
    for (const a of g.asks) freq.set(a.text, (freq.get(a.text) || 0) + 1)
    const kc = {}
    for (const a of g.asks) kc[a.kind] = (kc[a.kind] || 0) + 1
    const kind = Object.entries(kc).sort((a, b) => b[1] - a[1])[0]?.[0] || '기타'
    const n = String(j?.types?.[`T${gi + 1}`] || '').replace(/[「」"']/g, '').trim()
    return { name: n.length >= 2 && n.length <= 24 ? n : fallbackName([...freq.keys()], kind), kind, count: g.idx.length,
      examples: [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([s]) => s),
      lines: [...freq.keys()].map((s) => ({ text: s, line: gists.get(norm(s)) || null })) }
  })
  const list = (a) => (Array.isArray(a) ? a.map((x) => short(typeof x === 'string' ? x : x?.text, 80)).filter(Boolean).slice(0, 6) : [])
  const row = { summary: short(j?.summary || '', 400), decisions: list(j?.decisions), questions: list(j?.questions), kinds, prompt_types, turns: turns.length, last_at: turns.at(-1)?.at || t.updated_at }
  await q(`insert into pro_context_digests (tenant_id, user_id, conversation_id, summary, decisions, questions, kinds, prompt_types, turns, last_at, built_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
           on conflict (tenant_id, user_id, conversation_id) do update set summary = excluded.summary, decisions = excluded.decisions, questions = excluded.questions,
             kinds = excluded.kinds, prompt_types = excluded.prompt_types, turns = excluded.turns, last_at = excluded.last_at, built_at = now()`,
    [T(), owner, conv, row.summary, JSON.stringify(row.decisions), JSON.stringify(row.questions), JSON.stringify(row.kinds), JSON.stringify(row.prompt_types), row.turns, row.last_at])
  // 새 요약을 읽어 민감 표시 제안 — 주인이 설정을 열기 전에, 누가 요청하기 전에 홈 카드로
  const scan = await scanOwner(owner, { convs: [conv], notify: true }).catch((e) => { console.warn('[context] sensitive scan', e.message); return null })
  return { ...row, proposed: scan?.fresh?.[0]?.hit || null }
}

// 요약이 없거나 맥락이 그 뒤로 바뀐 것(라우터가 턴을 더함)
export async function staleDigests({ owners = null, limit = 40 } = {}) {
  return q(`select t.user_id as owner, t.conversation_id as conv from context_threads t
      left join pro_context_digests d on d.tenant_id = t.tenant_id and d.user_id::text = t.user_id and d.conversation_id = t.conversation_id
      join pro_sharing_rules r on r.tenant_id = t.tenant_id and r.user_id::text = t.user_id
      where t.tenant_id = $1 and (d.built_at is null or d.built_at < t.updated_at) ${owners ? 'and t.user_id = any($2::text[])' : ''}
      order by t.updated_at desc limit ${Number(limit)}`, owners ? [T(), owners] : [T()])
}

// 턴이 끝나면 그 맥락의 요약을 곧 다시 만든다(같은 맥락은 한 번으로 모은다). 팀 맥락 공유를 쓰는 사람(규칙 행이 있는 사람)만
const soon = new Map()
export function rebuildSoon(owner, conv, ms = 20000) {
  const k = `${T()}:${owner}:${conv}`
  clearTimeout(soon.get(k))
  const tenant = T()
  soon.set(k, setTimeout(async () => {
    soon.delete(k)
    const { withTenant } = await import('../tenant.js')
    await withTenant(tenant, async () => {
      const [on] = await q(`select 1 from pro_sharing_rules where tenant_id = $1 and user_id = $2`, [T(), owner])
      if (on) await buildDigest(owner, conv).catch((e) => console.warn('[context] digest', e.message))
    })
  }, ms).unref?.() || soon.get(k))
}
