<script setup>
// 「이 단계는」(server lib/ontology/steprule.js): 프로세스 안에서 이 단계가 꼭 하는 단계(조직이 약속한 단계 — 늘 해요) · 해도 되고 안 해도
// 되는 단계(건마다 필요한지 보고 건너뛸 수 있어요) · 지도대로인지, 그리고 사안에 따라(금액 · 글로 쓴 조건, 위에서부터 맞는 첫 규칙) 바뀌는지.
// 다듬기의 단계 분류가 AI 제안으로 곁에 보인다(제안일 뿐, 정한 것이 저장된다). 보기는 누구나, 바꾸기는 관리자(결정 기록에 남아요).
// procKey: 지도에서 고른 프로세스(없거나 이 일이 그 프로세스에 없으면 procs 가운데 고른다) · emits changed({proc, task, requirement})
import { ref, computed, watch } from 'vue'
import { api } from '../../api.js'
import { REQ_KO, REQ_SHORT } from './ontoText.js'

const props = defineProps({ taskKey: { type: String, required: true }, procKey: { type: String, default: '' }, procs: { type: Array, default: () => [] }, admin: Boolean })
const emit = defineEmits(['changed'])

// the processes whose flow as a case runs it has this step (server: a step 다듬기 added is not on the found map; one it took out
// is there but not run) — the map's own list until that is read
const known = ref(null)
const list = computed(() => known.value || props.procs)
const inProc = computed(() => !!props.procKey && list.value.some((p) => p.key === props.procKey))
watch(() => props.taskKey, async (k) => {
  known.value = null
  try { const r = await api(`/ontology/tasks/${encodeURIComponent(k)}/step-processes`); if (k === props.taskKey) known.value = r.procs || [] } catch { /* the map's list */ }
}, { immediate: true })
const proc = ref('')
const d = ref(null)
const err = ref('')
const note = ref('')
const busy = ref(false)
const req = ref('auto')
const rules = ref([])
const reason = ref('')

const CHOICES = [
  { key: 'required', ko: REQ_KO.required, tip: '조직이 약속한 단계예요. 늘 하고, 에이전트가 건너뛰지 않아요.' },
  { key: 'optional', ko: REQ_KO.optional, tip: '건마다 필요한지 보고, 필요 없으면 까닭을 남기고 건너뛰어요.' },
  { key: 'auto', ko: '지도대로', tip: '찾은 흐름대로 해요.' },
]
const OPS = [{ key: '>=', ko: '이상' }, { key: '>', ko: '초과' }, { key: '<=', ko: '이하' }, { key: '<', ko: '미만' }]
const opKo = (op) => OPS.find((o) => o.key === op)?.ko || op
const won = (n) => {
  const v = Math.round(Number(n)), f = (x) => new Intl.NumberFormat('ko-KR').format(x)
  if (!Number.isFinite(v)) return ''
  if (v >= 1e8 && v % 1e4 === 0) { const m = (v % 1e8) / 1e4; return `${f(Math.floor(v / 1e8))}억${m ? ` ${f(m)}만` : ''}원` }
  return v >= 1e4 && v % 1e4 === 0 ? `${f(v / 1e4)}만원` : `${f(v)}원`
}
// 「1,000만」 · 「1억 2000만」 · 「3500000」 → 원
function parseWon(s) {
  const t = String(s || '').replace(/[,\s원]/g, '')
  const m = t.match(/^(?:(\d+(?:\.\d+)?)억)?(?:(\d+(?:\.\d+)?)만)?(\d+)?$/)
  if (!t || !m || (!m[1] && !m[2] && !m[3])) return NaN
  return Math.round((+m[1] || 0) * 1e8 + (+m[2] || 0) * 1e4 + (+m[3] || 0))
}
const ruleLine = (r) => `${r.when.field === 'amount' ? `금액 ${won(r.when.value)} ${opKo(r.when.op)}` : `「${r.when.text}」`} → ${REQ_SHORT[r.then]}`

