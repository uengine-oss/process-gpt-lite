<script setup>
import Icon from './Icon.vue'

// Vertical flow of a process: definition steps, optionally with live state.
// step: {id, name, role, kind: start|human|agent|gateway|end|event, state?: done|active|pending|skipped|cancelled, mine?}
defineProps({ steps: Array, compact: Boolean })
const emit = defineEmits(['open', 'detail', 'retry'])
// agent steps that have run (or are running) can show what the agent did
const kindIcon = { human: 'hand', agent: 'panel', gateway: 'plan', start: 'clock', end: 'check', event: 'clock' }
</script>

<template>
  <ol class="tl" :class="{ compact }">
    <li v-for="(s, i) in steps" :key="s.id" :class="[s.kind, s.state || 'plain', { mine: s.mine, running: s.running, failed: s.failed }]" :style="{ '--i': i }">
      <span class="dot"><Icon v-if="s.state === 'done'" name="check" :size="12" /></span>
      <div class="body" :class="{ click: s.mine }" @click="s.mine && emit('open', s)">
        <div class="name">
          <span :class="{ 'shimmer-text': s.running }">{{ s.name }}</span>
          <span v-if="s.mine" class="attn"><Icon name="alert" :size="12" /> 입력 필요</span>
          <span v-else-if="s.failed" class="bad"><Icon name="alert" :size="12" /> 실패</span>
          <span v-else-if="s.state === 'active' && s.kind === 'human'" class="wait">확인 대기</span>
        </div>
        <!-- an agent step that stopped on an error: why, and 다시 시도 (lib/stepRetry.js) -->
        <div v-if="s.failed && !compact" class="fail">
          <span>{{ s.failure?.error || '오류로 멈췄어요.' }}<template v-if="s.failure?.autoRetry"> · 잠시 뒤 자동으로 다시 시도해요 ({{ s.failure.attempts }}/{{ s.failure.max }})</template></span>
          <button class="retry press" @click.stop="emit('retry', s)">다시 시도</button>
        </div>
        <div v-if="!compact && (s.role || s.assignee)" class="role">
          <Icon :name="kindIcon[s.kind] || 'panel'" :size="12" /> {{ s.role || s.assignee }}
          <button v-if="s.todoId && s.orchestration && ['done', 'active'].includes(s.state)" class="act press" @click.stop="emit('detail', s)">동작 보기</button>
        </div>
        <!-- the skills the definition binds to this step -->
        <div v-if="!compact && s.skills?.length" class="sk"><code v-for="k in s.skills" :key="k">{{ k }}</code></div>
      </div>
    </li>
  </ol>
</template>

<style scoped>
.tl { list-style: none; margin: 0; padding: 0; position: relative; }
.tl li { position: relative; display: grid; grid-template-columns: 24px 1fr; gap: 10px; padding: 0 0 14px; animation: blur-in .45s var(--spring) both; animation-delay: calc(var(--i) * 40ms); }
.tl li:not(:last-child)::before { content: ''; position: absolute; left: 11px; top: 20px; bottom: 0; width: 2px; border-radius: 2px; background: var(--hairline); }
.tl li.done:not(:last-child)::before { background: color-mix(in srgb, var(--color-success) 55%, transparent); }
.dot { width: 24px; height: 24px; border-radius: 9999px; display: grid; place-items: center; background: var(--cell-bg); color: #fff; box-shadow: inset 0 0 0 2px var(--hairline); z-index: 1; }
.done .dot { background: var(--color-success); box-shadow: none; }
/* an active step is ringed; only an agent actually at work pulses (a step waiting on a person stays still) */
.active .dot { box-shadow: inset 0 0 0 2px var(--text-primary); }
.running .dot { animation: pulse 1.6s ease-in-out infinite; }
.mine .dot { background: var(--color-attention); box-shadow: none; animation: none; }
.gateway .dot { border-radius: 6px; rotate: 45deg; scale: .78; }
.skipped, .cancelled { opacity: .38; }
.body { padding-top: 2px; min-width: 0; }
.body.click { cursor: pointer; }
.name { font-size: 15px; line-height: 1.35; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.pending .name, .plain.end .name { color: var(--text-secondary); }
.role { font-size: 12.5px; color: var(--text-secondary); margin-top: 3px; display: flex; align-items: center; gap: 5px; }
.attn { display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 9px; border-radius: 9999px; background: var(--color-attention); color: #fff; font-size: 12px; font-weight: 500; }
.wait { display: inline-flex; align-items: center; height: 22px; padding: 0 9px; border-radius: 9999px; background: var(--cell-bg); color: var(--text-secondary); font-size: 12px; }
.failed .dot { background: var(--color-error); box-shadow: none; animation: none; }
.bad { display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 9px; border-radius: 9999px; background: var(--color-error); color: #fff; font-size: 12px; font-weight: 500; }
.fail { margin-top: 6px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12.5px; color: var(--text-secondary); }
.fail span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.retry { height: 26px; padding: 0 12px; border-radius: 9999px; background: var(--ink); color: var(--ink-inverse); font-size: 12.5px; font-weight: 500; }
.act { margin-left: 6px; font-size: 12px; padding: 1px 9px; border-radius: 9999px; background: var(--field-bg); color: var(--text-primary); }
.sk { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.sk code { font-size: 11px; padding: 1px 6px; border-radius: 6px; background: rgba(150 240 176 / .14); color: var(--color-success); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.compact li { padding-bottom: 8px; }
.compact .name { font-size: 14px; }
</style>
