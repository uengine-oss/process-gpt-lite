<script setup>
// 오늘의 배경 (Home's date · weather panel, server lib/background): the plain sky first, then the day's photos — the solar term, the
// part of the day, today's weather, the season, the day's picture and a striking landscape — each with its theme under it. A mood
// chip asks for photos of that mood first. Tapping one makes it this person's background at once (stores/background.js); 「오늘만」
// · 「계속 두기」 says how long it stays, and the chosen photo's credit (title · author · license · source) is always shown under the strip.
import { computed, watch, nextTick, ref } from 'vue'
import { useBackground, MOODS } from '../stores/background.js'
import { useSky } from '../stores/sky.js'

const bg = useBackground()
const sky = useSky()
const strip = ref(null)


// the sky tile: today's sky colours as they are drawn now
const rgb = (c) => `rgb(${c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255)).join(' ')})`
const skySwatch = computed(() => { const p = sky.palette; return { background: `linear-gradient(180deg, ${rgb(p.zenith)} 0%, ${rgb(p.horizon)} 100%)` } })
const chosen = computed(() => bg.current?.id || null)
const failedNote = computed(() => !!bg.current && !!bg.failed[bg.current.id])
const thumbBroken = ref({})

// the chosen tile in view when the strip first shows — the strip scrolls sideways, never the Home list up or down
watch(() => bg.list.length, async (n) => {
  if (!n || !chosen.value) return
  await nextTick()
  const el = strip.value
  const tile = el?.querySelector('[aria-pressed="true"]')
  if (el && tile && (tile.offsetLeft < el.scrollLeft || tile.offsetLeft + tile.offsetWidth > el.scrollLeft + el.clientWidth)) el.scrollLeft = tile.offsetLeft - 16
})
</script>

<template>
  <section class="bgp" data-test="bg-picker">
    <div class="bh">
      <b>오늘의 배경</b>
      <div class="moods" role="group" aria-label="무드">
        <button v-for="m in MOODS" :key="m.key" class="chip press" :class="{ on: bg.mood === m.key }" :aria-pressed="bg.mood === m.key"
          :data-test="`bg-mood-${m.key}`" @click="bg.setMood(m.key)">{{ m.label }}</button>
      </div>
    </div>
    <div ref="strip" class="strip" data-test="bg-strip">
      <button class="tile press" data-test="bg-tile" data-id="sky" :aria-pressed="!chosen" :class="{ on: !chosen }" @click="bg.toSky()">
        <span class="pic" :style="skySwatch" />
        <span class="lbl">하늘</span>
      </button>
      <button v-for="c in bg.list" :key="c.id" class="tile press" data-test="bg-tile" :data-id="c.id" :aria-pressed="chosen === c.id"
        :class="{ on: chosen === c.id }" :title="`${c.title} · ${c.author}`" @click="bg.pick(c)">
        <span class="pic" :style="c.color ? { backgroundColor: c.color } : null">
          <img v-if="!thumbBroken[c.id]" :src="c.thumb" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" @error="thumbBroken = { ...thumbBroken, [c.id]: true }" />
        </span>
        <span class="lbl" data-no-i18n>{{ c.label }}</span>
      </button>
      <template v-if="bg.loading && !bg.list.length">
        <span v-for="i in 5" :key="'s' + i" class="tile skel" aria-hidden="true"><span class="pic" /><span class="lbl" /></span>
      </template>
    </div>
    <div v-if="bg.current" class="bf">
      <div class="keep" role="group" aria-label="얼마나 둘까요">
        <button :class="{ on: bg.keep === 'today' }" :aria-pressed="bg.keep === 'today'" data-test="bg-keep-today" @click="bg.setKeep('today')">오늘만</button>
        <button :class="{ on: bg.keep === 'always' }" :aria-pressed="bg.keep === 'always'" data-test="bg-keep-always" @click="bg.setKeep('always')">계속 두기</button>
      </div>
      <div class="credit" data-test="bg-credit" data-no-i18n>
        <a class="ct" :href="bg.current.sourceUrl" target="_blank" rel="noopener noreferrer" data-test="bg-credit-title">{{ bg.current.title }}</a>
        <span class="cm">
          <a v-if="bg.current.authorUrl" class="au" :href="bg.current.authorUrl" target="_blank" rel="noopener noreferrer">{{ bg.current.author }}</a><span v-else class="au">{{ bg.current.author }}</span>
          <span class="dot">·</span><a v-if="bg.current.licenseUrl" :href="bg.current.licenseUrl" target="_blank" rel="noopener noreferrer" data-test="bg-credit-license">{{ bg.current.license }}</a><span v-else data-test="bg-credit-license">{{ bg.current.license }}</span>
          <span class="dot">·</span><a :href="bg.current.sourceUrl" target="_blank" rel="noopener noreferrer">{{ bg.current.sourceName }}</a>
        </span>
      </div>
    </div>
    <p v-if="failedNote" class="note" data-test="bg-failed">사진을 불러오지 못해 하늘을 보여 드려요.</p>
    <p v-else-if="bg.error" class="note" data-test="bg-error">{{ bg.error }}</p>
    <p v-else-if="!bg.loading && bg.loadedKey && !bg.list.length" class="note" data-test="bg-empty">지금은 추천 사진을 가져오지 못했어요. 하늘은 그대로 고를 수 있어요.</p>
  </section>
