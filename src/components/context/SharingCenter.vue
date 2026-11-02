<script setup>
// 설정 › 공유와 허락(spec pgpt-pro_context-visibility · pgpt-pro_context-access-request): 새 맥락의 기본 등급, 자동 허용 규칙
// (위에서부터 처음 맞는 줄 + 지울 수 없는 민감 줄), 내 맥락의 공개 등급(등급 고르기), 내가 준 허락(회수)·받은 허락,
// 「내 맥락이 쓰인 곳」, 「내 맥락을 본 기록」. 모두 BFF /api/context/* — 남의 맥락은 서버가 깊이 판정을 거친 것만 보낸다.
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '../Icon.vue'
import GradePicker from './GradePicker.vue'
import { api } from '../../api.js'
import { useApp } from '../../stores/app.js'
import { GRADE, REACH, DEPTH, DURATION, wide, gradeLabel, ago, when } from './gradeKit.js'

const app = useApp()
const router = useRouter()
const mine = ref(null), rules = ref(null), grants = ref({ given: [], received: [] }), used = ref([]), views = ref([]), people = ref([])
const err = ref({}), saved = ref({}), dirty = ref(false)
const defaults = ref({ default_visibility: 'summary', default_reach: 'team' })
const WHO = { team: '같은 팀', department: '같은 부서', company: '회사 전체' }
const DECISION = { allow: '자동 허용', ask: '묻기', deny: '거절' }

const fail = (k) => (e) => { err.value = { ...err.value, [k]: e.message } }
const ok = (k, t) => { saved.value = { ...saved.value, [k]: t }; setTimeout(() => { saved.value = { ...saved.value, [k]: '' } }, 2500) }
async function loadMine() { try { mine.value = await api('/context/mine') } catch (e) { fail('mine')(e) } }
async function loadRules() {
  try {
    const r = await api('/context/sharing-rules')
    rules.value = { ...r, rules: (r.rules || []).map((x) => ({ ...x })) }
    defaults.value = { default_visibility: r.enabled ? r.default_visibility : 'private', default_reach: r.default_reach }
    dirty.value = false
  } catch (e) { fail('rules')(e) }
}
async function loadGrants() { try { grants.value = await api('/context/grants') } catch (e) { fail('grants')(e) } }
async function loadUsed() { try { used.value = await api('/context/used') } catch (e) { fail('used')(e) } }
async function loadViews() { try { views.value = await api('/context/views') } catch (e) { fail('views')(e) } }
async function loadPeople() { try { people.value = (await api('/team')).filter((m) => m.id !== app.me?.user?.id) } catch { people.value = [] } }
onMounted(() => Promise.all([loadMine(), loadRules(), loadGrants(), loadUsed(), loadViews(), loadPeople()]))

// ── 기본 등급 ──
const enabled = computed(() => !!rules.value?.enabled)
const defaultsDirty = computed(() => rules.value && (!enabled.value || defaults.value.default_visibility !== rules.value.default_visibility || (wide(defaults.value.default_visibility) && defaults.value.default_reach !== rules.value.default_reach)))
async function saveDefaults() {
  err.value = { ...err.value, defaults: '' }
  try {
    const r = await api('/context/defaults', { method: 'PUT', body: defaults.value })
    rules.value = { ...rules.value, enabled: r.enabled, default_visibility: r.default_visibility, default_reach: r.default_reach }
    ok('defaults', `새 맥락은 ${gradeLabel(r.default_visibility, r.default_reach)}에서 시작합니다`)
    loadMine()
  } catch (e) { fail('defaults')(e) }
}

// ── 자동 허용 규칙 ──
const whoKey = (r) => (String(r.who).startsWith('user:') ? 'user' : r.who)
const touch = () => { dirty.value = true; saved.value = { ...saved.value, rules: '' } }
function setWho(r, k) { r.who = k === 'user' ? `user:${people.value[0]?.id || ''}` : k; touch() }
function setDecision(r, d) { r.decision = d; if (d === 'allow') { r.depth ||= 'content'; r.duration ||= 'task' } else { delete r.depth; delete r.duration } touch() }
function move(i, d) { const a = rules.value.rules, j = i + d; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; touch() }
function remove(i) { rules.value.rules.splice(i, 1); touch() }
function add() { rules.value.rules.push({ who: 'company', decision: 'ask' }); touch() }
function reset() { rules.value.rules = rules.value.defaults.map((x) => ({ ...x })); touch() }
async function saveRules() {
  err.value = { ...err.value, rules: '' }
  try {
    // 기본 등급은 저장된 값 그대로 보낸다(위 칸에서 따로 저장)
    const r = await api('/context/sharing-rules', { method: 'PUT', body: { rules: rules.value.rules, default_visibility: rules.value.default_visibility, default_reach: rules.value.default_reach } })
    rules.value = { ...r, rules: (r.rules || []).map((x) => ({ ...x })) }
    dirty.value = false
    ok('rules', '규칙을 저장했습니다')
  } catch (e) { fail('rules')(e) }
}

