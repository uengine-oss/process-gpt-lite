<script setup>
// 고쳐 보기 · 개선안 · 시행 전후(server flowplan.js · improveplans.js, 설계 docs/auto-ax-onboarding/design-improve-on-map.md §5):
//   - 고쳐 보기: 지도의 수단(에이전트가 맡음 · AI 초안 먼저 · 건너뛰기 · 빼기 · 나란히 · 다른 역할 · 사람 더하기 · 들어오는 건)을 얹으면
//     지금 지도의 숫자로 앞 · 뒤를 다시 셈한다(저장 없음) — 지금 들어오면 · 자리 잡은 뒤 보통 건 · 병목 · 역할의 짐 · 한 달 사람 시간
//   - 개선안: 그 앞 · 뒤를 그대로 보관하고 나란히 견준다 → 합의에 올림(의견) → 같은 의견 · 다른 의견 → 관리자가 정함(효력일)
//   - 시행 전후: 정한 안은 효력일 뒤의 실행 기록으로 다시 재서 예상과 견준다
// emits preview(고쳐 본 결과 | null — 지도에 「할 일 8 → 1」로 그린다) · changed(정한 뒤 — 병목 보기를 다시 센다)
import { ref, computed, watch } from 'vue'
import { api } from '../../api.js'

const props = defineProps({ procKey: { type: String, required: true }, flow: { type: Object, default: null }, admin: Boolean })
const emit = defineEmits(['preview', 'changed'])

const WORK_H = 9
const fmtH = (h) => (h == null || !Number.isFinite(h) ? '—' : h < 1 ? `${Math.max(1, Math.round(h * 60))}분` : h < WORK_H ? `${Math.round(h * 10) / 10}시간` : `${Math.round((h / WORK_H) * 10) / 10}일`)
const n1 = (v) => (v == null ? '—' : Math.round(v * 10) / 10)
const pct = (v) => `${Math.round((v || 0) * 100)}%`
const KIND = [
  { v: 'draft', t: 'AI 초안 먼저', of: 'task' }, { v: 'agent', t: '에이전트가 맡음', of: 'task' }, { v: 'skip', t: '건너뛰기', of: 'task' },
  { v: 'remove', t: '흐름에서 빼기', of: 'task' }, { v: 'parallel', t: '나란히', of: 'pair' }, { v: 'role', t: '다른 역할이 맡음', of: 'task' },
  { v: 'capacity', t: '사람 더하기', of: 'role' }, { v: 'demand', t: '들어오는 건(가정)', of: 'pct' },
]
const kindName = (v) => KIND.find((k) => k.v === v)?.t || v
const VERDICT = { better: '예상보다 좋아요', met: '예상만큼', partly: '예상의 일부만', none: '그대로예요', worse: '나빠졌어요' }

const levers = ref([])
const w = ref(null)
const busy = ref('')
const err = ref('')
const name = ref('')
const plans = ref([])
const reviews = ref({})
const compare = ref(false)
const deciding = ref(null) // {id, note, kind: 'decide' | 'decline'}
const people = ref({}) // role → [{id, name, roles, open}]

const tasks = computed(() => (props.flow?.tasks || []).filter((t) => !t.outside))
const roles = computed(() => (props.flow?.constraint?.roles || []).map((r) => r.role))
const b = computed(() => props.flow?.bottleneck || null)
const bTask = computed(() => tasks.value.find((t) => t.key === b.value?.key) || null)
const bRole = computed(() => b.value?.role || props.flow?.constraint?.key || '')
const keyOf = (l) => JSON.stringify([l.type, l.task || '', l.role || '', l.a || '', l.b || '', l.to || ''])
const has = (l) => levers.value.some((x) => keyOf(x) === keyOf(l))
// the levers the bottleneck suggests (설계 §5.2 — the map's own means), in the five focusing steps' order
const chips = computed(() => {
  if (!b.value) return []
  const k = b.value.key, out = []
  out.push({ type: 'draft', task: k, save: 0.5, text: `「${k}」 AI 초안 먼저` })
  if (bTask.value?.cand?.fit === 'high' || bTask.value?.cls === 'ai') out.push({ type: 'agent', task: k, text: `「${k}」 에이전트가 맡음` })
  if (bRole.value) out.push({ type: 'capacity', role: bRole.value, n: 1, people: [], text: `「${bRole.value}」 사람 더하기` })
  out.push({ type: 'skip', task: k, share: 0.3, text: `「${k}」 작은 건 건너뛰기` })
  return out.filter((x) => !has(x))
})
const add = (l) => { const { text, ...x } = l; if (!has(x)) levers.value = [...levers.value, x]; if (x.type === 'capacity') loadPeople(x.role) }
const drop = (i) => { levers.value = levers.value.filter((_, j) => j !== i) }

