<script setup>
// Settings › 정책·가드레일 (Agentic BPM, pgpt-pro/docs/agentic-bpm/plan.md): the policies an agent's action with
// consequences passes before it runs (server lib/policy) — grouped by category, each with its decision, why,
// its sources and who approves; administrators turn them on or off, everyone else reads them. 시험해 보기 asks
// the policy engine about an action without running or recording it. The decision ledger shows what was
// decided and how it ended: whoever may decide a pending request (mayDecide) approves or rejects it here, and
// an action that ran under "record" can be taken back while its window is open. ?d=<decision id> — the link
// of an approval notification — opens that row.
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '../api.js'
import { isEnglish } from '../i18n/lang.js'
import { useApp } from '../stores/app.js'

const app = useApp()
const route = useRoute()
const loc = isEnglish ? 'en-US' : 'ko-KR'
const pick = (pair) => (Array.isArray(pair) ? pair[isEnglish ? 1 : 0] : pair)
const E = (ko, en) => (isEnglish ? en : ko)   // a value inside the facts JSON (a textarea is not translated)
const at = (t) => (t ? new Date(t).toLocaleString(loc, { month: 'long', day: 'numeric', weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '')
const time = (t) => new Date(t).toLocaleTimeString(loc, { hour: 'numeric', minute: '2-digit' })

const DEC = { allow: '허용', allow_audit: '기록', require_approval: '승인 필요', deny: '차단' }
const DEC_HINT = { allow: '바로 실행해요', allow_audit: '실행하고 감사 기록에 남겨요 · 되돌리기 창', require_approval: '승인자가 승인하면 실행해요', deny: '실행하지 않아요' }
const CATS = [['privacy', '개인정보'], ['security', '보안'], ['authority', '권한·결재'], ['legal', '법무·계약'], ['audit', '기록·감사'], ['quality', '품질·운영'], ['cost', '비용'], ['ethics', '윤리']]
const KINDS = { 'mail.send': '메일 보내기', 'browser.payment': '결제 (브라우저 에이전트)', 'purchase.approve': '구매 승인', 'purchase.order': '발주', 'release.deploy': '배포', 'data.export': '데이터 반출', 'data.delete': '데이터 삭제' }
const kindName = (k) => KINDS[k] || k
const PII_KIND = { resident_id: '주민등록번호', mobile: '휴대전화', email: '메일 주소', bank_account: '계좌번호' }
const FACT = {
  external: '외부 포함', external_count: '외부 수신자', recipient_count: '받는 사람', recipients: '받는 도메인', pii_count: '개인정보',
  pii_kinds: '개인정보 종류', pii_by_kind: '종류별', classification: '분류', attachments: '첨부',
  amount: '금액', merchant: '판매처', new_merchant: '처음 쓰는 판매처', supplier_new: '신규 공급사', category: '분류',
  approved: '승인됨', speculative: '되돌릴 수 있는 준비', audience: '공개 대상', features: '기능', open_findings: '열린 위험', security_scan: '보안 점검',
  weekday: '요일', hour: '시', rows: '행', pii_rows: '개인정보 행', destination_external: '외부로', count: '건수',
}
const FACT_ORDER = Object.keys(FACT)
const VALUE = { confidential: '기밀', general: '일반', public: '일반 공개', internal: '내부', beta: '베타', passed: '통과', failed: '실패' }
function fmt(k, v) {
  if (typeof v === 'boolean') return v ? '예' : '아니오'
  if (typeof v === 'number') return k === 'amount' ? `${v.toLocaleString(loc)}원` : v.toLocaleString(loc)
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : PII_KIND[x] || VALUE[x] || x)).join(', ') || '—'
  if (v && typeof v === 'object') return JSON.stringify(v)
  return VALUE[v] || String(v ?? '—')
}

// ── tabs
const tab = ref(route.query.d ? 'ledger' : 'catalog')

