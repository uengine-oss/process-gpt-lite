<script setup>
// The progress panel the pill opens (design turnplan §3.3, server lib/turnPlan.js): 지금 · 할 일 · 한 일 · 메모 of the turn on screen,
// and 멈추기. Beside the composer on a wide screen (anchored above the pill, 420 px, up to 60 % of the height); at 760 px and below a
// bottom sheet (85 %), closed by pulling it down, by its ✕ or by the pill.
import { computed, ref } from 'vue'
import Icon from './Icon.vue'
import { narrow } from '../viewport.js'
import { dur, elapsed, idle, stepsOf, stepText, liveLine } from '../turnView.js'

const props = defineProps({ turn: Object, now: Number, stopping: Boolean })
const emit = defineEmits(['close', 'stop'])
const t = computed(() => props.turn)
const todos = computed(() => stepsOf(t.value))
const current = computed(() => todos.value.find((s) => s.state === 'active')?.text || '')
const live = computed(() => liveLine(t.value, props.now))
const since = computed(() => Math.floor(idle(t.value, props.now) / 1000))
const notes = computed(() => t.value.notes || [])

// pulled down on a phone: it goes
const pull = ref(0)
let from = null
function down(e) { if (narrow.value && e.pointerType !== 'mouse') from = { y: e.clientY, id: e.pointerId } }
function move(e) { if (from && e.pointerId === from.id) pull.value = Math.max(0, e.clientY - from.y) }
function up() { if (!from) return; from = null; if (pull.value > 90) emit('close'); pull.value = 0 }
</script>

