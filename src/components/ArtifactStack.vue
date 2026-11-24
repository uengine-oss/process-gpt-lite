<script setup>
// The files made in the view on screen — the whole chat, one conversation of it, a project's room (app.artifacts, src/artifactScope.js)
// — piled like a macOS Dock stack: closed, the newest few float in a little pile; open, they fan out upward (a grid when there are
// many) and each opens where its chat card would (artifacts.js). Where the page has room beside the chat the same files are a list
// in the right column instead (ArtifactList.vue); the pile is for narrower pages and phones. It sits beside the composer, or above
// it, never over it (place: src/artifactScope.js pilePlace, from the composer's box).
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { useApp } from '../stores/app.js'
import { kindOf, kindLabel, openArtifact } from '../artifacts.js'
import { CAPTION } from '../artifactScope.js'
import ShareButton from './team/ShareButton.vue'
import { useTeam } from '../stores/team.js'
// each file (and the closed pile, all of them) is dragged like any file of the app (src/fileDrag.js): a messenger conversation, a folder,
// the composer
import { startDrag, cardItem, MAX } from '../fileDrag.js'

const props = defineProps({ place: { type: Object, default: () => ({ mode: 'beside', size: 64, right: 28, bottom: 112 }) } })
const app = useApp()
const team = useTeam()
const router = useRouter()
const open = ref(false)
// the fan rises from the pile toward the top bar; past what fits (or 8) it becomes a grid
const STEP = 54
const fanMax = ref(8)
const fit = () => { fanMax.value = Math.max(3, Math.min(8, Math.floor((window.innerHeight - 300) / STEP))) }
fit()
window.addEventListener('resize', fit)

const items = computed(() => app.artifacts.items.map((x) => x.msg))
const caption = computed(() => CAPTION[app.artifacts.scope] || '산출물')
const small = computed(() => props.place.size < 64)
const pile = computed(() => items.value.slice(0, 3).reverse())
const grid = computed(() => items.value.length > fanMax.value)

// the fan bends left as it rises, like the Dock's
const fanStyle = (i) => ({
  transform: `translate(${-(i * i) * 2.2}px, ${-(i + 1) * STEP}px) rotate(${-i * 1.6}deg)`,
  transitionDelay: `${i * 28}ms`,
  animationDelay: `${(i % 4) * 0.45}s`,
})

function pick(m) { open.value = false; openArtifact(app, router, m) }
const drag = (e, list) => startDrag(e, list.slice(0, MAX).map(cardItem))
const onKey = (e) => { if (e.key === 'Escape') open.value = false }
watch(open, (v) => (v ? window.addEventListener('keydown', onKey) : window.removeEventListener('keydown', onKey)))
watch(() => [app.artifacts.scope, app.activeId, app.convFilter, app.topicFilter], () => { open.value = false })
onBeforeUnmount(() => { window.removeEventListener('keydown', onKey); window.removeEventListener('resize', fit) })
</script>

<template>
  <div v-if="items.length" class="astack" :class="{ open, small, above: place.mode === 'above' }" :data-place="place.mode"
    :style="{ right: `${place.right}px`, bottom: `${place.bottom}px` }">
    <div v-if="open" class="scrim" @click="open = false" />

    <!-- fan: the newest sits closest to the pile -->
    <TransitionGroup v-if="!grid" name="fan" tag="div" class="fan">
      <div v-for="(m, i) in open ? items : []" :key="m.id" class="fitem" :style="fanStyle(i)" draggable="true" data-test="pile-item" :data-file="m.content.name" @dragstart="drag($event, [m])">
        <ShareButton :msg="m" compact class="fshare" />
        <button class="fopen press" @click="pick(m)">
          <span class="label">{{ m.content.name }}<em v-if="m.content.edited">편집본</em></span>
          <span class="tile" :class="kindOf(m.content.name)">{{ kindLabel[kindOf(m.content.name)] || 'FILE' }}</span>
        </button>
      </div>
    </TransitionGroup>

    <Transition name="pop">
      <div v-if="open && grid" class="grid glass">
        <p class="cap">{{ caption }} {{ items.length }}개<button class="allshare press" @click="open = false; team.startShare(items)">모두 공유</button></p>
        <div class="cells">
          <div v-for="m in items" :key="m.id" class="cellw" draggable="true" data-test="pile-item" :data-file="m.content.name" @dragstart="drag($event, [m])">
            <button class="cell press" @click="pick(m)">
              <span class="tile" :class="kindOf(m.content.name)">{{ kindLabel[kindOf(m.content.name)] || 'FILE' }}</span>
              <small>{{ m.content.name }}</small>
            </button>
            <ShareButton :msg="m" compact class="cshare" />
          </div>
        </div>
      </div>
    </Transition>

    <button class="pile press" :aria-label="`${caption} ${items.length}개 ${open ? '접기' : '펼치기'}`" :aria-expanded="open" draggable="true" data-test="pile" @click="open = !open" @dragstart="drag($event, items)">
      <span v-for="(m, i) in pile" :key="m.id" class="tile layer" :class="kindOf(m.content.name)"
        :style="{ transform: `translate(${(pile.length - 1 - i) * -4}px, ${(pile.length - 1 - i) * -5}px) rotate(${(pile.length - 1 - i) * -6}deg)`, zIndex: i }">
        {{ kindLabel[kindOf(m.content.name)] || 'FILE' }}
      </span>
      <b class="count">{{ items.length }}</b>
    </button>
    <span class="name">산출물</span>
  </div>
