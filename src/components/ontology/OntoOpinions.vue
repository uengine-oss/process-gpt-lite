<script setup>
// 의견 · 해소(지도 오른쪽 패널): 한 프로세스에 남은 의견. 엇갈린 의견(해소 필요)이 먼저 — 의견들을 나란히(누가 · 역할 · 한 말 · 언제 ·
// 어디서: 지도 · 채팅 · 건의 단계, 같은 의견 N명)와 이미 정한 것 — 다음에 엇갈리지 않은 의견, 맨 아래 접힌 「닫힌 의견」.
// 의견을 고르면 지도가 그 의견의 고친 뒤를 그린다(GET /ontology/opinions/:id/preview → preview), 엇갈린 의견은 「‹ ›」로 넘겨 본다.
// 관리자: 엇갈린 의견 → 「이 의견으로」 · 「말로 정리하기」(지도의 입력 칸을 그 단계들로 열어 준다 → speak) · 「그대로 두기」(메모 꼭),
// 다른 의견 → 「적용」 · 「거절」(메모 꼭). 해소는 POST /ontology/processes/:proc/opinions/resolve → 새 보기(changed).
// 다른 사람은 읽기만. 의견은 열려 있는 동안 아무것도 바꾸지 않는다(진행 중인 건도 그대로).
import { ref, reactive, computed } from 'vue'
import OntoChangeList from './OntoChangeList.vue'
import { api } from '../../api.js'
import { dateTimeKo } from './fmt.js'

const props = defineProps({
  view: { type: Object, default: null }, // GET /ontology/processes/:proc/opinions
  proc: { type: Object, required: true },
  admin: Boolean,
  call: { type: Function, default: api },
  current: { type: String, default: '' }, // the opinion the map previews
  error: { type: String, default: '' },
})
const emit = defineEmits(['preview', 'changed', 'speak'])

const conflicts = computed(() => props.view?.conflicts || [])
const open = computed(() => props.view?.open || [])
const closed = computed(() => props.view?.closed || [])
const busy = ref('')
const err = ref('')
const done = ref(null) // {action, text}
const notes = reactive({}) // conflict id | opinion id → 메모
const shown = ref(null) // the preview's changes for the current opinion
const SOURCE = { map: '지도', chat: '채팅', step: '건의 단계' }
const STATE = { applied: '적용함', declined: '거절함', merged: '말로 정리함', superseded: '다른 의견으로 정함' }
const DECIDED = { correction: '고친 것', requirement: '단계 규칙', pin: '고정' }
function sourceText(o) {
  const s = SOURCE[o.source] || o.source || ''
  if (o.source !== 'step') return s
  return [s, o.task && `「${o.task}」`, o.caseId && `건 ${String(o.caseId).replace(/^case-/, '')}`].filter(Boolean).join(' · ')
}
const whoText = (o) => `${o.who?.name || '누군가'}${o.who?.role ? ` · ${o.who.role}` : ''}`

// ---------- 미리 보기 ----------
async function show(o) {
  if (props.current === o.id) { emit('preview', null); shown.value = null; return }
  busy.value = `pv:${o.id}`; err.value = ''
  try {
    const r = await props.call(`/ontology/opinions/${encodeURIComponent(o.id)}/preview`)
    shown.value = { id: o.id, changes: r.changes || [], refused: r.refused || [] }
    emit('preview', { id: o.id, before: r.before || null, after: r.after })
  } catch (e) { err.value = e.message } finally { busy.value = '' }
}
// 「‹ ›」: the next option of a conflict on the map
function flip(c, k) {
  const list = c.opinions, n = list.length
  const i = list.findIndex((o) => o.id === props.current)
  const o = list[i < 0 ? (k > 0 ? 0 : n - 1) : (i + k + n) % n]
  if (o && o.id !== props.current) show(o)
}
const at = (c) => Math.max(0, c.opinions.findIndex((o) => o.id === props.current))
const inConflict = (c) => c.opinions.some((o) => o.id === props.current)

