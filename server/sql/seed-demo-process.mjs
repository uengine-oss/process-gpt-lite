// Seeds a small end-to-end demo process into process-gpt (tenant from config):
//   출장비 신청 (사람, 폼) → 규정 검토 보고서 (deepagents 에이전트) → 결재 (사람) → 종료
// Same storage shape the process-gpt designer produces: proc_def.definition jsonb + form_def html/fields_json.
// Run: node sql/seed-demo-process.mjs
import { q, pool } from '../lib/supa.js'
import { config } from '../config.js'

const T = config.tenantId
const PID = 'pro_expense_claim'
const AGENT = '7e1f5c2a-3b4d-4e6f-8a9b-0c1d2e3f4a5b'

const forms = {
  [`${PID}_submit_form`]: [
    { key: 'trip_place', text: '출장지', type: 'text' },
    { key: 'trip_period', text: '출장 기간', type: 'text' },
    { key: 'amount', text: '청구 금액(원)', type: 'number' },
    { key: 'category', text: '비용 구분', type: 'select', items: [{ 교통: '교통비' }, { 숙박: '숙박비' }, { 식대: '식대' }, { 기타: '기타' }] },
    { key: 'purpose', text: '출장 목적', type: 'textarea' },
    { key: 'receipt', text: '영수증', type: 'file' },
  ],
  [`${PID}_review_form`]: [
    { key: 'review_report', text: '규정 검토 보고서', type: 'report' },
    { key: 'recommendation', text: '검토 의견', type: 'select', items: [{ 승인권고: '승인 권고' }, { 보완필요: '보완 필요' }] },
  ],
  [`${PID}_approve_form`]: [
    { key: 'decision', text: '결재', type: 'radio', items: [{ 승인: '승인' }, { 반려: '반려' }] },
    { key: 'comment', text: '결재 의견', type: 'textarea' },
  ],
}

const tag = { text: 'text-field', number: 'text-field', select: 'select-field', radio: 'radio-field', textarea: 'textarea-field', file: 'file-field', report: 'report-field' }
function html(formId, alias, fields) {
  const cell = (f) => {
    const t = tag[f.type] || 'text-field'
    const items = f.items ? ` is_dynamic_load='fixed' items='${JSON.stringify(f.items)}'` : ''
    const type = t === 'text-field' ? ` type='${f.type === 'number' ? 'number' : 'text'}'` : ''
    return `<${t} name='${f.key}' alias='${f.text}'${type}${items} disabled='false' readonly='false' v-model="slotProps.modelValue['${f.key}']"></${t}>`
  }
  return `<section>\n${fields.map((f) => `  <row-layout name="${formId}" alias="${alias}" is_multidata_mode="false" v-model="formValues" v-slot="slotProps">
    <div class="row"><div class="col-sm-12">${cell(f)}</div></div>
  </row-layout>`).join('\n')}\n</section>`
}

const act = (id, name, role, formId, extra = {}) => ({
  id, name, role, tool: `formHandler:${formId}`, type: 'userTask', agent: null, skills: [], process: PID,
  duration: 1, agentMode: 'none', inputData: [], outputData: [name], properties: '{}', attachments: [],
  checkpoints: [], description: '', instruction: '', orchestration: null, attachedEvents: [], customProperties: [], ...extra,
})
const seq = (s, t) => ({ id: `seq_${s}_${t}`, name: '', source: s, target: t, condition: '', properties: '{}' })

const reviewInstruction = `출장비 신청 내용을 회사 출장비 규정(교통비 실비, 숙박 1박 15만원 한도, 식대 1일 5만원 한도, 영수증 필수)에 비추어 검토한다.
앞 단계 입력값(출장지, 기간, 금액, 비용 구분, 목적, 영수증 첨부 여부)을 그대로 인용하고, 한도 초과·누락 항목을 표로 정리한 뒤 결론을 쓴다.
[최종 출력 형식 — 반드시 이 JSON 하나] {"${PID}_review_form": {"review_report": "<마크다운 보고서>", "recommendation": "승인권고 또는 보완필요"}}
필드 값 안의 줄바꿈은 \\n 으로 이스케이프한다. 코드 블록을 쓰지 않는다.`