</template>

<style scoped>
.bgp { margin-top: 14px; }
.bh { display: flex; align-items: center; gap: 8px; margin: 0 6px 10px; min-width: 0; }
.bh b { font-weight: 500; font-size: 15px; white-space: nowrap; }
.moods { margin-left: auto; display: flex; gap: 4px; flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; }
.moods::-webkit-scrollbar { display: none; }
.chip { height: 26px; padding: 0 10px; border-radius: 13px; background: var(--cell-bg); color: var(--text-secondary); font-size: 12.5px; white-space: nowrap; flex: none; transition: background-color .2s, color .2s; }
.chip.on { background: var(--ink); color: var(--ink-inverse); }
/* the strip scrolls sideways inside the panel (to its edges), never the page */
.strip { position: relative; display: flex; gap: 8px; overflow-x: auto; overflow-y: hidden; margin: 0 -16px; padding: 2px 16px 4px; scroll-snap-type: x proximity;
  scroll-padding: 0 16px; overscroll-behavior-x: contain; scrollbar-width: none; -webkit-overflow-scrolling: touch; }
.strip::-webkit-scrollbar { display: none; }
.tile { flex: none; width: 92px; display: flex; flex-direction: column; gap: 6px; text-align: left; scroll-snap-align: start; color: var(--text-primary); }
.pic { position: relative; display: block; width: 92px; height: 62px; border-radius: 12px; overflow: hidden; background: var(--cell-bg);
  box-shadow: inset 0 0 0 1px var(--hairline); transition: box-shadow .2s; }
.pic img { width: 100%; height: 100%; object-fit: cover; display: block; }
.tile.on .pic { box-shadow: 0 0 0 2px var(--ink), inset 0 0 0 1px var(--hairline); }
.lbl { font-size: 12px; line-height: 1.3; color: var(--text-secondary); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; word-break: keep-all; min-height: 2.6em; }
.tile.on .lbl { color: var(--text-primary); }
.skel .pic, .skel .lbl { background: linear-gradient(90deg, var(--cell-bg) 0%, var(--field-bg) 50%, var(--cell-bg) 100%); background-size: 200% 100%; animation: shimmer 1.6s linear infinite; }
.skel .lbl { height: 12px; min-height: 0; border-radius: 6px; width: 70%; }
/* under the strip: how long it stays, then the chosen photo's credit across the panel */
.bf { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; margin: 10px 6px 0; min-width: 0; }
.bf .credit { align-self: stretch; }
.keep { flex: none; display: inline-flex; padding: 2px; border-radius: 15px; background: var(--cell-bg); }
.keep button { height: 26px; padding: 0 10px; border-radius: 13px; font-size: 12.5px; color: var(--text-secondary); white-space: nowrap; }
.keep button.on { background: var(--ink); color: var(--ink-inverse); }
/* the credit: the title on one line, then author · license · source (the author gives way first — the license and the source
   always show) */
.credit { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; font-size: 11.5px; line-height: 1.4; color: var(--text-secondary); }
.credit a { color: var(--text-secondary); text-decoration: none; }
.credit a:hover { text-decoration: underline; }
.credit .ct { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.credit .cm { display: flex; min-width: 0; white-space: nowrap; }
.credit .cm > * { flex: none; }
.credit .cm .au { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.credit .dot { margin: 0 4px; }
.note { margin: 8px 6px 0; font-size: 12.5px; color: var(--text-tertiary); }
@media (prefers-reduced-motion: reduce) { .skel .pic, .skel .lbl { animation: none; } }
</style>
