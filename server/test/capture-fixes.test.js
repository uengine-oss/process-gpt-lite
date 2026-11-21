// Fixes from the English tutorial capture runs (i18n/CAPTURE-LOG.md, 2026-10-29), each checked in Korean
// and English — no database, no model:
//   - the New process draft card is the definition this turn wrote, read from its folder — not the skill's
//     schema sample ("휴가 신청 프로세스") or another saved process the agent read; a process folder's
//     own skills (process-*/skills/xlsx) are not a skill draft (agent.js generationArtifact, draftContract)
//   (which message is a new process, a folder edit or a panel app record is the chat router's — skills/actions,
//   measured by the evaluation sets in server/eval, not by sentences here)
//   - a mined optional Finance review after the quote: no threshold nobody gave on its flows (2026-11-11:
//     a branch's conditions come from the work or the admin — mining/branch.js, shape.js)
//   - the quote step's total on its last line (mining/worker.js quoteTotal)
//   - a workroom terminal ticket carries the tenant it was issued in (the websocket has none: workroom.js)
//   - the test shop's order history, linked from the account menu, in the shop's language
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const { generationArtifact, draftContract } = await import('../lib/agent.js')
const { buildContract } = await import('../lib/mining/service.js')
const { quoteTotal } = await import('../lib/mining/worker.js')
const { withLang } = await import('../lib/lang.js')
const { setEnabledPacks } = await import('../lib/skillInstallCatalog.js')
const { config } = await import('../config.js')
const { startShop, SHOP } = await import('./fixtures/shop.mjs')
const { issueTicket } = await import('../lib/workroom.js')

const hangul = (v) => /[가-힣]/.test(typeof v === 'string' ? v : JSON.stringify(v))
const ROOM = '/workspace/.bpmn/42caa0b234b74c2bb5072463822ba0b3'

test('process draft: which written files are the definition, its folder, a skill draft', () => {
  assert.deepEqual(generationArtifact(`${ROOM}/process-40f2eb3/process-definition.json`),
    { def: '/.bpmn/42caa0b234b74c2bb5072463822ba0b3/process-40f2eb3/', gen: '/.bpmn/42caa0b234b74c2bb5072463822ba0b3/process-40f2eb3/', skill: null })
  // a folder the model named itself (deepagents process_work_dirs takes it too)
  assert.equal(generationArtifact(`${ROOM}/sales-proposal/process-definition.json`).def, '/.bpmn/42caa0b234b74c2bb5072463822ba0b3/sales-proposal/')
  // forms: part of the process folder, not a definition
  assert.deepEqual(generationArtifact(`${ROOM}/process-40f2eb3/forms/create_quote.form`), { def: null, gen: '/.bpmn/42caa0b234b74c2bb5072463822ba0b3/process-40f2eb3/', skill: null })
  // the generation's own skills (it copied xlsx/docx into its folder) are not a skill draft card
  assert.equal(generationArtifact(`${ROOM}/process-8c48732/skills/xlsx/SKILL.md`).skill, null)
  // skill-creator's draft at the conversation base still is
  assert.deepEqual(generationArtifact(`${ROOM}/skills/quote-check/SKILL.md`).skill, { dir: `${ROOM}/skills/quote-check`, name: 'quote-check' })
  // a skill's evaluation run (skill-creator inside the generation) is not an output card
  assert.equal(generationArtifact(`${ROOM}/.skill-evals/cafe-quotation/iteration-1/case/without_skill/outputs/quote.docx`).evalRun, true)
  // reading the skill's own files writes nothing: no file_artifact, and its paths are not a generation's
  assert.deepEqual(generationArtifact('/skills/process-gpt-system/bpmn-process-generation-skill/assets/templates/process-definition.schema.json'), { def: null, gen: null, skill: null })
})

