<script setup>
// A chat message's link to the mail it came from (server lib/mailFlow.js refOf): 「모닝 브리프」 under its summary, one chip per Home
// card the mails made; a line about one mail (메일에서 찾은 요청, 보낸 답장) under its bubble. A chip opens its card's mail sheet — the
// original, the reply, what the mail may start (MailReplySheet). Once the mail belongs to a process instance, the chip opens that
// instance's page instead, the way a scheduled run's chip opens its schedule (2026-11-24: 「스케줄이 칩으로 보여지듯 연관된 쓰레드를
// 표시」). In the instance's own conversation (event) a chip always opens the mail.
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import Icon from './Icon.vue'
import { useApp } from '../stores/app.js'
import { verbLabel } from '../mailKind.js'

const props = defineProps({ refs: { type: Array, default: () => [] }, event: { type: String, default: '' } })
const app = useApp()
const router = useRouter()
const err = ref('')
const busy = ref('')

// the instance a chip points to: the card on Home knows it at once (its update comes as an event), else what the message was told
const instOf = (r) => {
  if (props.event) return null
  const live = app.actions.find((a) => a.id === r.actionId)?.source?.inst
  return live?.instId ? { instId: live.instId, name: live.name || '' } : r.inst?.instId ? r.inst : null
}
// the chip's button word in the person's language, 「일정 추가」 for a calendar card — what the card is for as the card on Home knows
// it now (decided when its sheet was first opened), else as the message was told (src/mailKind.js)
const verbOf = (r) => {
  const card = app.actions.find((a) => a.id === r.actionId)
  return verbLabel(card || { verb: r.verb, source: { mail_id: r.mailId || r.actionId, ...(r.kind ? { kind: r.kind } : {}) } })
}
const chips = computed(() => props.refs.filter((r) => r && (r.actionId || r.mailId)).map((r) => {
  const inst = instOf(r)
  const label = inst ? `루틴 · ${inst.name || '진행 중인 일'}` : r.text || `메일 · ${r.subject || '(제목 없음)'}`
  return { r, inst, label, verb: inst ? '' : r.text ? verbOf(r) : '' }
}))

async function open(x) {
  err.value = ''
  if (x.inst) return router.push(`/routines/${encodeURIComponent(x.inst.instId)}`)
  busy.value = x.r.actionId || x.r.mailId
  try { await app.openMailCard(x.r, props.event ? 'instance' : 'chat') } catch (e) { err.value = e.message || '메일을 열지 못했어요' }
  busy.value = ''
}
</script>

<template>
  <div v-if="chips.length" class="mailchips" data-test="mail-chips">
    <button v-for="x in chips" :key="x.r.actionId || x.r.mailId" class="mchip press" :class="{ inst: !!x.inst, busy: busy && busy === (x.r.actionId || x.r.mailId) }"
      :data-test="x.inst ? 'mail-chip-inst' : 'mail-chip'" :title="x.label" @click="open(x)">
      <Icon :name="x.inst ? 'refresh' : 'mail'" :size="15" />
      <span v-if="x.verb" class="v" data-test="mail-chip-verb">{{ x.verb }}</span>
      <span class="t">{{ x.label }}</span>
      <Icon name="chevron" :size="13" />
    </button>
    <small v-if="err" class="err" data-test="mail-chip-error">{{ err }}</small>
  </div>
</template>

<style scoped>
.mailchips { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; margin-top: 6px; max-width: min(424px, 100%); min-width: 0; }
/* the same pill as a scheduled run's 「… 관리」 chip */
.mchip { display: inline-flex; align-items: center; gap: 7px; max-width: 100%; min-width: 0; min-height: 36px; padding: 0 14px; border-radius: 9999px;
  background: var(--regular-solid-bg); color: var(--text-primary); font-size: 14px; font-weight: 500; box-shadow: 0 2px 10px rgba(0 0 0 / .06); text-align: left; }
.mchip > :deep(svg) { flex: none; color: var(--text-secondary); }
.mchip .v { flex: none; height: 22px; line-height: 22px; padding: 0 6px; border-radius: 6px; background: var(--chip-bg); font-size: 12.5px; font-weight: 450; }
.mchip .t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mchip.busy { opacity: .6; }
.err { font-size: 12.5px; color: #c2410c; }
</style>
