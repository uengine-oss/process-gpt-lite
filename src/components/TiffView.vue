<script setup>
// A TIFF — a fax above all — drawn by the app itself (src/tiff.js: the browser does not draw TIFF; 2026-11-25 「tif 파일을 웹에서 못
// 열어보나?」). Loaded only where a TIFF is shown (an async component), one page at a time, on a canvas:
//   thumb   — the first page, small (a chat's or a messenger's picture: MediaPreview.vue), with 「N쪽」 on it when it has more pages
//   viewer  — the app's viewer (MediaViewer.vue): ‹ 1 / 3 ›, the page fitted to the width of the screen but never wider than a page is read
//             (860 px) nor larger than it is; a press zooms in where it was pressed (and out again), ⌘/Ctrl + wheel or a trackpad pinch
//             zooms gradually; ← → turn the pages. A fax is tall and narrow (its 98 dpi rows are evened out: src/tiffCore.js), so it scrolls
//             down — on a phone it fits whole.
//   inline  — a shared folder's or a workroom's preview (files/FileView.vue): as the viewer, on the light page
// A file it cannot show says so calmly — 「이 TIFF 는 열 수 없어요 · 내려받기」, with why when it is known (too large, a kind it cannot draw).
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import Icon from './Icon.vue'
import { openTiff, draw } from '../tiff.js'
import { TIFF_REASON } from '../tiffCore.js'

const props = defineProps({
  src: { type: String, default: '' },
  name: { type: String, default: '' },
  mode: { type: String, default: 'viewer' }, // thumb | viewer | inline
})
const emit = defineEmits(['loaded', 'failed', 'dismiss'])
const READ_W = 860
const cv = ref(null)
const stage = ref(null)
const doc = ref(null)
const count = computed(() => doc.value?.pages?.length || 0)
const cur = ref(0)
const state = ref('loading') // loading · ok · error
const busy = ref(false)
const why = ref('')
const size = ref(null)        // the page on the canvas {width, height}
const scale = ref(1)          // 1: fitted
const stageW = ref(0)
let ticket = 0

const fitW = computed(() => (size.value ? Math.max(40, Math.min(stageW.value || READ_W, READ_W, size.value.width)) : 0))
const pageStyle = computed(() => (props.mode === 'thumb' || !fitW.value ? {} : { width: `${Math.round(fitW.value * scale.value)}px` }))

async function load() {
  const t = ++ticket
  state.value = 'loading'; why.value = ''; doc.value = null; size.value = null; cur.value = 0; scale.value = 1
  if (!props.src) return
  try {
    const d = await openTiff(props.src)
    if (t !== ticket) return
    doc.value = d
    await show(0)
  } catch (e) { if (t === ticket) fail(e) }
}
async function show(i) {
  const t = ticket
  if (!doc.value || i < 0 || i >= count.value) return
  busy.value = true
  try {
    const p = await doc.value.page(i, props.mode === 'thumb' ? { maxWidth: 480 } : {})
    if (t !== ticket) return
    await nextTick()
    if (!cv.value) return
    draw(cv.value, p)
    cur.value = i; size.value = { width: p.width, height: p.height }; scale.value = 1
    if (stage.value) { stage.value.scrollTop = 0; stage.value.scrollLeft = 0 }
    if (state.value !== 'ok') { state.value = 'ok'; emit('loaded') }
  } catch (e) { if (t === ticket) fail(e) } finally { if (t === ticket) busy.value = false }
}
function fail(e) {
  state.value = 'error'
  why.value = e?.fetch ? '' : TIFF_REASON[e?.code] || ''
  emit('failed', { code: e?.code || '', fetch: !!e?.fetch })
}
const go = (d) => { if (!busy.value) show(cur.value + d) }

// a press: zoomed in around where it was pressed, or back to fitting
function press(e) {
  if (props.mode === 'thumb' || state.value !== 'ok') return
  const el = stage.value, c = cv.value
  if (!el || !c) return
  const r = c.getBoundingClientRect(), s = el.getBoundingClientRect()
  const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height
  scale.value = scale.value > 1 ? 1 : Math.min(4, Math.max(2, size.value.width / fitW.value))
  nextTick(() => {
    el.scrollLeft = fx * c.offsetWidth - (e.clientX - s.left) + c.offsetLeft - el.clientLeft
    el.scrollTop = fy * c.offsetHeight - (e.clientY - s.top) + c.offsetTop - el.clientTop
  })
}
// ⌘/Ctrl + wheel (a trackpad pinch sends this too): gradually; a plain wheel scrolls the page
function wheel(e) {
  if (props.mode === 'thumb' || !(e.ctrlKey || e.metaKey) || state.value !== 'ok') return
  e.preventDefault()
  scale.value = Math.min(6, Math.max(1, scale.value * Math.exp(-e.deltaY / 300)))
}
function onKey(e) {
  if (props.mode !== 'viewer' || state.value !== 'ok' || e.metaKey || e.ctrlKey || e.altKey) return
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || '') || e.target?.isContentEditable) return
  if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); go(1) }
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(-1) }
}
let ro = null
onMounted(() => {
  load()
  window.addEventListener('keydown', onKey)
  if (stage.value) stageW.value = stage.value.clientWidth - 32
  if (stage.value && typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => { const el = stage.value; if (el) stageW.value = el.clientWidth - 32 })
    ro.observe(stage.value)
  }
})
onBeforeUnmount(() => { ticket++; window.removeEventListener('keydown', onKey); ro?.disconnect() })
watch(() => props.src, load)
</script>

