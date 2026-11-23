<script setup>
// 간선 설정(server lib/ontology/edgecond.js, edge-step-condition): 이 프로세스에서 이 사건 → 일 간선으로 들어오는 다음 일이
//   꼭 하는 단계 · 해도 되고 안 해도 되는 단계 · 지도대로인지, 사안에 따라(금액 · 글로 쓴 조건, 위에서부터 맞는 첫 규칙) 바뀌는지,
//   그리고 단계 분류(사람이 꼭 · AI가 맡음 · 걷어냄 · 건너뛰었지만 해야 함).
// 같은 간선을 쓰는 다른 프로세스에는 걸리지 않는다. 같은 일로 들어오는 다른 간선에 같은 설정을 함께 넣을 수 있다.
// 보기는 누구나, 바꾸기는 관리자(결정 기록에 남아요). emits changed({proc, event, task})
import { ref, computed, watch } from 'vue'
import { api } from '../../api.js'
import { REQ_KO, REQ_SHORT } from './ontoText.js'

const props = defineProps({ procKey: { type: String, required: true }, event: { type: String, required: true }, task: { type: String, required: true }, admin: Boolean })
const emit = defineEmits(['changed'])

const d = ref(null)
const err = ref('')
const note = ref('')
const busy = ref(false)
const req = ref('auto')
const rules = ref([])
const cls = ref('none')
const reason = ref('')
const also = ref([])

const CHOICES = [
  { key: 'required', ko: REQ_KO.required, tip: '이 간선으로 들어오면 늘 해요. 에이전트가 건너뛰지 않아요.' },
  { key: 'optional', ko: REQ_KO.optional, tip: '건마다 필요한지 보고, 필요 없으면 까닭을 남기고 건너뛰어요.' },
  { key: 'auto', ko: '지도대로', tip: '찾은 흐름대로 해요.' },
]
const CLASSES = [
  { key: 'human', ko: '사람이 꼭', tip: '사람의 판단 · 책임 · 대면이 필요한 일이에요.' },
  { key: 'ai', ko: 'AI가 맡음', tip: '에이전트가 할 수 있는 일이에요.' },
  { key: 'drop', ko: '걷어냄', tip: '수작업 때문에 필요했던 일이에요.' },
  { key: 'skipped', ko: '건너뛰었지만 해야 함', tip: '기록에서는 자주 빠지지만 해야 하는 일이에요.' },
  { key: 'none', ko: '정하지 않음', tip: '' },
]
const CLASS_KO = Object.fromEntries(CLASSES.map((c) => [c.key, c.ko]))
const OPS = [{ key: '>=', ko: '이상' }, { key: '>', ko: '초과' }, { key: '<=', ko: '이하' }, { key: '<', ko: '미만' }]
const opKo = (op) => OPS.find((o) => o.key === op)?.ko || op
const won = (n) => {
  const v = Math.round(Number(n)), f = (x) => new Intl.NumberFormat('ko-KR').format(x)
  if (!Number.isFinite(v)) return ''
  if (v >= 1e8 && v % 1e4 === 0) { const m = (v % 1e8) / 1e4; return `${f(Math.floor(v / 1e8))}억${m ? ` ${f(m)}만` : ''}원` }
  return v >= 1e4 && v % 1e4 === 0 ? `${f(v / 1e4)}만원` : `${f(v)}원`
}
function parseWon(s) {
  const t = String(s || '').replace(/[,\s원]/g, '')
  const m = t.match(/^(?:(\d+(?:\.\d+)?)억)?(?:(\d+(?:\.\d+)?)만)?(\d+)?$/)
  if (!t || !m || (!m[1] && !m[2] && !m[3])) return NaN
  return Math.round((+m[1] || 0) * 1e8 + (+m[2] || 0) * 1e4 + (+m[3] || 0))
}
const ruleLine = (r) => `${r.when.field === 'amount' ? `금액 ${won(r.when.value)} ${opKo(r.when.op)}` : `「${r.when.text}」`} → ${REQ_SHORT[r.then]}`
const url = () => `/ontology/processes/${encodeURIComponent(props.procKey)}/edge-condition`

async function load() {
  err.value = ''; note.value = ''
  try {
    d.value = await api(`${url()}?event=${encodeURIComponent(props.event)}&task=${encodeURIComponent(props.task)}`)
    reset()
  } catch (e) { d.value = null; err.value = e.message }
}
const decidedCls = (c) => (c?.decided ? c.class : 'none')
function reset() {
  req.value = d.value?.requirement || 'auto'
  rules.value = (d.value?.rules || []).map((r) => ({ when: { ...r.when }, then: r.then }))
  cls.value = decidedCls(d.value?.class)
  reason.value = d.value?.reason || ''
  also.value = []
}
watch(() => [props.procKey, props.event, props.task], load, { immediate: true })

