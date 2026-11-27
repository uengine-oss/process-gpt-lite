<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'
import { api } from '../api.js'

// 「보낼 메일」 — a mail the agent wrote for the person (server lib/mailOut.js, the agent's send_mail_as_me). Nothing leaves until they press
// 보내기 here; it goes out from the mailbox THEY connected (the sender is read from the server every time, never taken from the card), and a
// reply goes in the thread of the mail it answers. No mailbox, or Gmail without permission to send: 연결하기 · 초안으로 두기.
// What the card shows is what leaves: everything is shown before 보내기 (the body whole, each file with its size and where it came from),
// it is drawn from the server's view, and 보내기 brings back that view's confirmation — an edit is saved on the card first.
// (2026-11-27 production: asked 「이렇게 보내」, the agent mailed a customer from the company's shared sending address, as a new mail)
const props = defineProps({ msg: Object })
const emit = defineEmits(['connect'])
const out = computed(() => props.msg.content?.mail_out || {})
const state = computed(() => out.value.state || 'pending')
const view = ref(null)
const editing = ref(false)
const draft = ref({ to: '', cc: '', subject: '', body: '' })
const busy = ref('')
const err = ref('')
const unfold = ref(false)

async function load() {
  try { view.value = await api(`/mail-out/${encodeURIComponent(props.msg.id)}`); err.value = '' } catch (e) { err.value = e.message }
}
onMounted(load)
// (the card changed on the server — an edit, a state — : what is shown is read again, with its new confirmation)
const sig = computed(() => JSON.stringify([out.value.state, out.value.to, out.value.cc, out.value.subject, out.value.body, out.value.edited_at]))
watch(sig, load)
// connecting the mail happens in a sheet or another tab: the sender is read again when the page comes back to the front
const onFocus = () => { if (['pending', 'kept', 'unknown'].includes(state.value)) load() }
onMounted(() => { window.addEventListener('focus', onFocus); document.addEventListener('visibilitychange', onFocus) })
onBeforeUnmount(() => { window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onFocus) })

const v = computed(() => view.value || {})
const mode = computed(() => view.value?.mode || null)
const cantSend = computed(() => mode.value === 'connect' || mode.value === 'none')
const sendLabel = computed(() => (mode.value === 'drafts' ? '임시 보관함에 넣기' : '보내기'))
const thread = computed(() => v.value.reply || null)
const noRecipient = computed(() => !!view.value && !String(v.value.to || '').trim())
const blocked = computed(() => !view.value || noRecipient.value || !!v.value.answered || editing.value || !v.value.confirm)
const sizeText = (n) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
const ORIGIN = { upload: '내가 올린 파일', draft: '이 메일을 위해 만든 초안' }

function edit() {
  draft.value = { to: v.value.to || '', cc: v.value.cc || '', subject: v.value.subject || '', body: v.value.body || '' }
  editing.value = true
}
async function act(what, body) {
  busy.value = what
  err.value = ''
  try {
    const r = await api(`/mail-out/${encodeURIComponent(props.msg.id)}/${what}`, { method: 'POST', ...(body ? { body } : {}) })
    if (what === 'edit') { view.value = r; editing.value = false }
  } catch (e) {
    err.value = e.message
    // the mailbox or the card changed under it (disconnected, permission taken back, changed since shown): show what it is now
    if (['mail_not_connected', 'gmail_scope', 'stale', 'already_answered', 'send_unknown'].includes(e.code)) load()
  } finally { busy.value = '' }
}
const save = () => act('edit', draft.value)
const send = () => act('send', { confirm: v.value.confirm })
function connect() { emit('connect') }
</script>