// ── the catalog
const policies = ref([])
const admin = ref(false)
const holders = ref({})     // role key → the teammate holding it company-wide
const team = ref([])
const err = ref('')
const busy = ref('')
const roleKey = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase()
const holderOf = (role) => holders.value[roleKey(role)] || null
const groups = computed(() => {
  const known = new Set(CATS.map(([k]) => k))
  const order = Object.keys(KINDS)
  const first = (p) => { const i = order.indexOf(p.spec.scope?.action?.[0]); return i < 0 ? order.length : i }
  const rank = (p) => ['deny', 'require_approval', 'allow_audit', 'allow'].indexOf(p.spec.decide)
  const sorted = [...policies.value].sort((a, b) => first(a) - first(b) || rank(a) - rank(b))
  const out = CATS.map(([k, label]) => ({ k, label, items: sorted.filter((p) => p.spec.category === k) }))
  out.push({ k: 'other', label: '기타', items: sorted.filter((p) => !known.has(p.spec.category)) })
  return out.filter((g) => g.items.length)
})
const onCount = computed(() => policies.value.filter((p) => p.enabled).length)
const scopeText = (s) => (s.scope?.action || []).map(kindName).join(' · ')
const spanText = (s) => { const m = String(s).match(/^(\d+)(m|h|d)$/); return m ? (m[2] === 'd' && m[1] === '1' ? '하루' : `${m[1]}${{ m: '분', h: '시간', d: '일' }[m[2]]}`) : s }
const windowText = (w) => `구간 규칙: ${spanText(w.span)} ${w.count}건을 넘으면 ${DEC[w.then]}`
const toleranceText = (t) => `허용 오차: ${Number(t.limit).toLocaleString(loc)}의 ${Math.round(Number(t.over) * 100)}%까지는 기록만`

async function loadCatalog() {
  const [p, roles, members] = await Promise.all([api('/policies'), api('/roles').catch(() => []), api('/team').catch(() => [])])
  admin.value = !!p.admin
  policies.value = p.policies
  holders.value = Object.fromEntries(roles.filter((a) => a.proc_def_id === '*').map((a) => [roleKey(a.role), a.name || a.email]))
  team.value = members
}
async function toggle(p) {
  if (!admin.value) return
  err.value = ''; busy.value = p.id
  const was = p.enabled
  p.enabled = !was
  try { await api(`/policies/${p.id}`, { method: 'PUT', body: { enabled: p.enabled } }) } catch (e) { p.enabled = was; err.value = e.message } finally { busy.value = '' }
}

