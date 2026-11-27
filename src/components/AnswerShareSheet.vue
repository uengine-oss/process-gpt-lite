<script setup>
// 답을 공유 (2026-11-27 22:33 휴대폰 녹화: 「텍스트 결과가 나왔을 때 이것을 어딘가에 … 공유한다든지 하는 기능이 지금 존재하지 않아」 — spec answer-share,
// server lib/answerShare.js). Opened by an answer's 「공유」 (Message.vue) or by holding / right-clicking the answer (its message menu):
//   menu   대화방 · 사람에게 보내기 · 문서로 남기기 · 프로젝트로 시작 · 복사
//   room   the conversations (the ones answers of this chat went to before first, with why) and the teammates with no conversation yet
//   send   where it goes, what that room will see (the answer's title and words — no file, no mail body), a word to say, 보내기
//   sent   「…」에 공유했어요 · 방 열기
// Nothing goes anywhere before 보내기. A document: the answer as a Markdown file card under it (once) — from there the file's own 공유,
// 내려받기 and IeumOffice.
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import Icon from './Icon.vue'
import PersonAvatar from './PersonAvatar.vue'
import { useApp } from '../stores/app.js'
import { useTeam } from '../stores/team.js'
import { openArtifact } from '../artifacts.js'
import { hidePaths } from '../paths.js'
import { startProjectFrom } from '../answerActions.js'

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
  return t.length > 60 ? `${t.slice(0, 59)}…` : t || 'AI 답'
})
// (the first lines as words: Markdown's marks — emphasis, headings, quotes, code — taken off)
const preview = computed(() => text.value.split('\n').map((l) => l.trim()).filter(Boolean).slice(msg.value?.kind === 'doc' ? 1 : 0).slice(0, 4)
  .map((l) => l.replace(/^#{1,6}\s*|^>\s*/, '').replace(/\*\*|__|`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')).join(' ').slice(0, 220))

const close = () => { app.answerShare = null }
const onEsc = (e) => { if (e.key === 'Escape') close() }
onMounted(() => { window.addEventListener('keydown', onEsc); if (step.value === 'room') loadRooms() })
onBeforeUnmount(() => window.removeEventListener('keydown', onEsc))

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
async function copy() {
  err.value = ''
  try { await navigator.clipboard.writeText(text.value); copied.value = true; setTimeout(() => { copied.value = false }, 2000) } catch { err.value = '복사하지 못했어요.' }
}
// 「글 선택」 (opened by holding the answer — a long press opens this menu, not the browser's selection): the answer's words selected, the
// browser's own handles and copy menu from there
const held = computed(() => app.answerShare?.el || null)
function selectText() {
  const el = held.value
  close()
  if (!el?.isConnected) return
  try { const sel = window.getSelection(); sel.removeAllRanges(); sel.selectAllChildren(el) } catch { /* nothing to select */ }
}
function toProject() { const m = msg.value; close(); startProjectFrom(app, m).catch((e) => team.say(e.message || '프로젝트 카드를 만들지 못했어요.')) }

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
      <div class="sheet glass blur-in" role="dialog" aria-label="답 공유" data-test="answer-share" :data-step="step">
        <header>
          <button v-if="step === 'room' || step === 'send'" class="x press" aria-label="뒤로" data-test="answer-share-back" @click="back"><Icon name="back" :size="17" /></button>
          <div class="hd">
            <h2>{{ step === 'room' ? '대화방 · 사람에게 보내기' : step === 'send' ? '보내기 전에 확인해 주세요' : step === 'sent' ? '공유했어요' : '공유' }}</h2>
            <p class="sub" data-no-i18n>{{ title }}</p>
          </div>
          <button class="x press" aria-label="닫기" data-test="answer-share-close" @click="close"><Icon name="close" :size="17" /></button>
        </header>

        <!-- what to do with this answer -->
        <div v-if="step === 'menu'" class="menu" role="menu">
          <button class="mi press" role="menuitem" data-test="answer-share-room" @click="toRooms">
            <span class="ic"><Icon name="team" :size="18" /></span><span class="mt"><b>대화방 · 사람에게 보내기</b><small>대화방이나 팀원을 골라 이 답을 보내요</small></span><Icon name="chevron" :size="14" />
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
          <div class="pv" data-test="answer-preview"><b data-no-i18n>{{ title }}</b><p data-no-i18n>{{ preview }}</p></div>
          <textarea v-model="note" class="note" rows="2" maxlength="1000" placeholder="함께 보낼 말 (선택)" data-test="answer-note" />
          <p class="says" data-test="answer-says">「{{ pickTitle }}」에 있는 사람들에게 이 답의 제목과 글이 그대로 보여요. 채팅의 파일이나 메일 본문은 보내지 않아요.</p>
        </template>

        <!-- sent -->
        <p v-else-if="step === 'sent'" class="sent" data-test="answer-sent" :data-room="sent?.id"><Icon name="check" :size="16" /><span>「<span data-no-i18n>{{ sent?.title || '대화방' }}</span>」에 공유했어요</span></p>

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