// ---------- 해소 ----------
const DONE = {
  apply: '적용했어요. 지도에 바로 반영했어요.',
  decline: '거절했어요.',
  keep: '그대로 두기로 했어요. 엇갈린 의견은 닫혔어요.',
}
async function resolve(body, key) {
  busy.value = key; err.value = ''
  try {
    const r = await props.call(`/ontology/processes/${encodeURIComponent(props.proc.key)}/opinions/resolve`, { method: 'POST', body })
    done.value = { action: body.action, text: DONE[body.action] || '' }
    shown.value = null
    emit('changed', r, body)
  } catch (e) { err.value = e.message } finally { busy.value = '' }
}
const note = (id) => String(notes[id] || '').trim()
const ids = (c) => c.opinions.map((o) => o.id)
const pick = (c, o) => resolve({ action: 'apply', opinion: o.id, opinions: ids(c), note: note(c.id) }, `apply:${o.id}`)
const keep = (c) => resolve({ action: 'keep', opinions: ids(c), note: note(c.id) }, `keep:${c.id}`)
const applyOne = (o) => resolve({ action: 'apply', opinion: o.id, note: note(o.id) }, `apply:${o.id}`)
const decline = (o) => resolve({ action: 'decline', opinion: o.id, note: note(o.id) }, `decline:${o.id}`)
const speak = (c) => emit('speak', { conflict: c, opinions: ids(c), note: note(c.id) })
const empty = computed(() => props.view && !conflicts.value.length && !open.value.length)
</script>

<template>
  <div class="oop" data-testid="onto-opinions" :data-conflicts="conflicts.length" :data-open="open.length" :data-admin="admin ? '1' : '0'">
    <p v-if="!view && !error" class="muted pulse">불러오는 중…</p>
    <p v-else-if="!view" class="err">{{ error }}</p>
    <template v-else>
      <p class="sum">
        <b v-if="conflicts.length" class="cf">해소 필요 {{ conflicts.length }}</b>
        <span>남은 의견 {{ view.counts?.open ?? open.length }}</span>
        <span v-if="!admin" class="ro" data-testid="onto-opinions-readonly">정하는 것은 관리자가 해요</span>
      </p>
      <p class="muted">의견은 정하기 전까지 지도도, 진행 중인 건도 바꾸지 않아요. 의견을 누르면 지도에 그 의견대로 고친 모습을 그려요.</p>
      <div v-if="done" class="done" data-testid="onto-opinions-done" :data-action="done.action">
        <span>{{ done.text }}</span>
        <small v-if="done.action === 'apply'">고친 기록에서 되돌려도 의견은 다시 열리지 않아요</small>
      </div>
      <p v-if="empty" class="muted" data-testid="onto-opinions-empty">이 프로세스에는 남은 의견이 없어요. 지도에서 말로 고치려다 「의견으로 남기기」를 누르거나, 건의 단계에서 「이 단계에 의견」을 누르면 여기 모여요.</p>

      <!-- 해소 필요 -->
      <section v-for="c in conflicts" :key="c.id" class="conf" data-testid="onto-opinion-conflict" :data-id="c.id">
        <header>
          <b class="tag">해소 필요</b>
          <span class="sp" />
          <span class="flip" :class="{ on: inConflict(c) }">
            <button class="fb press" aria-label="앞 의견" :disabled="!!busy" data-testid="onto-opinion-prev" @click="flip(c, -1)">‹</button>
            <small>{{ inConflict(c) ? at(c) + 1 : '–' }}/{{ c.opinions.length }}</small>
            <button class="fb press" aria-label="다음 의견" :disabled="!!busy" data-testid="onto-opinion-next" @click="flip(c, 1)">›</button>
          </span>
        </header>
        <p v-for="(w, i) in c.why || []" :key="i" class="why">{{ w }}</p>
        <div class="opts">
          <article v-for="o in c.opinions" :key="o.id" class="op" :class="{ cur: current === o.id }" data-testid="onto-opinion" :data-id="o.id" :data-current="current === o.id ? '1' : null">
            <button class="ob" type="button" :aria-pressed="current === o.id" title="지도에서 이 의견대로 보기" data-testid="onto-opinion-show" @click="show(o)">
              <span class="who"><b>{{ whoText(o) }}</b></span>
              <q>{{ o.words }}</q>
              <small class="meta">{{ dateTimeKo(o.at) }} · {{ sourceText(o) }}</small>
              <small v-if="o.agree > 1" class="agree" :title="(o.agreeWho || []).join(', ')" data-testid="onto-opinion-agree">같은 의견 {{ o.agree }}명</small>
            </button>
            <button v-if="admin" class="pick press" :disabled="!!busy" data-testid="onto-opinion-pick" @click="pick(c, o)">{{ busy === `apply:${o.id}` ? '적용하는 중…' : '이 의견으로' }}</button>
          </article>
        </div>
        <OntoChangeList v-if="shown && inConflict(c)" class="pv" :plan="shown" />
        <div v-if="c.decided?.length" class="dec">
          <small class="cap">이미 정한 것</small>
          <ul><li v-for="(d, i) in c.decided" :key="i"><span class="dk">{{ DECIDED[d.kind] || d.kind }}</span>{{ d.label }}<small> · {{ d.by }}<template v-if="d.why"> — {{ d.why }}</template></small></li></ul>
        </div>
        <div v-if="admin" class="acts">
          <input v-model="notes[c.id]" class="in" maxlength="300" placeholder="메모 — 그대로 둘 때는 꼭 적어요" data-testid="onto-opinion-note" />
          <div class="btns">
            <button class="pill press" :disabled="!!busy" data-testid="onto-opinion-speak" @click="speak(c)">말로 정리하기</button>
            <button class="ghost press" :disabled="!!busy || !note(c.id)" :title="note(c.id) ? '' : '메모를 적어 주세요'" data-testid="onto-opinion-keep" @click="keep(c)">{{ busy === `keep:${c.id}` ? '정하는 중…' : '그대로 두기' }}</button>
          </div>
        </div>
      </section>

      <!-- 엇갈리지 않은 의견 -->
      <section v-if="open.length" class="list">
        <h4>의견 <small>{{ open.length }}</small></h4>
        <article v-for="o in open" :key="o.id" class="op one" :class="{ cur: current === o.id }" data-testid="onto-opinion" :data-id="o.id" :data-current="current === o.id ? '1' : null">
          <button class="ob" type="button" :aria-pressed="current === o.id" title="지도에서 이 의견대로 보기" data-testid="onto-opinion-show" @click="show(o)">
            <span class="who"><b>{{ whoText(o) }}</b><small v-if="o.agree > 1" class="agree" :title="(o.agreeWho || []).join(', ')" data-testid="onto-opinion-agree">같은 의견 {{ o.agree }}명</small></span>
            <q>{{ o.words }}</q>
            <small class="meta">{{ dateTimeKo(o.at) }} · {{ sourceText(o) }}</small>
          </button>
          <OntoChangeList v-if="shown && current === o.id" class="pv" :plan="shown" />
          <div v-if="admin" class="acts">
            <input v-model="notes[o.id]" class="in" maxlength="300" placeholder="메모 — 거절할 때는 꼭 적어요" data-testid="onto-opinion-note" />
            <div class="btns">
              <button class="go press" :disabled="!!busy" data-testid="onto-opinion-apply" @click="applyOne(o)">{{ busy === `apply:${o.id}` ? '적용하는 중…' : '적용' }}</button>
              <button class="ghost press" :disabled="!!busy || !note(o.id)" :title="note(o.id) ? '' : '메모를 적어 주세요'" data-testid="onto-opinion-decline" @click="decline(o)">{{ busy === `decline:${o.id}` ? '거절하는 중…' : '거절' }}</button>
            </div>
          </div>
        </article>
      </section>

      <!-- 닫힌 의견 -->
      <details v-if="closed.length" class="closed" data-testid="onto-opinions-closed">
        <summary>닫힌 의견 <small>{{ closed.length }}</small></summary>
        <ul>
          <li v-for="o in closed" :key="o.id" :data-state="o.state" data-testid="onto-opinion-closed">
            <span class="st" :class="o.state">{{ STATE[o.state] || o.state }}</span>
            <q>{{ o.words }}</q>
            <small class="meta">{{ whoText(o) }} · {{ dateTimeKo(o.at) }} · {{ sourceText(o) }}</small>
            <small v-if="o.note" class="nt">{{ o.note }}</small>
            <small v-if="o.state === 'applied' || o.state === 'merged'" class="undo">고친 기록에서 되돌려도 의견은 다시 열리지 않아요</small>
          </li>
        </ul>
      </details>
    </template>
    <small v-if="err" class="err" data-testid="onto-opinions-error">{{ err }}</small>
  </div>
