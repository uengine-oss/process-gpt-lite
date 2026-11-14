// 근거(design-v0.3 §23, lib/ontology/evidence.js): 지도의 일 하나가 어느 메일 · 대화에서 왔는지. 제목 · 원문은 그 메일함 주인에게만.
// 이름 지킴(lib/ontology/names.js garbled): 모델이 낱말 가운데를 깨뜨린 이름(「온톨ologi 탐색」)은 이름으로 쓰지 않는다.
// DB 시험은 데모 테넌트(ax-demo, scripts/ax-demo.mjs --seed)의 메일 이력으로 — 없으면 건너뛴다.
import test from 'node:test'
import assert from 'node:assert/strict'
import { garbled } from '../lib/ontology/names.js'

test('낱말 안에서 한글과 영문 소문자가 섞이면 깨진 이름, 약어 · 띄어 쓴 영문은 이름', () => {
  assert.equal(garbled('온톨ologi 탐색'), true)
  assert.equal(garbled('견적서write'), true)
  for (const ok of ['SDK업데이트', 'PoC 컨택', 'Ontology Explorer 구현', '견적서 작성', 'API 연동', 'UI/UX 기획']) assert.equal(garbled(ok), false, ok)
})

test('근거: 주인은 제목 · 원문을, 다른 사람은 날짜 · 출처 · 역할만 본다', async (t) => {
  const { q } = await import('../lib/supa.js')
  const { withTenant } = await import('../lib/tenant.js')
  const row = (await q(`select h.owner_id::text as owner, l.task from pro_mail_history h
                          join pro_onto_labels l on l.tenant_id=h.tenant_id and l.raw=h.activity_label and l.task <> ''
                          join pro_mail_archive a on a.tenant_id=h.tenant_id and a.owner_id=h.owner_id and a.mail_id=h.mail_id
                         where h.tenant_id='ax-demo' limit 1`).catch(() => []))[0]
  if (!row) return t.skip('ax-demo 메일 이력 · 보관함이 없음')
  const { taskEvidence } = await import('../lib/ontology/evidence.js')
  await withTenant('ax-demo', async () => {
    const mine = await taskEvidence({ id: row.owner }, row.task, { limit: 50 })
    assert.ok(mine.items.length > 0, '이 일로 읽힌 기록이 있다')
    assert.ok(mine.counts.mail + mine.counts.chat + mine.counts.handover >= mine.items.length)
    const own = mine.items.filter((it) => it.source === 'mail' && it.subject)
    assert.ok(own.length > 0, '주인은 자기 메일의 제목을 본다')
    for (const it of mine.items) { assert.ok(it.at && it.source && it.raw !== undefined); assert.ok(it.from) }
    const other = await taskEvidence({ id: '00000000-0000-0000-0000-000000000000' }, row.task, { limit: 50 })
    assert.equal(other.items.length, mine.items.length)
    assert.ok(other.items.every((it) => it.subject == null || it.source === 'handover'), '다른 사람에게는 제목이 없다')
    assert.ok(other.items.every((it) => it.text == null && it.link == null), '다른 사람에게는 원문 · 링크가 없다')
    // 더 보기: 마지막 줄 앞의 기록만
    if (mine.items.length >= 2) {
      const first = await taskEvidence({ id: row.owner }, row.task, { limit: 1 })
      const next = await taskEvidence({ id: row.owner }, row.task, { limit: 50, before: first.items[0].at })
      assert.ok(next.items.every((it) => new Date(it.at) < new Date(first.items[0].at)))
    }
  })
})
