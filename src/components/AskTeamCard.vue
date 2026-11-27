<script setup>
// 팀원에게 물어 채우기 (server lib/askTeammate.js, skill skills/ask-teammate, spec openspec/specs/ask-teammate). Two kinds of chat card:
//   ask_team       — 「○○님께 메신저로 물어볼까요?」: who, why, the items, the words that would go — sent only when 물어보기 is pressed
//                    (고쳐서 물어보기: the words and the items changed first; 아니요: the person fills it in), then it follows the request
//                    (물어봤어요 · 아직 답이 없어요 · 답했어요 · 모른다고 했어요)
//   ask_team_reply — what came back, at the bottom of the chat: the values, the draft file's new version, the mail reply draft (never sent);
//                    a document (워드 · 한글 …) is filled only when the person presses 「문서에 채우기」 here, having seen the values
// 「고쳐서 물어보기」 changes everything that goes out: the reason (the form's first line too), the items, and the words — made again from the
// template as the reason and the items change, until the person writes the words themselves.
// Values are the teammate's words: shown as text (data-no-i18n).
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import Icon from './Icon.vue'
import { api } from '../api.js'
import { useApp } from '../stores/app.js'
import { useTeam } from '../stores/team.js'
import { openArtifact } from '../artifacts.js'

const props = defineProps({ msg: Object })
const app = useApp()
const team = useTeam()
const router = useRouter()
const c = computed(() => props.msg.content || {})
const a = computed(() => c.value.ask || {})
const reply = computed(() => props.msg.kind === 'ask_team_reply')
const name = computed(() => (reply.value ? c.value.member?.name : a.value.member?.name) || '')
const busy = ref('')
const err = ref('')
const done = ref('')
const editing = ref(false)
const draft = ref({ message: '', reason: '', fields: [], wrote: false })

function edit() {
  draft.value = { message: a.value.message || '', reason: a.value.reason || '', fields: (a.value.fields || []).map((f) => ({ key: f.key, label: f.label })), wrote: false }
  editing.value = true
}
// the words as the template makes them from the reason and the items now (the server makes them the same way when the person did not write them)
const made = computed(() => String(a.value.tpl || '{owner}\n{reason}\n{fields}').replace('{owner}', () => a.value.ownerName || '').replace('{reason}', () => draft.value.reason.trim())
  .replace('{fields}', () => draft.value.fields.filter((f) => f.label.trim()).map((f) => `- ${f.label.trim()}`).join('\n')))
