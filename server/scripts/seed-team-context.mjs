// 팀 맥락 공유(openspec changes/pgpt-pro-team-context) 시험·녹화용 회사 — 테넌트 team-demo(주소 team.localhost, PRO_TENANT_HOSTS 에 있어야 한다).
//   node scripts/seed-team-context.mjs --reset        지우고 다시 만든다(사람·조직도·장·규칙·대화 맥락·등급·맥락 요약)
//   node scripts/seed-team-context.mjs --live         녹화·시험이 만든 것(참고·요청·허락·열람·알림, 시드 뒤에 생긴 대화)만 지운다
//   node scripts/seed-team-context.mjs --clean [--accounts]   지우기만(계정까지)
//   node scripts/seed-team-context.mjs --status
// 조직: 서진컨설팅(루트, 관리자 윤서진) › 컨설팅본부 › 전략팀(박하늘 장, 이도윤)·제안팀(최유나 장, 정하은). 계정 pro-tc-<이름>@uengine.org, 로그인 코드 000000.
// 대화 맥락은 라우터가 나눈 모양(context_threads + 메인 채팅의 요청·답)으로 넣고, 맥락 요약은 실제 모델로 만든다(lib/context/digest.js).
// 「원문표지-…」 글은 답 원문에만 있다 — 원문 깊이가 없는 사람에게 보이면 실패(시험이 이것으로 확인한다).
import crypto from 'node:crypto'
const { enterSeedTenant } = await import('../lib/seedTenant.js')
const argv = process.argv.slice(2)
const T = enterSeedTenant(argv.includes('--tenant') ? argv : [...argv, '--tenant', 'team-demo'])
const { q, pool, admin, ensureUser } = await import('../lib/supa.js')
const { ensureTenantRow, forgetTenant, DEFAULT_TENANT } = await import('../lib/tenant.js')
const { mainThread } = await import('../lib/store.js')
if (T === DEFAULT_TENANT) { console.error('team-demo 는 기본 테넌트가 아니어야 합니다'); process.exit(2) }
const has = (k) => process.argv.includes(k)
const DAY = 86400000

export const PEOPLE = [
  { key: 'yoon', name: '윤서진', admin: true, team: 'root', role: '대표' },
  { key: 'park', name: '박하늘', team: 'strategy', role: '전략팀장', lead: 'strategy' },
  { key: 'lee', name: '이도윤', team: 'strategy', role: '전략 컨설턴트' },
  { key: 'choi', name: '최유나', team: 'proposal', role: '제안팀장', lead: 'proposal' },
  { key: 'jung', name: '정하은', team: 'proposal', role: '제안 컨설턴트' },
]
export const email = (p) => `pro-tc-${p.key}@uengine.org`