// 직접 고르기
const pick = ref({ type: 'draft', task: '', role: '', a: '', b: '', to: '', pct: 20 })
const pickOf = computed(() => KIND.find((k) => k.v === pick.value.type)?.of || 'task')
function addPicked() {
  const p = pick.value
  const l = p.type === 'capacity' ? { type: 'capacity', role: p.role || bRole.value, n: 1, people: [] }
    : p.type === 'parallel' ? { type: 'parallel', a: p.a, b: p.b }
      : p.type === 'demand' ? { type: 'demand', pct: Number(p.pct) || 0 }
        : p.type === 'role' ? { type: 'role', task: p.task, to: p.to }
          : p.type === 'draft' ? { type: 'draft', task: p.task, save: 0.5 } : p.type === 'skip' ? { type: 'skip', task: p.task, share: 0.3 } : { type: p.type, task: p.task }
  if ((pickOf.value === 'task' && !l.task) || (l.type === 'parallel' && (!l.a || !l.b)) || (l.type === 'role' && !l.to)) { err.value = '무엇을 바꿀지 골라 주세요.'; return }
  err.value = ''
  add(l)
}

async function loadPeople(role) {
  if (!role || people.value[role]) return
  try { const r = await api(`/ontology/flow/people?role=${encodeURIComponent(role)}`); people.value = { ...people.value, [role]: r.people || [] } } catch { /* the picker stays empty */ }
}
function setPerson(l, id) {
  const p = (people.value[l.role] || []).find((x) => x.id === id)
  l.people = p ? [{ id: p.id, name: p.name }] : []
  levers.value = [...levers.value]
}

let seq = 0
async function run() {
  const my = ++seq
  if (!levers.value.length) { w.value = null; emit('preview', null); return }
  busy.value = 'whatif'; err.value = ''
  try {
    const r = await api('/ontology/flow/whatif', { method: 'POST', body: { proc: props.procKey, levers: levers.value } })
    if (my !== seq) return
    w.value = r
    emit('preview', r)
  } catch (e) { if (my === seq) err.value = e.message } finally { if (my === seq) busy.value = '' }
}
watch(levers, run, { deep: true })
watch(() => props.procKey, () => { levers.value = []; w.value = null; emit('preview', null); loadPlans() })

async function loadPlans() {
  try {
    const r = await api(`/ontology/plans?proc=${encodeURIComponent(props.procKey)}`)
    plans.value = r.plans || []
    for (const p of plans.value.filter((x) => x.status === 'decided')) loadReview(p.id)
  } catch (e) { err.value = e.message }
}
async function loadReview(id) {
  try { reviews.value = { ...reviews.value, [id]: await api(`/ontology/plans/${id}/review`) } } catch (e) { reviews.value = { ...reviews.value, [id]: { error: e.message } } }
}
loadPlans()
defineExpose({ loadPlans })