<template>
  <!-- sent / put in Drafts -->
  <div v-if="state === 'sent' || state === 'drafted'" class="mo done glass" data-test="mail-out" :data-state="state">
    <Icon name="check" :size="18" />
    <div class="txt">
      <b data-test="mail-out-state">{{ state === 'drafted' ? '임시 보관함에 넣었어요 · 메일 앱에서 보내 주세요' : out.sent?.checked ? '보낸 편지함에서 확인했어요' : '보냈어요' }}</b>
      <small data-test="mail-out-sent"><span data-no-i18n>{{ out.sent?.from }}</span> → <span data-no-i18n>{{ out.sent?.to }}</span></small>
      <small><span data-no-i18n>{{ out.sent?.subject }}</span> · {{ out.sent?.thread ? '받은 메일의 스레드에 이어서' : '새 메일로' }}</small>
    </div>
  </div>
  <!-- the send got no answer in time: it may have left — check the Sent folder before anything else -->
  <div v-else-if="state === 'unknown'" class="mo glass" data-test="mail-out" data-state="unknown">
    <div class="h"><Icon name="alert" :size="17" /><b data-test="mail-out-state">보냈는지 확인하지 못했어요</b><span class="sub" data-no-i18n>{{ out.subject }}</span></div>
    <p class="notice">보낸 편지함을 확인해 주세요. 다시 보내면 중복으로 갈 수 있어 「보내기」를 막아 두었어요.</p>
    <p v-if="err" class="err" data-test="mail-out-err">{{ err }}</p>
    <div class="row">
      <button class="pill-btn sm" :disabled="!!busy" data-test="mail-out-not-sent" @click="act('resolve', { sent: false })">보내지 못했어요</button>
      <button class="dark-btn sm" :disabled="!!busy" data-test="mail-out-was-sent" @click="act('resolve', { sent: true })">보낸 편지함에 있어요</button>
    </div>
  </div>
  <!-- dropped, or replaced by a corrected draft further down -->
  <div v-else-if="state === 'cancelled' || state === 'replaced'" class="mo gone" data-test="mail-out" :data-state="state">
    <Icon name="mail" :size="15" /> <span data-test="mail-out-state">{{ state === 'replaced' ? '고친 초안이 아래에 있어요' : '보내지 않기로 했어요' }}</span> · <span data-no-i18n>{{ out.subject }}</span>
  </div>
  <!-- kept as a draft: nothing left -->
  <div v-else-if="state === 'kept'" class="mo kept glass" data-test="mail-out" data-state="kept">
    <div class="h"><Icon name="mail" :size="17" /><b data-test="mail-out-state">초안으로 두었어요</b><span class="sub" data-no-i18n>{{ out.subject }}</span></div>
    <pre class="body" :class="{ folded: !unfold }" data-test="mail-out-body" data-no-i18n>{{ out.body }}</pre>
    <div class="row">
      <button class="more press" @click="unfold = !unfold">{{ unfold ? '접기' : '본문 모두 보기' }}</button>
      <button class="pill-btn sm" :disabled="!!busy" data-test="mail-out-reopen" @click="act('reopen')">다시 열기</button>
    </div>
  </div>
  <!-- pending (or being sent): everything that will leave, in full -->
  <div v-else class="mo glass" data-test="mail-out" :data-state="state">
    <div class="h">
      <Icon name="mail" :size="17" /><b>보낼 메일</b>
      <span class="badge" data-test="mail-out-gate">{{ cantSend ? '아직 보낼 수 없어요' : `「${sendLabel}」를 눌러야 나가요` }}</span>
    </div>
    <div class="f" data-test="mail-out-from"><span>보낸 사람</span><b v-if="v.from" data-no-i18n>{{ v.from }}</b><i v-else-if="view">연결된 내 메일이 없어요</i><i v-else>…</i></div>
    <template v-if="!editing">
      <div class="f" data-test="mail-out-to"><span>받는 사람</span><b v-if="v.to" data-no-i18n>{{ v.to }}</b><i v-else-if="view" class="warn">받는 사람이 없어요</i><i v-else>…</i></div>
      <div v-if="v.cc" class="f" data-test="mail-out-cc"><span>참조</span><b data-no-i18n>{{ v.cc }}</b></div>
      <div class="f" data-test="mail-out-subject"><span>제목</span><b data-no-i18n>{{ v.subject || '—' }}</b></div>
    </template>
    <template v-else>
      <label class="f"><span>받는 사람</span><input v-model="draft.to" data-test="mail-out-to-input" /></label>
      <label class="f"><span>참조</span><input v-model="draft.cc" data-test="mail-out-cc-input" /></label>
      <label class="f"><span>제목</span><input v-model="draft.subject" data-test="mail-out-subject-input" /></label>
    </template>
    <div class="f" data-test="mail-out-thread"><span>스레드</span>
      <b v-if="thread"><span data-no-i18n>「{{ thread.subject }}」</span>에 이어서<small v-if="thread.from" data-no-i18n> · {{ thread.from }}</small>
        <small v-if="thread.by === 'subject'" class="by" data-test="mail-out-found-by"> · 제목과 받는 사람으로 찾은 메일이에요</small></b>
      <i v-else-if="v.replyNotFound" class="warn" data-test="mail-out-reply-missing">답장할 메일을 내 메일함에서 찾지 못해 새 메일로 보내요</i>
      <i v-else>새 메일</i>
    </div>
    <p v-if="thread?.replyTo" class="flag" data-test="mail-out-replyto">답장받을 주소(Reply-To)가 보낸 사람 주소와 달라요: <span data-no-i18n>{{ thread.replyTo }}</span></p>
    <p v-if="thread?.outsider" class="flag" data-test="mail-out-outsider">받는 사람이 이 메일을 주고받은 사람이 아니에요.</p>
    <div v-if="(v.files || []).length || (v.missing || []).length" class="f files" data-test="mail-out-files"><span>첨부</span>
      <span class="chips">
        <span v-for="f in v.files" :key="f.name" class="chip" data-test="mail-out-file"><Icon name="clip" :size="13" /> <span data-no-i18n>{{ f.name }}</span>
          <small><template v-if="f.size != null">{{ sizeText(f.size) }} · </template>{{ ORIGIN[f.origin] || '' }}</small></span>
        <span v-for="m in v.missing" :key="m.name" class="chip bad" data-test="mail-out-missing"><span data-no-i18n>{{ m.name }}</span> · 빼고 보내요({{ m.reason }})</span>
      </span>
    </div>
    <textarea v-if="editing" v-model="draft.body" class="text-in" rows="10" data-test="mail-out-body-input" />
    <pre v-else class="body" data-test="mail-out-body" data-no-i18n>{{ view ? v.body : out.body }}</pre>
    <p v-if="v.answered" class="notice" data-test="mail-out-answered">이 메일에는 이미 답장을 보냈어요. 보낸 편지함을 확인해 주세요.</p>
    <p v-if="noRecipient && !editing" class="notice" data-test="mail-out-no-to">받는 사람이 없어요. 「고치기」를 눌러 받는 사람을 적어 주세요.</p>
    <p v-if="mode === 'connect'" class="notice" data-test="mail-out-notice">메일을 연결하면 내 계정으로 보낼 수 있어요.</p>
    <p v-else-if="mode === 'none'" class="notice" data-test="mail-out-notice">Gmail의 메일 전송 권한이 없어요. 메일을 다시 연결하면 내 계정으로 보낼 수 있어요.</p>
    <p v-else-if="v.provider === 'demo'" class="hint" data-test="mail-out-notice">데모 메일함이라 실제로 보내지 않고 기록만 해요.</p>
    <p v-else-if="mode === 'drafts'" class="hint" data-test="mail-out-notice">이 메일함에서는 바로 보낼 수 없어서 임시 보관함에 넣어요. 메일 앱에서 보내 주세요.</p>
    <p v-if="err" class="err" data-test="mail-out-err">{{ err }}</p>
    <div class="row">
      <template v-if="editing">
        <button class="pill-btn sm ghost" :disabled="!!busy" data-test="mail-out-edit-cancel" @click="editing = false">취소</button>
        <button class="dark-btn sm" :disabled="!!busy" data-test="mail-out-save" @click="save">저장</button>
      </template>
      <template v-else-if="cantSend">
        <button class="pill-btn sm" :disabled="!!busy" data-test="mail-out-keep" @click="act('keep')">초안으로 두기</button>
        <button class="dark-btn sm" :disabled="!!busy" data-test="mail-out-connect" @click="connect">{{ mode === 'none' ? '다시 연결하기' : '연결하기' }}</button>
      </template>
      <template v-else>
        <button class="pill-btn sm ghost" :disabled="!!busy || state === 'sending'" data-test="mail-out-cancel" @click="act('cancel')">그만두기</button>
        <button class="pill-btn sm" :disabled="!!busy || state === 'sending' || !view" data-test="mail-out-edit" @click="edit">고치기</button>
        <button class="dark-btn sm" :disabled="!!busy || state === 'sending' || blocked" data-test="mail-out-send" @click="send">
          {{ busy === 'send' || state === 'sending' ? '보내는 중…' : sendLabel }}
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.mo { width: 460px; max-width: 100%; box-sizing: border-box; border-radius: 22px; padding: 16px 16px 12px; display: flex; flex-direction: column; gap: 6px; --regular-bg: var(--bubble-agent-bg); }
.h { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 15px; margin-bottom: 4px; }
.h .sub { color: var(--text-secondary); font-size: 13.5px; overflow-wrap: anywhere; }
.badge { margin-left: auto; font-size: 12px; color: var(--text-secondary); background: var(--chip-bg); border-radius: 9999px; padding: 3px 10px; }
.f { display: flex; align-items: baseline; gap: 10px; border-bottom: 1px solid var(--hairline); padding: 5px 0; font-size: 14px; min-width: 0; }
.f > span:first-child { flex: none; width: 64px; font-size: 12.5px; color: var(--text-secondary); }
.f b { font-weight: 500; min-width: 0; overflow-wrap: anywhere; }
.f b small { color: var(--text-secondary); font-weight: 400; }
.f i { font-style: normal; color: var(--text-secondary); font-size: 13.5px; }
.f i.warn { color: #c2410c; }
.f input { flex: 1; min-width: 0; border: 0; background: transparent; font: inherit; font-size: 14px; color: var(--text-primary); padding: 4px 0; outline: none; }
.files .chips { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
.chip { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; font-size: 12.5px; padding: 3px 10px; border-radius: 9999px; background: var(--field-bg); overflow-wrap: anywhere; flex-wrap: wrap; }
.chip small { color: var(--text-secondary); }
.chip.bad { color: #c2410c; }
.flag { margin: 2px 0 0; font-size: 13px; color: #c2410c; overflow-wrap: anywhere; }
.body { margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; font-size: 14px; line-height: 1.6; }
.body.folded { max-height: 200px; overflow: hidden; -webkit-mask-image: linear-gradient(#000 70%, transparent); mask-image: linear-gradient(#000 70%, transparent); }
.more { align-self: center; margin-right: auto; font-size: 13px; color: var(--text-secondary); padding: 2px 0; }
.text-in { width: 100%; box-sizing: border-box; border: 1px solid var(--hairline); border-radius: 14px; padding: 10px 12px; font: inherit; font-size: 14px; line-height: 1.6;
  background: var(--field-bg); color: var(--text-primary); resize: vertical; min-height: 180px; margin-top: 6px; }
.notice { margin: 6px 0 0; font-size: 13.5px; color: #c2410c; }
.hint { margin: 6px 0 0; font-size: 12.5px; color: var(--text-secondary); }
.err { margin: 4px 0 0; font-size: 13px; color: #c2410c; overflow-wrap: anywhere; }
.row { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.sm { height: 40px; padding: 0 16px; }
.ghost { background: transparent; }
.pill-btn:disabled, .dark-btn:disabled { opacity: .5; }
:root[data-theme="dark"] .dark-btn { background: #f5f5f7; color: #1d1d1f; }
.done { flex-direction: row; align-items: flex-start; gap: 10px; }
.done .txt { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.done small { color: var(--text-secondary); font-size: 13px; overflow-wrap: anywhere; }
.gone { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-secondary); padding: 6px 12px; border-radius: 9999px; background: var(--chip-bg); max-width: 100%; overflow-wrap: anywhere; }
</style>
