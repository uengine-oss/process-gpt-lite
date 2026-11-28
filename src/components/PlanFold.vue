<script setup>
// A saved answer's plan (server lib/turnPlan.js saved · settledPlan), over the answer where the running turn's plan card was — it no longer
// folds away under a long answer (2026-11-28 녹화 20:49: 「계획이 지금 사라져버렸는데 … 원래 계획은 뭐였냐면은」). Each step says how it
// went: ✓ done · ✗ missed · ↷ done another way, with why (lib/planGuard.js). A step that was not done as planned, or a turn that stopped to
// ask, opens the plan by itself.
// guard.after: the work ran to its end but went off on the way (planGuard final) — what happened and the question, its answers as buttons
// that send them (a guard that stopped the run asks in the answer itself — the chat's quick replies)
import { ref, computed, watch } from 'vue'
import { useApp } from '../stores/app.js'
import { planParts, STEP_MARK } from '../turnView.js'

const props = defineProps({ plan: Object, notes: { type: Array, default: () => [] }, guard: { type: Object, default: null }, threadId: String })
const app = useApp()
const info = computed(() => planParts(props.plan, props.notes))
const steps = computed(() => (Array.isArray(props.plan?.steps) ? props.plan.steps : []))
const after = computed(() => (props.guard?.after && props.guard.question ? props.guard : null))
const open = ref(!!info.value?.trouble || !!after.value)
// (the end check comes back after the answer is out: a plan that turns out to have a missed step opens then)
watch(() => !!info.value?.trouble || !!after.value, (t, was) => { if (t && !was) open.value = true })
const sent = ref('')
function answer(o) { sent.value = o; app.send(o, props.threadId) }
</script>

<template>
  <div v-if="info" class="pf" :class="{ open, trouble: info.trouble || !!after }" data-test="plan-fold">
    <button class="wl press" :aria-expanded="open" data-testid="plan-fold" @click="open = !open">
      <template v-for="(p, i) in info.parts" :key="i"><template v-if="i"> · </template><span :class="{ warn: p.warn }">{{ p.text }}</span></template>
      <span class="car">{{ open ? '▴' : '▾' }}</span>
    </button>
    <div v-if="open" class="pbody" data-testid="plan-body">
      <p class="pu" data-no-i18n>{{ plan.understood }}</p>
      <ol v-if="steps.length">
        <li v-for="(s, i) in steps" :key="s.id || i" :class="s.state" :data-state="s.state" data-testid="plan-step">
          <span class="pm" :aria-label="s.state">{{ STEP_MARK[s.state] || i + 1 }}</span>
          <span><span data-no-i18n>{{ s.text }}</span><small v-if="s.why" class="why" data-no-i18n data-testid="plan-step-why">{{ s.why }}</small></span>
        </li>
      </ol>
      <template v-if="notes.length"><small class="pn">메모</small><ul><li v-for="(n, i) in notes" :key="i" data-no-i18n>{{ n }}</li></ul></template>
    </div>
    <div v-if="after" class="off" role="group" aria-label="계획과 다르게 진행했어요" data-testid="plan-off">
      <b>계획과 다르게 진행했어요</b>
      <p data-no-i18n>{{ after.what }}</p>
      <p class="q" data-no-i18n>{{ after.question }}</p>
      <div v-if="after.options?.length && !sent" class="opts">
        <button v-for="o in after.options" :key="o" class="opt press" data-no-i18n data-testid="plan-off-option" @click="answer(o)">{{ o }}</button>
      </div>
      <small v-else-if="sent" class="sent" data-testid="plan-off-sent"><span>보냈어요</span> · <span data-no-i18n>{{ sent }}</span></small>
    </div>
  </div>
</template>

<style scoped>
.pf { max-width: min(424px, 100%); margin: 0 0 4px; font-size: 12.5px; color: var(--text-secondary); }
.wl { text-align: left; padding: 4px 8px; border-radius: 10px; color: var(--text-secondary); font-size: 12.5px; line-height: 1.45; overflow-wrap: anywhere; }
.wl .warn { color: var(--color-attention); font-weight: 600; }
.car { font-size: 10px; margin-left: 2px; }
.pbody { margin: 4px 0 0; padding: 10px 12px; border-radius: 14px; background: var(--bubble-agent-bg); }
.pu { margin: 0 0 6px; color: var(--text-primary); font-size: 13px; line-height: 1.45; overflow-wrap: anywhere; }
ol, ul { margin: 0; padding: 0; list-style: none; }
ol li { display: grid; grid-template-columns: 18px 1fr; gap: 6px; margin: 3px 0; line-height: 1.45; overflow-wrap: anywhere; }
ul li { margin: 2px 0; color: var(--text-tertiary); line-height: 1.45; overflow-wrap: anywhere; }
.pm { color: var(--text-tertiary); text-align: center; }
li.done .pm { color: var(--color-success); }
li.missed .pm, li.changed .pm { color: var(--color-attention); font-weight: 700; }
li.missed > span:last-child > span, li.changed > span:last-child > span { color: var(--text-primary); }
.why { display: block; margin-top: 1px; color: var(--text-secondary); font-size: 12px; }
.pn { display: block; margin: 8px 0 2px; color: var(--text-tertiary); }
.off { margin-top: 6px; padding: 10px 12px; border-radius: 14px; background: color-mix(in srgb, var(--color-attention) 12%, var(--bubble-agent-bg)); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-attention) 35%, transparent); color: var(--text-primary); font-size: 13px; line-height: 1.45; }
.off b { display: block; margin-bottom: 2px; font-size: 12.5px; color: var(--color-attention); }
.off p { margin: 2px 0; overflow-wrap: anywhere; }
.off .q { margin-top: 6px; font-weight: 600; }
.opts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.opt { padding: 6px 12px; border-radius: 16px; background: var(--cell-bg); color: var(--text-primary); font-size: 13px; line-height: 1.3; text-align: left; overflow-wrap: anywhere; }
.sent { display: block; margin-top: 6px; color: var(--text-tertiary); }
</style>
