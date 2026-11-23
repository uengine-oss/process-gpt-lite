// The document reader without Python (design-v0.3 §17): process-gpt's own document reading — bpmn-extractor (PDF2BPMN)
// EntityExtractor.extract_from_text, which bridge/extract_doc.py runs in the deepagents venv — done here with Lite's model.
// A server with no Python (the production image) reads a plain-text document (txt · md · csv) this way; the prompts below
// are PDF2BPMN's, copied unchanged from services/bpmn-extractor src/pdf2bpmn/extractors/entity_extractor.py (aee3efd,
// EXTRACTION_PROMPT · EXISTING_CONTEXT_TEMPLATE, the {{ }} of its template as plain braces). The answer has the same shape
// as extract_doc.py's: every chunk's entities, the later chunks reading with the names the earlier ones found.
import { chatJson } from '../llm.js'

export const EXTRACTION_PROMPT = `You are an expert at extracting business process elements from Korean business documents.
Your goal is to extract ALL relevant process elements from ANY type of business document, regardless of format.

Use the following explicit rules:
- Create or split entities only when the document provides a clear business reason.
- Do NOT create or split entities because of minor wording differences, sentence style differences, repeated explanation, or page change alone.
- Prefer stable business structure over creative inference.
- If the text clearly describes the same business purpose, keep it under the same process.
- If the text clearly describes the same business action by the same role, keep it under the same task.

{existing_context}

Analyze the following text and extract:
1. **Processes**: Business processes or procedures (절차, 업무 흐름, 처리 단계, 프로세스)
2. **Tasks/Activities**: Individual activities or actions (행위: ~한다, ~해야 한다, 점검, 승인, 검토, 접수, 등록, 통보, 보고)
3. **Roles**: Actors or performers (담당자, 승인권자, 검토자, 부서명, 직책, 시스템, 외부기관)
4. **Gateways**: Decision/branching POINTS only (분기점 - where flow splits or merges)
5. **Events**: Start/End triggers (요청 접수 시, 신청서 제출 후, 정기적으로, 완료 시)
6. **Decisions**: Business rules or decision logic (if-then rules)
7. **Rules**: Specific decision rules (조건-결과 pairs)

IMPORTANT: Also extract RELATIONSHIPS between entities:
8. **task_role_mappings**: Which role performs which task
9. **task_process_mappings**: Which process contains which task
10. **sequence_flows**: The order/sequence between tasks WITH CONDITIONS (VERY IMPORTANT!)
    - Identify which task comes BEFORE and AFTER another
    - **CONDITIONS GO HERE, NOT IN GATEWAYS**: "승인인 경우", "거부인 경우", "예산 부족 시", "금액 100만원 이상" etc.
    - Look for conditional keywords: "~인 경우", "~면", "~시", "아니면", "그렇지 않으면"
    - Look for sequential keywords: "다음", "이후", "후에", "그 다음", "완료 후"
    - Look for numbered steps: 1단계, 2단계, Step 1, Step 2

For each entity, provide:
- name: Clear, concise name
- description: Brief description from the text
- evidence: The exact text span that supports this extraction
- confidence: Your confidence level (0.0 to 1.0)
- order: Sequential order number if identifiable (1, 2, 3...)

PROCESS DECISION RULES:
- Start a NEW process only when at least one of these is clearly true:
  1. business purpose changes
  2. trigger/start condition changes
  3. final outcome changes
  4. the document explicitly introduces a separate procedure/process/workflow
- Do NOT start a new process when:
  1. the same process is described in more detail
  2. the same process continues on a later page
  3. wording/style changes but business purpose stays the same
  4. supporting notes/examples/exceptions are added

TASK DECISION RULES:
- Create a NEW task only when at least one of these is clearly true:
  1. performer role changes
  2. there is a real handoff or stage transition
  3. there is an approval/review/waiting/decision point between actions
  4. the business action itself is different
- Do NOT create a new task when:
  1. the same role continues the same purpose with more detail
  2. the text only adds explanation, checklist items, or execution notes
  3. two adjacent lines describe the same business action with slightly different wording

GATEWAY DECISION RULES:
- Create a gateway only when the text indicates a real split, merge, or decision point.
- Do NOT create a gateway for simple sequential explanation or detail expansion.
- If there is no real branching evidence, keep the flow linear.

For tasks, also identify:
- task_type: "human" (사람이 수행), "agent" (AI/자동화 가능), "system" (시스템 자동)
- performer_role: Name of the role that performs this task (IMPORTANT!)
- parent_process: Name of the process this task belongs to (IMPORTANT!)
- instruction: **How to perform this task** (태스크 수행 지침, Korean)
  - Preserve document wording as much as possible. Do NOT summarize or paraphrase when explicit instructions are present.
  - Keep line breaks/order from source text whenever possible.
  - Include inputs/outputs/checkpoints exactly as stated in the document if provided.
  - If the source does not provide explicit execution instructions, return "".
- order: Sequential order within the process (1, 2, 3...)
- next_task: Name of the task that follows this one (if identifiable)
- previous_task: Name of the task that precedes this one (if identifiable)
- Prefer one stable representative name for the same business action.
- Avoid near-duplicate task names that differ only by modifiers, suffixes, or wording order.

For gateways (IMPORTANT: Gateway is just a BRANCHING POINT, NOT the condition itself):
- gateway_type: "exclusive" (XOR - only one path taken), "parallel" (AND - all paths), "inclusive" (OR)
- name: Descriptive name for the decision point (e.g., "승인 여부 분기", "예산 확인 분기", "금액 기준 분기")
  - If description contains "~인지 여부", gateway name MUST follow "<주제> 여부 판단"
    Example: "예비타당성조사 대상 사업인지 여부..." -> "예비타당성조사 대상 사업 여부 판단"
  DO NOT put condition text here - just the name of the decision point
- parent_process: Name of the process this gateway belongs to
- incoming_task: Name of the task before this gateway (REQUIRED — what flows INTO this gateway)
- outgoing_branches: **REQUIRED** — List of branches OUT of this gateway. This is the most
  important field — without it the gateway has no purpose and will be discarded.
  Format: [ { "to_task": "<existing task name>", "condition": "<branch condition>" }, ... ]
  Rules (MUST follow):
    1. MUST contain at least 2 entries (a gateway with <2 branches is not a gateway).
    2. Each "to_task" MUST refer to a task that exists in the tasks list (or in the
       provided existing_tasks context). Do NOT invent task names that are not in the
       document; do NOT use gateway names; do NOT use roles or events.
    3. Each "condition" MUST be a real, semantically distinct condition from the source
       text (e.g., "승인인 경우" / "거부인 경우"). Do NOT use placeholders like
       "조건1", "분기1", or "case1".
    4. For exclusive/inclusive gateways: conditions must be mutually meaningful (e.g.,
       a true/false pair or a clear set of exclusive cases).
    5. For parallel gateways: condition can be "" but at least 2 outgoing tasks are still
       required.
  Example for "승인권자가 승인하면 발주 처리를 진행하고, 거부하면 반려 통보한다":
    outgoing_branches = [
      { "to_task": "발주 처리", "condition": "승인인 경우" },
      { "to_task": "반려 통보", "condition": "거부인 경우" }
    ]
  NOTE: You MUST also list these same branches as entries in \`sequence_flows\` (with
  from_task = this gateway's name). The two MUST be consistent. Duplicate listing is
  intentional and required.
- description: Brief description of what decision is being made

For decisions:
- input_data: List of input data items
- output_data: List of output data items
- related_role: Role that makes this decision

For rules:
- decision_name: Name of the decision this rule belongs to (IMPORTANT)
- decision_id: Optional, only when clearly known
- when: Condition expression
- then: Result/action

IMPORTANT POLICY CHANGE:
- Do NOT extract "skills" as a separate entity.
- If the text contains professional know-how/criteria/judgment logic, map it to:
  1) task.instruction (execution guidance), and/or
  2) decisions/rules (explicit decision criteria).
- Therefore, return "skills": [] and "role_skill_mappings": [].

For task_role_mappings:
- task_name: Name of the task
- role_name: Name of the role that performs it

For task_process_mappings:
- task_name: Name of the task
- process_name: Name of the parent process

**For sequence_flows (CRITICAL - CONDITIONS ARE EXTRACTED HERE!):**
- from_task: Name of the source task (or gateway name like "승인 여부 분기")
- to_task: Name of the target task
- condition: **THE CONDITION FOR THIS SPECIFIC PATH** (VERY IMPORTANT!)
  Examples:
    - "승인인 경우" (when approved)
    - "거부인 경우" (when rejected)
    - "예산 충분" (budget sufficient)
    - "예산 부족" (budget insufficient)
    - "금액 100만원 이상" (amount >= 1M)
    - "금액 100만원 미만" (amount < 1M)
  Leave empty ("") for default/unconditional flows
- CONDITION QUALITY RULES (MANDATORY):
  - NEVER output placeholder conditions like "조건1", "조건 1", "분기1", "case1"
  - NEVER output graph edge names/labels like "HAS_TASK", "HAS_INSTRUCTION", "PERFORMED_BY"
  - If a gateway has multiple outgoing paths, each condition must be semantically distinct
  - If an exclusive gateway has exactly 2 outgoing flows, prefer true/false pair:
    "<주제>인 경우" / "<주제>이 아닌 경우"
  - Prefer source wording from document ("승인인 경우", "미승인 시", "요건 충족 시", "재검토 필요 시")
- process_name: Name of the process this flow belongs to

SELF-CHECK BEFORE OUTPUT:
- Did I create a new process only when the business purpose truly changed?
- Did I avoid creating duplicate tasks from repeated explanation?
- Did I avoid creating gateways without real branching evidence?
- Are the names stable and reusable as business labels?

Example of correct extraction:
If text says: "승인권자가 승인하면 발주 처리를 진행하고, 거부하면 구매요청자에게 반려 통보한다"
Extract:
- Gateway:
    name="승인 여부 분기",
    gateway_type="exclusive",
    incoming_task="승인 요청",
    outgoing_branches=[
      { "to_task": "발주 처리", "condition": "승인인 경우" },
      { "to_task": "반려 통보", "condition": "거부인 경우" }
    ]
- sequence_flows (consistent duplicate listing):
  1. from_task="승인 여부 분기", to_task="발주 처리", condition="승인인 경우"
  2. from_task="승인 여부 분기", to_task="반려 통보", condition="거부인 경우"

TEXT TO ANALYZE:
{text}

Respond with a JSON object containing arrays for each entity type.
Return ONLY valid JSON, no markdown formatting.`

