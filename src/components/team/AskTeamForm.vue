<script setup>
// A request the AI sent for someone (server lib/askTeammate.js — 「AI 가 대신 묻는 중」), inside its messenger bubble. The one asked gets the
// small form while it is open (A2UI v1.0, the Lite step catalog, built by the server — A2uiSurface.vue): 보내기 fills the asker's draft,
// 잘 모르겠어요 tells them so. They may also just reply in the room. Everyone else sees the items and, once answered, the values.
import { computed, ref } from 'vue'
import A2uiSurface from '../a2ui/A2uiSurface.vue'
import { api } from '../../api.js'
import { useTeam } from '../../stores/team.js'

const props = defineProps({ m: Object })
const team = useTeam()
const ask = computed(() => props.m.ask || {})
const busy = ref(false)
const err = ref('')
const failed = ref(false)
const values = computed(() => (ask.value.fields || []).filter((f) => ask.value.values?.[f.key]).map((f) => ({ label: f.label, value: ask.value.values[f.key] })))
const stateText = computed(() => ({
  asked: ask.value.forMe ? '' : '답을 기다리고 있어요',
  late: ask.value.forMe ? '' : '아직 답이 없어요',
  answered: ask.value.forMe ? '보냈어요 · 고마워요' : `${ask.value.memberName}님이 답했어요`,
  unknown: ask.value.forMe ? '모른다고 보냈어요' : `${ask.value.memberName}님이 모른다고 했어요`,
  cancelled: '요청이 취소됐어요',
  superseded: '다시 물어본 요청으로 바뀌었어요',
}[ask.value.state] || ''))

async function submit({ values: v, a2ui }) {
  err.value = ''; busy.value = true
  try {
    const m = await api(`/team/asks/${props.m.id}/answer`, { method: 'POST', body: { values: v, a2ui } })
    // (the room's copy comes live too — server lib/team/messenger.js deliver; this one is mine at once)
    const list = team.msgs[props.m.threadId]
    const k = m?.id && list ? list.findIndex((y) => y.id === m.id) : -1
    if (k >= 0) list[k] = { ...list[k], ...m, reactions: list[k].reactions }
  } catch (e) { err.value = e.message } finally { busy.value = false }
}
</script>

<template>
  <div class="atf" data-testid="ask-team-form" :data-state="ask.state" :data-for-me="ask.forMe ? '1' : null">
    <template v-if="ask.surface && !failed">
      <A2uiSurface :message="ask.surface" :busy="busy" @submit="submit" @failed="failed = true" />
      <small class="hint">칸에 적어 보내거나 이 방에 답장으로 적어도 돼요.</small>
    </template>
    <p v-else-if="ask.forMe && ['asked', 'late'].includes(ask.state)" class="hint">이 방에 답을 적어 주세요.</p>
    <dl v-if="values.length" class="vals" data-testid="ask-team-form-values">
      <template v-for="it in values" :key="it.label"><dt>{{ it.label }}</dt><dd data-no-i18n>{{ it.value }}</dd></template>
    </dl>
    <p v-if="ask.state === 'unknown' && ask.note" class="note" data-no-i18n>「{{ ask.note }}」</p>
    <small v-if="stateText" class="st" data-testid="ask-team-form-state">{{ stateText }}</small>
    <small v-if="err" class="err" data-testid="ask-team-form-error">{{ err }}</small>
  </div>
</template>

<style scoped>
.atf { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; min-width: 0; }
/* (a teammate's bubble holds still for the reactions menu on a phone — its fields are still typed into and selected) */
.atf, .atf :deep(input), .atf :deep(textarea) { -webkit-user-select: text; user-select: text; -webkit-touch-callout: default; }
.hint, .st { font-size: 12.5px; color: var(--text-secondary); line-height: 1.5; }
.err { font-size: 12.5px; color: var(--color-error); }
.vals { display: grid; grid-template-columns: max-content 1fr; gap: 4px 10px; margin: 0; padding: 8px 10px; border-radius: 12px; background: var(--field-bg); font-size: 13.5px; }
.vals dt { color: var(--text-secondary); }
.vals dd { margin: 0; overflow-wrap: anywhere; }
.note { margin: 0; font-size: 13.5px; overflow-wrap: anywhere; }
</style>