async function save() {
  busy.value = 'save'; err.value = ''
  try {
    await api('/ontology/plans', { method: 'POST', body: { proc: props.procKey, name: name.value.trim(), levers: levers.value } })
    name.value = ''; levers.value = []
    await loadPlans()
  } catch (e) { err.value = e.message } finally { busy.value = '' }
}
async function act(p, what, body) {
  busy.value = `${what}:${p.id}`; err.value = ''
  try {
    if (what === 'remove') await api(`/ontology/plans/${p.id}`, { method: 'DELETE' })
    else await api(`/ontology/plans/${p.id}/${what}`, { method: 'POST', body: body || {} })
    if (what === 'decide' || what === 'decline') { deciding.value = null; emit('changed') }
    await loadPlans()
  } catch (e) { err.value = e.message } finally { busy.value = '' }
}
const open = (p, kind) => { deciding.value = { id: p.id, kind, note: '' } }
// 다시 얹어 보기: a kept plan's levers back into 고쳐 보기
const again = (p) => { levers.value = (p.levers || []).map(({ label, ...l }) => l); for (const l of levers.value) if (l.type === 'capacity') loadPeople(l.role) }

// the rows a result (or a kept plan) shows: before → after
function rowsOf(before, after) {
  if (!before || !after) return []
  const role = before.constraint?.role
  const rb = before.roles?.find((r) => r.role === role), ra = after.roles?.find((r) => r.role === role)
  const bk = before.bottleneck?.key
  const ahead = (side) => side.steps?.find((s) => s.key === bk)?.ahead ?? (side.bottleneck?.key === bk ? side.bottleneck.wip : 0)
  return [
    { key: 'now', label: '지금 들어오면', a: fmtH(before.nowH), b: fmtH(after.nowH), good: after.nowH < before.nowH },
    { key: 'path', label: '자리 잡은 뒤 보통 건', a: fmtH(before.pastH), b: fmtH(after.pastH), good: after.pastH < before.pastH },
    ...(bk ? [{ key: 'bott', label: `「${bk}」 할 일`, a: `${n1(before.bottleneck.wip)}건`, b: `${n1(ahead(after))}건`, good: ahead(after) < before.bottleneck.wip }] : []),
    ...(rb && ra ? [{ key: 'role', label: `「${role}」 한 사람당`, a: `${n1(rb.perPerson)}건 · ${pct(rb.rho)}`, b: `${n1(ra.perPerson)}건 · ${pct(ra.rho)}`, good: ra.perPerson < rb.perPerson, sub: `${rb.members}명 → ${ra.members}명` }] : []),
    { key: 'hours', label: '한 달 사람 시간', a: `${before.monthly.hours}시간`, b: `${after.monthly.hours}시간`, good: after.monthly.hours < before.monthly.hours },
  ]
}
const rows = computed(() => (w.value ? rowsOf(w.value.before, w.value.after) : []))
const live = computed(() => plans.value.filter((p) => ['draft', 'voted'].includes(p.status)))
const decided = computed(() => plans.value.filter((p) => p.status === 'decided'))
const closed = computed(() => plans.value.filter((p) => p.status === 'declined'))
// 나란히 보기: today and every live plan, metric by metric
const table = computed(() => {
  const list = live.value.filter((p) => p.baseline && p.predicted)
  if (list.length < 2) return null
  const base = list[0].baseline
  const metric = (side, k) => rowsOf(base, side).find((r) => r.key === k)?.b ?? '—'
  return { cols: list.map((p) => ({ id: p.id, name: p.name })), rows: rowsOf(base, base).map((r) => ({ key: r.key, label: r.label, now: r.a, plans: list.map((p) => metric(p.predicted, r.key)) })) }
})
const when = (s) => (s ? new Date(s).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '')
</script>

