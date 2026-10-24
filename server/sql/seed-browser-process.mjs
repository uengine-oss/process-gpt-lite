// Demo process with a browser step, saved through process-gpt's own save path (save_contract + BPMN):
//   조사 요청 (사람) → 공급사 카탈로그 조사 (browser-automation-agent) → 견적 검토·선정 (사람)
// Run: node sql/seed-browser-process.mjs
import { q, pool } from '../lib/supa.js'
import { config } from '../config.js'
import { saveGenerated } from '../lib/generated.js'

const T = config.tenantId
const PID = 'pro_supplier_survey'
const AGENT = '5b7c1d2e-9a8b-4c3d-8e7f-6a5b4c3d2e1f'
const form = (key) => `${PID}_${key}_form`

const fields = {
  request: [
    { key: 'category', text: '품목 분류', type: 'select', items: [{ Travel: '여행 가이드' }, { Mystery: '미스터리' }, { Science: '과학' }, { History: '역사' }, { Poetry: '시' }] },
    { key: 'min_rating', text: '최소 평점', type: 'select', items: [{ 3: '3점 이상' }, { 4: '4점 이상' }, { 5: '5점' }] },
    { key: 'max_price', text: '최대 단가(£)', type: 'number' },
    { key: 'memo', text: '요청 메모', type: 'textarea' },
  ],
  result: [
    { key: 'survey_report', text: '카탈로그 조사 보고서', type: 'report' },
    { key: 'best_item', text: '추천 품목', type: 'text' },
    { key: 'best_price', text: '추천 품목 단가', type: 'text' },
  ],
  review: [
    { key: 'decision', text: '결정', type: 'radio', items: [{ 발주: '발주 진행' }, { 재조사: '재조사' }] },
    { key: 'comment', text: '의견', type: 'textarea' },
  ],
}
const tag = { text: 'text-field', number: 'text-field', select: 'select-field', radio: 'radio-field', textarea: 'textarea-field', report: 'report-field' }
const html = (id, alias, fs) => `<section>\n${fs.map((f) => {
  const t = tag[f.type]
  const items = f.items ? ` is_dynamic_load='fixed' items='${JSON.stringify(f.items)}'` : ''
  const type = t === 'text-field' ? ` type='${f.type === 'number' ? 'number' : 'text'}'` : ''
  return `  <row-layout name="${id}" alias="${alias}" is_multidata_mode="false" v-model="formValues" v-slot="slotProps"><div class="row"><div class="col-sm-12"><${t} name='${f.key}' alias='${f.text}'${type}${items} disabled='false' readonly='false' v-model="slotProps.modelValue['${f.key}']"></${t}></div></div></row-layout>`
}).join('\n')}\n</section>`

const act = (id, name, role, key, extra = {}) => ({ elementType: 'Activity', id, name, role, type: 'UserActivity', tool: `formHandler:${form(key)}`, duration: 1, inputData: [], outputData: [name], checkpoints: [], agentMode: 'none', ...extra })
const seq = (s, t) => ({ elementType: 'Sequence', id: `seq_${s}_${t}`, source: s, target: t, condition: '' })

const contract = {
  type: 'process-definition-result',
  processDefinition: {
    processDefinitionId: PID,
    processDefinitionName: '공급사 카탈로그 단가 조사',
    description: '구매 담당자가 조사 조건을 주면 브라우저 에이전트가 공급사 온라인 카탈로그에 접속해 조건에 맞는 품목과 단가를 모아 보고하고, 담당자가 발주 여부를 정한다.',
    isHorizontal: true,
    roles: [
      { name: '구매 담당자', endpoint: '', default: '', resolutionRule: '', origin: 'created' },
      { name: '브라우저 에이전트', endpoint: AGENT, default: AGENT, resolutionRule: '', origin: 'used' },
    ],
    data: [],
    elements: [
      { elementType: 'Event', id: 'start_event', name: '조사 요청 접수', role: '구매 담당자', type: 'StartEvent' },
      act('request_survey', '조사 요청', '구매 담당자', 'request', { description: '조사할 품목 분류와 조건을 입력한다.' }),
      act('browse_catalog', '공급사 카탈로그 조사 (브라우저 에이전트)', '브라우저 에이전트', 'result', {
        agent: AGENT, agentMode: 'complete', orchestration: 'browser-automation-agent', duration: 3,
        description: '브라우저 에이전트가 공급사 카탈로그 사이트에 접속해 조건에 맞는 품목을 찾는다.',
        instruction: '공급사 카탈로그 https://books.toscrape.com/ 에 접속한다. 왼쪽 분류 목록에서 요청된 품목 분류로 이동해, 최소 평점과 최대 단가 조건에 맞는 품목을 최대 5개 찾는다. 각 품목의 이름·단가·평점(별 개수)·재고 여부·상품 URL 을 note 로 기록하고, 가장 저렴한 품목을 추천한다.',
      }),
      act('review_quotes', '견적 검토·선정', '구매 담당자', 'review', { description: '조사 보고서를 보고 발주 여부를 정한다.' }),
      { elementType: 'Event', id: 'end_event', name: '조사 완료', role: '구매 담당자', type: 'EndEvent' },
      seq('start_event', 'request_survey'), seq('request_survey', 'browse_catalog'), seq('browse_catalog', 'review_quotes'), seq('review_quotes', 'end_event'),
    ],
  },
  forms: [
    { activity_id: 'request_survey', form_id: form('request'), html: html(form('request'), '조사 요청', fields.request) },
    { activity_id: 'browse_catalog', form_id: form('result'), html: html(form('result'), '공급사 카탈로그 조사', fields.result) },
    { activity_id: 'review_quotes', form_id: form('review'), html: html(form('review'), '견적 검토·선정', fields.review) },
  ],
  agents: [{ id: AGENT, skills: [] }],
  skills: [],
}

// the agent the browser step is bound to (process-gpt's default alias for browser automation)
await q(`insert into users (id, username, email, tenant_id, is_agent, is_admin, is_draft, agent_type, alias, goal, persona, permission_ids)
         values ($1,'브라우저 에이전트',$2,$3,true,false,false,'agent','browser-automation-agent',$4,$5,'{}')
         on conflict (id, tenant_id) do update set goal=$4, persona=$5`,
[AGENT, `browser-agent@${T}`, T, '웹 브라우저로 외부 사이트에 접속해 정보를 찾고 업무 화면을 조작한다.', '사이트에 보이는 사실만 기록하고, 결제·전송 전에는 사람의 승인을 받는다.'])

console.log(await saveGenerated(contract))
const [d] = await q(`select id, length(bpmn) as bpmn_len, definition->'activities'->1->>'orchestration' as orch from proc_def where id=$1 and tenant_id=$2`, [PID, T])
console.log(d)
console.log(await q(`select id, jsonb_array_length(fields_json) as n from form_def where proc_def_id=$1 and tenant_id=$2`, [PID, T]))
await pool.end()