// ── 시험해 보기: the PDP's answer for an action, nothing run or recorded
const PRESETS = {
  'mail.send': [
    ['사내 메일', { external: false, external_count: 0, recipient_count: 1, pii_count: 0, pii_kinds: [], classification: 'general' }],
    ['외부 메일', { external: true, external_count: 1, recipient_count: 1, pii_count: 0, pii_kinds: [], classification: 'general' }],
    ['외부 + 개인정보 6건', { external: true, external_count: 1, recipient_count: 1, pii_count: 6, pii_kinds: ['mobile', 'email'], classification: 'general' }],
    ['개인정보 120건', { external: true, external_count: 1, recipient_count: 1, pii_count: 120, pii_kinds: ['mobile', 'email'], classification: 'general' }],
    ['기밀 첨부 외부 발송', { external: true, external_count: 1, recipient_count: 1, pii_count: 0, pii_kinds: [], classification: 'confidential' }],
  ],
  'browser.payment': [
    ['9만 원', { amount: 90000, merchant: E('사무용품몰', 'Office supplies'), new_merchant: false }],
    ['10만 5천 원 (허용 오차)', { amount: 105000, merchant: E('사무용품몰', 'Office supplies'), new_merchant: false }],
    ['13만 원', { amount: 130000, merchant: E('사무용품몰', 'Office supplies'), new_merchant: false }],
    ['600만 원', { amount: 6000000, merchant: E('장비몰', 'Equipment store'), new_merchant: false }],
    ['처음 쓰는 판매처', { amount: 30000, merchant: E('새 판매처', 'New store'), new_merchant: true }],
  ],
  'purchase.approve': [
    ['500만 원', { amount: 5000000, supplier_new: false, category: 'IT' }],
    ['1,200만 원', { amount: 12000000, supplier_new: false, category: 'IT' }],
    ['신규 공급사', { amount: 3000000, supplier_new: true, category: 'IT' }],
  ],
  'purchase.order': [
    ['승인 전 발주', { amount: 3000000, approved: false, speculative: false }],
    ['승인 전 견적·초안', { amount: 3000000, approved: false, speculative: true }],
    ['승인 후 발주', { amount: 3000000, approved: true, speculative: false }],
  ],
  'release.deploy': [
    ['금요일 오후 공개 + 개인정보 위험', { audience: 'public', features: [{ name: E('공유 링크', 'Share link'), pii: true }, { name: E('다크 모드', 'Dark mode'), pii: false }], open_findings: { privacy: 1, security: 0 }, security_scan: 'passed', weekday: 5, hour: 16 }],
    ['내부 사용자 먼저', { audience: 'internal', features: [{ name: E('공유 링크', 'Share link'), pii: true }], open_findings: { privacy: 1, security: 0 }, security_scan: 'passed', weekday: 5, hour: 16 }],
    ['보안 점검 실패', { audience: 'beta', features: [], open_findings: { privacy: 0, security: 2 }, security_scan: 'failed', weekday: 3, hour: 10 }],
  ],
  'data.export': [
    ['개인정보 10행 외부로', { rows: 200, pii_rows: 10, destination_external: true }],
    ['개인정보 3,000행 외부로', { rows: 5000, pii_rows: 3000, destination_external: true }],
  ],
  'data.delete': [['30건 삭제', { count: 30 }], ['500건 삭제', { count: 500 }]],
}
const kinds = computed(() => [...new Set([...Object.keys(KINDS), ...policies.value.flatMap((p) => p.spec.scope?.action || [])])].filter((k) => !k.includes('*')))
const kind = ref('mail.send')
const factsText = ref('')
const result = ref(null)
const tryErr = ref('')
const verdictEl = ref(null)
const presets = computed(() => PRESETS[kind.value] || [])
const preset = ref(0)
function usePreset(i) { preset.value = i; factsText.value = JSON.stringify(presets.value[i]?.[1] || {}, null, 2); result.value = null; tryErr.value = '' }
watch(kind, () => usePreset(0), { immediate: true })
async function tryIt() {
  tryErr.value = ''; result.value = null
  let facts
  try { facts = JSON.parse(factsText.value || '{}') } catch (e) { tryErr.value = `JSON 을 읽지 못했어요: ${e.message}`; return }
  try { result.value = await api('/policies/evaluate', { method: 'POST', body: { kind: kind.value, facts } }) } catch (e) { tryErr.value = e.message; return }
  await nextTick()
  verdictEl.value?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
}
const verdict = computed(() => {
  const r = result.value
  if (!r) return ''
  if (r.decision === 'require_approval') return `${r.approver || '관리자'}${holderOf(r.approver) ? ` (${holderOf(r.approver)})` : ''} 승인 후 실행돼요`
  return { allow: '바로 실행돼요', allow_audit: '실행되고 감사 기록에 남아요 · 되돌릴 수 있어요', deny: '실행되지 않아요' }[r.decision]
})
const noteText = (n) => (n.kind === 'tolerance' ? `허용 오차 안 (${Math.round(n.limit * (1 + n.over)).toLocaleString(loc)}까지)`
  : n.kind === 'window' ? `구간 안 ${n.count}번째 (${n.limit}건까지)` : '')

// ── the ledger
const decisions = ref([])
const filter = ref('')
const dry = ref(false)
const FILTERS = [['', '전체'], ['pending', '승인 대기'], ['executed', '실행됨'], ['decided', '차단'], ['rejected', '반려됨'], ['undone', '되돌림']]
const open = ref(route.query.d || '')
const highlight = ref(route.query.d || '')
const missing = ref(false)
const note = ref('')
const ledgerErr = ref('')
const now = ref(Date.now())
const pendingCount = ref(0)
let timer = null
const nameOf = (id) => team.value.find((m) => String(m.id) === String(id))?.name || ''
function statusText(d) {
  if (d.status === 'pending') return `${d.approver_role || '관리자'} 승인 대기`
  if (d.status === 'executed' && d.approved_by) return '승인 후 실행'
  if (d.status === 'executed' && d.decision === 'allow_audit') return '실행 · 기록'
  if (d.status === 'executed') return '실행함'
  if (d.status === 'decided') return d.dry_run ? '사전 검증' : d.decision === 'deny' ? '실행하지 않음' : '판단만'
  if (d.status === 'undone') return d.action_kind === 'mail.send' ? '회수함' : '되돌림'
  return { approved: '승인됨', rejected: '반려됨', failed: '실패', expired: '만료' }[d.status] || d.status
}
const stCls = (d) => (d.status === 'pending' ? 'wait' : ['rejected', 'failed'].includes(d.status) || (d.status === 'decided' && d.decision === 'deny') ? 'bad' : d.status === 'undone' ? 'muted' : 'ok')
const mine = (d) => String(d.user_id) === String(app.me?.user?.id)
const canUndo = (d) => d.status === 'executed' && d.decision === 'allow_audit' && d.undo_until && new Date(d.undo_until).getTime() > now.value && (mine(d) || admin.value)
const factRows = (f) => Object.entries(f || {}).filter(([, v]) => v !== null && v !== undefined)
  .sort(([a], [b]) => (FACT_ORDER.indexOf(a) + 1 || 99) - (FACT_ORDER.indexOf(b) + 1 || 99))