// 대화 맥락: 등급·범위·한 줄 목적, 턴(요청 → 답). 최근 것일수록 최근 날짜.
const C = {
  lee: [
    { title: '경쟁 서비스 동향', visibility: 'summary', reach: 'team', purpose: '국내 협업 SaaS 경쟁 3사의 가격·기능 변화를 매주 추적', days: 0.4, turns: [
      ['A사 요금제 페이지에서 지난주와 달라진 점을 정리해 줘', 'A사는 프로 요금제를 사용자당 월 8,900원에서 9,900원으로 올렸어요(원문표지-A사9900). 무료 요금제의 저장 공간은 그대로예요.'],
      ['B사 신기능 발표 내용을 세 줄로 요약해 줘', 'B사는 회의록 자동 작성 기능을 비즈니스 요금제에만 넣었어요. 기존 프로 사용자는 추가 요금을 내야 해요. 출시는 11월 둘째 주예요.'],
      ['경쟁 3사 사용자당 월 요금을 표로 비교해 줘', '| 회사 | 프로 | 비즈니스 |\n|---|---|---|\n| A사 | 9,900원 | 15,000원 |\n| B사 | 10,500원 | 16,000원 |\n| C사 | 9,000원 | 14,000원 |\n가격은 부가세 별도, 사용자당 월 요금 기준으로 맞췄어요.'],
      ['C사 블로그에서 가격 변경 공지를 찾아 줘', 'C사는 11월 1일부터 팀 요금제를 개편한다고 공지했어요. AI 기능을 상위 요금제로 옮긴다는 내용이에요.'],
      ['경쟁사 가격 인상률을 분기별로 계산해 줘', '3분기 평균 인상률은 11.2%예요. A사 11.2%, B사 9.4%, C사 13.0% 순이에요.'],
      ['이번 주 경쟁 동향 보고 문단을 써 줘', '이번 주 경쟁 3사는 모두 AI 기능을 상위 요금제로 옮겼습니다. 사용자당 요금은 평균 11% 올랐고, 기본 요금제의 기능은 줄었습니다.'],
      ['A사 요금제 페이지에서 지난주와 달라진 점을 정리해 줘', '이번 주 A사 요금제 페이지는 바뀐 점이 없어요.'],
      ['경쟁 3사 사용자당 월 요금을 표로 비교해 줘', '지난 표와 같아요. 바뀐 곳이 없어 표는 그대로 두었어요.'],
    ] },
    { title: '사내 교육 자료 정리', visibility: 'listed', reach: 'team', purpose: '신입 컨설턴트용 리서치 방법 교육 자료', days: 9, turns: [
      ['데스크 리서치 순서를 신입용 체크리스트로 만들어 줘', '1. 질문 정하기 2. 1차 출처 찾기 3. 출처 표기 4. 교차 확인 5. 한 장 요약'],
      ['출처 표기 규칙을 예시와 함께 정리해 줘', '출처는 「기관, 제목, 날짜, 주소」 순서로 씁니다. 예: A사, 요금제 안내, 2026-10-30, https://…'],
    ] },
    { title: '개인 학습 메모', visibility: 'private', reach: 'team', purpose: '개인 공부 메모', days: 3, turns: [
      ['회귀 분석 결과 해석하는 법을 쉽게 설명해 줘', '계수는 다른 변수를 고정했을 때의 변화량이에요(원문표지-개인메모).'],
      ['파이썬 판다스 피벗 예제를 보여 줘', "df.pivot_table(index='월', columns='회사', values='요금')"],
    ] },
  ],
  park: [
    { title: '가격 정책 조사', visibility: 'summary', reach: 'team', purpose: '우리 서비스 요금 개편안을 위한 시장 가격 조사', days: 1.5, turns: [
      ['해외 협업 SaaS 2곳의 요금 구조를 조사해 줘', 'N사와 M사는 좌석 요금에 AI 사용량 요금을 더하는 구조예요(원문표지-해외2사).'],
      ['경쟁 3사 평균 사용자당 월 요금을 계산해 줘', '경쟁 3사 프로 요금제 평균은 사용자당 월 9,800원이에요(원문표지-평균9800).'],
      ['요금 개편안 초안 1쪽을 써 줘', '요금 개편안(초안): 기본 요금은 시장 평균보다 10% 낮게, AI 기능은 사용량 기반 추가 요금으로 분리합니다.'],
      ['연간 결제 할인 15%와 20%일 때 매출 차이를 계산해 줘', '20%로 하면 첫해 매출이 4.2% 줄지만 해지율이 낮아져 2년 차부터 앞서요.'],
      ['C사 연간 결제 할인 정책을 찾아 줘', 'C사는 10월부터 연간 결제에 20% 할인을 줘요(원문표지-C사20).'],
      ['요금 개편안 초안 1쪽을 써 줘', '2판으로 고쳤어요. 연간 할인은 15%안과 20%안을 함께 실었어요.'],
    ] },
    { title: '팀 운영 회의', visibility: 'summary', reach: 'team', purpose: '전략팀 주간 운영 회의 안건과 결정', days: 4, turns: [
      ['이번 주 전략팀 회의 안건을 정리해 줘', '1. 3분기 시장 보고서 진행 2. 가격 개편안 검토 3. 교육 자료 일정'],
      ['지난주 결정 사항 이행 여부를 표로 만들어 줘', '| 결정 | 담당 | 상태 |\n|---|---|---|\n| 보고서 초안 목요일 마감 | 이도윤 | 진행 중 |'],
    ] },
  ],
  choi: [
    { title: '고객 B 가격 협상', visibility: 'listed', reach: 'team', purpose: '고객 B 와의 경쟁사 대비 가격 협상 전략', days: 2, turns: [
      ['고객 B 가 받은 경쟁사 견적과 우리 견적 차이를 계산해 줘', '차이는 연 1,240만 원이에요(원문표지-견적차1240).'],
      ['고객 B 에 보낼 가격 협상 메일 초안을 써 줘', '안녕하세요, 지난번 말씀하신 견적 조정 건으로 연락드립니다. 3년 계약이면 12%까지 조정할 수 있습니다.'],
      ['3년 계약 할인 시나리오 세 가지를 계산해 줘', '8%·10%·12% 할인일 때 3년 매출은 각각 2억 2,080만·2억 1,600만·2억 1,120만 원이에요.'],
      ['고객 B 구매 담당자에게 회의 일정을 잡는 메일을 써 줘', '다음 주 화요일이나 목요일 오후에 30분 통화가 가능하실까요?'],
    ] },
    { title: '경쟁사 가격 벤치마크', visibility: 'listed', reach: 'team', purpose: '국내 협업 SaaS 경쟁사의 요금제·가격 변화를 비교해 제안서 부록에', days: 3, turns: [
      ['제안서 부록용 경쟁사 요금 비교표를 만들어 줘', '부록 표를 만들었어요. 분기마다 갱신하는 것으로 적었어요.'],
      ['경쟁 서비스 신규 요금제를 찾아 줘', 'B사 비즈니스 요금제가 새로 생겼어요.'],
    ] },
    { title: '연봉 협상 준비', visibility: 'summary', reach: 'team', sensitive: 'proposed', purpose: '팀원 연봉 협상 준비 자료', days: 5, turns: [
      ['연봉 협상 면담 질문지를 만들어 줘', '1. 지난 1년의 성과 2. 내년 역할 3. 희망 조건(원문표지-연봉)'],
    ] },
    { title: '제안서 표준 목차', visibility: 'open', reach: 'department', purpose: '본부 공통 제안서 목차와 작성 규칙', days: 12, turns: [
      ['본부 공통 제안서 목차를 만들어 줘', '1. 해결할 문제 2. 근거 3. 기대 효과 4. 비용 5. 일정 — 표지 다음 장은 한 장 요약(원문표지-표준목차).'],
    ] },
    { title: '분기 정리', visibility: 'listed', reach: 'team', purpose: '제안팀 3분기 활동 정리', days: 15, turns: [
      ['3분기 제안 활동을 정리해 줘', '3분기 제안 7건, 수주 3건. 경쟁사 가격 인하 압박이 컸어요(원문표지-분기정리).'],
    ] },
  ],
  jung: [
    { title: '고객 C 제안서', visibility: 'summary', reach: 'team', purpose: '고객 C 업무 협업 도구 도입 제안서', days: 1, turns: [
      ['고객 C 제안서 목차를 본부 표준에 맞춰 써 줘', '1. 해결할 문제 — 메신저·문서·일정이 따로 놀아 정보가 흩어짐 …'],
      ['고객 C 의 현재 협업 도구를 조사해 줘', '고객 C 는 메신저 하나와 공유 드라이브를 써요. 일정은 메일로 잡아요.'],
      ['보안 기능 비교 장을 써 줘', '접근 권한·감사 기록·데이터 위치 세 가지로 비교했어요.'],
    ] },
  ],
  yoon: [
    { title: '회사 운영 원칙', visibility: 'open', reach: 'company', purpose: '서진컨설팅 운영 원칙과 AI 사용 규칙', days: 20, turns: [
      ['사내 AI 사용 규칙 초안을 써 줘', 'AI 사용은 기본 허용, 고객 자료는 외부 AI 로 보내지 않습니다.'],
    ] },
  ],
}