const sugg = computed(() => (d.value?.class?.ai && !d.value.class.decided ? d.value.class.ai : null))
const dirty = computed(() => !!d.value && (req.value !== (d.value.requirement || 'auto') || cls.value !== decidedCls(d.value.class)
  || JSON.stringify(rules.value) !== JSON.stringify((d.value.rules || []).map((r) => ({ when: r.when, then: r.then }))) || reason.value.trim() !== (d.value.reason || '') || also.value.length > 0))
const sibText = (s) => [s.setting?.requirement ? REQ_KO[s.setting.requirement] : s.setting?.rules?.length ? '사안에 따라' : '', s.cls ? CLASS_KO[s.cls] : ''].filter(Boolean).join(' · ') || '정하지 않음'

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
    const n = also.value.length
    d.value = await api(url(), { method: 'PUT', body: { event: props.event, task: props.task, requirement: req.value === 'auto' ? null : req.value, rules: rules.value,
      class: cls.value === 'none' ? null : cls.value, reason: reason.value.trim(), also: also.value } })
    reset()
    note.value = n ? `저장했어요. 같은 단계로 들어오는 간선 ${n}개에도 넣었어요.` : '저장했어요.'
    emit('changed', { proc: props.procKey, event: props.event, task: props.task })
  } catch (e) { err.value = e.message } finally { busy.value = false }
}
</script>

<template>
  <section class="sr" data-testid="onto-edgerule" :data-requirement="d?.requirement || 'auto'" :data-class="decidedCls(d?.class)">
    <div class="hd">
      <h4>이 간선으로 들어오면</h4>
      <small v-if="d" class="ctx">「{{ d.proc.name }}」에서만 · 「{{ d.step }}」은(는)</small>
    </div>
    <p v-if="!d && !err" class="muted pulse">불러오는 중…</p>
    <template v-if="d">
      <p v-if="d.virtual" class="muted" data-testid="onto-edgerule-virtual">지도에 아직 없는 「완료」 간선이에요. 지도를 다시 세면 생기고, 정한 것은 그대로 이어져요.</p>
      <div class="opts" role="radiogroup" aria-label="이 간선으로 들어오면">
        <button v-for="c in CHOICES" :key="c.key" class="opt press" role="radio" :aria-checked="req === c.key" :class="[c.key, { on: req === c.key }]" :disabled="!admin || busy"
          :data-testid="`onto-edgerule-opt-${c.key}`" @click="req = c.key">
          <b><i v-if="c.key === 'required'" class="lock" aria-hidden="true" />{{ c.ko }}</b><small>{{ c.tip }}</small>
        </button>
      </div>

      <div class="rules">
        <div class="rh"><b>사안에 따라</b><small>위에서부터 맞는 첫 규칙을 따라요. 맞는 게 없으면 위에서 고른 대로예요.</small></div>
        <ol v-if="rules.length" class="rl">
          <li v-for="(r, i) in rules" :key="i" data-testid="onto-edgerule-rule" :data-then="r.then">
            <span class="n">{{ i + 1 }}</span><span class="t">{{ ruleLine(r) }}</span>
            <template v-if="admin">
              <button class="ic press" :disabled="busy || i === 0" aria-label="위로" @click="moveRule(i, -1)">↑</button>
              <button class="ic press" :disabled="busy || i === rules.length - 1" aria-label="아래로" @click="moveRule(i, 1)">↓</button>
              <button class="ic press" :disabled="busy" aria-label="빼기" data-testid="onto-edgerule-rule-del" @click="dropRule(i)">✕</button>
            </template>
          </li>
        </ol>
        <small v-else-if="!admin" class="muted">사안에 따른 규칙이 없어요.</small>
        <div v-if="admin" class="add">
          <select v-model="addKind" class="sel" aria-label="규칙 종류" data-testid="onto-edgerule-add-kind">
            <option value="amount">금액이</option><option value="text">글로 쓴 조건</option>
          </select>
          <template v-if="addKind === 'amount'">
            <input v-model="addValue" class="in num" inputmode="numeric" placeholder="1000만" aria-label="금액" data-testid="onto-edgerule-add-value" @keydown.enter.prevent="addRule" />
            <select v-model="addOp" class="sel sm" aria-label="비교" data-testid="onto-edgerule-add-op">
              <option v-for="o in OPS" :key="o.key" :value="o.key">{{ o.ko }}</option>
            </select>
            <span class="w">이면</span>
          </template>
          <input v-else v-model="addText" class="in" maxlength="200" placeholder="예: 외부 고객에게 처음 나가는 제안이면" aria-label="조건" data-testid="onto-edgerule-add-text" @keydown.enter.prevent="addRule" />
          <select v-model="addThen" class="sel sm" aria-label="그러면" data-testid="onto-edgerule-add-then">
            <option value="required">꼭</option><option value="optional">선택</option>
          </select>
          <button class="ghost2 press" :disabled="busy" data-testid="onto-edgerule-add" @click="addRule">더하기</button>
        </div>
        <small v-if="admin && addKind === 'amount' && addValueWon" class="muted">{{ addValueWon }}</small>
        <small v-if="addErr" class="err">{{ addErr }}</small>
      </div>

      <div class="rules">
        <div class="rh"><b>단계 분류</b></div>
        <div class="chips" role="radiogroup" aria-label="단계 분류">
          <button v-for="c in CLASSES" :key="c.key" class="chip press" role="radio" :aria-checked="cls === c.key" :class="{ on: cls === c.key }" :disabled="!admin || busy" :title="c.tip"
            :data-testid="`onto-edgerule-cls-${c.key}`" @click="cls = c.key">{{ c.ko }}</button>
        </div>
        <!-- 다듬기의 AI 분류 제안: 관문이면 꼭 하는 단계로, 그 밖이면 그 분류로 -->
        <p v-if="sugg" class="ai" data-testid="onto-edgerule-ai" :data-suggest="sugg.class"><span class="cap">AI 제안</span> {{ sugg.class === 'gate' ? `${REQ_KO.required}(관문)` : CLASS_KO[sugg.class] }}<template v-if="sugg.why"> — {{ sugg.why }}</template>
          <button v-if="admin && sugg.class === 'gate' && req !== 'required'" class="lnk press" :disabled="busy" @click="req = 'required'">이걸로</button>
          <button v-else-if="admin && sugg.class !== 'gate' && cls !== sugg.class" class="lnk press" :disabled="busy" @click="cls = sugg.class">이걸로</button></p>
      </div>

      <ul class="lines" data-testid="onto-edgerule-lines"><li v-for="(l, i) in d.lines" :key="i">{{ l }}</li></ul>

      <div v-if="d.siblings.length" class="rules" data-testid="onto-edgerule-siblings">
        <div class="rh"><b>같은 단계로 들어오는 다른 간선</b><small v-if="admin">고르면 저장할 때 같은 설정을 함께 넣어요.</small></div>
        <label v-for="s in d.siblings" :key="s.event" class="sib">
          <input v-if="admin" v-model="also" type="checkbox" :value="s.event" :disabled="busy" data-testid="onto-edgerule-also" />
          <span class="t">{{ s.name }}</span><small>{{ sibText(s) }}</small>
        </label>
      </div>

      <template v-if="admin">
        <input v-model="reason" class="in wide" maxlength="300" placeholder="정한 까닭(선택) — 결정 기록에 남아요" aria-label="정한 까닭" data-testid="onto-edgerule-reason" />
        <div class="btns">
          <button v-if="dirty" class="ghost press" :disabled="busy" @click="reset">되돌리기</button>
          <button class="go press" :disabled="busy || !dirty" data-testid="onto-edgerule-save" @click="save">{{ busy ? '저장하는 중…' : '저장' }}</button>
        </div>
      </template>
      <small v-else class="muted">바꾸기는 관리자가 해요.</small>
      <small v-if="note" class="ok" data-testid="onto-edgerule-note">{{ note }}</small>
    </template>
    <small v-if="err" class="err">{{ err }}</small>
  </section>
