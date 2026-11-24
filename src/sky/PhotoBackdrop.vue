<script setup>
// The chosen background photo (stores/background.js) over the animated sky (SkyCanvas, which stays underneath: the default, and what
// shows again when a picture fails to load). A new photo is drawn on a layer of its own and fades in over the old one once it has
// loaded; a scrim tuned for the light and dark themes keeps the glass panels and the text over the page readable.
//   - the picture comes from the photo site's CDN at the width the window needs (srcset; a panorama is cover-fitted, so a tall window
//     asks for a wider file), never through this app's server, without a referrer
//   - data saving (Save-Data or a 2g/3g connection): the smallest width only
//   - reduced motion: no fade, no drift
//   - the credit (title · author · license · source) sits in the corner on a wide screen; on a phone it is in Home's panel
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { useBackground } from '../stores/background.js'
import { narrow } from '../viewport.js'

const bg = useBackground()
const layers = ref([]) // {key, photo, shown}
let seq = 0
const FADE = 1200
const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
const saveData = () => {
  const c = navigator.connection
  return !!(c && (c.saveData || /(^|-)2g$|^3g$/.test(c.effectiveType || '')))
}
const widths = (p) => Object.keys(p?.src || {}).map(Number).filter(Number.isFinite).sort((a, b) => a - b)
function srcset(p) {
  let ws = widths(p)
  if (saveData()) ws = ws.slice(0, 1)
  else if (narrow.value) ws = ws.filter((w) => w < 3840)
  return ws.map((w) => `${p.src[w]} ${w}w`).join(', ')
}
const fallbackSrc = (p) => { const ws = widths(p); return p.src[ws.find((w) => w >= 1280) || ws[ws.length - 1]] }
// cover-fit: the picture is as wide as the window, or as tall — then wider than the window by its ratio
const sizes = (p) => `max(100vw, ${Math.ceil(((p.width && p.height) ? p.width / p.height : 1.5) * 100)}vh)`

let timers = []
const later = (fn, ms) => { const t = setTimeout(fn, ms); timers.push(t) }
onBeforeUnmount(() => timers.forEach(clearTimeout))

watch(() => bg.photo, (p) => {
  if (!p) {
    for (const l of layers.value) l.shown = false
    later(() => { layers.value = layers.value.filter((l) => l.shown) }, reduced ? 0 : FADE)
    return
  }
  const same = layers.value.find((l) => l.photo.id === p.id)
  if (same) { layers.value = layers.value.filter((l) => l === same); return }
  layers.value = [...layers.value, { key: ++seq, photo: p, shown: false }]
}, { immediate: true })

function loaded(l) {
  if (!layers.value.includes(l)) return
  l.shown = true
  // the layers under it go once it has faded in
  later(() => { layers.value = layers.value.filter((x) => x === l || x.key > l.key) }, reduced ? 0 : FADE + 100)
}
function failed(l) {
  bg.markFailed(l.photo.id)
  layers.value = layers.value.filter((x) => x !== l)
}
const on = computed(() => layers.value.some((l) => l.shown))
const shown = computed(() => [...layers.value].reverse().find((l) => l.shown)?.photo || null)
</script>

<template>
  <div class="backdrop" :class="{ on, still: reduced }" aria-hidden="true" data-test="photo-backdrop" :data-photo="shown?.id || ''">
    <img v-for="l in layers" :key="l.key" class="ph" :class="{ shown: l.shown }" :data-id="l.photo.id"
      :src="fallbackSrc(l.photo)" :srcset="srcset(l.photo)" :sizes="sizes(l.photo)" alt="" referrerpolicy="no-referrer" decoding="async"
      :style="l.photo.color ? { backgroundColor: l.photo.color } : null" @load="loaded(l)" @error="failed(l)" />
    <div class="scrim" />
  </div>
  <!-- the photo's credit: a wide screen's corner (a phone shows it in Home's panel) -->
  <Transition name="fade">
    <p v-if="shown && !narrow" class="credit" data-test="bg-corner-credit" data-no-i18n>
      <a class="t" :href="shown.sourceUrl" target="_blank" rel="noopener noreferrer">{{ shown.title }}</a>
      <span class="rest"><span> · </span><a v-if="shown.authorUrl" :href="shown.authorUrl" target="_blank" rel="noopener noreferrer">{{ shown.author }}</a><span v-else>{{ shown.author }}</span><span> · </span><a v-if="shown.licenseUrl" :href="shown.licenseUrl" target="_blank" rel="noopener noreferrer">{{ shown.license }}</a><span v-else>{{ shown.license }}</span><span> · </span><a :href="shown.sourceUrl" target="_blank" rel="noopener noreferrer">{{ shown.sourceName }}</a></span>
    </p>
  </Transition>
</template>

<style scoped>
.backdrop { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
.ph { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0; transform: scale(1.03);
  transition: opacity 1.2s ease, transform 8s ease-out; }
.ph.shown { opacity: 1; transform: scale(1); }
/* the scrim: darker at the top (the bar) and the bottom (the composer, the clock) — tuned per theme */
.scrim { position: absolute; inset: 0; opacity: 0; transition: opacity 1.2s ease;
  background: linear-gradient(180deg, rgba(6 8 18 / .58) 0%, rgba(6 8 18 / .34) 28%, rgba(6 8 18 / .36) 62%, rgba(6 8 18 / .64) 100%); }
:root[data-theme="light"] .scrim {
  background: linear-gradient(180deg, rgba(248 249 252 / .5) 0%, rgba(248 249 252 / .2) 30%, rgba(248 249 252 / .24) 64%, rgba(248 249 252 / .55) 100%); }
.backdrop.on .scrim { opacity: 1; }
.backdrop.still .ph, .backdrop.still .scrim { transition: none; transform: none; }
@media (prefers-reduced-motion: reduce) { .ph, .scrim { transition: none; transform: none; } }

/* the title gives way first: the author, the license and the source always show */
.credit { position: fixed; z-index: 8; right: 12px; bottom: calc(env(safe-area-inset-bottom, 0px) + 2px); margin: 0; max-width: min(620px, 52vw); display: flex;
  font-size: 11px; line-height: 16px; color: var(--text-secondary); white-space: nowrap;
  text-shadow: 0 1px 2px rgba(0 0 0 / .25); opacity: .8; transition: opacity .2s; }
.credit .t { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.credit .rest { flex: none; }
:root[data-theme="light"] .credit { text-shadow: 0 1px 2px rgba(255 255 255 / .6); }
.credit:hover { opacity: 1; }
.credit a { color: inherit; text-decoration: none; }
.credit a:hover { text-decoration: underline; color: var(--text-primary); }
</style>