async function peopleIds() {
  return Object.fromEntries((await q(`select u.email, u.id::text as id from users u where u.tenant_id = $1 and u.email like 'pro-tc-%@uengine.org'`, [T])).map((r) => [r.email, r.id]))
}

async function wipeLive() {
  const ids = Object.values(await peopleIds())
  for (const t of ['pro_access_requests', 'pro_grants', 'pro_refers', 'pro_refer_edits', 'pro_context_refs', 'pro_context_views']) await q(`delete from ${t} where tenant_id = $1`, [T])
  await q(`delete from notifications where tenant_id = $1 and type like 'context_access%'`, [T])
  await q(`update pro_context_shares set sensitive = 'proposed' where tenant_id = $1 and conversation_id in (select conversation_id from context_threads where tenant_id = $1 and title = '연봉 협상 준비')`, [T])
  // 시드 뒤에 생긴 대화(녹화·시험의 턴)와 그 맥락
  const [st] = await q(`select value from configuration where tenant_id = $1 and key = 'team-context-seed'`, [T])
  const at = st?.value?.at
  // 녹화·시험이 바꾼 등급·목적·민감 표시를 시드 값으로 되돌린다
  for (const g of st?.value?.grades || []) {
    await q(`update pro_context_shares set visibility = $3, reach = $4, sensitive = $5, purpose = $6, sensitive_dismissed_at = null where tenant_id = $1 and conversation_id = $2`, [T, g.conv, g.visibility, g.reach, g.sensitive, g.purpose])
  }
  if (at && ids.length) {
    await q(`delete from pro_context_shares where tenant_id = $1 and not (conversation_id = any($2::text[]))`, [T, st.value.convs || []])
    await q(`delete from pro_messages where created_at > $2 and thread_id in (select id from pro_threads where user_id::text = any($1))`, [ids, at])
    await q(`delete from context_threads where tenant_id = $1 and user_id::text = any($2) and not (conversation_id = any($3::text[]))`, [T, ids, st.value.convs || []])
    await q(`update pro_threads set conversation_id = null, status = null where user_id::text = any($1) and kind = 'chat'`, [ids])
  }
}

