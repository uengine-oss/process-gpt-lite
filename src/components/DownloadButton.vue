<script setup>
// The one 「내려받기」 (2026-11-26 사용자: 「… 각 툴들의 그 헤더 부분에 다운로드 받는 버튼이 있든 뭔가 조치가 있어야」 — spec file-download):
// the same down arrow and word in the header of every place a file opens — the document panel (IeumOffice · ArtCraft), the picture ·
// sound · video viewer, a folder's file, the workroom's file, a process map's document, a meeting's stage — right before 공유 where
// there is one, else before the size and close buttons. Where the header is narrow (a phone, a narrow panel) the word folds away and the
// arrow stays (aria-label · title 「내려받기」). It looks like the buttons beside it: the header gives it their class.
//   source({last}) → {url, name, type?, note?} — where the newest version is, asked at the press (a signed address is made then)
//   prepare() → {ok: true, version: 'saved' | 'current'} — an editor with unsaved edits saves first (said while it does) — or
//               {ok: false, why | text}: the person is offered the last saved version (source({last: true})), told the new edits are not in it
// What happened is said in a small bubble under the button (a phone shows no download bar of its own): 「내려받았어요 · 이름」, which
// version, or why not — and the file to open when the browser blocked a new tab. The bubble is drawn over the page, or over the panel
// that is in full screen (전체 화면 — only that element is shown then).
// A file chip that downloads (a step's output or a form's file no viewer here takes, a TIFF that cannot be drawn) is this button too: its
// look in the slot, its name in `label` (aria-label · title) — a refusal is said and a blocked tab is offered as a link the same way.
import { ref, nextTick, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'
import { saveFile } from '../download.js'
import { doneNote } from '../downloadPlan.js'

const props = defineProps({
  source: { type: [Function, Object], required: true },
  prepare: { type: Function, default: null },
  size: { type: Number, default: 15 },
  iconOnly: { type: Boolean, default: false },
  label: { type: String, default: '내려받기' },
})
const emit = defineEmits(['done'])
const btn = ref(null)
const bubble = ref(null)
const busy = ref(false)
const note = ref(null) // {kind: 'busy' | 'ok' | 'err' | 'offer' | 'link', text, href?}
const at = ref({ top: 0, right: 8 })
// where the bubble goes: the element in full screen (nothing else is drawn then), else the page
const host = ref('body')
const hostNow = () => document.fullscreenElement || 'body'
let timer = null

function place() {
  const r = btn.value?.getBoundingClientRect()
  if (r) at.value = { top: Math.round(r.bottom + 8), right: Math.max(8, Math.round(window.innerWidth - r.right)) }
}
function say(n, ms = 0) {
  clearTimeout(timer)
  host.value = hostNow()
  note.value = n
  place()
  if (ms) timer = setTimeout(() => { if (note.value === n) note.value = null }, ms)
  // the offer takes the focus (a keyboard reaches its two buttons)
  if (n?.kind === 'offer') nextTick(() => bubble.value?.querySelector('button')?.focus({ preventScroll: true }))
}
const hush = () => { clearTimeout(timer); note.value = null }

async function fetchAndSave({ last = false, version = 'current' } = {}) {
  const src = typeof props.source === 'function' ? await props.source({ last }) : props.source
  if (!src?.url) throw new Error('내려받을 파일을 찾지 못했어요.')
  const r = await saveFile(src)
  if (r.how === 'link') return say({ kind: 'link', text: '브라우저가 새 창을 막았어요 · 눌러서 여세요', href: r.href }, 15000)
  if (r.how === 'opened') return say({ kind: 'ok', text: `새 창에서 열었어요 — 거기서 저장하세요 · ${r.name}` }, 6000)
  say({ kind: 'ok', text: src.note || doneNote({ version, name: r.name }) }, version === 'current' && !src.note ? 3500 : 7000)
  emit('done', { ...r, version })
}
async function press() {
  if (busy.value) return
  busy.value = true
  hush()
  try {
    let version = 'current'
    if (props.prepare) {
      // (a document with nothing unsaved answers at once: nothing is said)
      const slow = setTimeout(() => say({ kind: 'busy', text: '내려받기 전에 저장하는 중…' }), 250)
      let p
      try { p = await props.prepare() } finally { clearTimeout(slow) }
      if (!p?.ok) {
        say({ kind: 'offer', text: p?.text || `저장하지 못했어요${p?.why ? ` (${p.why})` : ''}. 마지막으로 저장된 판을 내려받을까요? 방금 고친 내용은 들어 있지 않아요.` })
        return
      }
      version = p.version || 'current'
      if (note.value?.kind === 'busy') hush()
    }
    await fetchAndSave({ version })
  } catch (e) {
    say({ kind: 'err', text: `내려받지 못했어요 · ${e?.message || e}` }, 9000)
  } finally { busy.value = false }
}
async function takeLast() {
  hush()
  busy.value = true
  try { await fetchAndSave({ last: true, version: 'last' }) } catch (e) { say({ kind: 'err', text: `내려받지 못했어요 · ${e?.message || e}` }, 9000) } finally { busy.value = false }
}

// a press elsewhere puts the bubble away (the offer too: nothing is downloaded); Esc as well
function away(e) {
  if (!note.value || note.value.kind === 'busy') return
  if (bubble.value?.contains(e.target) || btn.value?.contains(e.target)) return
  hush()
}
const onKey = (e) => { if (e.key === 'Escape' && note.value && note.value.kind !== 'busy') { e.stopPropagation(); hush() } }
document.addEventListener('pointerdown', away, true)
document.addEventListener('keydown', onKey, true)
window.addEventListener('resize', place)
const onFs = () => { host.value = hostNow(); if (note.value) nextTick(place) }
document.addEventListener('fullscreenchange', onFs)
onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', onFs)
  clearTimeout(timer)
  document.removeEventListener('pointerdown', away, true)
  document.removeEventListener('keydown', onKey, true)
  window.removeEventListener('resize', place)
})
</script>