const shown = computed(() => (editing.value && !draft.value.wrote ? made.value : draft.value.message))
function wrote(e) { draft.value.message = e.target.value; draft.value.wrote = true }
async function run(path, body, after) {
  err.value = ''; busy.value = path
  try {
    await api(`/asks/${reply.value ? c.value.card : props.msg.id}/${path}`, { method: 'POST', body: body || {} })
    if (after) done.value = after
    editing.value = false
  } catch (e) { err.value = e.message } finally { busy.value = '' }
}
const send = () => run('send', editing.value ? { reason: draft.value.reason, fields: draft.value.fields.filter((f) => f.label.trim()), ...(draft.value.wrote ? { message: draft.value.message } : {}) } : {})
const fillDoc = () => run('fill-doc', {})
const decline = () => run('decline', {}, '직접 채우기로 했어요.')
const again = () => run('again', {}, '다시 물어봤어요.')
const openRoom = () => team.openMessenger(a.value.room || c.value.room, a.value.chat || c.value.chat)
// the draft file's card (its newest version opens — the card's own address)
function openFile() {
  const id = (reply.value ? c.value.file?.msgId : a.value.file?.msgId)
  const m = Object.values(app.messages || {}).flat().find((x) => x?.id === id)
  if (m) openArtifact(app, router, m).catch(() => {})
}
const openMail = () => app.openMailCard({ actionId: c.value.mail?.actionId || a.value.actionId }, app.instance ? 'instance' : 'chat').catch(() => {})
// a long value next to 「문서에 채우기」: said plainly so the person reads it before an agent writes it into the document (its length only —
// the words are not read)
const LONG_VALUE = 120
const longValue = computed(() => (c.value.items || []).some((it) => String(it.value || '').length > LONG_VALUE))
const values = computed(() => (a.value.fields || []).filter((f) => a.value.values?.[f.key]).map((f) => ({ label: f.label, value: a.value.values[f.key] })))
const fileLine = computed(() => {
  const f = c.value.file
  if (!f) return ''
  if (f.state === 'filled') return `「${f.name}」의 빈칸 ${f.count}곳을 채워 새 판으로 저장했어요.${f.missing?.length ? ` 채우지 못한 항목: ${f.missing.join(', ')}` : ''}`
  if (f.state === 'doc') return `「${f.name}」은 문서라 바로 채우지 않았어요. 값을 확인하고 「문서에 채우기」를 누르면 에이전트가 이 문서만 채워요.`
  if (f.state === 'running') return `에이전트가 「${f.name}」을 채우고 있어요.`
  if (f.state === 'agent_done') return `에이전트가 「${f.name}」을 채웠어요. 새 판을 확인해 주세요.`
  if (f.state === 'agent_failed') return `「${f.name}」을 채우지 못했어요. 값을 직접 넣어 주세요.`
  if (f.state === 'conflict') return `「${f.name}」이 그사이 바뀌어 채우지 못했어요. 값을 직접 넣어 주세요.`
  if (f.state === 'none') return `「${f.name}」에서 채울 빈칸을 찾지 못했어요. 값을 직접 넣어 주세요.`
  return `「${f.name || '초안 파일'}」은 직접 채워 주세요.`
})
const mailLine = computed(() => {
  const m = c.value.mail
  if (!m) return ''
  if (m.sent) return '이 메일에는 이미 답장을 보냈어요.'
  if (m.count) return `메일 답장 초안의 빈칸 ${m.count}곳도 채웠어요. 직접 보내 주세요.`
  if (m.conflict) return '메일 답장 초안이 그사이 바뀌어 채우지 못했어요. 값을 직접 넣어 주세요.'
  return m.draft ? '메일 답장 초안에서는 채울 빈칸을 찾지 못했어요.' : '답을 메일 카드에 남겼어요. 「답장도 쓰기」로 초안을 쓰면 이 값이 들어가요.'
})
const stateLine = computed(() => ({
  sending: '보내는 중…',
  asked: `${name.value}님께 메신저로 물어봤어요. 답을 기다리고 있어요.`,
  late: '아직 답이 없어요.',
  answered: `${name.value}님이 답했어요.`,
  unknown: `${name.value}님이 모른다고 했어요.`,
  declined: '직접 채우기로 했어요.',
}[c.value.state] || ''))
</script>