async function cleanAll() {
  const ids = Object.values(await peopleIds())
  await wipeLive()
  for (const t of ['pro_context_shares', 'pro_context_digests', 'pro_sharing_rules', 'pro_team_leads']) await q(`delete from ${t} where tenant_id = $1`, [T])
  if (ids.length) await q(`delete from pro_schedules where user_id::text = any($1)`, [ids])
  await q(`delete from context_threads where tenant_id = $1`, [T])
  if (ids.length) {
    await q(`delete from pro_messages where thread_id in (select id from pro_threads where user_id::text = any($1))`, [ids])
    await q(`delete from pro_threads where user_id::text = any($1)`, [ids])
    await q(`delete from notifications where tenant_id = $1`, [T])
  }
  await q(`delete from configuration where tenant_id = $1 and key in ('organization', 'team-context-seed')`, [T])
  if (has('--accounts')) for (const id of ids) {
    for (const t of ['pro_team_members', 'pro_profile']) await q(`delete from ${t} where user_id::text = $1`, [id]).catch(() => {})
    await q(`delete from users where id::text = $1`, [id]).catch(() => {})
    await admin.auth.admin.deleteUser(id).catch(() => {})
    forgetTenant(id)
  }
  return ids.length
}

function chart(ids) {
  const node = (p) => ({ id: ids[p.key], name: p.name, data: { id: ids[p.key], pid: p.team, name: p.name, username: p.name, role: p.role, email: email(p), img: '/images/defaultUser.png' } })
  const team = (id, name, kids) => ({ id, data: { id, name, img: '', isTeam: true }, children: kids })
  const inTeam = (t) => PEOPLE.filter((p) => p.team === t).map(node)
  return { chart: { id: 'root', data: { id: 'root', name: '서진컨설팅', img: '' }, children: [...inTeam('root'),
    team('hq', '컨설팅본부', [team('strategy', '전략팀', inTeam('strategy')), team('proposal', '제안팀', inTeam('proposal'))])] } }
}

