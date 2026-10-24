<script setup>
import { computed, ref } from 'vue'
import Icon from './Icon.vue'
import { api } from '../api.js'
import { useApp } from '../stores/app.js'

const props = defineProps({ msg: Object, full: Boolean })
const app = useApp()
const showPlan = ref(false)
const c = computed(() => props.msg.content)
const frame = computed(() => app.frames[props.msg.id] || (c.value.shot ? { data: c.value.shot } : null))
const done = computed(() => c.value.steps?.filter((s) => s.done).length || 0)
const running = computed(() => c.value.state === 'running')
const needs = computed(() => c.value.state === 'needs_input')
const takeover = ref(false)

function onClick(e) {
  if (!takeover.value) return
  const r = e.currentTarget.getBoundingClientRect()
  api('/browser/input', { method: 'POST', body: { type: 'click', x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height } })
}
function onKey(e) {
  if (!takeover.value) return
  e.preventDefault()
  if (e.key.length === 1) api('/browser/input', { method: 'POST', body: { type: 'text', text: e.key } })
  else api('/browser/input', { method: 'POST', body: { type: 'key', key: e.key } })
}
function finishTakeover() {
  takeover.value = false
  api('/browser/resume', { method: 'POST', body: { text: 'The user took over and finished the manual part. Re-check the page and continue.' } })
}
const cancel = () => api('/browser/cancel', { method: 'POST' })
</script>

<template>
  <div class="task" :class="{ full }">
    <div class="screen" :class="{ live: running, takeover }" tabindex="0" @click="onClick" @keydown="onKey">
      <img v-if="frame?.data" :src="`data:image/jpeg;base64,${frame.data}`" alt="" />
      <div v-else class="blank"><span class="shimmer-text">{{ running ? '브라우저 여는 중' : c.title }}</span></div>
      <Transition name="fade">
        <div v-if="showPlan" class="plan glass" @click.stop>
          <div class="ph">작업 진행 상황 <button aria-label="닫기" @click="showPlan = false"><Icon name="close" :size="18" /></button></div>
          <ul>
            <li v-for="(s, i) in c.steps" :key="i" :class="{ done: s.done }"><span class="dot" />{{ s.text }}<small v-if="s.note">{{ s.note }}</small></li>
          </ul>
        </div>
      </Transition>
      <!-- hark: the task rides on the live screen — title pill (tap for the plan), expand, stop -->
      <div v-if="!full" class="ctl">
        <button v-if="needs" class="attn press" @click.stop="app.handoff = msg.id"><Icon name="alert" :size="16" /> 조치 필요</button>
        <button v-else class="title press" :aria-label="`${c.title}, 계획 ${done}/${c.steps?.length}`" @click.stop="showPlan = !showPlan">
          <span v-if="running" class="dots"><i /><i /><i /></span><Icon v-else name="check" :size="14" />
          <span class="tt">{{ c.title }}</span>
        </button>
        <button class="round press" aria-label="확장" @click.stop="app.handoff = msg.id"><Icon name="expand" :size="16" /></button>
        <button v-if="running || needs" class="round press" aria-label="작업 취소" @click.stop="cancel"><Icon name="close" :size="16" /></button>
      </div>
    </div>
    <div v-if="full" class="bar">
      <button class="pill press" :aria-label="`계획, ${c.steps?.length}단계 중 ${done} 완료`" @click="showPlan = !showPlan"><Icon name="plan" :size="16" /> 계획 {{ done }}/{{ c.steps?.length }}</button>
      <button v-if="!takeover" class="pill press" @click="takeover = true"><Icon name="hand" :size="16" /> 직접 제어</button>
      <button v-else class="pill press on" @click="finishTakeover"><Icon name="check" :size="16" /> 제어 돌려주기</button>
      <button v-if="running || needs" class="pill press" @click="cancel">작업 취소</button>
    </div>

  </div>
</template>

<style scoped>
.task { width: 100%; }
.screen { position: relative; aspect-ratio: 16 / 10; border-radius: 24px; overflow: hidden; background: #fff; box-shadow: var(--shadow-card); outline: 0; }
.screen img { width: 100%; height: 100%; object-fit: cover; object-position: top; display: block; }
.screen.takeover { box-shadow: 0 0 0 3px var(--color-attention), var(--shadow-card); cursor: crosshair; }
.blank { position: absolute; inset: 0; display: grid; place-items: center; background: #f3f5fa; font-size: 15px; --text-tertiary: rgba(29 29 31 / .3); --text-primary: #1d1d1f; }
.ctl { position: absolute; left: 12px; right: 12px; bottom: 12px; display: flex; gap: 8px; justify-content: flex-end; }
.title { margin-right: auto; min-width: 0; max-width: 72%; height: 40px; padding: 0 16px 0 14px; border-radius: 9999px; display: flex; align-items: center; gap: 10px; background: rgba(255 255 255 / .94); color: #1d1d1f; font-size: 14px; box-shadow: 0 2px 12px rgba(0 0 0 / .12); }
.tt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dots { position: relative; width: 14px; height: 14px; flex: none; animation: spin 1.4s linear infinite; }
.dots i { position: absolute; width: 4.5px; height: 4.5px; border-radius: 50%; background: #1d1d1f; }
.dots i:nth-child(1) { left: 5px; top: 0; } .dots i:nth-child(2) { left: 0; bottom: 1px; opacity: .7; } .dots i:nth-child(3) { right: 0; bottom: 1px; opacity: .45; }
.round { width: 40px; height: 40px; border-radius: 9999px; display: grid; place-items: center; background: rgba(255 255 255 / .9); color: #1d1d1f; box-shadow: 0 2px 10px rgba(0 0 0 / .12); }
.attn { margin-right: auto; height: 40px; padding: 0 14px; border-radius: 9999px; background: var(--color-attention); color: #fff; display: flex; align-items: center; gap: 6px; font-size: 14px; font-weight: 500; animation: pop-in .4s var(--spring); }
.meta { display: flex; justify-content: space-between; align-items: center; padding: 8px 6px 0; font-size: 14px; color: var(--text-secondary); }
.steps { font-size: 13px; color: var(--text-tertiary); }
.plan { position: absolute; inset: 16px; border-radius: 18px; padding: 18px 22px; overflow: auto; color: #1d1d1f; --regular-bg: rgba(255 255 255 / .82); cursor: default; }
.ph { display: flex; justify-content: space-between; font-size: 16px; margin-bottom: 10px; }
.plan ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 14px; }
.plan li { display: grid; grid-template-columns: 22px 1fr; align-items: start; font-size: 15px; line-height: 1.45; color: rgba(29 29 31 / .5); }
.plan li.done { color: #1d1d1f; }
.plan li small { grid-column: 2; color: rgba(29 29 31 / .45); }
.dot { width: 8px; height: 8px; border-radius: 9999px; background: rgba(29 29 31 / .2); margin-top: 7px; }
li.done .dot { background: #0F9D58; }
.full .screen { aspect-ratio: auto; height: min(70vh, 640px); width: min(92vw, 1024px); margin: 0 auto; }
.bar { display: flex; justify-content: center; gap: 8px; margin-top: 16px; }
.pill { height: 40px; padding: 0 16px; border-radius: 9999px; background: rgba(255 255 255 / .92); color: #1d1d1f; display: flex; align-items: center; gap: 6px; font-size: 14px; font-weight: 500; }
.pill.on { background: var(--color-attention); color: #fff; }
</style>
