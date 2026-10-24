<script setup>
import Icon from './Icon.vue'

// Vertical flow of a process: definition steps, optionally with live state.
// step: {id, name, role, kind: start|human|agent|gateway|end|event, state?: done|active|pending|skipped|cancelled, mine?}
defineProps({ steps: Array, compact: Boolean })
const emit = defineEmits(['open', 'detail'])
// agent steps that have run (or are running) can show what the agent did
const kindIcon = { human: 'hand', agent: 'panel', gateway: 'plan', start: 'clock', end: 'check', event: 'clock' }
</script>

<template>
  <ol class="tl" :class="{ compact }">
    <li v-for="(s, i) in steps" :key="s.id" :class="[s.kind, s.state || 'plain', { mine: s.mine }]" :style="{ '--i': i }">
      <span class="dot"><Icon v-if="s.state === 'done'" name="check" :size="12" /></span>
      <div class="body" :class="{ click: s.mine }" @click="s.mine && emit('open', s)">
        <div class="name">
          <span :class="{ 'shimmer-text': s.state === 'active' && !s.mine }">{{ s.name }}</span>
          <span v-if="s.mine" class="attn"><Icon name="alert" :size="12" /> 입력 필요</span>
        </div>
        <div v-if="!compact && (s.role || s.assignee)" class="role">
          <Icon :name="kindIcon[s.kind] || 'panel'" :size="12" /> {{ s.role || s.assignee }}
          <button v-if="s.todoId && s.orchestration && ['done', 'active'].includes(s.state)" class="act press" @click.stop="emit('detail', s)">동작 보기</button>
        </div>
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
.active .dot { box-shadow: inset 0 0 0 2px var(--text-primary); animation: pulse 1.6s ease-in-out infinite; }
.mine .dot { background: var(--color-attention); box-shadow: none; animation: none; }
.gateway .dot { border-radius: 6px; rotate: 45deg; scale: .78; }
.skipped, .cancelled { opacity: .38; }
.body { padding-top: 2px; min-width: 0; }
.body.click { cursor: pointer; }
.name { font-size: 15px; line-height: 1.35; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.pending .name, .plain.end .name { color: var(--text-secondary); }
.role { font-size: 12.5px; color: var(--text-secondary); margin-top: 3px; display: flex; align-items: center; gap: 5px; }
.attn { display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 9px; border-radius: 9999px; background: var(--color-attention); color: #fff; font-size: 12px; font-weight: 500; }
.act { margin-left: 6px; font-size: 12px; padding: 1px 9px; border-radius: 9999px; background: var(--field-bg); color: var(--text-primary); }
.compact li { padding-bottom: 8px; }
.compact .name { font-size: 14px; }
</style>