async function load() {
  if (!proc.value) { d.value = null; return }
  err.value = ''; note.value = ''
  try {
    d.value = await api(`/ontology/processes/${encodeURIComponent(proc.value)}/steps/${encodeURIComponent(props.taskKey)}/requirement`)
    reset()
  } catch (e) { d.value = null; err.value = e.message }
}
function reset() {
  req.value = d.value?.requirement || 'auto'
  rules.value = (d.value?.rules || []).map((r) => ({ when: { ...r.when }, then: r.then }))
  reason.value = d.value?.reason || ''
}
// the process to read: the one on the map when the task is in it, else the first of the task's own (the picker changes it)
watch(proc, load)
watch(() => [props.taskKey, props.procKey, list.value.map((p) => p.key).join('|')], () => {
  const next = inProc.value ? props.procKey : list.value[0]?.key || ''
  if (next === proc.value) load()
  else proc.value = next
}, { immediate: true })

const procName = computed(() => d.value?.proc?.name || list.value.find((p) => p.key === proc.value)?.name || '')
const sugg = computed(() => d.value?.suggestion || null)
const dirty = computed(() => !!d.value && (req.value !== (d.value.requirement || 'auto') || JSON.stringify(rules.value) !== JSON.stringify((d.value.rules || []).map((r) => ({ when: r.when, then: r.then }))) || reason.value.trim() !== (d.value.reason || '')))

// 사안에 따라: 더하기 · 순서 · 빼기
const addKind = ref('amount')
const addOp = ref('>=')
const addValue = ref('')
const addText = ref('')
const addThen = ref('required')
const addErr = ref('')
const addValueWon = computed(() => { const v = parseWon(addValue.value); return Number.isFinite(v) ? won(v) : '' })
function addRule() {
  addErr.value = ''
  if (addKind.value === 'amount') {
    const v = parseWon(addValue.value)
    if (!Number.isFinite(v)) { addErr.value = '금액을 숫자로 적어 주세요(예: 1000만, 5,000,000).'; return }
    rules.value.push({ when: { field: 'amount', op: addOp.value, value: v }, then: addThen.value })
    addValue.value = ''
  } else {
    const t = addText.value.replace(/\s+/g, ' ').trim()
    if (!t) { addErr.value = '조건을 글로 적어 주세요.'; return }
    rules.value.push({ when: { text: t }, then: addThen.value })
    addText.value = ''
  }
}
function moveRule(i, by) { const j = i + by; if (j < 0 || j >= rules.value.length) return; const x = [...rules.value]; [x[i], x[j]] = [x[j], x[i]]; rules.value = x }
const dropRule = (i) => { rules.value = rules.value.filter((_, k) => k !== i) }

async function save() {
  busy.value = true; err.value = ''; note.value = ''
  try {
    d.value = await api(`/ontology/processes/${encodeURIComponent(proc.value)}/steps/${encodeURIComponent(props.taskKey)}/requirement`, { method: 'PUT',
      body: { requirement: req.value === 'auto' ? null : req.value, rules: rules.value, reason: reason.value.trim() } })
    reset()
    note.value = '저장했어요. 이 프로세스의 건은 다음 단계부터 이대로 해요.'
    emit('changed', { proc: proc.value, task: props.taskKey, requirement: d.value.requirement, rules: d.value.rules.length })
  } catch (e) { err.value = e.message } finally { busy.value = false }
}
</script>

