<script setup>
// 방 규칙(server lib/roomRules.js): 이 방에 링크나 파일을 올리면 묻지 않고 실행하는 일. 그래서 맨 위에 늘 보이고, 바로 끌 수 있다.
import { computed, ref, watch } from 'vue'
import { api } from '../api.js'
import { useApp } from '../stores/app.js'

const props = defineProps({ thread: String })
const app = useApp()
const rule = ref(null)
const load = async () => { rule.value = (await api(`/threads/${props.thread}/rule`).catch(() => null))?.rule || null }
// GET /threads/:id/rule → { rule: { id, said, action, runs, at } } | { rule: null } — the rule lives on the room's
// message that took it down (content.roomRule). A rule is set by a message in this room, so it is read again on each one.
const count = computed(() => (app.messages[props.thread] || []).length)
watch(() => [props.thread, count.value], load, { immediate: true })
async function off() { await api(`/threads/${props.thread}/rule`, { method: 'DELETE' }); rule.value = null }
</script>

<template>
  <div v-if="rule" class="rule glass-thin" data-testid="room-rule">
    <div class="tx" :title="rule.said ? `정한 말: ${rule.said}` : ''"><b>이 방의 규칙</b><span class="sep">·</span><span>{{ rule.action }}</span><small v-if="rule.runs">{{ rule.runs }}번 실행</small></div>
    <button class="off press" data-testid="room-rule-off" @click="off">끄기</button>
  </div>
</template>

<style scoped>
.rule { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-radius: 18px; margin-bottom: 4px; font-size: 13.5px; color: var(--text-primary); }
.tx { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; gap: 2px 6px; line-height: 1.45; word-break: keep-all; overflow-wrap: anywhere; }
.tx b { font-weight: 600; }
.sep { color: var(--text-tertiary); }
.tx small { color: var(--text-tertiary); }
.off { flex: none; height: 36px; padding: 0 14px; border-radius: 18px; background: var(--cell-bg); color: var(--text-primary); font-size: 13px; }
</style>