</template>

<style scoped>
.sr { padding: 12px; border-radius: 16px; background: var(--cell-bg); min-width: 0; display: flex; flex-direction: column; gap: 10px; word-break: keep-all; overflow-wrap: anywhere;
  --step-req: #7a4fd0; --step-opt: #2b7fbf; --lock-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 14'%3E%3Cpath d='M3 6V4a3 3 0 0 1 6 0v2h1.5v8h-9V6zm1.5 0h3V4a1.5 1.5 0 0 0-3 0z'/%3E%3C/svg%3E"); }
.hd { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
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
.ai { margin: 0; font-size: 13px; line-height: 1.5; }
.cap { font-size: 12px; color: var(--text-tertiary); margin-right: 2px; }
.lnk { margin-left: 6px; font-size: 12.5px; color: var(--color-info); }
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
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { height: 30px; padding: 0 12px; border-radius: 9999px; font-size: 13px; background: var(--field-bg); box-shadow: inset 0 0 0 1px transparent; }
.chip.on { box-shadow: inset 0 0 0 2px var(--ink); font-weight: 600; }
.chip:disabled { cursor: default; }
.chip:disabled:not(.on) { opacity: .6; }
.lines { margin: 0; padding-left: 18px; font-size: 12.5px; color: var(--text-secondary); line-height: 1.5; display: flex; flex-direction: column; gap: 2px; }
.sib { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 10px; background: var(--field-bg); font-size: 13px; }
.sib .t { flex: 1; min-width: 0; }
.sib small { font-size: 12px; color: var(--text-secondary); }
.btns { display: flex; justify-content: flex-end; gap: 6px; }
.ghost { height: 34px; padding: 0 14px; border-radius: 9999px; font-size: 13.5px; color: var(--text-secondary); }
.ghost2 { height: 32px; padding: 0 14px; border-radius: 9999px; font-size: 13px; font-weight: 500; background: var(--field-bg); box-shadow: inset 0 0 0 1px var(--hairline); }
.go { height: 34px; padding: 0 16px; border-radius: 9999px; font-size: 13.5px; font-weight: 600; background: var(--ink); color: var(--ink-inverse); }
.go:disabled, .ghost:disabled, .ghost2:disabled { opacity: .45; cursor: default; }
</style>