<template>
  <section v-if="proc" class="sr" data-testid="onto-steprule" :data-requirement="d?.requirement || 'auto'">
    <div class="hd">
      <h4>이 단계는</h4>
      <select v-if="list.length > 1" v-model="proc" class="sel" aria-label="프로세스" data-testid="onto-steprule-proc">
        <option v-for="p in list" :key="p.key" :value="p.key">{{ p.name }}{{ p.refinedOnly ? ' · 다듬기에서 더한 단계' : '' }}</option>
      </select>
      <small v-else-if="procName" class="ctx">「{{ procName }}」에서</small>
    </div>
    <p v-if="!d && !err" class="muted pulse">불러오는 중…</p>
    <template v-if="d">
      <div class="opts" role="radiogroup" aria-label="이 단계는">
        <button v-for="c in CHOICES" :key="c.key" class="opt press" role="radio" :aria-checked="req === c.key" :class="[c.key, { on: req === c.key }]" :disabled="!admin || busy"
          :data-testid="`onto-steprule-opt-${c.key}`" @click="req = c.key">
          <b><i v-if="c.key === 'required'" class="lock" aria-hidden="true" />{{ c.ko }}</b><small>{{ c.tip }}</small>
        </button>
      </div>
      <p v-if="sugg" class="ai" data-testid="onto-steprule-ai" :data-suggest="sugg.requirement">
        <span class="cap">{{ sugg.by === 'person' ? '다듬기에서 정한 분류' : 'AI 제안' }}</span> {{ REQ_KO[sugg.requirement] }}<template v-if="sugg.why"> — {{ sugg.why }}</template>
        <button v-if="admin && req !== sugg.requirement" class="lnk press" :disabled="busy" data-testid="onto-steprule-ai-apply" @click="req = sugg.requirement">이걸로</button>
      </p>

      <div class="rules">
        <div class="rh"><b>사안에 따라</b><small>위에서부터 맞는 첫 규칙을 따라요. 맞는 게 없으면 위에서 고른 대로예요.</small></div>
        <ol v-if="rules.length" class="rl">
          <li v-for="(r, i) in rules" :key="i" data-testid="onto-steprule-rule" :data-then="r.then">
            <span class="n">{{ i + 1 }}</span><span class="t">{{ ruleLine(r) }}</span>
            <template v-if="admin">
              <button class="ic press" :disabled="busy || i === 0" aria-label="위로" data-testid="onto-steprule-rule-up" @click="moveRule(i, -1)">↑</button>
              <button class="ic press" :disabled="busy || i === rules.length - 1" aria-label="아래로" data-testid="onto-steprule-rule-down" @click="moveRule(i, 1)">↓</button>
              <button class="ic press" :disabled="busy" aria-label="빼기" data-testid="onto-steprule-rule-del" @click="dropRule(i)">✕</button>
            </template>
          </li>
        </ol>
        <small v-else-if="!admin" class="muted">사안에 따른 규칙이 없어요.</small>
        <div v-if="admin" class="add">
          <select v-model="addKind" class="sel" aria-label="규칙 종류" data-testid="onto-steprule-add-kind">
            <option value="amount">금액이</option><option value="text">글로 쓴 조건</option>
          </select>
          <template v-if="addKind === 'amount'">
            <input v-model="addValue" class="in num" inputmode="numeric" placeholder="1000만" aria-label="금액" data-testid="onto-steprule-add-value" @keydown.enter.prevent="addRule" />
            <select v-model="addOp" class="sel sm" aria-label="비교" data-testid="onto-steprule-add-op">
              <option v-for="o in OPS" :key="o.key" :value="o.key">{{ o.ko }}</option>
            </select>
            <span class="w">이면</span>
          </template>
          <input v-else v-model="addText" class="in" maxlength="200" placeholder="예: 외부 고객에게 처음 나가는 제안이면" aria-label="조건" data-testid="onto-steprule-add-text" @keydown.enter.prevent="addRule" />
          <select v-model="addThen" class="sel sm" aria-label="그러면" data-testid="onto-steprule-add-then">
            <option value="required">꼭</option><option value="optional">선택</option>
          </select>
          <button class="ghost2 press" :disabled="busy" data-testid="onto-steprule-add" @click="addRule">더하기</button>
        </div>
        <small v-if="admin && addKind === 'amount' && addValueWon" class="muted">{{ addValueWon }}</small>
        <small v-if="addErr" class="err">{{ addErr }}</small>
      </div>

      <ul class="lines" data-testid="onto-steprule-lines"><li v-for="(l, i) in d.lines" :key="i">{{ l }}</li></ul>
      <template v-if="admin">
        <input v-model="reason" class="in wide" maxlength="300" placeholder="정한 까닭(선택) — 결정 기록에 남아요" aria-label="정한 까닭" data-testid="onto-steprule-reason" />
        <div class="btns">
          <button v-if="dirty" class="ghost press" :disabled="busy" @click="reset">되돌리기</button>
          <button class="go press" :disabled="busy || !dirty" data-testid="onto-steprule-save" @click="save">{{ busy ? '저장하는 중…' : '저장' }}</button>
        </div>
      </template>
      <small v-else class="muted">바꾸기는 관리자가 해요.</small>
      <small v-if="note" class="ok" data-testid="onto-steprule-note">{{ note }}</small>
    </template>
    <small v-if="err" class="err">{{ err }}</small>
  </section>
</template>

