<script setup>
import { computed, onMounted, ref } from 'vue'
import Icon from './Icon.vue'
import { useApp } from '../stores/app.js'
import { uploadAttachment } from '../api.js'

// A mail's Home card, opened: the mail as it arrived, and a reply the person reads, changes and sends
// themselves (lib/mailReply.js). Nothing leaves before 보내기 — a card no longer hands the agent
// "reply to …" (2026-11-23: the agent's mail tool sent it at once, to the wrong address).
const props = defineProps({ action: Object })
const emit = defineEmits(['close'])
const app = useApp()
const id = props.action.id
const info = ref(null)          // {provider, mode, mail, files, to, reply, sent}
const loadErr = ref('')
const draft = ref(null)         // {to, cc, subject, body}
const drafting = ref(false)
const draftErr = ref('')
const picked = ref([])          // message ids of the documents made for this mail, to attach
const added = ref([])           // files the person adds: {uid, name, key, state, error}
const sending = ref(false)
const sendErr = ref('')
const sent = ref(null)
const whole = ref(false)        // the mail's whole text (a long one is folded)
const fileInput = ref(null)

// the reply is what this card is for: the triage's 「Reply」 verb, or the card that came with the
// documents made for the mail (「… 초안 검토하고 회신하기」) — the server's isReplyCard (lib/mailReply.js)
const replyCard = computed(() => props.action.verb === 'Reply' || !!props.action.source?.drafts?.length)
const mail = computed(() => info.value?.mail)
const who = (a) => (a ? (a.name ? `${a.name} <${a.address}>` : a.address) : '')
const when = computed(() => {
  const d = mail.value?.date && new Date(mail.value.date)
  return d && !isNaN(d) ? d.toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''
})
const long = computed(() => String(mail.value?.text || '').length > 600)
const uploading = computed(() => added.value.some((f) => f.state === 'up'))
const canSend = computed(() => draft.value && info.value?.mode !== 'none' && draft.value.to.trim() && draft.value.body.trim() && !sending.value && !uploading.value)

onMounted(async () => {
  try {
    info.value = await app.mailOfCard(id)
    picked.value = info.value.files.map((f) => f.messageId)
    if (info.value.sent) sent.value = info.value.sent
    else if (info.value.reply) draft.value = pick(info.value.reply)
    else if (replyCard.value) write()
  } catch (e) { loadErr.value = e.message }
})
const pick = (r) => ({ to: r.to || '', cc: r.cc || '', subject: r.subject || '', body: r.body || '' })

async function write() {
  drafting.value = true; draftErr.value = ''
  try { draft.value = pick((await app.draftReply(id)).reply) } catch (e) { draftErr.value = e.message }
  drafting.value = false
}

async function addFiles(e) {
  for (const file of [...(e.target.files || [])]) {
    const f = { uid: `${Date.now()}-${Math.random()}`, name: file.name, key: null, state: 'up', error: '' }
    added.value.push(f)
    uploadAttachment(file).then((r) => { const x = added.value.find((y) => y.uid === f.uid); if (x) Object.assign(x, { key: r.key, state: 'ok' }) })
      .catch((err) => { const x = added.value.find((y) => y.uid === f.uid); if (x) Object.assign(x, { state: 'err', error: err.message }) })
  }
  e.target.value = ''
}
function toggle(messageId) {
  picked.value = picked.value.includes(messageId) ? picked.value.filter((x) => x !== messageId) : [...picked.value, messageId]
}

async function send() {
  if (!canSend.value) return
  sending.value = true; sendErr.value = ''
  try {
    const files = [...picked.value.map((messageId) => ({ messageId })), ...added.value.filter((f) => f.key).map((f) => ({ key: f.key, name: f.name }))]
    sent.value = (await app.sendReply(id, { ...draft.value, files })).sent
  } catch (e) { sendErr.value = e.message }
  sending.value = false
}

function toAgent() { app.runAction(props.action); emit('close') }
</script>