<template>
  <section class="box plan" data-testid="onto-plan">
    <h4>고쳐 보기<small>지금 지도의 숫자로 앞 · 뒤를 셈해요 — 저장하기 전에는 아무것도 바뀌지 않아요</small></h4>
    <div v-if="chips.length" class="chips">
      <button v-for="c in chips" :key="keyOf(c)" class="chip press" data-testid="onto-plan-chip" :data-kind="c.type" :data-task="c.task || ''" :data-role="c.role || ''" @click="add(c)">＋ {{ c.text }}</button>
    </div>
    <details class="pickbox">
      <summary data-testid="onto-plan-pick">직접 고르기</summary>
      <div class="pick">
        <select v-model="pick.type" data-testid="onto-plan-pick-kind"><option v-for="k in KIND" :key="k.v" :value="k.v">{{ k.t }}</option></select>
        <select v-if="pickOf === 'task'" v-model="pick.task" data-testid="onto-plan-pick-task"><option value="">일 고르기</option><option v-for="t in tasks" :key="t.key" :value="t.key">{{ t.key }}</option></select>
        <select v-if="pick.type === 'role'" v-model="pick.to"><option value="">맡을 역할</option><option v-for="r in roles" :key="r" :value="r">{{ r }}</option></select>
        <template v-if="pickOf === 'pair'">
          <select v-model="pick.a"><option value="">일 하나</option><option v-for="t in tasks" :key="t.key" :value="t.key">{{ t.key }}</option></select>
          <select v-model="pick.b"><option value="">다른 일</option><option v-for="t in tasks" :key="t.key" :value="t.key">{{ t.key }}</option></select>
        </template>
        <select v-if="pickOf === 'role'" v-model="pick.role"><option value="">역할 고르기</option><option v-for="r in roles" :key="r" :value="r">{{ r }}</option></select>
        <label v-if="pickOf === 'pct'" class="pctin"><input v-model.number="pick.pct" type="number" step="5" min="-90" max="300" />%</label>
        <button class="pill press" data-testid="onto-plan-pick-add" @click="addPicked">더하기</button>
      </div>
    </details>

    <ul v-if="levers.length" class="levers">
      <li v-for="(l, i) in levers" :key="keyOf(l)" data-testid="onto-plan-lever" :data-kind="l.type">
        <b>{{ kindName(l.type) }}</b>
        <span>{{ l.task || l.role || (l.a ? `${l.a} · ${l.b}` : '') }}<template v-if="l.to"> → {{ l.to }}</template></span>
        <label v-if="l.type === 'draft'" class="knob">사람 일 <select v-model.number="l.save"><option :value="0.3">30%</option><option :value="0.5">50%</option><option :value="0.7">70%</option></select> 덜기<small>가정</small></label>
        <label v-else-if="l.type === 'skip'" class="knob">건 <select v-model.number="l.share"><option :value="0.1">10%</option><option :value="0.3">30%</option><option :value="0.5">50%</option></select> 건너뜀<small>가정</small></label>
        <label v-else-if="l.type === 'capacity'" class="knob">
          <select :value="l.people?.[0]?.id || ''" data-testid="onto-plan-people" @change="setPerson(l, $event.target.value)">
            <option value="">사람은 나중에 정함</option>
            <option v-for="p in people[l.role] || []" :key="p.id" :value="p.id">{{ p.name }}{{ p.roles.length ? ` · ${p.roles.join(', ')}` : '' }} · 할 일 {{ p.open }}</option>
          </select>
        </label>
        <label v-else-if="l.type === 'demand'" class="knob"><input v-model.number="l.pct" type="number" step="5" />%</label>
        <button class="x press" title="빼기" @click="drop(i)">×</button>
      </li>
    </ul>

    <p v-if="busy === 'whatif' && !w" class="sm pulse">셈하는 중…</p>
    <div v-if="w && levers.length" class="result" :class="{ dim: busy === 'whatif' }" data-testid="onto-plan-result">
      <table>
        <thead><tr><th /><th>지금</th><th>고친 뒤(예상)</th></tr></thead>
        <tbody>
          <tr v-for="r in rows" :key="r.key" :data-key="r.key" :data-testid="`onto-plan-row-${r.key}`">
            <th>{{ r.label }}<small v-if="r.sub">{{ r.sub }}</small></th><td>{{ r.a }}</td><td :class="{ good: r.good }">{{ r.b }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="w.moved" class="moved" data-testid="onto-plan-moved">병목이 「{{ w.moved.from }}」에서 「{{ w.moved.to }}」로 옮겨 가요 — 그다음은 그 일을 봐요.</p>
      <p v-for="s in w.skipped" :key="s.label" class="sm warn">{{ s.label }} — {{ s.why }}</p>
      <ul class="notes"><li v-for="n in w.notes" :key="n">{{ n }}</li></ul>
      <div class="save">
        <input v-model="name" maxlength="60" placeholder="안 이름(예: 초안 먼저 + 한 사람 더)" data-testid="onto-plan-name" />
        <button class="go press" :disabled="!!busy" data-testid="onto-plan-save" @click="save">{{ busy === 'save' ? '저장하는 중…' : '개선안으로 저장' }}</button>
      </div>
    </div>

    <!-- 개선안 -->
    <template v-if="plans.length">
      <h4 class="sub">개선안<small>{{ live.length }}개 견주는 중<template v-if="decided.length"> · 정한 것 {{ decided.length }}개</template></small>
        <button v-if="live.length >= 2" class="lnk press" data-testid="onto-plan-compare" @click="compare = !compare">{{ compare ? '접기' : '나란히 보기' }}</button>
      </h4>
      <table v-if="compare && table" class="cmp" data-testid="onto-plan-compare-table">
        <thead><tr><th /><th>지금</th><th v-for="c in table.cols" :key="c.id">{{ c.name }}</th></tr></thead>
        <tbody><tr v-for="r in table.rows" :key="r.key"><th>{{ r.label }}</th><td>{{ r.now }}</td><td v-for="(v, i) in r.plans" :key="i">{{ v }}</td></tr></tbody>
      </table>
      <article v-for="p in live" :key="p.id" class="card" data-testid="onto-plan-card" :data-id="p.id" :data-status="p.status">
        <header><b>{{ p.name }}</b><em :class="p.status">{{ p.statusName }}</em></header>
        <small class="by">{{ p.by.name }} · {{ when(p.at) }} · {{ p.mapAt?.slice(0, 10) }} 지도</small>
        <ul class="ll"><li v-for="l in p.levers" :key="l.label">{{ l.label }}</li></ul>
        <p class="num">지금 들어오면 {{ fmtH(p.baseline?.nowH) }} → <b>{{ fmtH(p.predicted?.nowH) }}</b> · 보통 건 {{ fmtH(p.baseline?.pastH) }} → <b>{{ fmtH(p.predicted?.pastH) }}</b></p>
        <p v-if="p.opinion" class="sm" data-testid="onto-plan-agree-count">같은 의견 {{ p.opinion.agree }}명<template v-if="p.opinion.who.length"> · {{ p.opinion.who.join(', ') }}</template> — 다른 의견은 지도의 「의견」에서 함께 봐요.</p>
        <div class="acts">
          <button v-if="p.can.vote" class="pill press" :disabled="!!busy" data-testid="onto-plan-vote" @click="act(p, 'vote')">합의에 올리기</button>
          <button v-if="p.can.agree" class="pill press" :disabled="!!busy" data-testid="onto-plan-agree" @click="act(p, 'agree')">같은 의견</button>
          <button class="ghost press" :disabled="!!busy" @click="again(p)">다시 얹어 보기</button>
          <span class="sp" />
          <button v-if="p.can.decide" class="go press" :disabled="!!busy" data-testid="onto-plan-decide" @click="open(p, 'decide')">정하기</button>
          <button v-if="p.can.decline" class="ghost press" :disabled="!!busy" data-testid="onto-plan-decline" @click="open(p, 'decline')">하지 않기</button>
          <button v-if="p.can.remove" class="ghost press" :disabled="!!busy" @click="act(p, 'remove')">지우기</button>
        </div>
        <div v-if="deciding?.id === p.id" class="decide">
          <p class="sm">{{ deciding.kind === 'decide' ? '정하면 지도의 고침이 고친 기록에 들어가고(새 건부터), 사람 더하기는 역할에 들어가요. 오늘이 효력일이에요.' : '하지 않는 까닭을 한 줄 적어 주세요.' }}</p>
          <input v-model="deciding.note" maxlength="300" :placeholder="deciding.kind === 'decide' ? '한 줄 메모(선택)' : '까닭'" data-testid="onto-plan-decide-note" />
          <div class="acts">
            <button class="go press" :disabled="!!busy || (deciding.kind === 'decline' && !deciding.note.trim())" data-testid="onto-plan-decide-go" @click="act(p, deciding.kind, { note: deciding.note })">{{ deciding.kind === 'decide' ? '이 안으로 정하기' : '하지 않기로 정하기' }}</button>
            <button class="ghost press" @click="deciding = null">그만두기</button>
          </div>
        </div>
      </article>

      <!-- 시행 전후 -->
      <article v-for="p in decided" :key="p.id" class="card done" data-testid="onto-plan-card" :data-id="p.id" data-status="decided">
        <header><b>{{ p.name }}</b><em class="decided">정함 · {{ p.effectiveAt?.slice(0, 10) }}부터</em></header>
        <ul class="ll"><li v-for="l in p.levers" :key="l.label">{{ l.label }}</li></ul>
        <p v-if="p.membersAdded?.length" class="sm">역할에 넣은 사람: {{ p.membersAdded.map((m) => `${m.name}(${m.role})`).join(', ') }}</p>
        <div v-if="reviews[p.id]?.rows" class="review" data-testid="onto-plan-review">
          <h5>시행 전후<small>효력일 뒤 근무일 {{ reviews[p.id].since.workDays }}일 · 할 일 {{ reviews[p.id].since.items }}개(건 {{ reviews[p.id].since.cases }}개)</small></h5>
          <table>
            <thead><tr><th /><th>전</th><th>예상</th><th>실측</th></tr></thead>
            <tbody>
              <tr v-for="r in reviews[p.id].rows" :key="r.key" data-testid="onto-plan-review-row" :data-key="r.key" :data-verdict="r.verdict || ''">
                <th>{{ r.label }}<small v-if="r.verdict">{{ VERDICT[r.verdict] }}</small></th>
                <td>{{ r.unit === 'h' ? fmtH(r.before) : `${n1(r.before)}건` }}</td><td>{{ r.unit === 'h' ? fmtH(r.predicted) : `${n1(r.predicted)}건` }}</td>
                <td :class="r.verdict">{{ r.actual == null ? '—' : r.unit === 'h' ? fmtH(r.actual) : `${n1(r.actual)}건` }}</td>
              </tr>
            </tbody>
          </table>
          <p v-if="reviews[p.id].moved" class="moved" data-testid="onto-plan-review-moved">병목이 「{{ reviews[p.id].moved.from }}」에서 「{{ reviews[p.id].moved.to }}」로 옮겨 갔어요. 다음 개선은 그 일부터예요.</p>
          <p v-if="!reviews[p.id].since.items" class="sm">효력일 뒤에 돈 건이 아직 없어요 — 건이 돌면 실측이 채워져요.</p>
        </div>
        <p v-else-if="reviews[p.id]?.error" class="sm warn">{{ reviews[p.id].error }}</p>
      </article>
      <details v-if="closed.length" class="old"><summary>하지 않기로 한 안 {{ closed.length }}개</summary>
        <p v-for="p in closed" :key="p.id" class="sm">{{ p.name }} — {{ p.decidedNote }}</p>
      </details>
    </template>
    <p v-if="err" class="err">{{ err }}</p>
  </section>
</template>

<style scoped>
.box { padding: 10px 12px; border-radius: 14px; background: var(--field-bg); display: flex; flex-direction: column; gap: 8px; }
.plan { border-left: 3px solid #0a84ff; }
h4 { margin: 0; font-size: 13.5px; font-weight: 700; display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
h4 small, h5 small { font-size: 11.5px; font-weight: 400; color: var(--text-tertiary); }
h4.sub { margin-top: 4px; }
h5 { margin: 0; font-size: 12.5px; font-weight: 700; display: flex; gap: 6px; flex-wrap: wrap; align-items: baseline; }
.chips { display: flex; flex-wrap: wrap; gap: 5px; }
.chip { height: 28px; padding: 0 11px; border-radius: 9999px; font-size: 12.5px; background: color-mix(in srgb, #0a84ff 12%, var(--cell-bg)); color: var(--text-primary); }
.pickbox summary { font-size: 12.5px; color: var(--color-info); cursor: pointer; }
.pick { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; align-items: center; }
select, input { height: 30px; padding: 0 8px; border-radius: 9px; border: 0; background: var(--cell-bg); font-size: 12.5px; color: var(--text-primary); min-width: 0; }
.pctin { display: inline-flex; align-items: center; gap: 3px; font-size: 12.5px; }
.pctin input { width: 64px; }
.levers { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.levers li { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 5px 8px; border-radius: 10px; background: var(--cell-bg); font-size: 12.5px; }
.levers b { font-size: 12px; color: #0a63c9; }
.knob { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--text-secondary); }
.knob select { height: 26px; }
.knob small { font-size: 10.5px; color: #b5651d; }
.x { margin-left: auto; width: 24px; height: 24px; border-radius: 9999px; color: var(--text-tertiary); font-size: 15px; }
.result { display: flex; flex-direction: column; gap: 6px; transition: opacity .2s; }
.result.dim { opacity: .55; }
table { width: 100%; border-collapse: collapse; font-size: 12.5px; font-variant-numeric: tabular-nums; }
th, td { padding: 4px 6px; text-align: right; border-bottom: 1px solid var(--hairline); }
thead th { font-size: 11px; font-weight: 500; color: var(--text-tertiary); }
tbody th { text-align: left; font-weight: 500; }
tbody th small { display: block; font-size: 10.5px; font-weight: 400; color: var(--text-tertiary); }
td.good, td.met, td.better { color: #2b8a3e; font-weight: 700; }
td.partly { color: #b5651d; font-weight: 700; }
td.worse { color: var(--color-error); font-weight: 700; }
.moved { margin: 0; font-size: 12.5px; padding: 6px 9px; border-radius: 10px; background: color-mix(in srgb, #e8590c 12%, transparent); line-height: 1.5; }
.notes { margin: 0; padding-left: 16px; font-size: 11.5px; color: var(--text-tertiary); line-height: 1.5; }
.save { display: flex; gap: 6px; }
.save input { flex: 1; }
.card { padding: 9px 10px; border-radius: 12px; background: var(--cell-bg); display: flex; flex-direction: column; gap: 5px; }
.card header { display: flex; align-items: baseline; gap: 6px; justify-content: space-between; }
.card header b { font-size: 13px; }
.card em { font-style: normal; font-size: 11px; padding: 1px 8px; border-radius: 9999px; background: var(--field-bg); color: var(--text-secondary); white-space: nowrap; }
.card em.voted { background: color-mix(in srgb, #0a84ff 16%, transparent); color: #0a63c9; }
.card em.decided { background: color-mix(in srgb, #2b8a3e 16%, transparent); color: #2b8a3e; }
.by { font-size: 11px; color: var(--text-tertiary); }
.ll { margin: 0; padding-left: 16px; font-size: 12px; line-height: 1.5; }
.num { margin: 0; font-size: 12.5px; font-variant-numeric: tabular-nums; }
.acts { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
.sp { flex: 1; }
.decide { display: flex; flex-direction: column; gap: 6px; padding-top: 6px; border-top: 1px solid var(--hairline); }
.review { display: flex; flex-direction: column; gap: 6px; }
.cmp th, .cmp td { font-size: 12px; }
.go { height: 30px; padding: 0 14px; border-radius: 9999px; font-size: 12.5px; font-weight: 600; background: var(--ink); color: var(--text-primary-on); white-space: nowrap; }
.pill { height: 30px; padding: 0 12px; border-radius: 9999px; font-size: 12.5px; background: var(--field-bg); color: var(--text-primary); white-space: nowrap; }
.ghost { height: 30px; padding: 0 8px; border-radius: 9999px; font-size: 12.5px; color: var(--text-secondary); white-space: nowrap; }
.go:disabled, .pill:disabled, .ghost:disabled { opacity: .45; }
.lnk { font-size: 12px; color: var(--color-info); margin-left: auto; }
.sm { margin: 0; font-size: 12px; line-height: 1.5; color: var(--text-secondary); }
.warn { color: #b5651d; }
.err { margin: 0; font-size: 12.5px; color: var(--color-error); }
.old summary { font-size: 12px; color: var(--text-tertiary); cursor: pointer; }
</style>