async function loadLedger() {
  ledgerErr.value = ''
  try {
    const qs = new URLSearchParams()
    if (filter.value) qs.set('status', filter.value)
    if (dry.value) qs.set('dry', '1')
    const r = await api(`/decisions${qs.toString() ? `?${qs}` : ''}`)
    decisions.value = r.decisions
    if (!filter.value) pendingCount.value = r.decisions.filter((d) => d.status === 'pending' && d.mayDecide).length
  } catch (e) { ledgerErr.value = e.message }
}
async function focusAsked() {
  const id = route.query.d
  if (!id) return
  tab.value = 'ledger'; filter.value = ''; open.value = id; highlight.value = id
  await loadLedger()
  missing.value = !decisions.value.some((d) => d.id === id)
  await nextTick()
  document.getElementById(`d-${id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
}
watch(() => route.query.d, focusAsked)
watch([filter, dry], loadLedger)
watch(tab, (t) => { if (t === 'ledger') loadLedger() })

async function act(d, what) {
  ledgerErr.value = ''; busy.value = d.id
  try {
    await api(`/decisions/${d.id}/${what}`, { method: 'POST', body: what === 'undo' ? undefined : { note: note.value } })
    note.value = ''
    await loadLedger()
  } catch (e) { ledgerErr.value = e.message } finally { busy.value = '' }
}

onMounted(async () => {
  timer = setInterval(() => { now.value = Date.now() }, 15000)
  try { await loadCatalog() } catch (e) { err.value = e.message }
  if (route.query.d) await focusAsked()
  else await loadLedger()
})
onUnmounted(() => clearInterval(timer))
</script>

<template>
  <div class="pcn">
    <p class="hint lead">에이전트가 결과가 남는 일(메일 보내기, 결제, 배포 …)을 하기 전에 아래 정책으로 판단해요. 여러 정책이 걸리면 가장 엄격한 결과를 따르고, 판단은 규칙으로만 해요 — AI 모델이 승인 여부를 정하지 않아요.</p>
    <div class="legend glass">
      <div v-for="(label, d) in DEC" :key="d" class="lg"><span class="chip" :class="d">{{ label }}</span><small>{{ DEC_HINT[d] }}</small></div>
    </div>

    <div class="seg tabs" role="tablist">
      <button :class="{ on: tab === 'catalog' }" role="tab" @click="tab = 'catalog'">정책 <small>{{ onCount }}/{{ policies.length }}</small></button>
      <button :class="{ on: tab === 'try' }" role="tab" @click="tab = 'try'">시험해 보기</button>
      <button :class="{ on: tab === 'ledger' }" role="tab" data-test="ledger-tab" @click="tab = 'ledger'">결정 원장 <span v-if="pendingCount" class="n">{{ pendingCount }}</span></button>
    </div>

    <!-- the catalog -->
    <template v-if="tab === 'catalog'">
      <p v-if="!admin" class="hint ro">정책 켜기·끄기는 관리자만 할 수 있어요. 바꿀 일이 있으면 관리자에게 알려 주세요.</p>
      <p v-if="err" class="err">{{ err }}</p>
      <template v-for="g in groups" :key="g.k">
        <p class="cap">{{ g.label }}</p>
        <div class="list glass">
          <div v-for="p in g.items" :key="p.id" class="li pol" :class="{ off: !p.enabled }" :data-policy="p.id">
            <div class="main">
              <div class="t"><span class="chip" :class="p.spec.decide">{{ DEC[p.spec.decide] }}</span><b>{{ pick(p.spec.title) }}</b></div>
              <small class="ex">{{ pick(p.spec.explain) }}</small>
              <div class="meta">
                <span class="kd">{{ scopeText(p.spec) }}</span>
                <span v-if="p.spec.approver?.role" class="ap"><span>승인·예외</span> <b>{{ p.spec.approver.role }}</b> <span v-if="holderOf(p.spec.approver.role)" data-no-i18n>{{ holderOf(p.spec.approver.role) }}</span><span v-else class="none">담당 없음 → 관리자</span></span>
              </div>
              <small v-if="p.spec.window" class="rule">{{ windowText(p.spec.window) }}</small>
              <small v-if="p.spec.tolerance" class="rule">{{ toleranceText(p.spec.tolerance) }}</small>
              <small v-if="p.spec.sources?.length" class="src"><span>근거</span> {{ p.spec.sources.join(' · ') }}</small>
              <details v-if="p.spec.when !== undefined" class="rule-x"><summary>조건 (JSONLogic)</summary><pre>{{ JSON.stringify(p.spec.when, null, 1) }}</pre></details>
            </div>
            <button class="switch" :class="{ on: p.enabled }" role="switch" :aria-checked="p.enabled" :aria-label="p.enabled ? '끄기' : '켜기'"
              :disabled="!admin || busy === p.id" :title="admin ? '' : '관리자만 바꿀 수 있어요'" @click="toggle(p)"><i /></button>
          </div>
        </div>
      </template>
    </template>

    <!-- try an action -->
    <template v-if="tab === 'try'">
      <p class="hint">행위와 그 사실(facts)을 넣으면 정책 엔진이 어떻게 판단하는지 보여 줘요. 실행하지도, 결정 원장에 남기지도 않아요. 구간 규칙(하루 N건)은 내 실제 기록으로 세요.</p>
      <div class="card glass try">
        <div class="row"><b>행위</b>
          <select v-model="kind" aria-label="행위">
            <option v-for="k in kinds" :key="k" :value="k">{{ kindName(k) }}</option>
          </select>
        </div>
        <div class="presets">
          <button v-for="(ps, i) in presets" :key="ps[0]" class="pre" :class="{ on: preset === i }" @click="usePreset(i)">{{ ps[0] }}</button>
        </div>
        <textarea v-model="factsText" class="facts" spellcheck="false" rows="7" aria-label="facts (JSON)" />
        <div class="row end"><button class="dark-btn sm" data-test="evaluate" @click="tryIt">판단해 보기</button></div>
        <p v-if="tryErr" class="err">{{ tryErr }}</p>
      </div>
      <div v-if="result" ref="verdictEl" class="card glass verdict" :class="result.decision">
        <div class="vd"><span class="chip big" :class="result.decision">{{ DEC[result.decision] }}</span><b>{{ verdict }}</b></div>
        <ul v-if="result.matched.length" class="pols">
          <li v-for="m in result.matched" :key="m.id">
            <span class="chip" :class="m.decision">{{ DEC[m.decision] }}</span>
            <span class="t">{{ pick(m.title) }}</span>
            <small v-for="(n, i) in m.notes || []" :key="i" class="nt">{{ noteText(n) }}</small>
            <small v-if="m.sources?.length" class="src"><span>근거</span> {{ m.sources.join(' · ') }}</small>
          </li>
        </ul>
        <small v-else class="muted">걸린 정책이 없어서 허용해요.</small>
      </div>
    </template>

    <!-- the decision ledger -->
    <template v-if="tab === 'ledger'">
      <div class="seg filters">
        <button v-for="[s, label] in FILTERS" :key="s" :class="{ on: filter === s }" @click="filter = s">{{ label }}</button>
        <button :class="{ on: dry }" title="최적화가 대안을 고르기 전에 정책으로 미리 확인한 판단" @click="dry = !dry">사전 검증 포함</button>
      </div>
      <p v-if="missing" class="hint">알림의 결정이 목록에 없어요. 볼 수 있는 사람이 아니거나 이미 오래된 결정이에요.</p>
      <p v-if="ledgerErr" class="err">{{ ledgerErr }}</p>
      <div v-if="decisions.length" class="list glass ledger">
        <div v-for="d in decisions" :id="`d-${d.id}`" :key="d.id" class="entry" :class="{ hl: d.id === highlight }" :data-decision="d.id">
          <div class="li dec" @click="open = open === d.id ? '' : d.id">
            <div class="av">{{ (d.name || '?').slice(0, 1) }}</div>
            <div class="main">
              <b class="subj" data-no-i18n>{{ d.subject || kindName(d.action_kind) }}</b>
              <small><span data-no-i18n>{{ d.name || '—' }}</span> · {{ kindName(d.action_kind) }} · {{ at(d.created_at) }}</small>
              <div class="chips">
                <span class="chip" :class="d.decision">{{ DEC[d.decision] }}</span>
                <span class="st" :class="stCls(d)">{{ statusText(d) }}</span>
                <span v-if="d.result?.demo" class="demo">시연용 보낸편지함 · 실제 메일은 나가지 않아요</span>
              </div>
            </div>
            <div class="acts" @click.stop>
              <template v-if="d.status === 'pending' && d.mayDecide">
                <button class="pill-btn sm ok" :disabled="busy === d.id" data-test="approve" @click="act(d, 'approve')">승인</button>
                <button class="pill-btn sm" :disabled="busy === d.id" data-test="reject" @click="act(d, 'reject')">반려</button>
              </template>
              <template v-else-if="canUndo(d)">
                <button class="pill-btn sm" :disabled="busy === d.id" data-test="undo" @click="act(d, 'undo')">{{ d.action_kind === 'mail.send' ? '회수하기' : '되돌리기' }}</button>
                <small class="until">{{ time(d.undo_until) }}까지</small>
              </template>
            </div>
          </div>
          <div v-if="open === d.id" class="detail">
            <p class="dh">판단에 쓴 사실</p>
            <div class="facts-l">
              <div v-for="[k, v] in factRows(d.facts)" :key="k" class="fr">
                <span class="fk">{{ FACT[k] || k }}</span>
                <span v-if="k === 'pii_by_kind'" class="fv"><span v-for="(n, kk) in v" :key="kk" class="pk">{{ PII_KIND[kk] || kk }} <b>{{ n }}</b></span></span>
                <span v-else-if="k === 'attachments'" class="fv"><span v-for="a in v" :key="a.name" class="pk"><span data-no-i18n>{{ a.name }}</span><template v-if="a.rows != null"> · {{ a.rows }}행</template><template v-if="a.scanned === false"> · 내용 확인 못 함</template></span><span v-if="!v.length">—</span></span>
                <span v-else class="fv">{{ fmt(k, v) }}</span>
              </div>
            </div>
            <p class="dh">걸린 정책</p>
            <ul v-if="d.matched?.length" class="pols">
              <li v-for="m in d.matched" :key="m.id">
                <span class="chip" :class="m.decision">{{ DEC[m.decision] }}</span>
                <span class="t">{{ pick(m.title) }}</span>
                <small v-if="m.explain">{{ pick(m.explain) }}</small>
                <small v-for="(n, i) in m.notes || []" :key="i" class="nt">{{ noteText(n) }}</small>
                <small v-if="m.sources?.length" class="src"><span>근거</span> {{ m.sources.join(' · ') }}</small>
              </li>
            </ul>
            <small v-else class="muted">걸린 정책이 없어서 허용했어요.</small>
            <template v-if="d.approver_role && ['require_approval', 'deny'].includes(d.decision)">
              <p class="dh">{{ d.decision === 'deny' ? '예외 권한' : '승인자' }}</p>
              <small class="line"><b>{{ d.approver_role }}</b> <span v-if="holderOf(d.approver_role)" data-no-i18n>{{ holderOf(d.approver_role) }}</span><span v-else>담당 없음 → 관리자</span></small>
              <small v-if="d.approved_by" class="line"><span>{{ d.status === 'rejected' ? '반려한 사람' : '승인한 사람' }}</span> <b data-no-i18n>{{ nameOf(d.approved_by) || '—' }}</b> <span>{{ at(d.approved_at) }}</span></small>
              <small v-if="d.result?.note" class="line" data-no-i18n>“{{ d.result.note }}”</small>
            </template>
            <template v-if="d.result?.error">
              <p class="dh">결과</p>
              <small class="line bad">{{ d.result.error }}</small>
            </template>
            <div v-if="d.status === 'pending' && d.mayDecide" class="noteform" @click.stop>
              <input v-model="note" placeholder="승인·반려 메모 (선택)" maxlength="300" />
            </div>
          </div>
        </div>
      </div>
      <p v-else-if="!ledgerErr" class="hint">아직 결정이 없어요.</p>
    </template>
  </div>
</template>

<style scoped>
.pcn { display: flex; flex-direction: column; }
.cap { margin: 18px 4px 8px; color: var(--text-secondary); font-size: 14px; }
.hint { margin: -2px 4px 10px; color: var(--text-tertiary); font-size: 13px; line-height: 1.5; }
.hint.lead { margin-top: -10px; color: var(--text-secondary); }
.hint.ro { margin-top: 12px; }
.legend { border-radius: 18px; padding: 10px 14px; display: grid; grid-template-columns: 1fr 1fr; gap: 6px 14px; margin-bottom: 14px; }
.lg { display: flex; align-items: center; gap: 8px; min-width: 0; }
.lg small { color: var(--text-secondary); font-size: 12px; line-height: 1.35; }
.chip { flex: none; font-size: 11.5px; padding: 1px 8px; border-radius: 9px; background: var(--field-bg); color: var(--text-secondary); white-space: nowrap; }
.chip.allow { color: var(--color-success); background: color-mix(in srgb, var(--color-success) 14%, transparent); }
.chip.allow_audit { color: var(--color-info); background: color-mix(in srgb, var(--color-info) 14%, transparent); }
.chip.require_approval { color: #d9822b; background: rgba(230 126 34 / .15); }
.chip.deny { color: var(--color-error); background: color-mix(in srgb, var(--color-error) 14%, transparent); }
.chip.big { font-size: 13px; padding: 3px 10px; border-radius: 10px; }

.seg { display: flex; gap: 6px; flex-wrap: wrap; }
.seg button { height: 32px; padding: 0 13px; border-radius: 9999px; background: var(--field-bg); font-size: 13.5px; color: var(--text-secondary); display: inline-flex; align-items: center; gap: 6px; }
.seg button.on { background: var(--ink); color: var(--ink-inverse); }
.seg button small { font-size: 12px; opacity: .7; }
.tabs { margin: 2px 0 6px; }
.tabs button { height: 36px; padding: 0 16px; font-size: 14px; }
.n { min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: #d9822b; color: #fff; font-size: 11.5px; display: grid; place-items: center; }
.filters { margin: 12px 0 10px; }
.filters button { height: 30px; font-size: 13px; }

.list { border-radius: 20px; overflow: hidden; }
.li { display: flex; align-items: flex-start; gap: 12px; padding: 12px 14px; border-bottom: 1px solid var(--hairline); }
.li:last-child { border-bottom: 0; }
.main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; text-align: left; }
.pol .t { display: flex; align-items: center; gap: 8px; }
.pol .t b { font-weight: 500; font-size: 14.5px; line-height: 1.35; }
.pol.off { opacity: .55; }
.ex { color: var(--text-secondary); font-size: 12.5px; line-height: 1.45; }
.meta { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; color: var(--text-secondary); margin-top: 1px; }
.meta .kd { color: var(--text-tertiary); }
.meta .ap b { font-weight: 500; color: var(--text-primary); }
.meta .none { color: var(--text-tertiary); }
.rule { color: var(--color-info); font-size: 12px; }
.src { color: var(--text-tertiary); font-size: 12px; line-height: 1.4; }
.src > span:first-child { margin-right: 2px; }
.rule-x summary { cursor: pointer; color: var(--text-tertiary); font-size: 12px; }
.rule-x pre { margin: 4px 0 0; padding: 8px 10px; border-radius: 10px; background: var(--field-bg); font-size: 11.5px; line-height: 1.4; overflow-x: auto; max-height: 180px; }
.switch { width: 52px; height: 30px; border-radius: 9999px; background: var(--field-bg); position: relative; transition: background-color .25s; flex: none; margin-top: 2px; }
.switch i { position: absolute; top: 3px; left: 3px; width: 24px; height: 24px; border-radius: 50%; background: #fff; box-shadow: 0 1px 4px rgba(0 0 0 / .25); transition: left .25s var(--spring); }
.switch.on { background: var(--ink); } .switch.on i { left: 25px; }
.switch:disabled { cursor: default; opacity: .75; }
:root[data-theme="dark"] .switch.on { background: #f5f5f7; } :root[data-theme="dark"] .switch.on i { background: #1d1d1f; }

.card { border-radius: 20px; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.row { display: flex; justify-content: space-between; align-items: center; gap: 10px; font-size: 14px; }
.row b { font-weight: 500; }
.row.end { justify-content: flex-end; }
select { max-width: 64%; height: 34px; border-radius: 10px; padding: 0 8px; background: var(--field-bg); border: 1px solid var(--hairline); font-size: 14px; }
.presets { display: flex; flex-wrap: wrap; gap: 6px; }
.pre { height: 28px; padding: 0 11px; border-radius: 9999px; background: var(--field-bg); font-size: 12.5px; color: var(--text-secondary); }
.pre.on { background: var(--ink); color: var(--ink-inverse); }
.facts { width: 100%; border-radius: 12px; padding: 10px 12px; border: 1px solid var(--hairline); background: var(--field-bg); font-family: ui-monospace, Menlo, monospace; font-size: 12.5px; line-height: 1.45; resize: vertical; }
.dark-btn.sm { height: 38px; padding: 0 18px; font-size: 14px; }
.verdict { margin-top: 10px; border-left: 4px solid var(--hairline); }
.verdict.allow { border-left-color: var(--color-success); } .verdict.allow_audit { border-left-color: var(--color-info); }
.verdict.require_approval { border-left-color: #d9822b; } .verdict.deny { border-left-color: var(--color-error); }
.vd { display: flex; align-items: center; gap: 10px; font-size: 15px; }
.vd b { font-weight: 500; }
.pols { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.pols li { display: flex; flex-direction: column; gap: 2px; font-size: 13px; }
.pols li .chip { align-self: flex-start; }
.pols .t { font-weight: 500; }
.pols small { color: var(--text-secondary); font-size: 12px; line-height: 1.45; }
.pols .src { color: var(--text-tertiary); }
.nt { color: var(--color-info) !important; }
.muted { color: var(--text-tertiary); font-size: 12.5px; }

.entry { border-bottom: 1px solid var(--hairline); transition: background-color .4s; scroll-margin-top: 90px; }
.entry:last-child { border-bottom: 0; }
.entry .li { border-bottom: 0; cursor: pointer; }
.entry.hl { background: rgba(230 126 34 / .1); box-shadow: inset 3px 0 0 #d9822b; }
.av { width: 32px; height: 32px; border-radius: 16px; background: var(--ink); color: var(--ink-inverse); display: grid; place-items: center; font-size: 14px; flex: none; }
.subj { font-weight: 500; font-size: 14px; line-height: 1.35; word-break: break-all; }
.dec small { color: var(--text-secondary); font-size: 12px; }
.chips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 2px; }
.st { font-size: 12px; }
.st.ok { color: var(--color-success); } .st.wait { color: #d9822b; } .st.bad { color: var(--color-error); } .st.muted { color: var(--text-tertiary); }
.demo { font-size: 11.5px; color: var(--text-tertiary); }
.acts { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; flex: none; }
.pill-btn.sm { height: 32px; padding: 0 14px; font-size: 13px; }
.pill-btn.ok { background: var(--ink); color: var(--ink-inverse); }
.until { color: var(--text-tertiary); font-size: 11.5px; }
.detail { padding: 0 14px 14px 58px; display: flex; flex-direction: column; gap: 6px; }
.dh { margin: 6px 0 0; font-size: 12px; color: var(--text-tertiary); }
.facts-l { display: flex; flex-direction: column; gap: 2px; }
.fr { display: flex; gap: 10px; font-size: 12.5px; }
.fk { flex: 0 0 124px; color: var(--text-secondary); }
.fv { flex: 1; min-width: 0; word-break: break-all; display: flex; flex-wrap: wrap; gap: 2px 10px; }
.pk b { font-weight: 500; }
.line { font-size: 12.5px; color: var(--text-secondary); }
.line b { font-weight: 500; color: var(--text-primary); }
.line.bad { color: var(--color-error); }
.noteform input { width: 100%; height: 34px; border-radius: 10px; padding: 0 10px; border: 1px solid var(--hairline); background: var(--field-bg); font-size: 13px; }
.err { color: var(--color-error); font-size: 13px; margin: 6px 4px; }
@media (max-width: 480px) { .legend { grid-template-columns: 1fr; } .detail { padding-left: 14px; } }
</style>
