<script setup>
// The plan card under the person's message while their turn runs (design turnplan §3.2, server lib/turnPlan.js): what was understood,
// who handles it, the steps — the agent's own to-dos once it wrote them — and one live line of what is happening now. 「자세히」 opens
// the progress panel (TurnProgress.vue). When the turn ends the card goes; the answer keeps the plan folded (Message.vue).
import { computed } from 'vue'
import Icon from './Icon.vue'
import { dur, elapsed, stepsOf, doneOf, liveLine } from '../turnView.js'

const props = defineProps({ turn: Object, now: Number })
const emit = defineEmits(['details'])
const t = computed(() => props.turn)
const reading = computed(() => !t.value.plan)
// (a message answered at once — a panel, a schedule — ends before its plan comes: no card flashes for it)
const shown = computed(() => !reading.value || elapsed(t.value, props.now) >= 600)
const steps = computed(() => stepsOf(t.value))
const done = computed(() => doneOf(steps.value))
const live = computed(() => liveLine(t.value, props.now))
const fallback = computed(() => t.value.plan?.source === 'fallback')
</script>

<template>
  <div v-if="shown" class="turn-card" :class="{ reading, fallback }" data-testid="turn-card" :data-turn="t.turnId" :data-state="reading ? 'reading' : 'planned'">
    <p v-if="reading" class="head"><span class="shimmer-text">요청을 읽는 중</span></p>
    <p v-else class="head" data-testid="turn-understood" data-no-i18n>{{ t.plan.understood }}</p>
    <small v-if="t.handler?.label" class="handler" data-testid="turn-handler">{{ t.handler.label }}</small>
    <ol v-if="steps.length" class="steps" data-testid="turn-steps">
      <li v-for="(s, i) in steps" :key="s.id || i" :class="s.state" data-testid="turn-step" :data-state="s.state">
        <span class="mark" aria-hidden="true"><Icon v-if="s.state === 'done'" name="check" :size="11" /><i v-else-if="s.state === 'active'" class="spin" /><b v-else>{{ i + 1 }}</b></span>
        <span class="txt" data-no-i18n>{{ s.text }}</span>
      </li>
    </ol>
    <p v-if="live.text && !reading" class="live" data-testid="turn-live"><span v-if="live.raw" data-no-i18n>{{ live.text }}</span><template v-else>{{ live.text }}</template></p>
    <div class="foot">
      <span class="time" data-testid="turn-elapsed">{{ dur(elapsed(t, now)) }}</span>
      <span v-if="steps.length" class="count" data-testid="turn-count">계획 {{ done }}/{{ steps.length }}</span>
      <button class="more press" data-testid="turn-details" @click="emit('details', t.turnId)">자세히 <Icon name="chevron" :size="12" /></button>
    </div>
  </div>
</template>

<style scoped>
.turn-card { align-self: flex-start; width: min(424px, 100%); border-radius: 20px; padding: 13px 16px 10px; background: var(--bubble-agent-bg); -webkit-backdrop-filter: blur(50px); backdrop-filter: blur(50px);
  border: 1px solid var(--hairline); animation: blur-in .4s var(--spring) both; }
.head { margin: 0; font-size: 15px; line-height: 1.45; color: var(--text-primary); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; word-break: keep-all; }
.reading .head { color: var(--text-secondary); }
.fallback .head { color: var(--text-secondary); }
.handler { display: block; margin-top: 3px; font-size: 12px; color: var(--text-tertiary); }
.steps { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 7px; }
.steps li { display: grid; grid-template-columns: 20px 1fr; gap: 8px; align-items: start; font-size: 13.5px; line-height: 1.4; color: var(--text-secondary); }
.steps li.active { color: var(--text-primary); }
.steps li.done { color: var(--text-primary); }
.txt { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; word-break: keep-all; }
.mark { width: 18px; height: 18px; margin-top: 1px; border-radius: 9999px; display: grid; place-items: center; background: var(--cell-bg); box-shadow: inset 0 0 0 1.5px var(--hairline); font-size: 10.5px; color: var(--text-tertiary); }
.mark b { font-weight: 500; }
.done .mark { background: var(--color-success); box-shadow: none; color: #fff; }
.active .mark { box-shadow: inset 0 0 0 1.5px var(--text-secondary); }
.spin { width: 10px; height: 10px; border-radius: 50%; border: 1.6px solid var(--text-tertiary); border-top-color: var(--text-primary); animation: spin .9s linear infinite; }
.live { margin: 9px 0 0; font-size: 12.5px; line-height: 1.4; color: var(--text-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.foot { margin-top: 8px; display: flex; align-items: center; gap: 10px; font-size: 12px; color: var(--text-tertiary); }
.count { color: var(--text-secondary); }
.more { margin-left: auto; display: inline-flex; align-items: center; gap: 2px; padding: 3px 4px 3px 9px; border-radius: 9999px; font-size: 12.5px; color: var(--text-secondary); background: var(--button-bg); }
</style>
