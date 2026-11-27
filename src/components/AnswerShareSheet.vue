<script setup>
// 답을 공유 (2026-11-27 22:33 휴대폰 녹화: 「텍스트 결과가 나왔을 때 이것을 어딘가에 … 공유한다든지 하는 기능이 지금 존재하지 않아」 — spec answer-share,
// server lib/answerShare.js). Opened by an answer's 「공유」 (Message.vue) or by holding / right-clicking the answer (its message menu):
//   menu   대화방 · 사람에게 보내기 · 다른 앱으로 보내기(the phone's share sheet — where there is one) · 문서로 남기기 · 프로젝트로 시작 · 복사
//   room   the conversations (the ones answers of this chat went to before first, with why) and the teammates with no conversation yet
//   send   where it goes, what that room will see (the answer's title and words — no file, no mail body), a word to say, 보내기
//   sent   「…」에 공유했어요 · 방 열기
// Nothing goes anywhere before 보내기. A document: the answer as a Markdown file card under it (once) — from there the file's own 공유,
// 내려받기 and IeumOffice.
import { computed, ref, onMounted, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import Icon from './Icon.vue'
import PersonAvatar from './PersonAvatar.vue'
import { useApp } from '../stores/app.js'
import { useTeam } from '../stores/team.js'
import { openArtifact } from '../artifacts.js'
import { hidePaths } from '../paths.js'
import { startProjectFrom, canShareOut } from '../answerActions.js'

const app = useApp()
const team = useTeam()
const router = useRouter()
const msg = computed(() => app.answerShare?.msg || null)
const step = ref(app.answerShare?.step || 'menu')
const myId = computed(() => app.me?.user?.id || null)
const text = computed(() => hidePaths(String(msg.value?.content?.text || '')))
const title = computed(() => {
  const lines = text.value.split('\n').map((l) => l.trim()).filter(Boolean)
  const head = msg.value?.kind === 'doc' ? lines[0] : lines.find((l) => /^#{1,6}\s/.test(l)) || lines[0]
  const t = String(head || '').replace(/^#{1,6}\s*/, '').replace(/[*_`>|]/g, '').trim()
  return t.length > 60 ? `${t.slice(0, 59)}…` : t
})
// (the answer as it goes — its title, its first lines, whether it is cut — is the server's: the paths and private addresses taken out
// as they will be in the room, lib/answerShare.js; until the rooms come, the screen's own reading)
const sentTitle = computed(() => data.value?.answer?.title || title.value)
const preview = computed(() => data.value?.answer?.preview ?? text.value.split('\n').map((l) => l.trim()).filter(Boolean).slice(msg.value?.kind === 'doc' ? 1 : 0).slice(0, 4)
  .map((l) => l.replace(/^#{1,6}\s*|^>\s*/, '').replace(/\*\*|__|`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')).join(' ').slice(0, 220))

// a dialog of its own: the focus goes into it, Esc closes it (only while the focus is in it — not another sheet's Esc)
const sheet = ref(null)
const close = () => { app.answerShare = null }
onMounted(async () => {
  if (step.value === 'room') loadRooms()
  // (the words as they may leave the chat — 「글 복사」 and 「다른 앱으로 보내기」 alike: asked for at once, on every screen)
  loadOut().catch(() => {})
  await nextTick()
  ;(sheet.value?.querySelector('[role="menuitem"], input, textarea, button') || sheet.value)?.focus?.()
})

// ---------- menu ----------
const docBusy = ref(false)
const doc = ref(null)       // the file card it became
const copied = ref(false)
const err = ref('')
async function saveDoc() {
  if (docBusy.value) return
  docBusy.value = true; err.value = ''
  try { doc.value = (await app.saveAnswerDoc(msg.value.id)).message } catch (e) { err.value = e.message } finally { docBusy.value = false }
}
function openDoc() { const d = doc.value; close(); if (d) openArtifact(app, router, d).catch(() => {}) }
// 「글 복사」: the server's cleaned words (out.text — the whole answer, its Markdown as it is: no signed or storage address, no key on the
// clipboard), never the page's own reading of the answer. Pressed before they came, it waits for them (3 s at most) — and keeps the press:
// where the clipboard takes a ClipboardItem whose words are still coming (Safari asks the write to start in the press itself), it starts there
// with the words to come; elsewhere it writes once they are here. They did not come (a slow line, the server failing): nothing is copied and
// the sheet says so — a press again asks again (PR #123 review).
const COPY_WAIT_MS = 3000
const within = (p, ms) => new Promise((ok, no) => {
  const t = setTimeout(() => no(new Error('timeout')), ms)
  p.then((v) => { clearTimeout(t); ok(v) }, (e) => { clearTimeout(t); no(e) })
})
const copyBusy = ref(false)
async function copy() {
  if (copyBusy.value) return
  err.value = ''
  copyBusy.value = true
  // (asked once per press: the ClipboardItem and the write after it wait on the same words)
  let asked = null
  const words = () => (asked ||= within(loadOut(), COPY_WAIT_MS).then((o) => o.text))
  try {
    const cb = navigator.clipboard
    if (out.value) await cb.writeText(out.value.text)
    else if (typeof ClipboardItem === 'function' && typeof cb.write === 'function') {
      // (a browser that takes no words still coming: the words once here — and nothing when they did not come)
      try { await cb.write([new ClipboardItem({ 'text/plain': words().then((t) => new Blob([t], { type: 'text/plain' })) })]) } catch { await cb.writeText(await words()) }
    } else await cb.writeText(await words())
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  } catch {
    err.value = out.value ? '복사하지 못했어요.' : '정리한 글을 받지 못했어요. 다시 눌러 주세요.'
  } finally { copyBusy.value = false }
}
// 「글 선택」 (opened by holding the answer — a long press opens this menu, not the browser's selection): the answer's words selected, the
// browser's own handles and copy menu from there
const held = computed(() => app.answerShare?.el || null)
function selectText() {
  const el = held.value
  close()
  if (!el?.isConnected) return
  // (on a phone the answer takes no selection of its own — Message.vue: it is lifted while this selection lasts)
  el.dataset.selecting = ''
  const done = () => {
    const sel = window.getSelection()
    if (sel && !sel.isCollapsed && el.contains(sel.anchorNode)) return
    delete el.dataset.selecting
    document.removeEventListener('selectionchange', done)
  }
  try { const sel = window.getSelection(); sel.removeAllRanges(); sel.selectAllChildren(el) } catch { /* nothing to select */ }
  setTimeout(() => document.addEventListener('selectionchange', done), 0)
}
function toProject() { const m = msg.value; close(); startProjectFrom(app, m).catch((e) => team.say(e.message || '프로젝트 카드를 만들지 못했어요.')) }

// ---------- to another app ----------
// 「다른 앱으로 보내기」 (2026-11-28 — 「웹 앱으로 공유」 of the recording, the phone's share sheet): navigator.share with the answer's words as a
// room gets them (server lib/answerShare.js textFor — paths, signed and storage addresses and keys taken out, cut at 12,000 characters with
// 「…(이어짐)」, Markdown's marks off), never the raw answer. They are asked for as the sheet opens: a phone opens its share sheet only right
// after a press, so the press hands over words already here. Cancelled there: nothing said. No share sheet (most computers, the desktop app):
// no item — 「글 복사」.
const shareOut = canShareOut()
const out = ref(null)        // {title, text (「글 복사」), plain (the share sheet's), truncated, limit}
const outBusy = ref(false)
const outDone = ref(false)
let outAsk = null, doneTimer = null
function loadOut() {
  if (out.value) return Promise.resolve(out.value)
  outAsk ||= app.answerOutText(msg.value.id).then((r) => { out.value = r; return r }).finally(() => { outAsk = null })
  return outAsk
}
const outCut = computed(() => (out.value?.truncated ? `글이 길어서 앞부분 ${Number(out.value.limit || 12000).toLocaleString('ko-KR')}자만 보내요.` : ''))
async function sendOut() {
  if (outBusy.value) return
  // (a press again: what the last one said goes — 「보냈어요」 never stands beside a failure)
  err.value = ''
  outDone.value = false
  clearTimeout(doneTimer)
  outBusy.value = true
  const waited = !out.value
  try {
    // (words already here: handed over in the press itself — no await before navigator.share, which some phones ask to be the press's own)
    let o = out.value
    if (!o) { try { o = await loadOut() } catch (e) { err.value = e.message || '보낼 글을 준비하지 못했어요.'; return } }
    try {
      // (plain text: a messenger, a mail or a note would show Markdown's marks as they are)
      await navigator.share({ title: o.title, text: o.plain })
      outDone.value = true
      doneTimer = setTimeout(() => { outDone.value = false }, 2000)
    } catch (e) {
      // (the person closed the phone's sheet: nothing to say; the press came too long before the words did: once more opens it)
      if (e?.name === 'AbortError') return
      err.value = e?.name === 'NotAllowedError' && waited ? '글을 준비했어요. 한 번 더 눌러 주세요.' : '다른 앱으로 보내지 못했어요. 「글 복사」로 복사해 붙여 넣어 주세요.'
    }
  } finally { outBusy.value = false }
}

// ---------- the rooms ----------
const data = ref(null)
const loadErr = ref('')
const find = ref('')
const pick = ref(null)          // {room} | {person}
const note = ref('')
const busy = ref(false)
const sent = ref(null)          // {id, title}
async function loadRooms() {
  if (data.value) return
  loadErr.value = ''
  try { data.value = await app.answerRooms(msg.value.id) } catch (e) { loadErr.value = e.message }
}
function toRooms() { step.value = 'room'; err.value = ''; loadRooms() }
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '')
const hit = (s) => !find.value.trim() || norm(s).includes(norm(find.value))
const others = (r) => (r.members || []).filter((m) => m.id !== myId.value).map((m) => m.name).join(', ')
const rooms = computed(() => (data.value?.rooms || []).filter((r) => hit(r.title) || (r.members || []).some((m) => hit(m.name))))
const people = computed(() => (data.value?.people || []).filter((p) => hit(p.name) || hit(p.email)))
const pickTitle = computed(() => pick.value?.room?.title || pick.value?.person?.name || '')
// what the room will read, said before 보내기 (one sentence with the room's name in it — the English screen's pattern keeps the name)
const says = computed(() => `「${pickTitle.value}」에 있는 사람들에게 이 답의 글만 보내요. 작업 공간 파일 경로와 서명된 주소 · 저장소 주소는 파일 이름만 남기고 빼요. 일반 웹 주소는 그대로 보내요.`)
const cutNote = computed(() => (data.value?.answer?.truncated ? `글이 길어서 앞부분 ${Number(data.value.answer.limit || 12000).toLocaleString('ko-KR')}자만 보내요.` : ''))
const sentLine = computed(() => (sent.value?.title ? `「${sent.value.title}」에 공유했어요` : '대화방에 공유했어요'))
function choose(p) { pick.value = p; step.value = 'send'; err.value = '' }
function back() { if (step.value === 'send') { step.value = 'room'; pick.value = null } else step.value = 'menu'; err.value = '' }
async function send() {
  if (busy.value || !pick.value) return
  busy.value = true; err.value = ''
  try {
    const r = await app.shareAnswer(msg.value.id, { ...(pick.value.room ? { room: pick.value.room.id } : { person: pick.value.person.id }), note: note.value })
    sent.value = r.room
    step.value = 'sent'
  } catch (e) { err.value = e.message }
  busy.value = false
}
function openRoom() { const id = sent.value?.id; close(); if (id) team.openMessenger(id) }
</script>

<template>
  <Teleport to="body">
    <div v-if="msg" class="veil" data-test="answer-share-veil" @click.self="close">
      <div ref="sheet" class="sheet glass blur-in" role="dialog" aria-modal="true" aria-label="답 공유" tabindex="-1" data-test="answer-share" :data-step="step"
        @keydown.esc.stop.prevent="close">
        <header>
          <button v-if="step === 'room' || step === 'send'" class="x press" aria-label="뒤로" data-test="answer-share-back" @click="back"><Icon name="back" :size="17" /></button>
          <div class="hd">
            <h2>{{ step === 'room' ? '대화방 · 사람에게 보내기' : step === 'send' ? '보내기 전에 확인해 주세요' : step === 'sent' ? '공유했어요' : '공유' }}</h2>
            <p class="sub"><span v-if="sentTitle" data-no-i18n>{{ sentTitle }}</span><template v-else>AI 답</template></p>
          </div>
          <button class="x press" aria-label="닫기" data-test="answer-share-close" @click="close"><Icon name="close" :size="17" /></button>
        </header>

        <!-- what to do with this answer -->
        <div v-if="step === 'menu'" class="menu" role="menu">
          <button class="mi press" role="menuitem" data-test="answer-share-room" @click="toRooms">
            <span class="ic"><Icon name="team" :size="18" /></span><span class="mt"><b>대화방 · 사람에게 보내기</b><small>대화방이나 팀원을 골라 이 답을 보내요</small></span><Icon name="chevron" :size="14" />
          </button>
          <button v-if="shareOut" class="mi press" role="menuitem" data-test="answer-share-apps" :disabled="outBusy" @click="sendOut">
            <span class="ic"><Icon :name="outDone ? 'check' : 'share'" :size="18" /></span>
            <span class="mt"><b>{{ outDone ? '다른 앱으로 보냈어요' : outBusy && !out ? '보낼 글을 준비하고 있어요…' : '다른 앱으로 보내기' }}</b>
              <small>이 답의 글을 메신저 · 메일 · 메모 앱으로 보내요. 파일 경로와 비공개 주소는 빼요.</small>
              <small v-if="outCut" class="cut" data-test="answer-apps-truncated">{{ outCut }}</small></span>
          </button>
          <button class="mi press" role="menuitem" data-test="answer-share-doc" :disabled="docBusy" @click="doc ? openDoc() : saveDoc()">
            <span class="ic"><Icon name="doc" :size="18" /></span>
            <span class="mt"><b>{{ doc ? '문서로 남겼어요' : docBusy ? '문서로 남기는 중…' : '문서로 남기기' }}</b>
              <small v-if="doc" data-test="answer-doc-saved" data-no-i18n>{{ doc.content?.name }} · 눌러서 열기</small>
              <small v-else>채팅에 Markdown 문서로 남겨요 · 이후 공유 · 내려받기 · 편집할 수 있어요</small></span>
            <Icon v-if="doc" name="check" :size="15" />
          </button>
          <button class="mi press" role="menuitem" data-test="answer-share-project" @click="toProject">
            <span class="ic"><Icon name="folder" :size="18" /></span><span class="mt"><b>프로젝트로 시작</b><small>이 답을 첫 문서로 담아 새 프로젝트를 만들어요 · 만들기 전에 한 번 더 물어봐요</small></span><Icon name="chevron" :size="14" />
          </button>
          <button v-if="held" class="mi press" role="menuitem" data-test="answer-share-select" @click="selectText">
            <span class="ic"><Icon name="hand" :size="18" /></span><span class="mt"><b>글 선택</b><small>답에서 글을 골라 일부만 복사해요</small></span>
          </button>
          <button class="mi press" role="menuitem" data-test="answer-share-copy" @click="copy">
            <span class="ic"><Icon :name="copied ? 'check' : 'list'" :size="18" /></span><span class="mt"><b>{{ copied ? '복사했어요' : '글 복사' }}</b><small>이 답의 글을 클립보드에 복사해요</small></span>
          </button>
        </div>

        <!-- the rooms and the teammates -->
        <template v-else-if="step === 'room'">
          <p v-if="loadErr" class="err" data-test="answer-rooms-error">{{ loadErr }}</p>
          <p v-else-if="!data" class="wait shimmer-text">대화방을 불러오는 중…</p>
          <template v-else>
            <label class="find"><Icon name="search" :size="14" /><input v-model="find" placeholder="대화방이나 팀원 찾기" autocomplete="off" data-test="answer-room-find" /></label>
            <div class="list scroll" role="listbox" aria-label="대화방">
              <button v-for="r in rooms" :key="r.id" class="opt press" :class="{ sug: r.suggested }" role="option" data-test="answer-room-option" :data-room="r.id" @click="choose({ room: r })">
                <PersonAvatar v-if="r.kind !== 'direct'" kind="group" size="sm">{{ r.members.length }}</PersonAvatar>
                <PersonAvatar v-else :id="r.members.find((m) => m.id !== myId)?.id" :name="r.title" size="sm" />
                <span class="nm"><b data-no-i18n>{{ r.title }}</b><small>{{ r.why[0]?.text || others(r) }}</small></span>
                <i v-if="r.suggested" class="tag">추천</i>
              </button>
              <template v-if="people.length">
                <p class="sec">팀원에게 바로</p>
                <button v-for="p in people" :key="p.id" class="opt press" role="option" data-test="answer-person-option" :data-person="p.id" @click="choose({ person: p })">
                  <PersonAvatar :id="p.id" :name="p.name" size="sm" />
                  <span class="nm"><b data-no-i18n>{{ p.name }}</b><small>새 1:1 대화로 보내요</small></span>
                </button>
              </template>
              <p v-if="!rooms.length && !people.length" class="none">보낼 대화방이나 팀원이 없어요.</p>
            </div>
          </template>
        </template>

        <!-- what the room will see, a word, 보내기 -->
        <template v-else-if="step === 'send'">
          <div class="to" data-test="answer-send-to"><small>받는 곳</small><b data-no-i18n>{{ pickTitle }}</b></div>
          <div class="pv" data-test="answer-preview"><b><span v-if="sentTitle" data-no-i18n>{{ sentTitle }}</span><template v-else>AI 답</template></b><p data-no-i18n>{{ preview }}</p></div>
          <p v-if="cutNote" class="cut" data-test="answer-truncated">{{ cutNote }}</p>
          <textarea v-model="note" class="note" rows="2" maxlength="1000" placeholder="함께 보낼 말 (선택)" data-test="answer-note" />
          <p class="says" data-test="answer-says">{{ says }}</p>
        </template>

        <!-- sent -->
        <p v-else-if="step === 'sent'" class="sent" data-test="answer-sent" :data-room="sent?.id"><Icon name="check" :size="16" /><span>{{ sentLine }}</span></p>

        <p v-if="err" class="err" role="alert" data-test="answer-share-error">{{ err }}</p>
        <footer v-if="step === 'send' || step === 'sent'">
          <button v-if="step === 'send'" class="go press" :disabled="busy" data-test="answer-send" @click="send">{{ busy ? '보내는 중…' : '보내기' }}</button>
          <button v-else class="go press" data-test="answer-room-open" @click="openRoom">방 열기</button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.veil { position: fixed; inset: 0; z-index: 200; background: rgba(0, 0, 0, .28); display: grid; place-items: center; padding: 16px; }
.sheet { width: min(460px, 100%); min-width: 0; box-sizing: border-box; max-height: min(80vh, 680px); max-height: min(80dvh, 680px); border-radius: 26px; padding: 16px 16px 14px;
  display: flex; flex-direction: column; gap: 10px; background: var(--regular-solid-bg, var(--bubble-agent-bg)); box-shadow: var(--shadow-card); color: var(--text-primary); }
header { display: flex; align-items: flex-start; gap: 8px; }
.hd { flex: 1; min-width: 0; }
h2 { margin: 2px 0 0; font-size: 17px; font-weight: 600; }
.sub { margin: 3px 0 0; font-size: 12.5px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.x { width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; background: var(--field-bg); flex: none; color: var(--text-primary); }
.menu { display: flex; flex-direction: column; gap: 4px; }
.mi { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 56px; padding: 8px 10px; border-radius: 16px; text-align: left; color: var(--text-primary); }
.mi:hover { background: var(--cell-bg, rgba(127, 127, 127, .1)); }
.mi:disabled { opacity: .6; }
.ic { width: 36px; height: 36px; border-radius: 12px; display: grid; place-items: center; flex: none; background: var(--field-bg); }
.mt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.mt b { font-size: 14.5px; font-weight: 600; }
.mt small { font-size: 12px; color: var(--text-secondary); line-height: 1.35; overflow-wrap: anywhere; }
.mt small.cut { color: var(--color-warning, #b26a00); }
.find { display: flex; align-items: center; gap: 6px; height: 38px; padding: 0 12px; border-radius: 12px; background: var(--field-bg); border: 1px solid var(--hairline); color: var(--text-secondary); }
.find input { flex: 1; min-width: 0; border: 0; background: transparent; outline: 0; color: var(--text-primary); font: inherit; font-size: 14px; }
.list { flex: 1; min-height: 120px; overflow: auto; display: flex; flex-direction: column; gap: 2px; }
.opt { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px; border-radius: 12px; text-align: left; color: var(--text-primary); }
.opt:hover { background: var(--cell-bg, rgba(127, 127, 127, .1)); }
.nm { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.nm b { font-size: 14px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nm small { font-size: 12px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tag { font-style: normal; font-size: 11px; padding: 2px 7px; border-radius: 8px; background: rgba(42, 120, 214, .14); color: #2a78d6; flex: none; }
.sec { margin: 8px 6px 2px; font-size: 11.5px; font-weight: 600; color: var(--text-secondary); }
.none, .wait { font-size: 13px; color: var(--text-secondary); margin: 8px 4px; }
.to { display: flex; align-items: baseline; gap: 8px; font-size: 14px; min-width: 0; }
.to small { color: var(--text-secondary); flex: none; }
.to b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pv { padding: 10px 12px; border-radius: 14px; background: var(--cell-bg, rgba(127, 127, 127, .08)); border: 1px solid var(--hairline); min-width: 0; }
.pv b { display: block; font-size: 13.5px; font-weight: 600; overflow-wrap: anywhere; }
.pv p { margin: 4px 0 0; font-size: 12.5px; color: var(--text-secondary); line-height: 1.45; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.note { width: 100%; box-sizing: border-box; border: 1px solid var(--hairline); background: var(--field-bg); border-radius: 12px; padding: 9px 12px; font: inherit; font-size: 14px; color: var(--text-primary); outline: 0; resize: none; }
.says { margin: 0; font-size: 12.5px; color: var(--text-secondary); line-height: 1.45; }
.cut { margin: 0; font-size: 12.5px; color: var(--color-warning, #b26a00); line-height: 1.45; }
.sheet:focus { outline: none; }
.sent { display: flex; align-items: center; gap: 8px; margin: 6px 2px; font-size: 14.5px; }
.sent svg { color: var(--color-success); flex: none; }
.err { margin: 0; color: var(--color-error, #c62828); font-size: 12.5px; overflow-wrap: anywhere; }
footer { display: flex; justify-content: flex-end; gap: 8px; }
.go { height: 40px; padding: 0 20px; border-radius: 20px; background: var(--text-primary); color: var(--ink-inverse, #fff); font-size: 14.5px; font-weight: 600; }
.go:disabled { opacity: .45; }
@media (max-width: 760px) {
  .veil { place-items: end stretch; padding: 0; }
  .sheet { width: 100%; max-height: 86vh; max-height: 86dvh; border-radius: 24px 24px 0 0; padding: 16px 16px calc(14px + env(safe-area-inset-bottom, 0px)); }
}
</style>
