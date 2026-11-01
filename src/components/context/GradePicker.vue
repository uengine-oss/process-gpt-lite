<script setup>
// 공개 등급 고르기(spec pgpt-pro_context-visibility): 칩(「요약 공개 · 팀」, 민감) → 등급 네 개 · 범위 · 한 줄 목적 · 민감 표시
// · 「누가 무엇을 보게 되나」 미리보기 → 저장. 미리보기와 저장은 서버(GET /context/visibility/preview, PATCH /context/items/:conv/grade)가
// 같은 깊이 판정으로 한다. 민감 항목을 전체 공개로 저장하면 422 안내를 그대로 보여 준다.
// value 를 주지 않으면 내 맥락 하나를 스스로 읽는다(GET /context/mine?conv=) — 내 것이 아니면(404) 아무것도 그리지 않는다.
import { ref, reactive, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { api } from '../../api.js'
import { GRADES, GRADE, REACH, DEPTH, INFO, wide, gradeLabel, ro } from './gradeKit.js'

const props = defineProps({
  conv: { type: String, required: true },
  value: { type: Object, default: null },            // { visibility, reach, sensitive, purpose, title? }
  title: { type: String, default: '' },
  compact: { type: Boolean, default: false },
})
const emit = defineEmits(['changed'])

const cur = reactive({ visibility: 'private', reach: 'team', sensitive: 'none', purpose: '', title: '' })
const draft = reactive({ visibility: 'private', reach: 'team', purpose: '' })
const ready = ref(!!props.value)
const open = ref(false), saving = ref(false), err = ref(''), done = ref(''), pv = ref(null), loading = ref(false)
const chip = ref(null), pop = ref(null), pos = ref({})
const name = computed(() => props.title || cur.title || '')

function sync() {
  Object.assign(cur, { visibility: 'private', reach: 'team', sensitive: 'none', purpose: '', title: '' }, props.value || {})
  Object.assign(draft, { visibility: cur.visibility, reach: cur.reach, purpose: cur.purpose || '' })
}
watch(() => [props.conv, props.value?.visibility, props.value?.reach, props.value?.sensitive, props.value?.purpose], () => { if (props.value && !open.value) { sync(); ready.value = true } }, { immediate: true })
async function selfLoad() {
  if (props.value) return
  try {
    const r = await api(`/context/mine?conv=${encodeURIComponent(props.conv)}`)
    const it = r.items?.[0]
    if (it) { Object.assign(cur, it); Object.assign(draft, { visibility: it.visibility, reach: it.reach, purpose: it.purpose || '' }); ready.value = true }
  } catch { ready.value = false }
}
onMounted(selfLoad)
watch(() => props.conv, () => { if (!props.value) { ready.value = false; selfLoad() } })

const sensitive = computed(() => cur.sensitive === 'confirmed')
const dirty = computed(() => draft.visibility !== cur.visibility || (wide(draft.visibility) && draft.reach !== cur.reach) || draft.purpose.trim() !== (cur.purpose || '').trim())
const blocked = computed(() => sensitive.value && draft.visibility === 'open')

// 미리보기: 등급·범위가 바뀔 때마다(조금 기다렸다가) — 늦게 온 옛 응답은 버린다
let seq = 0, timer = null
function refresh() {
  clearTimeout(timer)
  timer = setTimeout(async () => {
    const my = ++seq
    loading.value = true
    try {
      const r = await api(`/context/visibility/preview?conv=${encodeURIComponent(props.conv)}&visibility=${draft.visibility}&reach=${draft.reach}`)
      if (my === seq) { const first = !pv.value; pv.value = r; if (first) nextTick(place) }
    } catch (e) { if (my === seq) { pv.value = null; err.value = e.message } }
    finally { if (my === seq) loading.value = false }
  }, 120)
}
watch(() => [draft.visibility, draft.reach], () => { if (open.value) { err.value = ''; done.value = ''; refresh() } })

// 칩 아래(안 되면 위)에 통째로 들어가면 거기, 어느 쪽도 모자라면(1280×720 의 화면 가운데 칩) 화면 세로 가운데에 띄운다
function place() {
  const r = chip.value?.getBoundingClientRect()
  if (!r) return
  const vw = window.innerWidth, vh = window.innerHeight
  const w = Math.min(780, vw - 24)
  // 칩 왼쪽에 맞추고, 넘치면 칩 오른쪽 끝에 맞춘다
  const left = r.left + w <= vw - 12 ? r.left : Math.max(12, Math.min(r.right - w, vw - w - 12))
  const h = Math.min(pop.value?.scrollHeight || 540, vh - 24)
  const below = vh - r.bottom - 20, above = r.top - 20
  const base = { left: left + 'px', width: w + 'px' }
  pos.value = below >= h ? { ...base, top: r.bottom + 8 + 'px', maxHeight: below + 'px' }
    : above >= h ? { ...base, bottom: vh - r.top + 8 + 'px', maxHeight: above + 'px' }
    : { ...base, top: Math.max(12, Math.round((vh - h) / 2)) + 'px', maxHeight: vh - 24 + 'px' }
}
async function toggle() {
  if (open.value) return close()
  if (props.value) sync()
  else Object.assign(draft, { visibility: cur.visibility, reach: cur.reach, purpose: cur.purpose || '' })
  err.value = ''; done.value = ''; pv.value = null
  open.value = true
  await nextTick(); place(); refresh()
  window.addEventListener('resize', place); window.addEventListener('keydown', onKey)
}
function close() { open.value = false; window.removeEventListener('resize', place); window.removeEventListener('keydown', onKey) }
const onKey = (e) => { if (e.key === 'Escape') close() }
onBeforeUnmount(close)

function took(item) {
  Object.assign(cur, { visibility: item.visibility, reach: item.reach, sensitive: item.sensitive, purpose: item.purpose ?? cur.purpose })
  Object.assign(draft, { visibility: item.visibility, reach: item.reach, purpose: item.purpose ?? draft.purpose })
}
async function save() {
  err.value = ''; done.value = ''; saving.value = true
  try {
    const r = await api(`/context/items/${encodeURIComponent(props.conv)}/grade`, { method: 'PATCH', body: { visibility: draft.visibility, reach: draft.reach, purpose: draft.purpose } })
    took(r.item)
    done.value = r.note || `${r.item.label}${ro(r.item.label)} 바꿨습니다`
    emit('changed', r)
    refresh()
  } catch (e) { err.value = e.message }
  finally { saving.value = false }
}
async function mark(action) {
  err.value = ''; done.value = ''
  try {
    const r = await api(`/context/items/${encodeURIComponent(props.conv)}/sensitive`, { method: 'POST', body: { action } })
    took(r.item)
    done.value = r.note
    emit('changed', r)
    refresh()
  } catch (e) { err.value = e.message }
}
const COLS = [['title', '제목'], ['summary', '요약'], ['content', '원문']]
const VIA = { lead: '장', admin: '관리자', grant: '허락' }
</script>

<template>
  <span v-if="ready" class="gp" :class="{ compact }">
    <button ref="chip" type="button" class="gchip press" :class="['g-' + cur.visibility, { on: open }]" :aria-expanded="open" data-testid="grade-chip"
      :title="`공개 등급: ${gradeLabel(cur.visibility, cur.reach)} — 누르면 바꿉니다`" @click.stop="toggle">
      <i class="gdot" />{{ gradeLabel(cur.visibility, cur.reach) }}
      <span v-if="cur.sensitive === 'confirmed'" class="badge bad">민감</span>
      <span v-else-if="cur.sensitive === 'proposed'" class="badge warn">민감 제안</span>
    </button>
    <Teleport to="body">
      <div v-if="open" class="gp-back" @click="close" />
      <section v-if="open" ref="pop" class="gp-pop" :style="pos" role="dialog" :aria-label="`공개 등급 — ${name}`" data-testid="grade-popover" @click.stop>
        <header class="hd">
          <h3>공개 등급<span v-if="name" class="nm"> · 「{{ name }}」</span></h3>
          <span class="sp" />
          <button class="x press" aria-label="닫기" @click="close">닫기</button>
        </header>
        <div class="cols">
          <div class="left">
            <div class="grades" role="radiogroup" aria-label="등급">
              <label v-for="g in GRADES" :key="g" class="grade" :class="['g-' + g, { on: draft.visibility === g, off: g === 'open' && sensitive }]" :data-grade="g">
                <input v-model="draft.visibility" type="radio" name="grade" :value="g" />
                <i class="gdot" />
                <span class="gt"><b>{{ GRADE[g] }}</b><small>{{ g === 'open' && sensitive ? '민감 항목은 전체 공개로 열 수 없습니다' : INFO[g] }}</small></span>
              </label>
            </div>
            <label class="reach">
              <span class="k">범위</span>
              <select v-model="draft.reach" :disabled="!wide(draft.visibility)" aria-label="범위" data-testid="grade-reach">
                <option v-for="(t, r) in REACH" :key="r" :value="r">{{ t }}</option>
              </select>
              <small>{{ wide(draft.visibility) ? (draft.visibility === 'open' ? '원문까지 볼 수 있는 사람' : '요약을 볼 수 있는 사람') : '이 등급에서는 범위를 쓰지 않습니다' }}</small>
            </label>
            <label class="purpose">
              <span class="k">한 줄 목적</span>
              <input v-model="draft.purpose" maxlength="120" placeholder="예: 경쟁 3사 가격 변화를 매주 추적" aria-label="한 줄 목적" data-testid="grade-purpose" />
              <small>제목과 함께 보입니다(비공개면 아무에게도 보이지 않음)</small>
            </label>
            <div class="sens" :class="'s-' + cur.sensitive" data-testid="grade-sensitive">
              <template v-if="cur.sensitive === 'proposed'">
                <span class="badge warn">민감 표시 제안</span>
                <small class="grow">인사·급여·계약·건강·개인 정보로 보입니다</small>
                <button class="b warn press" data-testid="sensitive-confirm" @click="mark('confirm')">승인</button>
                <button class="b ghost press" data-testid="sensitive-dismiss" @click="mark('dismiss')">무시</button>
              </template>
              <template v-else-if="cur.sensitive === 'confirmed'">
                <span class="badge bad">민감</span>
                <small class="grow">전체 공개 불가 · 자동 허용 제외 · 장·관리자에게도 제목만</small>
                <button class="b ghost press" @click="mark('clear')">표시 떼기</button>
              </template>
              <template v-else>
                <small class="grow dim">민감 표시 없음</small>
                <button class="b ghost press" @click="mark('mark')">민감 표시 붙이기</button>
              </template>
            </div>
          </div>
          <div class="right">
            <div class="ph"><h4>누가 무엇을 보게 되나</h4><i v-if="loading" class="spin" /><span class="sp" />
              <small v-if="pv && pv.next.label !== pv.current">{{ pv.current }} → <b>{{ pv.next.label }}</b></small></div>
            <div v-if="pv && !pv.in_org" class="nobody">조직도에 없어 나 말고는 아무에게도 보이지 않습니다</div>
            <div v-else-if="pv && draft.visibility === 'private'" class="nobody">나 말고는 아무에게도 보이지 않습니다 — 존재도 숨깁니다</div>
            <div v-else-if="pv" class="depths" data-testid="grade-preview">
              <div v-for="[k, t] in COLS" :key="k" class="dcol" :data-depth="k">
                <div class="dh"><b>{{ t }}</b><small>{{ pv[k].length }}명</small></div>
                <ul>
                  <li v-for="p in pv[k]" :key="p.id" :class="{ added: p.added }" :title="p.reason" :data-name="p.name">
                    <span class="pn">{{ p.name }}</span>
                    <span v-if="p.added" class="badge new">새로</span>
                    <span v-if="VIA[p.via]" class="badge" :class="p.via">{{ p.via === 'lead' ? p.reason : p.via === 'grant' ? p.reason.replace(/^허락\(|\)$/g, '') : VIA[p.via] }}</span>
                    <small class="tm">{{ p.team || '회사' }}</small>
                  </li>
                  <li v-if="!pv[k].length" class="none">없음</li>
                </ul>
              </div>
            </div>
            <small v-if="pv?.lost?.length" class="lost">덜 보게 됨: <span v-for="(p, i) in pv.lost" :key="p.id">{{ i ? ', ' : '' }}{{ p.name }}({{ DEPTH[p.from] }} → {{ DEPTH[p.to] === '없음' ? '숨김' : DEPTH[p.to] }})</span></small>
            <small class="note">제목은 비공개가 아니면 회사 전체에 보입니다. 장·관리자는 범위 밖이어도 요약까지 봅니다(민감 항목은 제목만). 원문은 범위 안(전체 공개)이나 허락받은 사람만.</small>
          </div>
        </div>
        <footer class="ft">
          <div v-if="err" class="msg err grow" role="alert" data-testid="grade-error">{{ err }}</div>
          <div v-else-if="blocked || (pv?.problem && dirty)" class="msg warn grow" data-testid="grade-warning">저장하면 거절됩니다: {{ pv?.problem || '민감 항목은 전체 공개로 열 수 없습니다' }}</div>
          <div v-else-if="done" class="msg ok grow" data-testid="grade-done">{{ done }}</div>
          <span v-else class="grow" />
          <button class="b ghost press" @click="close">닫기</button>
          <button class="b main press" :disabled="!dirty || saving" data-testid="grade-save" @click="save">{{ saving ? '저장 중…' : '저장' }}</button>
        </footer>
      </section>
    </Teleport>
  </span>
</template>

<style scoped>
.gp { display: inline-flex; flex: none; }
.gchip { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px; border-radius: 15px; font-size: 13px; white-space: nowrap;
  color: var(--text-primary); background: var(--field-bg); border: 1px solid var(--hairline); }
.gchip:hover, .gchip.on { border-color: var(--color-info); }
.compact .gchip { height: 28px; padding: 0 10px; font-size: 12.5px; }
.gdot { width: 9px; height: 9px; border-radius: 50%; flex: none; background: var(--text-tertiary); }
.g-listed .gdot { background: #9b8cff; }
.g-summary .gdot { background: var(--color-info); }
.g-open .gdot { background: var(--color-success); }
.badge { display: inline-flex; align-items: center; height: 18px; padding: 0 7px; border-radius: 9px; font-size: 11px; font-weight: 500; white-space: nowrap; background: var(--chip-bg); color: var(--text-secondary); }
.badge.bad { background: color-mix(in srgb, var(--color-error) 18%, transparent); color: var(--color-error); }
.badge.warn { background: rgba(230 126 34 / .18); color: #d9822b; }
.badge.new { background: color-mix(in srgb, var(--color-info) 20%, transparent); color: var(--color-info); }
.badge.lead, .badge.admin { background: rgba(155 140 255 / .2); color: #8b7cf0; }
.badge.grant { background: color-mix(in srgb, var(--color-success) 18%, transparent); color: var(--color-success); }

.gp-back { position: fixed; inset: 0; z-index: 90; background: rgba(0 0 0 / .18); }
.gp-pop { position: fixed; z-index: 91; overflow-y: auto; padding: 16px 18px; display: flex; flex-direction: column; gap: 12px; font-size: 14px; color: var(--text-primary);
  background: var(--regular-solid-bg); -webkit-backdrop-filter: blur(40px); backdrop-filter: blur(40px); border: 1px solid var(--hairline); border-radius: 22px; box-shadow: 0 24px 64px rgba(0 0 0 / .28); text-align: left; }
.hd { display: flex; align-items: center; gap: 8px; }
.hd h3 { margin: 0; font-size: 16px; font-weight: 600; }
.hd .nm { color: var(--text-secondary); font-weight: 400; }
.sp, .grow { flex: 1; }
.x { height: 30px; padding: 0 12px; border-radius: 15px; font-size: 13px; color: var(--text-secondary); background: var(--field-bg); }
.cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr); gap: 18px; }
.left, .right { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.grades { display: flex; flex-direction: column; gap: 5px; }
.grade { display: flex; align-items: flex-start; gap: 9px; padding: 8px 11px; border: 1px solid var(--hairline); border-radius: 12px; cursor: pointer; }
.grade input { width: auto; margin: 3px 0 0; accent-color: var(--color-info); }
.grade .gdot { margin-top: 5px; }
.grade.on { border-color: var(--color-info); background: color-mix(in srgb, var(--color-info) 10%, transparent); }
.grade.off { opacity: .55; }
.gt { display: flex; flex-direction: column; line-height: 1.35; }
.gt b { font-weight: 600; font-size: 14px; }
.gt small, .reach small, .purpose small { color: var(--text-secondary); font-size: 12.5px; }
.reach, .purpose { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.purpose { align-items: stretch; flex-direction: column; gap: 4px; }
.k { font-size: 13px; color: var(--text-secondary); flex: none; min-width: 34px; }
.reach select { width: 96px; height: 32px; border-radius: 10px; padding: 0 8px; background: var(--field-bg); border: 1px solid var(--hairline); color: var(--text-primary); }
.reach select:disabled { opacity: .5; }
.purpose input { height: 34px; border-radius: 10px; padding: 0 10px; background: var(--field-bg); border: 1px solid var(--hairline); color: var(--text-primary); font-size: 14px; outline: 0; }
.purpose input:focus { border-color: var(--color-info); }
.sens { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-radius: 12px; background: var(--field-bg); flex-wrap: wrap; }
.sens small { font-size: 12.5px; color: var(--text-secondary); }
.sens.s-proposed { background: rgba(230 126 34 / .14); }
.sens.s-confirmed { background: color-mix(in srgb, var(--color-error) 12%, transparent); }
.dim { color: var(--text-tertiary) !important; }
.ph { display: flex; align-items: center; gap: 8px; }
.ph h4 { margin: 0; font-size: 14px; font-weight: 600; }
.ph small { font-size: 12.5px; color: var(--text-secondary); }
.depths { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.dcol { border: 1px solid var(--hairline); border-radius: 12px; padding: 8px 9px; background: var(--field-bg); min-height: 112px; }
.dcol[data-depth="summary"] { background: color-mix(in srgb, var(--color-info) 9%, transparent); }
.dcol[data-depth="content"] { background: color-mix(in srgb, var(--color-success) 9%, transparent); }
.dh { display: flex; align-items: baseline; gap: 6px; margin-bottom: 6px; font-size: 13px; }
.dh small { color: var(--text-secondary); font-size: 12px; }
.dcol ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
.dcol li { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; font-size: 13.5px; }
.dcol li.added .pn { font-weight: 700; color: var(--color-info); }
.tm { flex-basis: 100%; margin-top: -3px; font-size: 11.5px; color: var(--text-tertiary); }
.none { color: var(--text-tertiary); font-size: 12.5px; }
.nobody { padding: 22px; text-align: center; border: 1px dashed var(--hairline); border-radius: 12px; color: var(--text-secondary); font-size: 13.5px; }
.lost { color: #d9822b; font-size: 12.5px; }
.note { color: var(--text-tertiary); font-size: 12px; line-height: 1.45; }
.ft { display: flex; align-items: center; gap: 8px; border-top: 1px solid var(--hairline); padding-top: 12px; }
.msg { font-size: 13.5px; }
.msg.err { color: var(--color-error); font-weight: 500; }
.msg.warn { color: #d9822b; }
.msg.ok { color: var(--color-success); }
.b { height: 34px; padding: 0 16px; border-radius: 17px; font-size: 14px; background: var(--field-bg); color: var(--text-primary); white-space: nowrap; }
.b.main { background: var(--ink); color: var(--ink-inverse); }
.b.main:disabled { opacity: .35; cursor: default; }
.b.ghost { background: transparent; color: var(--text-secondary); }
.b.warn { background: #d9822b; color: #fff; height: 28px; padding: 0 12px; font-size: 13px; }
.sens .b.ghost { height: 28px; padding: 0 10px; font-size: 13px; }
.spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--hairline); border-top-color: var(--color-info); animation: gp-spin .8s linear infinite; }
@keyframes gp-spin { to { transform: rotate(360deg); } }
@media (max-width: 760px) { .cols { grid-template-columns: 1fr; } }
</style>