test('process draft: the card shows the definition in the folder, not the streamed one when it is another process', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pro-draft-'))
  try {
    const mine = { processDefinitionName: 'Moonlight Coffee proposal', processDefinitionId: 'moonlight_coffee_proposal', elements: [{ elementType: 'Activity', id: 'a', name: 'Receive request mail', role: 'Sales' }] }
    await fs.writeFile(path.join(dir, 'process-definition.json'), JSON.stringify(mine))
    const leave = { type: 'process-definition-result', processDefinition: { processDefinitionName: '휴가 신청 프로세스', processDefinitionId: 'leave_request_process', elements: [] }, forms: [{}], agents: [], skills: [] }
    const built = { type: 'process-definition-result', processDefinition: { ...mine, activities: [{ id: 'a', name: 'Receive request mail' }] }, forms: [{ activity_id: 'a' }], agents: [], skills: [] }
    // as saving assembles it (save_generated.py CONTRACT_ONLY)
    assert.equal((await draftContract(dir, leave, async () => built)).processDefinition.processDefinitionName, 'Moonlight Coffee proposal')
    // the assembly could not run: the file itself — never the streamed leave-request sample
    const c = await draftContract(dir, leave, async () => null)
    assert.equal(c.processDefinition.processDefinitionName, 'Moonlight Coffee proposal')
    assert.equal(c.processDefinition.processDefinitionId, 'moonlight_coffee_proposal')
    // the streamed contract is used only when it is that same definition (it carries the forms)
    const same = { ...leave, processDefinition: { ...mine } }
    assert.equal(await draftContract(dir, same, async () => null), same)
    // nothing written (the consulting draft): no card
    assert.equal(await draftContract(path.join(dir, 'nothing'), leave, async () => null), null)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})


// the mined definition the miner hands back for Receive → … → Prepare quote → xor(Finance review, skip) → Reply
function mined(lang) {
  const en = lang === 'en'
  const N = en ? ['Receive request mail', 'Prepare quote', 'Finance review', 'Reply to customer'] : ['요청 메일 접수', '견적서 작성', '재무 검토', '고객 회신']
  const act = (id, name) => ({ id, name, role: '', type: 'userTask', agent: '', skills: [], properties: '{}', outputData: ['x'] })
  return {
    process_id: 'mined_test', name: en ? 'Design proposal & quote' : '설계 제안·견적', summary: '',
    pattern: { case_count: 5, event_count: 29 },
    definition: {
      roles: [], events: [{ id: 'start_event', type: 'startEvent' }, { id: 'end_event', type: 'endEvent' }],
      activities: [act('activity_01', N[0]), act('activity_02', N[1]), act('activity_03', N[2]), act('activity_04', N[3])],
      gateways: [{ id: 'gw_split', name: en ? 'Split' : '분기', type: 'exclusiveGateway' }, { id: 'gw_join', name: en ? 'Join' : '합류', type: 'exclusiveGateway' }, { id: 'gw_tau', name: '', type: 'exclusiveGateway' }],
      sequences: [
        { id: 's1', source: 'start_event', target: 'activity_01', condition: '', properties: '{}' },
        { id: 's2', source: 'activity_01', target: 'activity_02', condition: '', properties: '{}' },
        { id: 's3', source: 'activity_02', target: 'gw_split', condition: '', properties: '{}' },
        { id: 's4', source: 'gw_split', target: 'activity_03', name: N[2], condition: '', properties: '{"priority": 0, "default": true}' },
        { id: 's5', source: 'gw_split', target: 'gw_tau', name: en ? 'Skip' : '건너뜀', condition: '', properties: '{"priority": 1}' },
        { id: 's6', source: 'activity_03', target: 'gw_join', condition: '', properties: '{}' },
        { id: 's7', source: 'gw_tau', target: 'gw_join', condition: '', properties: '{}' },
        { id: 's8', source: 'gw_join', target: 'activity_04', condition: '', properties: '{}' },
        { id: 's9', source: 'activity_04', target: 'end_event', condition: '', properties: '{}' },
      ],
    },
  }
}