<template>
  <div class="tv" :class="[mode, state, { zoom: scale > 1 }]" data-test="tiff-view" :data-mode="mode" :data-state="state" :data-pages="count" :data-page="cur + 1">
    <template v-if="mode === 'thumb'">
      <span v-if="state === 'loading'" class="ph shimmer-text" aria-hidden="true">TIFF</span>
      <canvas v-show="state === 'ok'" ref="cv" class="tthumb" data-test="tiff-page" :aria-label="name" role="img" />
      <span v-if="state === 'ok' && count > 1" class="pc" data-test="tiff-count">{{ count }}쪽</span>
    </template>
    <template v-else>
      <div ref="stage" class="tstage" @click.self="emit('dismiss')" @wheel="wheel">
        <p v-if="state === 'loading' && !size" class="msg shimmer-text" data-test="tiff-loading">불러오는 중…</p>
        <p v-else-if="state === 'error'" class="msg calm" role="status" data-test="tiff-error">
          <span>이 TIFF 는 열 수 없어요<template v-if="why"> · {{ why }}</template></span>
          <a :href="src" download target="_blank" rel="noopener" data-test="tiff-download"><Icon name="down" :size="13" /> 내려받기</a>
        </p>
        <canvas v-show="state !== 'error' && size" ref="cv" class="tpage" :class="{ dim: busy }" :style="pageStyle" data-test="tiff-page" role="img"
          :aria-label="`${name} ${cur + 1}쪽`" @click="press" />
      </div>
      <nav v-if="count > 1 && state !== 'error'" class="tnav" aria-label="쪽 넘기기" @click.self="emit('dismiss')">
        <button type="button" class="nb press" :disabled="cur === 0 || busy" aria-label="이전 쪽" data-test="tiff-prev" @click="go(-1)"><Icon name="chevron" :size="16" class="back" /></button>
        <span class="pos" data-test="tiff-pos" aria-live="polite">{{ cur + 1 }} / {{ count }}</span>
        <button type="button" class="nb press" :disabled="cur >= count - 1 || busy" aria-label="다음 쪽" data-test="tiff-next" @click="go(1)"><Icon name="chevron" :size="16" /></button>
      </nav>
    </template>
  </div>
</template>

<style scoped>
.tv { min-width: 0; }
/* ---------- thumb: as MediaPreview's picture — never wider than the column, never taller than a phone's third ---------- */
.tv.thumb { position: relative; display: block; line-height: 0; background: #fff; }
.tthumb { display: block; max-width: 100%; max-height: 260px; width: auto; height: auto; min-width: 48px; }
.ph { display: grid; place-items: center; width: 150px; height: 190px; font-size: 12px; font-weight: 600; letter-spacing: .08em; line-height: 1; color: #8a8f98; background: #f4f4f6; }
.pc { position: absolute; right: 6px; bottom: 6px; padding: 3px 7px; border-radius: 9px; font-size: 11px; font-weight: 600; line-height: 1.2; color: #fff; background: rgba(0, 0, 0, .62); }
/* ---------- viewer · inline ---------- */
.tv.viewer, .tv.inline { display: flex; flex-direction: column; min-height: 0; }
.tv.viewer { flex: 1 1 auto; }
.tv.inline { height: 100%; }
.tstage { flex: 1 1 auto; min-height: 0; overflow: auto; overscroll-behavior: contain; display: flex; padding: 4px 16px 12px; }
/* centred while it fits, scrollable from its edge when it does not (margin: auto); paper is white whatever the theme */
.tpage { margin: 0 auto auto; display: block; height: auto; max-width: none; background: #fff; border-radius: 4px; cursor: zoom-in;
  box-shadow: 0 1px 3px rgba(0, 0, 0, .25); transition: opacity .15s; }
.tv.zoom .tpage { cursor: zoom-out; }
.tpage.dim { opacity: .55; }
.msg { margin: auto; text-align: center; font-size: 14px; line-height: 1.5; }
.viewer .msg { color: rgba(255, 255, 255, .82); }
.inline .msg { color: inherit; opacity: .8; }
.calm { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 6px 10px; padding: 0 12px; }
.calm a { display: inline-flex; align-items: center; gap: 4px; height: 34px; padding: 0 14px; border-radius: 17px; font-weight: 500; text-decoration: none; color: inherit;
  background: rgba(127, 127, 127, .2); }
.tnav { flex: none; display: flex; align-items: center; justify-content: center; gap: 14px; padding: 6px 16px 2px; }
.nb { width: 40px; height: 40px; border-radius: 20px; display: grid; place-items: center; }
.viewer .nb { background: rgba(255, 255, 255, .14); color: #fff; }
.inline .nb { background: rgba(127, 127, 127, .16); color: inherit; }
.nb:disabled { opacity: .35; }
.nb .back { transform: rotate(180deg); }
.pos { min-width: 64px; text-align: center; font-size: 14px; font-weight: 500; font-variant-numeric: tabular-nums; }
.viewer .pos { color: #fff; }
</style>