<template>
  <!-- what came back -->
  <div v-if="reply" class="at glass" data-testid="ask-team-reply" :data-mode="c.mode" :data-card="c.card">
    <div class="hd"><span class="badge"><Icon name="chat" :size="13" />팀원에게 묻기</span><b>{{ c.text }}</b></div>
    <template v-if="c.mode === 'answered'">
      <dl class="vals" data-testid="ask-team-values">
        <template v-for="it in c.items || []" :key="it.label"><dt>{{ it.label }}</dt><dd data-no-i18n>{{ it.value }}</dd></template>
      </dl>
      <p v-if="c.note" class="note">덧붙인 말: <span data-no-i18n>「{{ c.note }}」</span></p>
      <p v-if="fileLine" class="line" data-testid="ask-team-file" :data-state="c.file?.state"><Icon name="doc" :size="14" />{{ fileLine }}</p>
      <p v-if="mailLine" class="line" data-testid="ask-team-mail"><Icon name="mail" :size="14" />{{ mailLine }}</p>
      <small class="sub">메일은 보내지 않았어요.</small>
      <div class="btns">
        <button v-if="c.file?.state === 'doc'" class="pill yes press" :disabled="!!busy" data-testid="ask-team-fill-doc" @click="fillDoc">{{ busy === 'fill-doc' ? '시작하는 중…' : '문서에 채우기' }}</button>
        <small v-if="c.file?.state === 'doc' && longValue" class="warn" data-testid="ask-team-long">값이 길어요 — 내용을 확인하고 채우세요</small>
        <button v-if="c.file?.msgId && ['filled', 'none', 'doc', 'running', 'agent_done', 'conflict'].includes(c.file.state)" class="pill press" data-testid="ask-team-open-file" @click="openFile">초안 열기</button>
        <button v-if="c.mail?.actionId" class="pill press" data-testid="ask-team-open-mail" @click="openMail">메일 열기</button>
      </div>
    </template>
    <template v-else-if="c.mode === 'unknown'">
      <p class="note" data-no-i18n data-testid="ask-team-note">「{{ c.note || '…' }}」</p>
      <div v-if="!done" class="btns">
        <button class="pill press" :disabled="!!busy" data-testid="ask-team-again" @click="again">다시 묻기</button>
        <button class="pill press" :disabled="!!busy" data-testid="ask-team-decline" @click="decline">직접 채우기</button>
      </div>
    </template>
    <template v-else-if="c.mode === 'late'">
      <small class="sub">하루가 지났어요. 다시 물어보거나 직접 채울 수 있어요.</small>
      <div v-if="!done" class="btns">
        <button class="pill yes press" :disabled="!!busy" data-testid="ask-team-again" @click="again">{{ busy === 'again' ? '묻는 중…' : '다시 묻기' }}</button>
        <button class="pill press" :disabled="!!busy" data-testid="ask-team-decline" @click="decline">직접 채우기</button>
      </div>
    </template>
    <small v-if="done" class="sub" data-testid="ask-team-done">{{ done }}</small>
    <small v-if="err" class="err" data-testid="ask-team-error">{{ err }}</small>
  </div>

  <!-- the offer, and then the request it became -->
  <div v-else class="at glass" data-testid="ask-team-card" :data-state="c.state" :data-card="msg.id">
    <div class="hd"><span class="badge"><Icon name="chat" :size="13" />팀원에게 묻기</span><b>{{ c.text }}</b></div>
    <p v-if="!editing" class="why"><span class="k">묻는 이유</span>{{ a.reason }}</p>
    <label v-else class="why"><span class="k">묻는 이유</span><input v-model="draft.reason" class="rin" maxlength="300" data-testid="ask-team-reason-input" /></label>
    <div class="items">
      <span class="k">물어볼 항목</span>
      <template v-if="!editing">
        <span v-for="f in a.fields || []" :key="f.key" class="chip" data-testid="ask-team-item">{{ f.label }}</span>
      </template>
      <template v-else>
        <span v-for="(f, i) in draft.fields" :key="f.key" class="chip edit">
          <input v-model="f.label" :aria-label="`항목 ${i + 1}`" maxlength="40" data-testid="ask-team-item-input" />
          <button v-if="draft.fields.length > 1" class="x" aria-label="빼기" @click="draft.fields.splice(i, 1)">×</button>
        </span>
      </template>
    </div>
    <p v-if="a.file?.name" class="why"><span class="k">채울 파일</span><button class="flink press" @click="openFile">{{ a.file.name }}</button></p>
    <div v-if="c.state === 'offered'" class="pv">
      <span class="k">{{ name }}님께 보낼 메시지</span>
      <textarea v-if="editing" :value="shown" rows="6" maxlength="2000" data-testid="ask-team-message-input" @input="wrote" />
      <p v-else class="msg" data-testid="ask-team-preview">{{ a.message }}</p>
    </div>
    <dl v-if="c.state === 'answered' && values.length" class="vals">
      <template v-for="it in values" :key="it.label"><dt>{{ it.label }}</dt><dd data-no-i18n>{{ it.value }}</dd></template>
    </dl>
    <p v-if="c.state === 'unknown' && a.note" class="note" data-no-i18n>「{{ a.note }}」</p>
    <template v-if="c.state === 'offered'">
      <div class="btns">
        <button class="pill yes press" :disabled="!!busy" data-testid="ask-team-send" @click="send">{{ busy === 'send' ? '보내는 중…' : editing ? '이대로 물어보기' : '물어보기' }}</button>
        <button v-if="!editing" class="pill press" :disabled="!!busy" data-testid="ask-team-edit" @click="edit">고쳐서 물어보기</button>
        <button v-else class="pill press" :disabled="!!busy" @click="editing = false">취소</button>
        <button class="pill press" :disabled="!!busy" data-testid="ask-team-decline" @click="decline">아니요(직접 채울게요)</button>
      </div>
      <small class="sub">물어보기를 누르기 전에는 아무에게도 보내지 않아요. {{ name }}님과의 1:1 대화방에 내 이름으로 보내요.</small>
    </template>
    <template v-else>
      <p class="state" data-testid="ask-team-state">{{ stateLine }}</p>
      <div v-if="['asked', 'late', 'unknown'].includes(c.state)" class="btns">
        <button v-if="a.room" class="pill press" data-testid="ask-team-room" @click="openRoom">메신저에서 보기</button>
        <button v-if="c.state !== 'asked'" class="pill press" :disabled="!!busy" data-testid="ask-team-again" @click="again">다시 묻기</button>
        <button class="pill press" :disabled="!!busy" data-testid="ask-team-decline" @click="decline">직접 채우기</button>
      </div>
    </template>
    <small v-if="err" class="err" data-testid="ask-team-error">{{ err }}</small>
  </div>