async function seed() {
  await ensureTenantRow(T)
  const ids = {}
  for (const p of PEOPLE) {
    const u = await ensureUser(email(p), p.name)
    ids[p.key] = String(u.id)
    await q('update users set username = $2, is_admin = $4, role = $5 where id = $1 and tenant_id = $3', [u.id, p.name, T, !!p.admin, p.admin ? 'admin' : 'user'])
    await q(`insert into pro_profile (user_id, name, email, birth, onboarded_at, lang) values ($1,$2,$3,'1990-01-01',now(),'ko')
             on conflict (user_id) do update set name = $2, lang = 'ko', onboarded_at = coalesce(pro_profile.onboarded_at, now())`, [u.id, p.name, email(p)])
    await q('delete from pro_team_removed where tenant_id = $1 and user_id = $2', [T, u.id])
    await q('insert into pro_team_members (tenant_id, user_id, added_by) values ($1,$2,$2) on conflict do nothing', [T, u.id])
    await q(`insert into pro_sharing_rules (tenant_id, user_id) values ($1,$2) on conflict (tenant_id, user_id) do update set rules = '[]', default_visibility = 'summary', default_reach = 'team', updated_at = now()`, [T, u.id])
    if (p.lead) await q(`insert into pro_team_leads (tenant_id, node_id, user_id) values ($1,$2,$3) on conflict (tenant_id, node_id) do update set user_id = excluded.user_id`, [T, p.lead, u.id])
  }
  await q('update tenants set owner = $2 where id = $1', [T, ids.yoon])
  await q(`delete from configuration where tenant_id = $1 and key = 'organization'`, [T])
  await q(`insert into configuration (key, value, tenant_id) values ('organization', $1, $2)`, [chart(ids), T])
  const now = Date.now(), convs = []
  for (const p of PEOPLE) {
    const owner = ids[p.key]
    const th = await mainThread(owner)
    for (const c of C[p.key] || []) {
      const conv = crypto.randomUUID()
      convs.push({ owner, conv, title: c.title, visibility: c.visibility, reach: c.reach, sensitive: c.sensitive || 'none', purpose: c.purpose })
      const start = now - c.days * DAY - c.turns.length * 3600000
      for (const [i, [ask, answer]] of c.turns.entries()) {
        const at = new Date(start + i * (c.days * DAY / Math.max(1, c.turns.length)) + i * 60000)
        await q(`insert into pro_messages (thread_id, role, kind, content, created_at) values ($1, 'user', 'text', $2, $3)`, [th.id, { text: ask, conv, seed: 'team-context' }, at])
        await q(`insert into pro_messages (thread_id, role, kind, content, created_at) values ($1, 'agent', 'text', $2, $3)`,
          [th.id, { text: answer, conv, seed: 'team-context', context: { title: c.title, action: i ? 'continue' : 'new', conversationId: conv } }, new Date(at.getTime() + 20000)])
      }
      const last = c.turns.at(-1)
      await q(`insert into context_threads (tenant_id, user_id, conversation_id, title, summary, gist, kind, turns, created_at, updated_at) values ($1,$2,$3,$4,$5,'',$6,$7,$8,$9)`,
        [T, owner, conv, c.title, `최근 요청: ${last[0]}\n최근 답: ${last[1].slice(0, 300)}`, 'chat', c.turns.length, new Date(start), new Date(now - c.days * DAY)])
      await q(`insert into pro_context_shares (tenant_id, user_id, conversation_id, visibility, reach, sensitive, purpose) values ($1,$2,$3,$4,$5,$6,$7)`,
        [T, owner, conv, c.visibility, c.reach, c.sensitive || 'none', c.purpose])
    }
  }
  // 이도윤: 지금 도는 AI 작업(예약 작업의 실행 — cron 은 걸지 않는다)과 경쟁 서비스 동향에서 만든 파일
  const lee = ids.lee, leeTh = await mainThread(lee), comp = convs.find((c) => c.title === '경쟁 서비스 동향')
  const [sch] = await q(`insert into pro_schedules (user_id, name, cron, prompt, thread_id) values ($1, '주간 경쟁 동향 조사', '0 9 * * 1', '경쟁 3사 요금제 페이지를 확인해 지난주와 바뀐 점을 정리해 줘', $2) returning id`, [lee, leeTh.id])
  await q(`insert into pro_mission_runs (schedule_id, trigger, status, started_at) values ($1, 'cron', 'running', now() - interval '4 minutes')`, [sch.id])
  await q(`insert into pro_messages (thread_id, role, kind, content, created_at) values ($1, 'agent', 'file', $2, now() - interval '2 hours')`,
    [leeTh.id, { name: '경쟁사_요금_비교_3분기.xlsx', ext: 'xlsx', url: '', conv: comp.conv, seed: 'team-context' }])
  return { ids, convs }
}