</template>

<style scoped>
.astack { position: absolute; z-index: 8; right: 28px; bottom: 112px; display: flex; flex-direction: column; align-items: center; gap: 6px; transition: bottom .2s, right .3s var(--spring); }
/* a phone's: smaller */
.astack.small .pile { width: 48px; height: 48px; border-radius: 14px; }
.astack.small .tile.layer { width: 32px; height: 32px; border-radius: 9px; font-size: 9.5px; }
.astack.small .name { font-size: 11px; }
.scrim { position: fixed; inset: 0; z-index: -1; }
.pile { position: relative; width: 64px; height: 64px; border-radius: 18px; display: grid; place-items: center;
  background: var(--composer-bg); -webkit-backdrop-filter: blur(30px); backdrop-filter: blur(30px); box-shadow: 0 8px 28px rgba(0, 0, 0, .16);
  animation: bob 3.4s ease-in-out infinite alternate; }
.open .pile { animation: none; }
.name { font-size: 12px; color: var(--text-secondary); text-shadow: 0 1px 6px rgba(255, 255, 255, .35); }
.count { position: absolute; top: -6px; right: -6px; min-width: 22px; height: 22px; padding: 0 6px; border-radius: 11px; background: #1d1d1f; color: #fff; font-size: 12px; line-height: 22px; text-align: center; z-index: 5; }
.tile { width: 42px; height: 42px; border-radius: 11px; display: grid; place-items: center; font-size: 11px; font-weight: 700; color: #fff; background: #6b6b66; box-shadow: 0 3px 10px rgba(0, 0, 0, .18); }
.tile.hwp { background: #1f6fd1; } .tile.doc { background: #2b579a; } .tile.xls { background: #217346; } .tile.ppt { background: #c43e1c; } .tile.pdf { background: #d93025; } .tile.md { background: #3d4451; } .tile.txt { background: #5f6670; } .tile.web { background: #e44d26; } .tile.map { background: #b8860b; } .tile.cad { background: #0b6f88; } .tile.vec { background: #c2570c; } .tile.img { background: #7b3fbf; } .tile.snd { background: #0f8a5f; } .tile.vid { background: #b0223c; }
.layer { position: absolute; transition: transform .3s var(--spring); }

/* fan */
.fan { position: absolute; right: 10px; bottom: 74px; width: 0; height: 0; }
.fitem { position: absolute; right: -10px; bottom: 0; display: flex; align-items: center; gap: 10px; transition: transform .38s var(--spring), opacity .25s; }
.fitem .tile { animation: bob 3.2s ease-in-out infinite alternate; animation-delay: inherit; }
.fitem:hover .tile { transform: scale(1.12); }
.fitem, .cellw { cursor: grab; }
.fopen { display: flex; align-items: center; gap: 10px; }
/* 공유 (components/team): beside each artifact in the fan and the grid */
.fshare { flex: none; background: rgba(29, 29, 31, .7); color: #fff; }
.cellw { position: relative; }
.cellw .cell { width: 100%; }
.cshare { position: absolute; top: 0; right: 2px; width: 24px !important; height: 24px; opacity: 0; transition: opacity .15s; background: rgba(29, 29, 31, .72); color: #fff; }
.cellw:hover .cshare, .cshare:focus-visible { opacity: 1; }
@media (hover: none) { .cshare { opacity: 1; } }
.allshare { float: right; font-size: 12px; padding: 2px 10px; border-radius: 10px; background: rgba(127, 127, 127, .14); color: var(--text-primary); }
.label { max-width: 260px; padding: 5px 12px; border-radius: 9px; background: rgba(29, 29, 31, .78); color: #fff; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); }
.label em { font-style: normal; margin-left: 6px; font-size: 11px; color: #9fd0ff; }
.fan-enter-from, .fan-leave-to { opacity: 0; transform: translate(0, 0) scale(.6) !important; }

/* grid (many files) */
.grid { position: absolute; right: 0; bottom: 92px; width: min(420px, calc(100vw - 32px)); max-height: 56vh; overflow: auto; border-radius: 20px; padding: 10px 12px 14px; box-shadow: 0 16px 48px rgba(0, 0, 0, .2); }
.cap { margin: 4px 4px 10px; font-size: 12.5px; color: var(--text-secondary); }
.cells { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px 8px; }
.cell { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 6px 2px; border-radius: 12px; }
.cell:hover { background: rgba(0, 0, 0, .05); }
.cell small { width: 100%; font-size: 11.5px; text-align: center; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; word-break: break-all; }
.pop-enter-from, .pop-leave-to { opacity: 0; transform: translateY(12px) scale(.96); }
.pop-enter-active, .pop-leave-active { transition: opacity .2s, transform .25s var(--spring); }

@keyframes bob { from { translate: 0 0; } to { translate: 0 -4px; } }
@media (prefers-reduced-motion: reduce) { .pile, .fitem .tile { animation: none; } }
@media (max-width: 700px) { .label { max-width: 52vw; } }
</style>