<template>
  <Teleport to="body">
    <div class="veil" @click.self="emit('close')">
      <div class="sheet glass blur-in" role="dialog" :aria-label="action.text" data-test="mail-sheet">
        <header>
          <div>
            <span class="verb">{{ action.verb }}</span>
            <h2>{{ action.text }}</h2>
          </div>
          <button class="x press" aria-label="닫기" @click="emit('close')"><Icon name="close" :size="18" /></button>
        </header>

        <div class="body scroll">
          <p v-if="loadErr" class="err" data-test="mail-load-error">{{ loadErr }}</p>
          <p v-else-if="!info" class="wait shimmer-text">메일을 불러오는 중…</p>

          <section v-if="mail" class="orig" data-test="mail-original">
            <p class="cap">받은 메일</p>
            <div class="meta">
              <b>{{ who(mail.from) }}</b>
              <small v-if="when">{{ when }}</small>
            </div>
            <p class="subj">{{ mail.subject }}</p>
            <div class="text" :class="{ folded: long && !whole }" data-test="mail-text">{{ mail.text }}</div>
            <button v-if="long" class="more press" @click="whole = !whole">{{ whole ? '접기' : '전체 보기' }}</button>
            <div v-if="mail.attachments?.length" class="chips">
              <span v-for="a in mail.attachments" :key="a.name" class="chip"><Icon name="clip" :size="13" /> {{ a.name }}</span>
            </div>
          </section>

          <section v-if="sent" class="done" data-test="mail-sent">
            <Icon name="check" :size="18" />
            <div>
              <b>{{ sent.via === 'drafts' ? '임시 보관함에 넣었어요' : '답장을 보냈어요' }}</b>
              <small>{{ sent.to }} · {{ sent.subject }}</small>
              <small v-if="sent.via === 'drafts'">메일 앱의 임시 보관함에서 보내 주세요.</small>
            </div>
          </section>

          <section v-else-if="info" class="reply" data-test="mail-reply">
            <p class="cap">답장</p>
            <p v-if="drafting" class="wait shimmer-text" data-test="mail-drafting">답장 초안을 쓰는 중…</p>
            <p v-if="draftErr" class="err">{{ draftErr }}</p>
            <button v-if="!draft && !drafting" class="pill-btn sm write" data-test="mail-write" @click="write">답장 초안 쓰기</button>
            <template v-if="draft">
              <label class="field"><span>받는 사람</span><input v-model="draft.to" data-test="mail-to" autocomplete="off" /></label>
              <label class="field"><span>참조</span><input v-model="draft.cc" data-test="mail-cc" autocomplete="off" /></label>
              <label class="field"><span>제목</span><input v-model="draft.subject" data-test="mail-subject" /></label>
              <textarea v-model="draft.body" class="text-in" rows="11" data-test="mail-body" />
              <div class="chips">
                <button v-for="f in info.files" :key="f.messageId" class="chip pick press" :class="{ on: picked.includes(f.messageId) }"
                  data-test="mail-file" :aria-pressed="picked.includes(f.messageId)" @click="toggle(f.messageId)">
                  <Icon :name="picked.includes(f.messageId) ? 'check' : 'clip'" :size="13" /> {{ f.name }}
                </button>
                <span v-for="f in added" :key="f.uid" class="chip on" :class="{ bad: f.state === 'err' }" :title="f.error">
                  <Icon name="clip" :size="13" /> {{ f.name }}<i v-if="f.state === 'up'"> · 올리는 중</i><i v-if="f.state === 'err'"> · 올리지 못함</i>
                </span>
                <button class="chip add press" @click="fileInput.click()"><Icon name="plus" :size="13" /> 파일 첨부</button>
                <input ref="fileInput" type="file" multiple hidden @change="addFiles" />
              </div>
              <p v-if="info.mode === 'none'" class="err">Gmail에서 메일 보내기를 허락받지 않았어요. 설정에서 메일을 다시 연결하면 여기서 보낼 수 있어요.</p>
              <p v-if="sendErr" class="err" data-test="mail-send-error">{{ sendErr }}</p>
              <div class="row">
                <button class="pill-btn sm" :disabled="drafting || sending" @click="write">다시 쓰기</button>
                <button class="dark-btn sm" :disabled="!canSend" data-test="mail-send" @click="send">
                  {{ sending ? '보내는 중…' : info.mode === 'drafts' ? '임시 보관함에 넣기' : '보내기' }}
                </button>
              </div>
              <p class="hint">보내기를 누르기 전에는 아무것도 보내지 않아요.</p>
            </template>
          </section>

          <button v-if="info && !replyCard && !sent && action.status === 'open'" class="agent press" data-test="mail-agent" @click="toAgent">
            에이전트에게 맡기기 <small>{{ action.prompt }}</small>
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.veil { position: fixed; inset: 0; z-index: 200; background: rgba(0, 0, 0, .28); display: grid; place-items: center; padding: 16px; }
.sheet { width: min(720px, 100%); min-width: 0; box-sizing: border-box; max-height: min(90vh, 940px); border-radius: 28px; padding: 20px 22px 16px;
  display: flex; flex-direction: column; gap: 10px; background: var(--bubble-agent-bg); box-shadow: var(--shadow-card); }