if (has('--status')) {
  console.log(JSON.stringify({
    people: await q(`select u.username, u.email, u.is_admin from users u join pro_team_members m on m.user_id = u.id and m.tenant_id = u.tenant_id where u.tenant_id = $1 order by u.email`, [T]),
    contexts: await q(`select u.username, t.title, s.visibility, s.reach, s.sensitive, (d.summary <> '') as digest from context_threads t join users u on u.id = t.user_id and u.tenant_id = t.tenant_id
                       left join pro_context_shares s using (tenant_id, user_id, conversation_id) left join pro_context_digests d using (tenant_id, user_id, conversation_id) where t.tenant_id = $1 order by u.username, t.title`, [T]),
    live: (await q(`select (select count(*) from pro_access_requests where tenant_id = $1)::int req, (select count(*) from pro_grants where tenant_id = $1)::int grants, (select count(*) from pro_context_refs where tenant_id = $1)::int refs`, [T]))[0],
  }, null, 1))
} else if (has('--live')) {
  await wipeLive()
  console.log(`${T}: 녹화·시험이 만든 참고·요청·허락·열람과 시드 뒤의 대화를 지웠습니다`)
} else {
  console.log(`${T}: 지움 ${await cleanAll()}명${has('--accounts') ? '(계정까지)' : ''}`)
  if (!has('--clean')) {
    const { ids, convs } = await seed()
    for (const p of PEOPLE) console.log(`  ${p.name} ${email(p)} ${ids[p.key]}`)
    const { buildDigest } = await import('../lib/context/digest.js')
    const t0 = Date.now()
    let ok = 0
    for (const c of convs) { const d = await buildDigest(c.owner, c.conv).catch((e) => ({ error: e.message })); if (d?.summary) ok++; else console.log('  요약 실패', c.title, d?.error || '') }
    console.log(`  맥락 ${convs.length}개 · 요약 ${ok}개(${((Date.now() - t0) / 1000).toFixed(0)}초)`)
    await q(`delete from configuration where tenant_id = $1 and key = 'team-context-seed'`, [T])
    await q(`insert into configuration (key, value, tenant_id) values ('team-context-seed', $1, $2)`, [{ at: new Date().toISOString(), convs: convs.map((c) => c.conv), grades: convs.map((c) => ({ conv: c.conv, visibility: c.visibility, reach: c.reach, sensitive: c.sensitive, purpose: c.purpose })) }, T])
  }
}
await pool.end()