// ── 내 맥락 ──
const items = computed(() => mine.value?.items || [])
const proposed = computed(() => mine.value?.proposed || [])
function onItem(r) {
  const it = items.value.find((x) => x.id === r.item.id)
  if (it) Object.assign(it, r.item)
  if (r.sensitive) loadMine()
}
async function decideSensitive(p, action) {
  err.value = { ...err.value, mine: '' }
  try { await api(`/context/items/${encodeURIComponent(p.id)}/sensitive`, { method: 'POST', body: { action } }); await loadMine() } catch (e) { fail('mine')(e) }
}

// ── 허락 ──
const showOld = ref(false)
const live = (g) => !g.revoked_at && !(g.until && new Date(g.until) <= Date.now())
const given = computed(() => grants.value.given.filter((g) => showOld.value || live(g)))
const received = computed(() => grants.value.received.filter((g) => showOld.value || live(g)))
function left(g) {
  if (g.revoked_at) return '회수됨'
  if (g.until && new Date(g.until) <= Date.now()) return '끝남'
  if (g.duration === 'forever') return '회수할 때까지'
  const h = Math.round((new Date(g.until) - Date.now()) / 3600000)
  return `${g.duration === 'task' ? '이 작업 동안 · ' : ''}${h >= 48 ? `${Math.round(h / 24)}일 남음` : `${Math.max(1, h)}시간 남음`}`
}
async function revoke(g) {
  err.value = { ...err.value, grants: '' }
  try { await api(`/context/grants/${g.id}`, { method: 'DELETE' }); await Promise.all([loadGrants(), loadMine()]); ok('grants', `${g.grantee_name}의 허락을 회수했습니다`) } catch (e) { fail('grants')(e) }
}
const viewWhen = (r) => (r.depth === 'summary' ? `${r.day.slice(5).replace('-', '/')} · ${r.count}번 · 마지막 ${new Date(r.last_at).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' })}` : when(r.last_at))
</script>