<style scoped>
.sr { padding: 12px; border-radius: 16px; background: var(--cell-bg); min-width: 0; display: flex; flex-direction: column; gap: 10px; word-break: keep-all; overflow-wrap: anywhere; }
.hd { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
h4 { margin: 0; font-size: 13px; font-weight: 600; color: var(--text-secondary); }
.ctx { font-size: 12px; color: var(--text-tertiary); }
.muted { margin: 0; font-size: 12.5px; color: var(--text-secondary); line-height: 1.5; }
.err { font-size: 12.5px; color: var(--color-error); }
.ok { font-size: 12.5px; color: var(--color-success); }
.opts { display: flex; flex-direction: column; gap: 6px; }
.opt { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 9px 12px; border-radius: 12px; background: var(--field-bg); text-align: left; box-shadow: inset 0 0 0 1px transparent; transition: box-shadow .15s, background .15s; }
.opt b { font-size: 14px; font-weight: 600; display: inline-flex; align-items: center; gap: 6px; }
.opt small { font-size: 12px; color: var(--text-secondary); line-height: 1.4; }
.opt.on { background: color-mix(in srgb, var(--ink) 8%, var(--field-bg)); box-shadow: inset 0 0 0 2px var(--ink); }
.opt.on.required { box-shadow: inset 0 0 0 2px var(--step-req); }
.opt.on.optional { box-shadow: inset 0 0 0 2px var(--step-opt); background: color-mix(in srgb, var(--step-opt) 8%, var(--field-bg)); }
.opt:disabled { cursor: default; }
.opt:disabled:not(.on) { opacity: .6; }
.lock { display: inline-block; width: 11px; height: 12px; background: currentColor; -webkit-mask: var(--lock-mask) center / contain no-repeat; mask: var(--lock-mask) center / contain no-repeat; }
.sr { --step-req: #7a4fd0; --step-opt: #2b7fbf; --lock-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 14'%3E%3Cpath d='M3 6V4a3 3 0 0 1 6 0v2h1.5v8h-9V6zm1.5 0h3V4a1.5 1.5 0 0 0-3 0z'/%3E%3C/svg%3E"); }
.ai { margin: 0; font-size: 13px; line-height: 1.5; }
.cap { font-size: 12px; color: var(--text-tertiary); margin-right: 2px; }
.lnk { margin-left: 6px; font-size: 12.5px; color: var(--color-info); }
.lnk:disabled { opacity: .5; }
.rules { display: flex; flex-direction: column; gap: 6px; padding-top: 8px; border-top: 1px solid var(--hairline); }
.rh { display: flex; flex-direction: column; gap: 2px; }
.rh b { font-size: 13.5px; font-weight: 600; }
.rh small { font-size: 12px; color: var(--text-secondary); line-height: 1.4; }
.rl { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.rl li { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: 10px; background: var(--field-bg); font-size: 13px; }
.rl .n { flex: none; width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center; font-size: 11px; font-weight: 600; background: var(--chip-bg); }
.rl .t { flex: 1; min-width: 0; line-height: 1.4; }
.ic { flex: none; width: 24px; height: 24px; border-radius: 8px; font-size: 12px; color: var(--text-secondary); }
.ic:hover:not(:disabled) { background: var(--button-bg); color: var(--text-primary); }
.ic:disabled { opacity: .3; }
.add { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.sel { height: 32px; padding: 0 8px; border-radius: 10px; border: 0; background: var(--field-bg); font-size: 13px; color: var(--text-primary); min-width: 0; }
.sel.sm { flex: none; }
.in { flex: 1 1 140px; min-width: 0; height: 32px; padding: 0 10px; border-radius: 10px; border: 0; outline: 0; background: var(--field-bg); font-size: 13px; color: var(--text-primary); }
.in.num { flex: 0 1 110px; font-variant-numeric: tabular-nums; }
.in.wide { flex: none; width: 100%; }
.in:focus { box-shadow: inset 0 0 0 1.5px var(--hairline); }
.w { font-size: 13px; color: var(--text-secondary); }
.lines { margin: 0; padding-left: 18px; font-size: 12.5px; color: var(--text-secondary); line-height: 1.5; display: flex; flex-direction: column; gap: 2px; }
.btns { display: flex; justify-content: flex-end; gap: 6px; }
.ghost { height: 34px; padding: 0 14px; border-radius: 9999px; font-size: 13.5px; color: var(--text-secondary); }
.ghost2 { height: 32px; padding: 0 14px; border-radius: 9999px; font-size: 13px; font-weight: 500; background: var(--field-bg); box-shadow: inset 0 0 0 1px var(--hairline); }
.go { height: 34px; padding: 0 16px; border-radius: 9999px; font-size: 13.5px; font-weight: 600; background: var(--ink); color: var(--ink-inverse); }
.go:disabled, .ghost:disabled, .ghost2:disabled { opacity: .45; cursor: default; }
</style>
