<script setup>
// "공유" for one artifact: a file card in chat, an item of the artifact stack, or the document open in
// the editor (no prop: app.officeDoc's card). Hidden when there is nothing that can be shared.
import { computed } from 'vue'
import Icon from '../Icon.vue'
import { useApp } from '../../stores/app.js'
import { useTeam, shareable } from '../../stores/team.js'

// plain: no look of its own (an editor bar styles it as one of its .tb buttons)
// forName: in an editor frame, only when the frame shows the chat's open document (not a folder preview)
const props = defineProps({ msg: { type: Object, default: null }, label: { type: String, default: '공유' }, compact: Boolean, plain: Boolean, forName: { type: String, default: '' } })
const app = useApp()
const team = useTeam()
// the editor's document: its card in any loaded thread
const target = computed(() => {
  if (props.msg) return props.msg
  const id = app.officeDoc?.msgId
  if (!id || (props.forName && app.officeDoc.name !== props.forName)) return null
  for (const list of Object.values(app.messages)) { const m = list.find((x) => x.id === id); if (m) return m }
  return null
})
const ok = computed(() => shareable(target.value))
</script>

<template>
  <button v-if="ok" class="press" :class="plain ? null : ['shb', { compact }]" :title="`${target.content.name} 팀원에게 공유`" :aria-label="`${target.content.name} 공유`"
    @click.stop="team.startShare([target])">
    <Icon name="team" :size="compact ? 15 : 16" /><span v-if="!compact">{{ label }}</span>
  </button>
</template>

<style scoped>
.shb { display: inline-flex; align-items: center; gap: 5px; height: 30px; padding: 0 11px; border-radius: 15px; font-size: 13px; font-weight: 500;
  color: var(--text-primary); background: rgba(127, 127, 127, .12); }
.shb:hover { background: rgba(127, 127, 127, .22); }
.shb.compact { width: 30px; padding: 0; justify-content: center; }
</style>
