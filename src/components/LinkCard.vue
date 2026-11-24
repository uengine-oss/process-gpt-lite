<script setup>
// 링크 하나의 미리보기 카드(server lib/linkPreview.js): 화면에 들어올 때 묻고, 묻는 동안 뼈대, 못 만들면 아무것도 보이지 않는다.
// 그림이 넓으면(동영상 · 1.3:1 이상 · 가로 400px 이상) 위에 크게, 아니면 왼쪽에 작게. 누르면 새 탭에서 연다.
// 제목 · 설명 · 사이트 이름은 그 페이지의 글이라 번역하지 않는다(data-no-i18n). 그림은 referrer 없이 그 사이트에서 직접 읽는다.
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { loadPreview, knownPreview } from '../linkPreview.js'

const props = defineProps({ url: { type: String, required: true } })
const el = ref(null)
const known = knownPreview(props.url)
const state = ref(known === undefined ? 'idle' : 'done')
const p = ref(known || null)
const skeleton = ref(false)
const imgOk = ref(true)
const favOk = ref(true)
const wide = ref(false)
let io = null
let timer = null

async function load() {
  if (state.value !== 'idle') return
  state.value = 'loading'
  // a quick answer (a refused link, one read before) shows no flash of a skeleton
  timer = setTimeout(() => { if (state.value === 'loading') skeleton.value = true }, 120)
  p.value = await loadPreview(props.url)
  clearTimeout(timer)
  state.value = 'done'
}
onMounted(() => {
  if (state.value !== 'idle') return
  if (typeof IntersectionObserver === 'undefined') return load()
  io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); load() } }, { rootMargin: '200px 0px' })
  io.observe(el.value)
})
onBeforeUnmount(() => { io?.disconnect(); clearTimeout(timer) })

const showImg = computed(() => !!p.value?.image && imgOk.value)
const top = computed(() => {
  const c = p.value
  if (!c || !showImg.value) return false
  if (c.kind === 'video' || wide.value) return true
  return c.imageWidth >= 400 && c.imageWidth / (c.imageHeight || c.imageWidth) >= 1.3
})
// (size known only once the picture is there: a wide one moves to the top)
function sized(e) {
  const i = e.target
  if (i.naturalWidth >= 400 && i.naturalWidth / Math.max(1, i.naturalHeight) >= 1.3) wide.value = true
}
const title = computed(() => p.value?.title || p.value?.siteName || p.value?.domain || props.url)
const site = computed(() => {
  const s = p.value?.siteName, d = p.value?.domain
  return s && d && s.toLowerCase().replace(/^www\./, '') !== d.toLowerCase() ? `${s} · ${d}` : s || d || ''
})
</script>

<template>
  <div ref="el" class="lpw">
    <a v-if="state === 'done' && p" class="lp press" :class="{ top, video: p.kind === 'video', noimg: !showImg }" :href="url" target="_blank" rel="noopener noreferrer"
       data-test="link-card" :data-kind="p.kind" data-no-i18n>
      <span v-if="showImg" class="im">
        <img :src="p.image" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" @load="sized" @error="imgOk = false" />
        <span v-if="p.kind === 'video'" class="play" data-test="link-play" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.52.85l10.4-6.5a1 1 0 0 0 0-1.7L9.52 4.65A1 1 0 0 0 8 5.5z" /></svg>
        </span>
      </span>
      <span class="tx">
        <b class="ti" data-test="link-title">{{ title }}</b>
        <span v-if="p.description" class="de" data-test="link-desc">{{ p.description }}</span>
        <span class="si" data-test="link-site"><img v-if="p.favicon && favOk" :src="p.favicon" alt="" width="14" height="14" referrerpolicy="no-referrer" @error="favOk = false" /><span>{{ site }}</span></span>
      </span>
    </a>
    <span v-else-if="state === 'loading' && skeleton" class="lp sk" data-test="link-skeleton" aria-hidden="true">
      <span class="im" /><span class="tx"><i /><i /><i class="short" /></span>
    </span>
  </div>
</template>

<style scoped>
.lpw { display: block; width: 100%; min-height: 1px; }
.lp { display: flex; width: 100%; min-height: 84px; border-radius: 18px; overflow: hidden; background: var(--bubble-agent-bg); border: 1px solid var(--hairline);
  -webkit-backdrop-filter: blur(30px); backdrop-filter: blur(30px); color: var(--text-primary); text-decoration: none; text-align: left;
  box-shadow: 0 2px 12px rgba(0 0 0 / .06); animation: blur-in .4s var(--spring) both; transition: border-color .15s, scale .12s ease-out; }
.lp.noimg { min-height: 0; }
.lp:hover { border-color: var(--text-tertiary); }
.lp:focus-visible { outline: 2px solid var(--color-info); outline-offset: 2px; }
.im { position: relative; flex: none; width: 96px; align-self: stretch; background: var(--cell-bg); overflow: hidden; }
.im img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
.lp.top { flex-direction: column; }
.lp.top .im { width: 100%; aspect-ratio: 1.91 / 1; align-self: auto; }
.lp.top.video .im { aspect-ratio: 16 / 9; }
.play { position: absolute; left: 50%; top: 50%; translate: -50% -50%; width: 54px; height: 54px; border-radius: 50%; display: grid; place-items: center; color: #fff;
  background: rgba(0 0 0 / .55); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); box-shadow: 0 2px 14px rgba(0 0 0 / .3); }
.play svg { translate: 2px 0; }
.lp:not(.top) .play { width: 36px; height: 36px; }
.tx { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: 3px; padding: 10px 14px 11px; }
.ti { font-size: 14.5px; font-weight: 600; line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; word-break: keep-all; }
.de { font-size: 13px; line-height: 1.45; color: var(--text-secondary); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.si { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 12px; color: var(--text-tertiary); }
.si span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.si img { flex: none; width: 14px; height: 14px; border-radius: 3px; }
/* fetching: the card's shape, quietly shimmering */
.sk { animation: fade-in .3s both; box-shadow: none; }
.sk .im { width: 96px; }
.sk .tx { gap: 8px; }
.sk i { display: block; height: 11px; width: 90%; border-radius: 6px; background: linear-gradient(90deg, var(--cell-bg) 0%, var(--chip-bg) 50%, var(--cell-bg) 100%); background-size: 200% 100%; animation: shimmer 1.4s linear infinite; }
.sk i:first-child { width: 70%; height: 13px; }
.sk i.short { width: 40%; }
</style>