export const EXISTING_CONTEXT_TEMPLATE = `
**IMPORTANT - EXISTING ENTITIES (이미 추출된 엔티티들):**

{process_list}
{role_list}
{task_list}

**CRITICAL RULES FOR PROCESS IDENTIFICATION (프로세스 식별 규칙):**
1. If a task clearly belongs to an EXISTING process listed above, use that EXACT process name for parent_process.
   (태스크가 위에 나열된 기존 프로세스에 속하면, 정확히 그 프로세스 이름을 parent_process로 사용하세요)

2. Do NOT create a new process if the content describes steps/tasks of an existing process.
   (내용이 기존 프로세스의 단계/태스크를 설명하는 경우 새 프로세스를 만들지 마세요)

3. "발주 처리", "입고 검수", "대금 지급" etc. are likely TASKS within a larger process, NOT separate processes.
   ("발주 처리", "입고 검수", "대금 지급" 등은 별도 프로세스가 아니라 상위 프로세스의 태스크일 가능성이 높습니다)

4. Look for phrases like "~단계", "~절차", "제N조" which indicate sub-steps of an existing process.
   ("~단계", "~절차", "제N조" 같은 표현은 기존 프로세스의 하위 단계를 나타냅니다)

5. Only create a NEW process if the text explicitly defines a completely different business process.
   (텍스트가 완전히 다른 업무 프로세스를 명시적으로 정의하는 경우에만 새 프로세스를 생성하세요)

6. For existing roles, use the EXACT same name - do not create duplicates with slightly different names.
   (기존 역할의 경우 정확히 같은 이름을 사용하세요 - 약간 다른 이름으로 중복 생성하지 마세요)

**CRITICAL RULES FOR TASK DEDUPLICATION (태스크 중복 제거 규칙):**
7. BEFORE creating a new task, check the EXISTING TASKS list above. If a similar task already exists, DO NOT create a duplicate.
   (새 태스크를 만들기 전에 위의 기존 태스크 목록을 확인하세요. 유사한 태스크가 이미 있으면 중복 생성하지 마세요)

8. Tasks performed by the SAME ROLE in sequence WITHOUT requiring other department collaboration should be MERGED into ONE task.
   (다른 부서 협업 없이 같은 역할이 연속으로 수행하는 작업은 하나의 태스크로 통합해야 합니다)
   Examples of tasks to MERGE (통합해야 할 태스크 예시):
   - "구매요청서 접수" + "형식 검토" → "구매요청서 접수 및 형식 검토" (same role: 구매담당자)
   - "견적서 검토" + "견적 비교" → "견적서 검토 및 비교" (same role)

9. Tasks are SEPARATE only when:
   - Different roles perform them (역할이 다를 때)
   - There is a waiting/approval point between them (승인/대기 시점이 있을 때)
   - They belong to different stages requiring handoff (업무 인계가 필요한 다른 단계일 때)

10. If the current text provides MORE DETAIL about an existing task, DO NOT create a new task.
    Instead, the existing task's description should be enhanced (but this is handled in post-processing).
    (현재 텍스트가 기존 태스크에 대한 추가 설명이면 새 태스크를 만들지 마세요)

`