<template>
  <Teleport to="body" :disabled="!narrow">
    <div v-if="narrow" class="scrim" data-testid="turn-scrim" @click="emit('close')" />
    <section class="turn-panel glass" :class="{ sheet: narrow }" role="dialog" aria-label="진행 상황" data-testid="turn-panel" :data-turn="t.turnId"
      :style="pull ? { transform: `translateY(${pull}px)` } : null">
      <div class="grab" @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up"><i v-if="narrow" class="bar" /></div>
      <header class="hd">
        <b>진행 상황</b>
        <button class="x press" aria-label="닫기" data-testid="turn-panel-close" @click="emit('close')"><Icon name="close" :size="18" /></button>
      </header>
      <div class="body">
        <section data-testid="turn-now">
          <h4>지금</h4>
          <p class="now">{{ t.stage?.text || '요청을 읽는 중' }}</p>
          <p v-if="current" class="sub" data-no-i18n>{{ current }}</p>
          <!-- (what the agent is writing right now, when it is a short text: the card's live line has the rest) -->
          <p v-if="live.raw" class="sub" data-no-i18n>{{ live.text }}</p>
          <p class="meta"><span>{{ dur(elapsed(t, now)) }}</span><span v-if="since >= 5"> · 마지막 소식 {{ since }}초 전</span></p>
        </section>
        <section data-testid="turn-todos">
          <h4>할 일</h4>
          <ol v-if="todos.length" class="todo">
            <li v-for="(s, i) in todos" :key="s.id || i" :class="s.state" :data-state="s.state">
              <span class="mark" aria-hidden="true"><Icon v-if="s.state === 'done'" name="check" :size="11" /><i v-else-if="s.state === 'active'" class="spin" /></span>
              <span data-no-i18n>{{ s.text }}</span>
            </li>
          </ol>
          <p v-else class="empty">에이전트가 할 일을 정리하면 여기에 보여요</p>
        </section>
        <section data-testid="turn-done">
          <h4>한 일</h4>
          <ol v-if="t.steps?.length" class="did">
            <li v-for="s in t.steps" :key="s.key || s.seq">{{ stepText(s) }}<template v-if="s.n > 1"> ×{{ s.n }}</template></li>
          </ol>
          <p v-else class="empty">아직 없어요</p>
        </section>
        <section data-testid="turn-notes">
          <h4>메모</h4>
          <ul v-if="notes.length || t.open?.text" class="notes">
            <li v-for="n in notes" :key="n.seq" data-testid="turn-note" data-no-i18n>{{ n.text }}</li>
            <li v-if="t.open?.text" class="open" data-no-i18n>{{ t.open.text }}</li>
          </ul>
          <p v-else class="empty">아직 없어요</p>
        </section>
      </div>
      <footer class="ft">
        <button class="stop press" data-testid="turn-panel-stop" :disabled="stopping" @click="emit('stop')"><span class="sq" />{{ stopping ? '멈추는 중' : '멈추기' }}</button>
      </footer>
    </section>
  </Teleport>
</template>

<style scoped>
.turn-panel { position: absolute; left: 4px; bottom: calc(100% + 60px); width: 420px; max-width: calc(100vw - 32px); max-height: 60vh; z-index: 30; display: flex; flex-direction: column;
  border-radius: 22px; border: 1px solid var(--hairline); box-shadow: var(--shadow-card); background: var(--regular-solid-bg); animation: pop-in .3s var(--spring) both; overflow: hidden; }
.turn-panel.sheet { position: fixed; left: 0; right: 0; bottom: 0; width: auto; max-width: none; max-height: 85vh; z-index: 90; border-radius: 22px 22px 0 0; border-bottom: 0;
  padding-bottom: env(safe-area-inset-bottom, 0); transition: transform .2s; }
.scrim { position: fixed; inset: 0; z-index: 89; background: rgba(0 0 0 / .32); animation: fade-in .2s both; }
.grab { height: 10px; display: grid; place-items: center; touch-action: none; flex: none; }
.sheet .grab { height: 22px; }
.bar { width: 40px; height: 5px; border-radius: 3px; background: var(--hairline); background: color-mix(in srgb, var(--text-primary) 22%, transparent); }
.hd { display: flex; align-items: center; justify-content: space-between; padding: 0 12px 4px 18px; flex: none; }
.hd b { font-size: 15px; font-weight: 600; }
.x { width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; color: var(--text-secondary); }
.body { overflow: auto; padding: 2px 18px 6px; display: flex; flex-direction: column; gap: 14px; min-height: 0; }
h4 { margin: 0 0 6px; font-size: 12px; font-weight: 600; letter-spacing: .02em; color: var(--text-tertiary); }
.now { margin: 0; font-size: 15px; line-height: 1.4; }
.sub { margin: 3px 0 0; font-size: 13px; line-height: 1.4; color: var(--text-secondary); overflow-wrap: anywhere; }
.meta { margin: 4px 0 0; font-size: 12px; color: var(--text-tertiary); }
.empty { margin: 0; font-size: 13px; color: var(--text-tertiary); }
.todo, .did, .notes { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; font-size: 13.5px; line-height: 1.4; }
.todo li { display: grid; grid-template-columns: 20px 1fr; gap: 8px; color: var(--text-secondary); overflow-wrap: anywhere; }
.todo li.done, .todo li.active { color: var(--text-primary); }
.mark { width: 18px; height: 18px; border-radius: 9999px; display: grid; place-items: center; background: var(--cell-bg); box-shadow: inset 0 0 0 1.5px var(--hairline); color: #fff; }
.done .mark { background: var(--color-success); box-shadow: none; }
.spin { width: 10px; height: 10px; border-radius: 50%; border: 1.6px solid var(--text-tertiary); border-top-color: var(--text-primary); animation: spin .9s linear infinite; }
.did li { color: var(--text-secondary); padding-left: 12px; position: relative; overflow-wrap: anywhere; }
.did li::before { content: ''; position: absolute; left: 0; top: .6em; width: 5px; height: 5px; border-radius: 50%; background: var(--text-tertiary); }
.notes li { color: var(--text-secondary); font-size: 13px; padding: 6px 10px; border-radius: 10px; background: var(--cell-bg); overflow-wrap: anywhere; }
.notes li.open { opacity: .7; }
.ft { flex: none; display: flex; justify-content: flex-end; padding: 8px 14px 12px; border-top: 1px solid var(--hairline); }
.stop { height: 38px; padding: 0 16px 0 14px; border-radius: 19px; display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--hairline); background: var(--button-bg); font-size: 14px; color: var(--text-primary); }
.stop .sq { width: 10px; height: 10px; border-radius: 2px; background: currentColor; }
.stop:disabled { opacity: .55; }
</style>
