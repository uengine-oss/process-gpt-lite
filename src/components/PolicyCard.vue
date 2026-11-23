<script setup>
// The card that follows an action through the policies (server lib/policy/pep.js): what was decided and why
// (the policies that matched, with their sources), and what happened — ran, ran and recorded with an undo
// window (Human-on-the-Loop), waits for an approver (Human-in-the-Loop), approved / rejected, or blocked.
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { api } from '../api.js'
import { isEnglish } from '../i18n/lang.js'

const props = defineProps({ msg: Object })
const c = computed(() => props.msg.content || {})
const pick = (pair) => (Array.isArray(pair) ? pair[isEnglish ? 1 : 0] : pair)
const now = ref(Date.now())
let timer = null
onMounted(() => { timer = setInterval(() => { now.value = Date.now() }, 15000) })
onUnmounted(() => clearInterval(timer))
const loc = isEnglish ? 'en-US' : 'ko-KR'
const time = (t) => new Date(t).toLocaleTimeString(loc, { hour: 'numeric', minute: '2-digit' })

const state = computed(() => {
  const s = c.value.status
  if (s === 'undone') return { cls: 'muted', text: '되돌렸어요' }
  if (s === 'failed') return { cls: 'bad', text: '실행하지 못했어요' }
  if (s === 'rejected') return { cls: 'bad', text: '반려됐어요' }
  if (s === 'blocked') return { cls: 'bad', text: '정책에 막혔어요' }
  if (s === 'pending') return { cls: 'wait', text: `${c.value.approver || '관리자'} 승인을 기다려요` }
  if (s === 'executed' && c.value.approvedBy) return { cls: 'ok', text: `${c.value.approvedBy} 님이 승인해 실행했어요` }
  if (s === 'executed' && c.value.decision === 'allow_audit') return { cls: 'audit', text: '실행하고 감사 기록에 남겼어요' }
  if (s === 'executed') return { cls: 'ok', text: '실행했어요' }
  return { cls: 'muted', text: s || '' }
})
const canUndo = computed(() => c.value.status === 'executed' && c.value.undoUntil && new Date(c.value.undoUntil).getTime() > now.value)
const noteText = (n) => (n.kind === 'tolerance' ? `허용 오차 안 (${Math.round(n.limit * (1 + n.over)).toLocaleString(loc)}까지)`
  : n.kind === 'window' ? `기간 안 ${n.count}번째 (${n.limit}건까지)` : '')
const busy = ref(false)
const err = ref('')
async function undo() {
  busy.value = true; err.value = ''
  try { await api(`/decisions/${c.value.decisionId}/undo`, { method: 'POST' }) } catch (e) { err.value = e.message } finally { busy.value = false }
}
</script>

<template>
  <div class="pc glass" :class="state.cls">
    <div class="hd"><span class="dot" /><b>{{ state.text }}</b></div>
    <p class="subj">{{ c.subject }}</p>
    <ul v-if="c.matched?.length" class="pol">
      <li v-for="m in c.matched" :key="m.id">
        <span class="chip" :class="m.decision">{{ { allow: '허용', allow_audit: '기록', require_approval: '승인 필요', deny: '차단' }[m.decision] }}</span>
        <span class="t">{{ pick(m.title) }}</span>
        <small v-if="m.explain">{{ pick(m.explain) }}</small>
        <small v-for="(n, i) in m.notes || []" :key="i" class="note">{{ noteText(n) }}</small>
        <small v-if="m.sources?.length" class="src">근거: {{ m.sources.join(' · ') }}</small>
      </li>
    </ul>
    <p v-if="c.note" class="note2">{{ c.note }}</p>
    <p v-if="c.error" class="err">{{ c.error }}</p>
    <div v-if="canUndo" class="row"><small>{{ time(c.undoUntil) }}까지 되돌릴 수 있어요</small><button class="pill-btn sm" :disabled="busy" @click="undo">되돌리기</button></div>
    <p v-if="err" class="err">{{ err }}</p>
  </div>
</template>

<style scoped>
.pc { border-radius: 18px; padding: 12px 14px; max-width: 520px; display: flex; flex-direction: column; gap: 6px; border-left: 4px solid rgba(0, 0, 0, .15); }
.pc.ok { border-left-color: #2e7d32; } .pc.audit { border-left-color: #1565c0; } .pc.wait { border-left-color: #e67e22; } .pc.bad { border-left-color: #c62828; }
.hd { display: flex; align-items: center; gap: 8px; font-size: 14.5px; }
.hd b { font-weight: 600; }
.dot { width: 8px; height: 8px; border-radius: 4px; background: currentColor; opacity: .5; }
.subj { margin: 0; font-size: 14px; color: var(--text-secondary); }
.pol { list-style: none; margin: 2px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.pol li { display: flex; flex-direction: column; gap: 2px; font-size: 13px; }
.pol .t { font-weight: 500; }
.pol small { color: var(--text-secondary); font-size: 12px; line-height: 1.45; }
.pol .src { color: var(--text-tertiary); }
.note { color: #1565c0 !important; }
.chip { align-self: flex-start; font-size: 11.5px; padding: 1px 8px; border-radius: 9px; background: rgba(0, 0, 0, .06); }
.chip.allow_audit { background: rgba(21, 101, 192, .12); color: #1565c0; }
.chip.require_approval { background: rgba(230, 126, 34, .15); color: #b35c00; }
.chip.deny { background: rgba(198, 40, 40, .12); color: #c62828; }
.row { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
.row small { color: var(--text-secondary); font-size: 12.5px; }
.pill-btn.sm { padding: 4px 12px; font-size: 13px; }
.note2 { margin: 0; font-size: 13px; color: var(--text-secondary); }
.err { margin: 0; color: #c62828; font-size: 13px; }
</style>