const KEYS = ['processes', 'tasks', 'roles', 'gateways', 'events', 'decisions', 'rules', 'task_role_mappings', 'task_process_mappings', 'sequence_flows']
const fill = (tpl, vals) => Object.entries(vals).reduce((s, [k, v]) => s.replace(`{${k}}`, () => v), tpl)

// EntityExtractor._build_context: the processes, roles and tasks found so far, so a later part keeps their names
export function contextOf(processes = [], roles = [], tasks = []) {
  if (!processes.length && !roles.length && !tasks.length) return ''
  return fill(EXISTING_CONTEXT_TEMPLATE, {
    process_list: processes.length ? `**기존 프로세스 목록 (Existing Processes):**\n${processes.map((p) => `  - ${p}`).join('\n')}` : '',
    role_list: roles.length ? `**기존 역할 목록 (Existing Roles):**\n${roles.map((r) => `  - ${r}`).join('\n')}` : '',
    task_list: tasks.length ? `**기존 태스크 목록 (Existing Tasks - DO NOT DUPLICATE):**\n${tasks.map((t) => `  - ${t.name || 'Unknown'}${t.role ? ` (담당: ${t.role})` : ''}${t.process ? ` [프로세스: ${t.process}]` : ''}`).join('\n')}` : '',
  })
}