</template>

<style scoped>
.oop { --conf: #e8590c; display: flex; flex-direction: column; gap: 12px; min-width: 0; word-break: keep-all; overflow-wrap: anywhere; }
.muted { margin: 0; font-size: 12.5px; color: var(--text-secondary); line-height: 1.5; }
.err { margin: 0; font-size: 12.5px; color: var(--color-error); }
.sum { margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; font-size: 13px; color: var(--text-secondary); }
.sum .cf { color: var(--conf); font-weight: 700; }
.ro { font-size: 12px; color: var(--text-tertiary); }
.done { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border-radius: 12px; background: var(--field-bg); font-size: 13px; }
.done small { font-size: 12px; color: var(--text-secondary); }
section { display: flex; flex-direction: column; gap: 8px; }
.conf { padding: 10px; border-radius: 16px; box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--conf) 55%, transparent); background: color-mix(in srgb, var(--conf) 5%, transparent); }
.conf header { display: flex; align-items: center; gap: 6px; }
.tag { font-size: 11px; font-weight: 700; padding: 1px 8px; border-radius: 9999px; background: var(--conf); color: #fff; }
.sp { flex: 1; }
.flip { display: inline-flex; align-items: center; gap: 2px; padding: 1px; border-radius: 9999px; background: var(--field-bg); color: var(--text-secondary); }
.flip small { min-width: 30px; text-align: center; font-size: 11.5px; font-variant-numeric: tabular-nums; }
.flip.on { color: var(--text-primary); }
.fb { width: 26px; height: 24px; border-radius: 12px; font-size: 16px; line-height: 1; color: inherit; }
.fb:disabled { opacity: .4; }
.why { margin: 0; font-size: 12.5px; line-height: 1.5; color: var(--text-secondary); }
.opts { display: grid; grid-template-columns: repeat(auto-fit, minmax(128px, 1fr)); gap: 6px; }
.op { display: flex; flex-direction: column; gap: 4px; padding: 9px 10px; border-radius: 13px; background: var(--regular-solid-bg); box-shadow: inset 0 0 0 1px var(--hairline); min-width: 0; }
.op:hover { box-shadow: inset 0 0 0 1px var(--text-tertiary); }
.op.cur, .op:has(.ob:focus-visible) { box-shadow: inset 0 0 0 2px #5468ff; }
.ob { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; padding: 0; text-align: left; color: inherit; outline: none; min-width: 0; }
.who { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; font-size: 12.5px; }
.who b { font-weight: 600; }
.op q { font-size: 13px; line-height: 1.5; color: var(--text-primary); quotes: '「' '」'; }
.meta { font-size: 11.5px; color: var(--text-tertiary); line-height: 1.45; }
.agree { font-size: 11.5px; font-weight: 600; color: var(--color-info); }
.pick { align-self: flex-start; margin-top: 2px; height: 28px; padding: 0 11px; border-radius: 9999px; font-size: 12.5px; font-weight: 600; background: var(--ink); color: var(--text-primary-on); white-space: nowrap; }
.pick:disabled { opacity: .45; }
.pv { padding: 8px 10px; border-radius: 12px; background: var(--field-bg); }
.dec { display: flex; flex-direction: column; gap: 3px; }
.cap { font-size: 11.5px; color: var(--text-tertiary); }
.dec ul, .closed ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.dec li { font-size: 12.5px; line-height: 1.5; }
.dec li small { color: var(--text-secondary); }
.dk { margin-right: 6px; font-size: 11px; font-weight: 600; padding: 0 7px; border-radius: 9999px; background: var(--field-bg); color: var(--text-secondary); }
.acts { display: flex; flex-direction: column; gap: 6px; cursor: default; }
.in { height: 32px; padding: 0 11px; border-radius: 11px; border: 0; outline: 0; background: var(--field-bg); font-size: 13px; color: var(--text-primary); min-width: 0; }
.in::placeholder { color: var(--text-tertiary); }
.btns { display: flex; gap: 6px; flex-wrap: wrap; }
.go { height: 30px; padding: 0 14px; border-radius: 9999px; font-size: 13px; font-weight: 600; background: var(--ink); color: var(--text-primary-on); }
.pill { height: 30px; padding: 0 12px; border-radius: 9999px; font-size: 13px; font-weight: 500; background: var(--field-bg); color: var(--text-primary); }
.ghost { height: 30px; padding: 0 10px; border-radius: 9999px; font-size: 13px; color: var(--text-secondary); box-shadow: inset 0 0 0 1px var(--hairline); }
.go:disabled, .pill:disabled, .ghost:disabled { opacity: .45; cursor: default; }
h4 { margin: 4px 0 0; font-size: 13.5px; font-weight: 600; }
h4 small { margin-left: 4px; font-size: 12px; font-weight: 400; color: var(--text-tertiary); }
.op.one .acts { margin-top: 4px; }
.closed summary { cursor: pointer; font-size: 13px; font-weight: 600; color: var(--text-secondary); }
.closed summary small { margin-left: 4px; font-weight: 400; color: var(--text-tertiary); }
.closed ul { margin-top: 8px; }
.closed li { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border-radius: 12px; background: var(--field-bg); }
.closed q { font-size: 12.5px; line-height: 1.5; quotes: '「' '」'; }
.st { align-self: flex-start; font-size: 11px; font-weight: 600; padding: 0 7px; border-radius: 9999px; background: var(--regular-solid-bg); color: var(--text-secondary); }
.st.applied, .st.merged { color: var(--color-success); }
.nt { font-size: 12px; color: var(--text-secondary); }
.undo { font-size: 11.5px; color: var(--text-tertiary); }
</style>