<template>
  <div class="sc">
    <!-- 민감 표시 제안: 승인하기 전까지는 적용되지 않는다 -->
    <div v-if="proposed.length" class="propose glass" data-testid="sensitive-proposals">
      <div v-for="p in proposed" :key="p.id" class="pr">
        <span class="badge warn">민감 표시 제안</span>
        <div class="main"><b>「{{ p.title }}」</b><small>{{ p.hit ? `「${p.hit}」에 관한 내용으로 보입니다 · ` : '' }}승인하면 전체 공개 불가 · 자동 허용 제외 · 장·관리자에게도 제목만</small></div>
        <button class="b warn press" data-testid="proposal-confirm" @click="decideSensitive(p, 'confirm')">승인</button>
        <button class="b ghost press" @click="decideSensitive(p, 'dismiss')">무시</button>
      </div>
    </div>

    <p class="cap">새 맥락의 기본 등급</p>
    <div class="list glass" data-testid="sharing-defaults">
      <div class="li">
        <div class="main"><b>판단 모델이 새로 나눈 대화에 붙는 등급</b>
          <small>{{ enabled ? '등급을 따로 정하지 않은 맥락은 이 등급을 따릅니다' : '아직 정하지 않아 내 맥락은 모두 비공개로 다룹니다' }}</small></div>
      </div>
      <div v-if="rules" class="li row">
        <select v-model="defaults.default_visibility" aria-label="기본 등급" data-testid="default-visibility"><option v-for="(t, g) in GRADE" :key="g" :value="g">{{ t }}</option></select>
        <select v-model="defaults.default_reach" aria-label="기본 범위" :disabled="!wide(defaults.default_visibility)"><option v-for="(t, r) in REACH" :key="r" :value="r">{{ t }}</option></select>
        <span class="sp" />
        <small v-if="saved.defaults" class="okm">{{ saved.defaults }}</small>
        <button class="pill-btn sm" :disabled="!defaultsDirty" @click="saveDefaults">저장</button>
      </div>
      <p v-if="err.defaults" class="err">{{ err.defaults }}</p>
    </div>

    <p class="cap">자동 허용 규칙 <span class="dim">· 내 맥락을 참고하겠다는 요청에 위에서부터 처음 맞는 줄을 씁니다</span></p>
    <div v-if="rules" class="list glass" data-testid="sharing-rules">
      <!-- 고정 줄은 회사 정책(설정 › 정책 · 팀원 맥락 참고)이다: 관리자가 끄면 민감 항목도 내 규칙을 따른다 -->
      <div v-if="rules.fixed?.policy?.sensitive !== false" class="li rule fixed" title="회사 정책 — 지울 수 없는 줄" data-testid="rule-fixed">
        <span class="no"><Icon name="lock" :size="14" /></span>
        <div class="main"><b>민감 항목 → 언제나 묻기</b><small>회사 정책 「{{ rules.fixed?.policy?.titles?.sensitive || '민감 맥락은 주인이 직접 허락' }}」 · 지울 수 없음 · 규칙보다 먼저</small></div>
      </div>
      <div v-else class="li rule fixed off" data-testid="rule-fixed">
        <span class="no"><Icon name="lock" :size="14" /></span>
        <div class="main"><b>민감 항목도 내 규칙대로</b><small>{{ rules.fixed.note }}</small></div>
      </div>
      <div v-if="rules.fixed?.policy?.topic" class="li rule fixed" data-testid="rule-topic">
        <span class="no"><Icon name="lock" :size="14" /></span>
        <div class="main"><b>민감할 수 있는 내용으로 읽히면 → 묻기</b><small>회사 정책 「{{ rules.fixed.policy.titles?.topic || '민감할 수 있는 주제는 자동 허용하지 않음' }}」 · 모델이 글을 읽어 인사·급여·건강처럼 민감해 보이거나 주민번호·계좌·전화 형식이 있으면, 민감 표시 전이라도 자동 허용하지 않습니다</small></div>
      </div>
      <div v-for="(r, i) in rules.rules" :key="i" class="li rule" data-testid="rule-row">
        <span class="no">{{ i + 1 }}</span>
        <div class="sels">
          <select :value="whoKey(r)" aria-label="누가" @change="setWho(r, $event.target.value)"><option v-for="(t, k) in WHO" :key="k" :value="k">{{ t }}</option><option value="user" :disabled="!people.length">특정 사람</option></select>
          <select v-if="whoKey(r) === 'user'" v-model="r.who" aria-label="사람" @change="touch"><option v-for="p in people" :key="p.id" :value="`user:${p.id}`">{{ p.name }}</option></select>
          <select :value="r.decision" aria-label="결정" @change="setDecision(r, $event.target.value)"><option v-for="(t, k) in DECISION" :key="k" :value="k">{{ t }}</option></select>
          <template v-if="r.decision === 'allow'">
            <select v-model="r.depth" aria-label="깊이" @change="touch"><option value="summary">요약까지</option><option value="content">원문까지</option></select>
            <select v-model="r.duration" aria-label="기간" @change="touch"><option v-for="(t, k) in DURATION" :key="k" :value="k">{{ t }}</option></select>
          </template>
        </div>
        <div class="ord">
          <button class="ib press" :disabled="!i" aria-label="위로" @click="move(i, -1)">↑</button>
          <button class="ib press" :disabled="i === rules.rules.length - 1" aria-label="아래로" @click="move(i, 1)">↓</button>
          <button class="ib press" aria-label="지우기" @click="remove(i)"><Icon name="close" :size="14" /></button>
        </div>
      </div>
      <div class="li rule tail"><span class="no">·</span><div class="main"><small>맞는 줄이 없으면 묻기</small></div></div>
      <div class="li row">
        <button class="pill-btn sm" @click="add">줄 더하기</button>
        <button class="pill-btn sm ghost" @click="reset">처음 값으로</button>
        <span class="sp" />
        <small v-if="saved.rules" class="okm">{{ saved.rules }}</small>
        <button class="pill-btn sm dark" :disabled="!dirty" data-testid="rules-save" @click="saveRules">저장</button>
      </div>
      <p v-if="err.rules" class="err">{{ err.rules }}</p>
    </div>

    <p class="cap">내 맥락의 공개 등급 <span class="dim">· 판단 모델이 나눈 대화마다</span></p>
    <div class="list glass" data-testid="my-contexts">
      <div v-for="x in items" :key="x.id" class="li ctx" :data-title="x.title" data-testid="my-context">
        <button class="main" @click="router.push(`/context/${x.id}`)">
          <b>{{ x.title }}</b>
          <small v-if="x.purpose">{{ x.purpose }}</small>
          <small class="dim">턴 {{ x.turns }}개 · {{ ago(x.updated_at) }}<template v-if="x.inherited"> · 기본 등급 따름</template><template v-if="x.grants"> · 허락 {{ x.grants }}건</template></small>
        </button>
        <GradePicker :conv="x.id" :title="x.title" :value="{ visibility: x.visibility, reach: x.reach, sensitive: x.sensitive, purpose: x.purpose }" compact @changed="onItem" />
      </div>
      <div v-if="mine && !items.length" class="li"><div class="main"><small>아직 나눈 대화가 없습니다. 채팅에서 일을 시키면 판단 모델이 일마다 대화를 나눕니다.</small></div></div>
      <div v-if="!mine && !err.mine" class="li"><div class="main"><small>읽는 중…</small></div></div>
      <p v-if="err.mine" class="err">{{ err.mine }}</p>
    </div>

    <p class="cap">허락 <span class="sp" /><label class="chk"><input v-model="showOld" type="checkbox" /> 회수·끝난 것도</label></p>
    <div class="list glass" data-testid="sharing-grants">
      <p class="sub">내가 준 허락</p>
      <div v-for="g in given" :key="g.id" class="li" :class="{ old: !live(g) }" data-testid="grant-given">
        <div class="main"><b>{{ g.grantee_name }} · 「{{ g.target_title }}」 {{ DEPTH[g.depth] }}</b>
          <small>{{ g.via === 'auto' ? '자동 허용' : '직접 허락' }} · {{ left(g) }} · {{ ago(g.created_at) }}</small></div>
        <button v-if="live(g)" class="pill-btn sm bad" data-testid="grant-revoke" @click="revoke(g)">회수</button>
      </div>
      <div v-if="!given.length" class="li"><div class="main"><small>준 허락이 없습니다</small></div></div>
      <p class="sub">받은 허락</p>
      <div v-for="g in received" :key="g.id" class="li" :class="{ old: !live(g) }" data-testid="grant-received">
        <button class="main" @click="router.push(`/context/${g.conversation_id}${g.thread_id ? `?thread=${g.thread_id}` : ''}`)"><b>{{ g.owner_name }} · 「{{ g.target_title }}」 {{ DEPTH[g.depth] }}</b>
          <small>{{ DURATION[g.duration] }} · {{ left(g) }} · {{ ago(g.created_at) }}</small></button>
      </div>
      <div v-if="!received.length" class="li"><div class="main"><small>받은 허락이 없습니다</small></div></div>
      <small v-if="saved.grants" class="okm pad">{{ saved.grants }}</small>
      <p v-if="err.grants" class="err">{{ err.grants }}</p>
    </div>

    <p class="cap">내 맥락이 쓰인 곳 <span class="dim">· 다른 사람의 대화가 내 맥락을 참고한 기록</span></p>
    <div class="list glass" data-testid="sharing-used">
      <div v-for="r in used" :key="r.id" class="li" data-testid="used-row">
        <div class="main"><b>{{ r.viewer_name }} · 「{{ r.item_title }}」 <span class="badge" :class="r.depth">{{ DEPTH[r.depth] }}</span></b>
          <small>{{ r.turn_title ? `「${r.turn_title}」 답에 참고` : '대화에서 참고' }} · {{ r.basis }} · {{ when(r.created_at) }}</small></div>
      </div>
      <div v-if="!used.length" class="li"><div class="main"><small>아직 없습니다</small></div></div>
      <p v-if="err.used" class="err">{{ err.used }}</p>
    </div>

    <p class="cap">내 맥락을 본 기록 <span class="dim">· 원문은 건마다, 요약은 사람·날짜별로</span></p>
    <div class="list glass" data-testid="sharing-views">
      <div v-for="r in views" :key="r.id" class="li" data-testid="view-row">
        <div class="main"><b>{{ r.viewer_name }} · 「{{ r.item_title }}」 <span class="badge" :class="r.depth">{{ DEPTH[r.depth] }}</span></b>
          <small>{{ r.basis }} · {{ viewWhen(r) }}</small></div>
      </div>
      <div v-if="!views.length" class="li"><div class="main"><small>아직 없습니다</small></div></div>
      <p v-if="err.views" class="err">{{ err.views }}</p>
    </div>
  </div>