test('mining: a mined optional Finance review gets no threshold nobody gave — its flows wait for the work or the admin; the quote form keeps its amount', () => {
  for (const l of ['en', 'ko']) {
    const c = withLang(l, () => buildContract(mined(l)))
    const split = c.processDefinition.elements.filter((e) => e.elementType === 'Sequence' && e.source === 'gw_split')
    assert.equal(split.length, 2)
    for (const s of split) {
      assert.equal(s.condition, '', `${l}: no condition the work or the admin did not give`)
      assert.ok(!JSON.parse(s.properties || '{}').default, `${l}: no default flow`)
    }
  }
  // the quote step's form still has the amount an admin's condition can read — the form is the business
  // pack's (skills/packs/store-design), so with the pack on for the company
  setEnabledPacks(config.tenantId, ['store-design'])
  try {
    const c = withLang('en', () => buildContract(mined('en')))
    assert.match(c.forms.find((f) => f.activity_id === 'activity_02').html, /name='amount' alias='Quote total incl\. VAT \(KRW\)'/)
  } finally { setEnabledPacks(config.tenantId, []) }
})

test('mining: the quote step reads its total off the agent\'s last line', () => {
  assert.deepEqual(quoteTotal('Moonlight Coffee quote.xlsx\nAssumed: hall ₩850,000/㎡\nTOTAL: 51216000'), { total: 51216000, rest: 'Moonlight Coffee quote.xlsx\nAssumed: hall ₩850,000/㎡' })
  assert.equal(quoteTotal('**TOTAL:** ₩51,216,000').total, 51216000)
  assert.equal(quoteTotal('달빛커피 견적서.xlsx\n합계: 51,216,000원').total, 51216000)
  assert.deepEqual(quoteTotal('no total here'), { total: null, rest: 'no total here' })
})

test('test shop: an order history page from the account menu, in English and Korean', async () => {
  for (const lang of ['en', 'ko']) {
    const shop = await startShop(0, { lang })
    try {
      const form = (b) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(b).toString(), redirect: 'manual' })
      await fetch(`${shop.url}/login`, form({ username: SHOP.username, password: SHOP.password }))
      const otp = await fetch(`${shop.url}/otp`, form({ code: SHOP.otp }))
      const cookie = otp.headers.get('set-cookie').split(';')[0]
      const account = await (await fetch(`${shop.url}/account`, { headers: { cookie } })).text()
      assert.match(account, lang === 'en' ? /<a href="\/orders">Order history<\/a>/ : /<a href="\/orders">주문 내역<\/a>/)
      const orders = await (await fetch(`${shop.url}/orders`, { headers: { cookie } })).text()
      assert.match(orders, /#A-1001/)
      assert.match(orders, lang === 'en' ? /<h1>Order history<\/h1>.*Wireless earbuds × 1/s : /<h1>주문 내역<\/h1>.*무선 이어폰 1개/s)
      if (lang === 'en') assert.ok(!hangul(orders), 'no Korean on the English order history')
      // signed out: back to the login
      assert.equal((await fetch(`${shop.url}/orders`, { redirect: 'manual' })).headers.get('location'), '/login')
    } finally { await shop.close() }
  }
})

test('workroom: a terminal ticket remembers the tenant it was issued in', async () => {
  const { withTenant } = await import('../lib/tenant.js')
  const { config } = await import('../config.js')
  // (the ticket map is private: the tenant goes in with the ticket; the upgrade resolves the room in it)
  const src = await fs.readFile(new URL('../lib/workroom.js', import.meta.url), 'utf8')
  assert.match(src, /tenant: config\.tenantId, until/)
  assert.match(src, /withTenant\(ticket\.tenant, \(\) => resolveRoom\(ticket\.kind, ticket\.id\)\)/)
  assert.equal(typeof issueTicket(...[{ id: 'u1' }, { kind: 'folder', id: 'x' }, 'shell']), 'string')
  assert.equal(withTenant(config.defaultTenantId, () => config.tenantId), config.defaultTenantId)
})