const definition = {
  processDefinitionId: PID,
  processDefinitionName: '출장비 정산',
  description: '직원이 출장비를 청구하면 에이전트가 규정 검토 보고서를 쓰고, 결재자가 승인한다.',
  data: [],
  roles: [
    { name: '신청자', origin: 'created', default: '', endpoint: '', resolutionRule: '' },
    { name: '정산 검토 에이전트', origin: 'used', default: AGENT, endpoint: AGENT, resolutionRule: '' },
    { name: '결재자', origin: 'created', default: '', endpoint: '', resolutionRule: '' },
  ],
  events: [
    { id: 'start_event', name: '출장비 청구', role: '신청자', type: 'startEvent', process: PID, trigger: '', properties: '{}', description: '' },
    { id: 'end_event', name: '정산 완료', role: '결재자', type: 'endEvent', process: PID, trigger: '', properties: '{}', description: '' },
  ],
  skills: [],
  gateways: [],
  activities: [
    act('submit_claim', '출장비 신청', '신청자', `${PID}_submit_form`, { description: '출장 내역과 영수증을 올린다.' }),
    act('review_claim', '규정 검토 (정산 검토 에이전트)', '정산 검토 에이전트', `${PID}_review_form`, {
      agent: AGENT, agentMode: 'complete', orchestration: 'deepagents', duration: 3,
      inputData: [`${PID}_submit_form`], description: '에이전트가 규정에 맞는지 검토 보고서를 쓴다.', instruction: reviewInstruction,
    }),
    act('approve_claim', '결재', '결재자', `${PID}_approve_form`, { inputData: [`${PID}_review_form`], description: '검토 보고서를 보고 승인 또는 반려한다.' }),
  ],
  sequences: [seq('start_event', 'submit_claim'), seq('submit_claim', 'review_claim'), seq('review_claim', 'approve_claim'), seq('approve_claim', 'end_event')],
}

await q(`insert into users (id, username, email, tenant_id, is_agent, is_admin, is_draft, agent_type, model, goal, persona, alias, permission_ids)
         values ($1,'정산 검토 에이전트',$2,$3,true,false,false,'agent','gpt-4.1',$4,$5,'expense-review-agent','{}')
         on conflict (id, tenant_id) do update set goal=$4, persona=$5`,
[AGENT, `expense-review-agent@${T}`, T, '출장비 청구를 회사 규정에 비추어 검토하고 보고서를 쓴다.',
  '정산 담당 에이전트다. 입력값에 없는 사실을 지어내지 않고, 한도 초과와 누락을 표로 정리한다.'])

await q(`delete from proc_def where id=$1 and tenant_id=$2`, [PID, T])
await q(`insert into proc_def (id, name, definition, bpmn, tenant_id, isdeleted, type, is_draft, description, saved_at)
         values ($1,$2,$3,'',$4,false,'bpmn',false,$5, now())`, [PID, definition.processDefinitionName, definition, T, definition.description])
for (const [fid, fields] of Object.entries(forms)) {
  const a = definition.activities.find((x) => x.tool === `formHandler:${fid}`)
  await q('delete from form_def where id=$1 and tenant_id=$2', [fid, T])
  await q(`insert into form_def (uuid, id, html, proc_def_id, activity_id, tenant_id, fields_json) values (gen_random_uuid(),$1,$2,$3,$4,$5,$6)`,
    [fid, html(fid, a.name, fields), PID, a.id, T, JSON.stringify(fields.map((f) => ({ ...f, disabled: 'false', readonly: 'false' })))])
}
console.log('seeded', PID, 'forms:', Object.keys(forms).length)
await pool.end()