</template>

<style scoped>
.sc { display: flex; flex-direction: column; }
.cap { display: flex; align-items: center; gap: 6px; margin: 18px 4px 8px; color: var(--text-secondary); font-size: 14px; }
.cap .dim { font-size: 12.5px; }
.dim { color: var(--text-tertiary); }
.sp { flex: 1; }
.list { border-radius: 20px; overflow: hidden; }
.li { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-bottom: 1px solid var(--hairline); }
.li:last-child { border-bottom: 0; }
.li.row { gap: 8px; flex-wrap: wrap; }
.main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; text-align: left; }
.main b { font-weight: 500; font-size: 15px; line-height: 1.35; }
.main small { color: var(--text-secondary); font-size: 13px; line-height: 1.4; }
.main small.dim { color: var(--text-tertiary); font-size: 12.5px; }
button.main { cursor: pointer; }
button.main:hover b { text-decoration: underline; text-underline-offset: 3px; }
select { height: 34px; border-radius: 10px; padding: 0 8px; background: var(--field-bg); border: 1px solid var(--hairline); color: var(--text-primary); font-size: 14px; }
select:disabled { opacity: .5; }
.pill-btn.sm { height: 34px; padding: 0 14px; font-size: 14px; }
.pill-btn.sm.dark { background: var(--ink); color: var(--ink-inverse); }
.pill-btn.sm.ghost { background: transparent; }
.pill-btn.sm.bad { color: var(--color-error); }
.pill-btn:disabled { opacity: .4; cursor: default; }
.okm { color: var(--color-success); font-size: 13px; }
.okm.pad { padding: 8px 14px; display: block; }
.err { color: var(--color-error); font-size: 13px; margin: 0; padding: 8px 14px; }
.rule .no { width: 22px; flex: none; text-align: center; color: var(--text-tertiary); font-size: 12.5px; display: grid; place-items: center; }
.rule.fixed { background: color-mix(in srgb, var(--color-error) 9%, transparent); }
.rule.tail { padding-top: 8px; padding-bottom: 8px; }
.sels { flex: 1; display: flex; gap: 6px; flex-wrap: wrap; min-width: 0; }
.sels select { height: 32px; font-size: 13px; padding: 0 4px; }
.ord { display: flex; gap: 0; flex: none; }
.ib { width: 26px; height: 26px; border-radius: 14px; display: grid; place-items: center; color: var(--text-secondary); font-size: 14px; }
.ib:hover:not(:disabled) { background: var(--field-bg); color: var(--text-primary); }
.ib:disabled { opacity: .3; cursor: default; }
.ctx { align-items: flex-start; }
.ctx :deep(.gp) { margin-top: 2px; }
.sub { margin: 0; padding: 10px 14px 2px; font-size: 12.5px; color: var(--text-tertiary); }
.li.old { opacity: .55; }
.li.old b { text-decoration: line-through; }
.chk { display: inline-flex; align-items: center; gap: 4px; font-size: 12.5px; color: var(--text-secondary); cursor: pointer; }
.chk input { width: auto; margin: 0; }
.badge { display: inline-flex; align-items: center; height: 18px; padding: 0 7px; border-radius: 9px; font-size: 11px; font-weight: 500; vertical-align: 2px; background: var(--chip-bg); color: var(--text-secondary); }
.badge.content { background: color-mix(in srgb, var(--color-success) 18%, transparent); color: var(--color-success); }
.badge.summary { background: color-mix(in srgb, var(--color-info) 18%, transparent); color: var(--color-info); }
.badge.warn { background: rgba(230 126 34 / .18); color: #d9822b; flex: none; }
.propose { border-radius: 20px; padding: 6px 14px; margin-top: 4px; border: 1px solid rgba(230 126 34 / .45); }
.pr { display: flex; align-items: center; gap: 10px; padding: 8px 0; }
.pr + .pr { border-top: 1px solid var(--hairline); }
.b { height: 32px; padding: 0 14px; border-radius: 16px; font-size: 13.5px; white-space: nowrap; flex: none; }
.b.warn { background: #d9822b; color: #fff; }
.b.ghost { color: var(--text-secondary); }
</style>
