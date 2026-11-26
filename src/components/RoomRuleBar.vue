<script setup>
// 방 규칙(server lib/roomRules.js): 이 방에 링크나 파일을 올리면 묻지 않고 실행하는 일. 그래서 맨 위에 늘 보이고, 바로 끌 수 있다.
// 막대는 그 일을 누가 하는지도 보인다 — 「서버 브라우저: <스킬>」 또는 「에이전트가 처리」(설계 turnplan §4.4). 그 자리를 누르면 브라우저 스킬과
// 「에이전트」 가운데 고른다(PUT /threads/:id/rule {skill}) — 잘못 고른 스킬을 규칙을 다시 말하지 않고 고친다.
// 그 아래 「프로젝트 계획」 칩(ProjectNote.vue): 이 프로젝트의 모든 대화가 먼저 읽는 목적 · 약속.
import { computed, ref, watch } from 'vue'
import { api } from '../api.js'
import { useApp } from '../stores/app.js'
import ProjectNote from './ProjectNote.vue'

const props = defineProps({ thread: String })
const app = useApp()
const rule = ref(null)
const skills = ref([])
const picking = ref(false)
const err = ref('')
const load = async () => { rule.value = (await api(`/threads/${props.thread}/rule`).catch(() => null))?.rule || null }
// GET /threads/:id/rule → { rule: { id, said, action, skill, label, runs, at } } | { rule: null } — the rule lives on the room's
// message that took it down (content.roomRule). A rule is set by a message in this room, so it is read again on each one.
const count = computed(() => (app.messages[props.thread] || []).length)
watch(() => [props.thread, count.value], load, { immediate: true })
async function off() { await api(`/threads/${props.thread}/rule`, { method: 'DELETE' }); rule.value = null }
async function pickOpen() {
  err.value = ''
  picking.value = !picking.value
  // (the browser skills: the same list the plan sheet offers — GET /threads/:id/note)
  if (picking.value && !skills.value.length) skills.value = (await api(`/threads/${props.thread}/note`).catch(() => null))?.skills || []
}
async function pick(name) {
  try {
    rule.value = (await api(`/threads/${props.thread}/rule`, { method: 'PUT', body: { skill: name } }))?.rule || rule.value
    picking.value = false
  } catch (e) { err.value = e.message || '바꾸지 못했어요' }
}
</script>

<template>
  <div class="roomtop">
    <div v-if="rule" class="rule glass-thin" data-testid="room-rule">
      <div class="tx" :title="rule.said ? `정한 말: ${rule.said}` : ''"><b>이 방의 규칙</b><span class="sep">·</span><span data-no-i18n>{{ rule.action }}</span>
        <span class="sep">·</span>
        <button class="who press" data-testid="room-rule-skill" :aria-expanded="picking" @click="pickOpen">
          <template v-if="rule.skill">서버 브라우저: <span data-no-i18n>{{ rule.label || rule.skill }}</span></template><template v-else>에이전트가 처리</template>
        </button>
        <small v-if="rule.runs">{{ rule.runs }}번 실행</small></div>
      <button class="off press" data-testid="room-rule-off" @click="off">끄기</button>
    </div>
    <div v-if="rule && picking" class="pick glass-thin" role="listbox" data-testid="room-rule-picker">
      <button v-for="s in skills" :key="s.name" class="opt press" role="option" :aria-selected="rule.skill === s.name" :class="{ on: rule.skill === s.name }" data-testid="room-rule-pick" :data-skill="s.name" @click="pick(s.name)">서버 브라우저: <span data-no-i18n>{{ s.label }}</span></button>
      <button class="opt press" role="option" :aria-selected="!rule.skill" :class="{ on: !rule.skill }" data-testid="room-rule-pick" data-skill="" @click="pick('')">에이전트</button>
      <small v-if="err" class="err">{{ err }}</small>
    </div>
    <ProjectNote :thread="thread" />
  </div>
</template>

<style scoped>
.roomtop { display: flex; flex-direction: column; gap: 6px; margin-bottom: 4px; min-width: 0; }
.rule { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-radius: 18px; font-size: 13.5px; color: var(--text-primary); }
.tx { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 6px; line-height: 1.45; word-break: keep-all; overflow-wrap: anywhere; }
.tx b { font-weight: 600; }
.sep { color: var(--text-tertiary); }
.tx small { color: var(--text-tertiary); }
.who { font: inherit; color: var(--text-secondary); text-decoration: underline dotted; text-underline-offset: 3px; padding: 0; background: none; text-align: left; overflow-wrap: anywhere; }
.off { flex: none; height: 36px; padding: 0 14px; border-radius: 18px; background: var(--cell-bg); color: var(--text-primary); font-size: 13px; }
.pick { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px; border-radius: 16px; }
.opt { height: 32px; padding: 0 12px; border-radius: 16px; background: var(--cell-bg); color: var(--text-primary); font-size: 13px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.opt.on { background: var(--text-primary); color: var(--ink-inverse, #fff); }
.err { width: 100%; color: var(--color-error); font-size: 12.5px; }
</style>