// extract_doc.py main(), with the model call of extract_from_text: a part that cannot be read gives nothing (as there) and the
// reading goes on. onChunk(i, n) before each part (the "chunk i/n" lines the Python reader writes).
export async function readInNode(chunks, existing = {}, onChunk, { timeoutMs = 240000 } = {}) {
  const parts = (chunks || []).filter((c) => String(c).trim())
  const procs = [...(existing.processes || [])], roles = [...(existing.roles || [])], tasks = [...(existing.tasks || [])]
  const out = Object.fromEntries(KEYS.map((k) => [k, []]))
  const [head, tail] = EXTRACTION_PROMPT.split('TEXT TO ANALYZE:')
  let read = 0, lastError = null
  for (const [i, text] of parts.entries()) {
    onChunk?.(i + 1, parts.length)
    let got = {}
    try {
      got = await chatJson(fill(head, { existing_context: contextOf(procs, roles, tasks) }).trim(), `TEXT TO ANALYZE:${fill(tail, { text })}`, { temperature: 0, timeoutMs })
      read++
    } catch (e) { lastError = e; console.warn(`[ontology] document part ${i + 1}/${parts.length}`, e.message) }
    for (const k of KEYS) for (const x of Array.isArray(got?.[k]) ? got[k] : []) if (x && typeof x === 'object') out[k].push({ ...x, chunk: i })
    for (const p of Array.isArray(got?.processes) ? got.processes : []) if (p?.name && !procs.includes(p.name)) procs.push(p.name)
    for (const r of Array.isArray(got?.roles) ? got.roles : []) if (r?.name && !roles.includes(r.name)) roles.push(r.name)
    const owner = new Map((Array.isArray(got?.task_role_mappings) ? got.task_role_mappings : []).filter((m) => m && typeof m === 'object').map((m) => [m.task_name, m.role_name]))
    const within = new Map((Array.isArray(got?.task_process_mappings) ? got.task_process_mappings : []).filter((m) => m && typeof m === 'object').map((m) => [m.task_name, m.process_name]))
    for (const t of Array.isArray(got?.tasks) ? got.tasks : []) {
      if (t?.name && !tasks.some((x) => x.name === t.name)) tasks.push({ name: t.name, role: owner.get(t.name) || '', process: within.get(t.name) || t.parent_process || '', order: t.order })
    }
  }
  // no part could be read at all (the model is down): said as the reading's failure, not as "no procedure in the document"
  if (parts.length && !read && lastError) throw new Error(`문서를 읽는 모델에 묻지 못했어요(${String(lastError.message).slice(0, 120)}).`)
  return out
}