<template>
  <!-- one root (the button), so the header's own class and scoped look reach it; the bubble is drawn over the page (body) -->
  <button ref="btn" type="button" class="press dlb" :class="{ busy }" :disabled="busy" :aria-label="label" :title="label" :aria-busy="busy ? 'true' : 'false'"
    data-test="download" @click.stop="press">
    <slot><span class="ic"><Icon name="down" :size="size" /></span><span v-if="!iconOnly" class="t">{{ busy ? '받는 중…' : '내려받기' }}</span></slot>
    <Teleport :to="host">
      <div v-if="note" ref="bubble" class="dl-note" :class="note.kind" :style="{ top: `${at.top}px`, right: `${at.right}px` }"
        :role="note.kind === 'offer' ? 'alertdialog' : note.kind === 'err' ? 'alert' : 'status'" aria-live="polite" data-test="download-note" :data-kind="note.kind">
        <span v-if="note.kind === 'busy'" class="spin" aria-hidden="true" />
        <p>{{ note.text }}</p>
        <div v-if="note.kind === 'offer'" class="acts">
          <button type="button" class="press main" data-test="download-last" @click="takeLast">마지막 저장본 받기</button>
          <button type="button" class="press" data-test="download-cancel" @click="hush">취소</button>
        </div>
        <a v-else-if="note.kind === 'link'" class="go" :href="note.href" target="_blank" rel="noopener" @click="hush">열기</a>
      </div>
    </Teleport>
  </button>
</template>

<style scoped>
.dlb { display: inline-flex; align-items: center; gap: 5px; }
.dlb .ic { display: inline-flex; }
.dlb:disabled { cursor: progress; }
.dlb.busy .ic { animation: dl-bob 1s ease-in-out infinite; }
@keyframes dl-bob { 50% { transform: translateY(2px); opacity: .55; } }
/* a narrow header: the arrow alone (the word stays its name: aria-label · title) — inside a narrow panel (an editor's bar is a
   container) or on a phone-wide screen */
@container (max-width: 640px) { .dlb .t { display: none; } }
@media (max-width: 520px) { .dlb .t { display: none; } }
</style>

<style>
/* the bubble under the button: the same dark note in both themes, as the editors' own notices */
.dl-note { position: fixed; z-index: 1200; max-width: min(340px, calc(100vw - 16px)); display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px;
  padding: 9px 13px; border-radius: 12px; background: #1d1d1f; color: #fff; font-size: 13px; line-height: 1.45; box-shadow: 0 6px 22px rgba(0, 0, 0, .28);
  animation: dl-in .16s ease-out both; }
@keyframes dl-in { from { opacity: 0; transform: translateY(-4px); } }
.dl-note p { margin: 0; flex: 1 1 200px; min-width: 0; overflow-wrap: anywhere; }
.dl-note.ok { background: #2e7d32; }
.dl-note.err { background: #c62828; }
.dl-note.offer { background: #3a2f12; border: 1px solid rgba(255, 196, 107, .45); }
.dl-note .acts { display: flex; gap: 6px; flex: 1 1 100%; justify-content: flex-end; }
.dl-note .acts button { height: 30px; padding: 0 12px; border-radius: 15px; font-size: 13px; font-weight: 500; color: #fff; background: rgba(255, 255, 255, .14); }
.dl-note .acts button.main { background: #ffc46b; color: #2b1d00; font-weight: 600; }
.dl-note .go { color: #fff; font-weight: 600; text-decoration: underline; }
.dl-note .spin { width: 14px; height: 14px; flex: none; border-radius: 50%; border: 2px solid rgba(255, 255, 255, .3); border-top-color: #fff; animation: dl-spin .8s linear infinite; }
@keyframes dl-spin { to { transform: rotate(360deg); } }
</style>