header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
header > div { min-width: 0; }
.verb { display: inline-block; height: 28px; line-height: 28px; padding: 0 8px; border-radius: 8px; background: var(--chip-bg); font-size: 14px; }
h2 { margin: 6px 0 0; font-size: 18px; font-weight: 500; line-height: 1.45; overflow-wrap: anywhere; }
.x { width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; background: var(--field-bg); flex: none; }
.body { overflow: auto; min-height: 0; display: flex; flex-direction: column; gap: 14px; }
section { display: flex; flex-direction: column; gap: 6px; }
.cap { margin: 0; font-size: 12.5px; color: var(--text-secondary); letter-spacing: .02em; }
.orig { border-radius: 18px; padding: 12px 14px; background: var(--field-bg); }
.meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; font-size: 14px; overflow-wrap: anywhere; }
.meta small { color: var(--text-secondary); font-size: 12.5px; }
.subj { margin: 0; font-weight: 600; font-size: 15px; overflow-wrap: anywhere; }
.text { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14.5px; line-height: 1.6; }
.text.folded { max-height: 15em; overflow: hidden; -webkit-mask-image: linear-gradient(#000 70%, transparent); mask-image: linear-gradient(#000 70%, transparent); }
.more { align-self: flex-start; font-size: 13px; color: var(--text-secondary); padding: 2px 0; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; font-size: 12.5px; padding: 4px 10px; border-radius: 9999px; background: var(--field-bg); color: var(--text-secondary); overflow-wrap: anywhere; }
.chip.pick { border: 1px solid var(--hairline); }
.chip.on { color: var(--text-primary); background: var(--chip-bg); }
.chip.bad { color: #c2410c; }
.chip i { font-style: normal; color: var(--text-tertiary); }
.field { display: flex; align-items: center; gap: 10px; border-bottom: 1px solid var(--hairline); padding: 4px 0; }
.field span { flex: none; width: 64px; font-size: 13px; color: var(--text-secondary); }
.field input { flex: 1; min-width: 0; border: 0; background: transparent; font: inherit; font-size: 14.5px; color: var(--text-primary); padding: 6px 0; outline: none; }
.text-in { width: 100%; box-sizing: border-box; border: 1px solid var(--hairline); border-radius: 14px; padding: 10px 12px; font: inherit; font-size: 14.5px; line-height: 1.6;
  background: var(--field-bg); color: var(--text-primary); resize: vertical; min-height: 180px; }
.row { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
.sm { height: 42px; }
.write { align-self: flex-start; color: var(--text-primary); }
.pill-btn:disabled { opacity: .5; }
:root[data-theme="dark"] .dark-btn { background: #f5f5f7; color: #1d1d1f; }
.hint { margin: 0; text-align: right; font-size: 12px; color: var(--text-tertiary); }
.wait { margin: 0; font-size: 14px; color: var(--text-secondary); }
.err { margin: 0; font-size: 13.5px; color: #c2410c; overflow-wrap: anywhere; }
.done { flex-direction: row; align-items: flex-start; gap: 10px; border-radius: 18px; padding: 12px 14px; background: var(--chip-bg); }
.done div { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.done small { color: var(--text-secondary); font-size: 13px; overflow-wrap: anywhere; }
.agent { text-align: left; border-radius: 18px; padding: 12px 14px; background: var(--field-bg); font-size: 15px; color: var(--text-primary); display: flex; flex-direction: column; gap: 4px; }
.agent small { color: var(--text-secondary); font-size: 12.5px; line-height: 1.5; overflow-wrap: anywhere; }
@media (max-width: 520px) {
  .veil { padding: 8px; align-items: end; }
  .sheet { max-height: 94vh; border-radius: 24px; padding: 16px 16px 12px; }
}
</style>