</template>

<style scoped>
.at { width: 424px; max-width: 100%; box-sizing: border-box; border-radius: 24px; padding: 16px 18px 14px; display: flex; flex-direction: column; gap: 10px; --regular-bg: var(--bubble-agent-bg); animation: blur-in .4s var(--spring, ease) both; }
.hd { display: flex; flex-direction: column; gap: 6px; }
.hd b { font-size: 16px; line-height: 1.45; font-weight: 600; word-break: keep-all; overflow-wrap: anywhere; }
.badge { align-self: flex-start; display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 10px; border-radius: 9999px; background: var(--field-bg); color: var(--text-secondary); font-size: 12.5px; font-weight: 500; }
.k { display: block; font-size: 12px; color: var(--text-tertiary, var(--text-secondary)); margin-bottom: 3px; }
.why { margin: 0; font-size: 14.5px; line-height: 1.55; word-break: keep-all; overflow-wrap: anywhere; }
.items { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.items .k { width: 100%; margin: 0; }
.chip { display: inline-flex; align-items: center; gap: 4px; min-height: 30px; padding: 0 12px; border-radius: 9999px; background: var(--field-bg); font-size: 14px; max-width: 100%; overflow-wrap: anywhere; }
.chip.edit { padding: 0 6px 0 4px; }
.chip input { width: 9em; max-width: 60vw; height: 28px; border: 0; background: transparent; color: var(--text-primary); font: inherit; padding: 0 6px; outline: none; }
.chip .x { width: 22px; height: 22px; border-radius: 50%; color: var(--text-secondary); font-size: 16px; line-height: 1; }
.flink { padding: 0; background: none; color: var(--text-primary); text-decoration: underline; text-underline-offset: 3px; font-size: 14.5px; text-align: left; overflow-wrap: anywhere; }
.pv { display: flex; flex-direction: column; }
.msg { margin: 0; padding: 10px 12px; border-radius: 14px; background: var(--field-bg); font-size: 14px; line-height: 1.55; white-space: pre-line; overflow-wrap: anywhere; }
.rin { width: 100%; box-sizing: border-box; height: 36px; padding: 0 12px; border-radius: 12px; border: 0; background: var(--field-bg); color: var(--text-primary); font: inherit; font-size: 14.5px; outline: none; }
textarea { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 14px; border: 0; background: var(--field-bg); color: var(--text-primary); font: inherit; font-size: 14px; line-height: 1.55; resize: vertical; outline: none; }
.vals { display: grid; grid-template-columns: max-content 1fr; gap: 6px 12px; margin: 0; padding: 10px 12px; border-radius: 14px; background: var(--field-bg); font-size: 14px; }
.vals dt { color: var(--text-secondary); }
.vals dd { margin: 0; overflow-wrap: anywhere; }
.note { margin: 0; font-size: 14px; line-height: 1.5; overflow-wrap: anywhere; }
.line { margin: 0; display: flex; gap: 6px; align-items: flex-start; font-size: 14px; line-height: 1.5; overflow-wrap: anywhere; }
.line :deep(svg) { flex: none; margin-top: 3px; }
.state { margin: 0; font-size: 14.5px; }
.btns { display: flex; flex-wrap: wrap; gap: 6px; }
.pill { height: 36px; padding: 0 15px; border-radius: 9999px; background: var(--regular-solid-bg, var(--field-bg)); color: var(--text-primary); font-size: 14px; font-weight: 500; box-shadow: 0 2px 10px rgba(0 0 0 / .06); }
.pill.yes { background: var(--ink, #1d1d1f); color: var(--ink-inverse, #f5f5f7); }
.pill:disabled { opacity: .55; }
.sub { font-size: 12.5px; color: var(--text-secondary); line-height: 1.5; }
.err { font-size: 12.5px; color: var(--color-error); }
.warn { align-self: center; font-size: 12.5px; color: var(--color-error); }
</style>
