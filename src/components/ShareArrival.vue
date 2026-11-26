<script setup>
// 다른 앱의 「공유」로 온 파일 · 글을 그 자리로 (2026-11-26, 사용자 휴대폰 녹화 — 「현재 열려있는 공간의 첨부를 바로 할 수 있겠지.」
// 「예를 들면 지금 현재 대화창이 열려 있다고 치면 팀 메시지에 여기에 곧바로 첨부를 할 수 있을 거야.」). On every page (App.vue):
//   - keeps the place this device has open (the messenger's room over the page, else the page's: the chat or one of its
//     conversations, a project, a routine, a folder) — its kind and id, whose, and when it was last open (src/shareTarget.js)
//   - when a share came (the service worker's ?share=, src/shareInbox.js) it asks once, showing what came (the files' names, the first
//     line of the words): 「넣기」 into that place, or 「다른 곳에」 — the chooser 「어디에 넣을까요?」. Another site can post the same
//     form as Android does and the app cannot tell the two apart, so nothing goes in or up before that tap (2026-11-26 review). A place
//     left more than 30 minutes ago, or one this share cannot go to, is not asked about: the chooser opens (with it first, when it can).
//   - after 「넣기」 the files go up in that place's composer and the words go in its box — never sent by itself; 「다른 곳에」 on the bar
//     takes them back out (the uploads stop)
//   - files over the limits are named with the reason; a share that did not come says so
// The composers take it through their own paths: the messenger's uploads (Messenger.vue — a room's files go only to that room), the
// chat's attachments (stores/app.js addAttachments), the folder's upload (FolderDetail.vue — its own permission check).
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Icon from './Icon.vue'
import PersonAvatar from './PersonAvatar.vue'
import { useApp } from '../stores/app.js'
import { useTeam } from '../stores/team.js'
import { api } from '../api.js'
import { folders as F } from '../foldersApi.js'
import { narrow } from '../viewport.js'
import { placeOf, writeLast, touchLast, rememberFolder, recentFolders, pickTarget, isFresh, chooserRows, pathOf, skippedNotice, summaryParts, askTitle, firstLine } from '../shareTarget.js'
import { inbox, takePending, hasPending, readShare, whoNow } from '../shareInbox.js'

const app = useApp()
const team = useTeam()
const route = useRoute()
const router = useRouter()
const store = () => { try { return window.localStorage } catch { return null } }

// ---- the place open now, kept on this device for this person ----
const teamHere = () => !!route.matched.length && !route.meta.public && !route.meta.noTeam && !route.meta.settings
function track() {
  const who = whoNow()
  if (!who.uid) return
  const p = placeOf({ path: route.path, mode: route.meta.mode, settings: !!route.meta.settings, public: !!route.meta.public, noTeam: !!route.meta.noTeam || !route.matched.length, params: route.params },
    { open: team.open && teamHere(), tab: team.tab, active: team.active })
  if (p === undefined) return
  writeLast(store(), p, who)
  if (p?.kind === 'folder') rememberFolder(store(), p.id, who)
}
watch(() => [route.fullPath, team.open, team.tab, team.active], track, { immediate: true })
// the app going to the background — where another app's 「공유」 begins: the place open is still open as of now. (Not on pagehide: a share
// arriving in a window left in the background unloads it — that is no sign the person was there.)
const away = () => { if (document.visibilityState !== 'hidden') return; const who = whoNow(); if (who.uid) touchLast(store(), who) }
onMounted(() => document.addEventListener('visibilitychange', away))
onBeforeUnmount(() => document.removeEventListener('visibilitychange', away))

// ---- a share that came ----
const payload = ref(null)    // {key, files: File[], text, first, notice}
const ask = ref(null)        // {kind, id, title} — 「… 넣을까요?」 · 「넣기」 · 「다른 곳에」
const placed = ref(null)     // {kind, id, label} — the bar 「… 입력창에 넣었어요 · 다른 곳에」
const choosing = ref(false)  // 「어디에 넣을까요?」
const rows = ref(null)       // the chooser's rows (chooserRows)
const notice = ref('')       // a short line: what did not come, or why nothing did
let barTimer, noticeTimer
const say = (t, ms = 9000) => { notice.value = t; clearTimeout(noticeTimer); if (ms) noticeTimer = setTimeout(() => { notice.value = '' }, ms) }
onBeforeUnmount(() => { clearTimeout(barTimer); clearTimeout(noticeTimer) })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// signed in, the app's data in, on a page with the top bar: the share is asked about now
const ready = computed(() => !!app.mainThread && !!route.matched.length && !route.meta.public && !route.meta.noTeam)
watch(ready, (ok) => { if (ok && hasPending()) arrive() }, { immediate: true })

// what the app knows now about the place last open (the lists asked for again where they did not come)
async function knowFor(last, files) {
  const known = {}
  if (last?.kind === 'room') {
    await team.loadThreads()
    // (the list asked for at start may have answered nothing — a busy server, a newer request: once more before asking where)
    if (!team.threads.some((t) => t.id === last.id)) { await wait(600); await team.loadThreads() }
    known.rooms = team.threads.map((t) => t.id)
  }
  if (last?.kind === 'project') { if (!app.projects.length) await app.loadProjects().catch(() => {}); known.projects = app.projects.map((x) => x.id) }
  if (last?.kind === 'chat' && last.id) { if (!app.conversations.length) await app.loadConversations().catch(() => {}); known.conversations = app.conversations.map((c) => c.id) }
  // a routine only when this person can open it (GET /instances/:id answers its participants)
  if (last?.kind === 'routine') {
    const r = await api(`/instances/${encodeURIComponent(last.id)}`).catch(() => null)
    if (r?.inst) { known.routines = [last.id]; known.routineName = r.inst.proc_inst_name || r.def?.name || '' }
  }
  if (last?.kind === 'folder' && files) known.folder = await F.get(last.id).then((f) => ({ slug: last.id, role: f.role, name: f.name })).catch(() => null)
  return known
}
function labelOf(t, known = {}) {
  if (t.kind === 'room') return team.threads.find((x) => x.id === t.id)?.title || '대화'
  if (t.kind === 'project') return app.projects.find((x) => x.id === t.id)?.title || '프로젝트'
  if (t.kind === 'routine') return known.routineName || '루틴'
  if (t.kind === 'folder') return known.folder?.name || t.id
  if (t.kind === 'chat' && t.id) return app.conversations.find((c) => c.id === t.id)?.title || 'Process GPT 채팅'
  return 'Process GPT 채팅'
}

async function arrive() {
  const p = takePending()
  if (!p) return
  if (p.id === 'failed') return say(p.why === 'big' ? '공유한 파일이 너무 커요. 한 번에 200MB까지 받을 수 있어요.' : '공유한 내용을 받지 못했어요. 다시 공유해 주세요.')
  const got = await readShare(p.id)
  if (!got) return say('공유한 내용을 찾지 못했어요. 다시 공유해 주세요.')
  const skipped = skippedNotice(got.skipped)
  if (!got.files.length && !got.text) return say(skipped || '공유한 내용이 비어 있어요.', 0)
  payload.value = { key: p.id, files: got.files, text: got.text, first: firstLine(got.text), notice: skipped }
  const known = await knowFor(p.last, got.files.length)
  const t = pickTarget(p.last, { files: got.files.length, text: !!got.text }, known)
  const place = t ? { ...t, title: labelOf(t, known) } : null
  // the place open a moment ago: one question; left a while ago, or not for this share: the chooser (with it first when it can)
  if (place && isFresh(p.last)) ask.value = place
  else openChooser(place, p.last?.kind === 'folder' && got.files.length && known.folder && !['editor', 'owner'].includes(known.folder.role) ? '이 폴더에 넣을 권한이 없어요. 넣을 곳을 골라 주세요.' : '')
}

// into the place (after 「넣기」 or a pick in the chooser): its composer gets the files (going up at once, as if picked there) and the
// words; the person sends. A folder: its own upload, in its own screen.
function put(t) {
  const s = payload.value
  if (!s) return
  ask.value = null
  choosing.value = false
  if (t.kind === 'folder') {
    inbox.forFolder = { key: s.key, slug: t.id, files: s.files }
    if (route.path !== pathOf(t)) router.push(pathOf(t)).catch(() => {})
    if (s.notice) say(s.notice)
    payload.value = null
    return
  }
  if (t.kind === 'room') {
    inbox.forRoom = { key: s.key, room: t.id, files: s.files, text: s.text }
    team.openMessenger(t.id).catch(() => {})
  } else {
    team.open = false
    const to = pathOf(t)
    if (route.path !== to) router.push(to).catch(() => {})
    // a phone shows Home over the chat at first: the chat, with its composer
    if (narrow.value && t.kind === 'chat') app.dockOpen = false
    if (s.files.length) app.addAttachments(s.files, { share: s.key })
    if (s.text) app.prefill = s.text
  }
  placed.value = { kind: t.kind, id: t.id, label: t.title || labelOf(t) }
  clearTimeout(barTimer)
  barTimer = setTimeout(() => { placed.value = null }, 10000)
}

// 「다른 곳에」 on the bar: what this share put there goes away — the uploads still going stop — then the chooser
function takeBack() {
  const s = payload.value
  if (!s) return
  if (inbox.forRoom?.key === s.key) inbox.forRoom = null
  app.dropAttachments((a) => a.share === s.key)
  if (s.text && app.prefill === s.text) app.prefill = ''
  inbox.takeBack = { key: s.key, text: s.text }
  placed.value = null
}
function elsewhere() { takeBack(); openChooser(null, '') }

async function openChooser(first, note) {
  const s = payload.value
  if (!s) return
  ask.value = null
  choosing.value = true
  if (note) say(note)
  rows.value = null
  const [threads, list] = await Promise.all([team.loadThreads().then(() => team.threads).catch(() => team.threads),
    s.files.length ? F.list().catch(() => []) : Promise.resolve([])])
  rows.value = chooserRows({ rooms: threads, folders: list, recent: recentFolders(store(), whoNow()), meId: app.me?.user?.id, files: s.files.length, first })
}
// a place picked in the chooser is the person's own choice: it goes in at once
const pick = (row) => put(row)
function cancel() { choosing.value = false; ask.value = null; payload.value = null; placed.value = null }

const askLine = computed(() => (ask.value && payload.value ? askTitle({ files: payload.value.files.length, text: !!payload.value.text }, ask.value.title, ask.value.kind) : ''))
const what = computed(() => (payload.value ? summaryParts(payload.value) : []))
const placedLine = computed(() => {
  const s = payload.value, p = placed.value
  if (!s || !p) return ''
  const n = s.files.length
  const obj = n && s.text ? `파일 ${n}개와 글을` : n ? `파일 ${n}개를` : '글을'
  return `공유한 ${obj} ‘${p.label}’ 입력창에 넣었어요.`
})
const kb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`)
const shown = (files) => files.slice(0, 4)
</script>

<template>
  <!-- (on the body, like the messenger: the page's stage is a layer of its own, under the messenger's sheet) -->
  <Teleport to="body">
  <!-- the one question: what came (names, the first line of the words) and where it would go — nothing goes in or up before 「넣기」 -->
  <div v-if="ask && payload" class="sa-veil" data-test="share-ask-veil" @click.self="cancel">
    <section class="sa-sheet" role="dialog" :aria-label="askLine" data-test="share-ask" :data-kind="ask.kind" :data-place="ask.id">
      <header>
        <span class="ic share" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="17.5" cy="5.5" r="2.5" /><circle cx="6.5" cy="12" r="2.5" /><circle cx="17.5" cy="18.5" r="2.5" /><path d="M8.7 10.8l6.6-4M8.7 13.2l6.6 4" /></svg>
        </span>
        <div class="ti"><strong data-test="share-ask-title">{{ askLine }}</strong><small>지금 열어 둔 곳</small></div>
        <button class="x press" aria-label="닫기" data-test="share-cancel" @click="cancel"><Icon name="close" :size="16" /></button>
      </header>
      <ul v-if="payload.files.length" class="files" data-test="share-files">
        <li v-for="(f, i) in shown(payload.files)" :key="i" :data-file="f.name"><Icon name="doc" :size="15" /><span class="fn">{{ f.name }}</span><small>{{ kb(f.size) }}</small></li>
        <li v-if="payload.files.length > 4" class="more"><span class="fn">외 {{ payload.files.length - 4 }}개</span></li>
      </ul>
      <p v-if="payload.first && ask.kind !== 'folder'" class="said" data-test="share-text">{{ payload.first }}</p>
      <p v-if="payload.text && ask.kind === 'folder'" class="note">함께 온 글은 폴더에 넣지 않아요.</p>
      <p v-if="payload.notice" class="warnline" data-test="share-skipped">{{ payload.notice }}</p>
      <div class="acts">
        <button class="go press" data-test="share-put" @click="put(ask)">넣기</button>
        <button class="soft press" data-test="share-ask-elsewhere" @click="openChooser(null, '')">다른 곳에</button>
      </div>
      <p v-if="ask.kind !== 'folder'" class="foot">넣기만 하고 보내지는 않아요. 보내기는 직접 눌러 주세요.</p>
    </section>
  </div>

  <!-- after 「넣기」: where it went, that nothing is sent yet, 「다른 곳에」 -->
  <Transition name="sa-drop">
    <div v-if="placed && payload" class="sa-bar" :class="{ overms: team.open }" role="status" data-test="share-placed" :data-kind="placed.kind" :data-place="placed.id">
      <span class="ic ok" aria-hidden="true"><Icon name="check" :size="16" /></span>
      <span class="tx"><b>{{ placedLine }}</b><small>보내기를 눌러야 보내져요.</small><small v-if="payload.notice" class="skip" data-test="share-skipped">{{ payload.notice }}</small></span>
      <button class="soft press" data-test="share-elsewhere" @click="elsewhere">다른 곳에</button>
      <button class="x press" aria-label="닫기" data-test="share-placed-close" @click="placed = null"><Icon name="close" :size="15" /></button>
    </div>
  </Transition>
  <!-- what did not come (over 50MB …), or that nothing did -->
  <Transition name="sa-drop">
    <div v-if="notice && !placed" class="sa-bar warn" :class="{ overms: team.open }" role="alert" data-test="share-notice">
      <span class="ic" aria-hidden="true"><Icon name="alert" :size="16" /></span>
      <span class="tx"><b>{{ notice }}</b></span>
      <button class="x press" aria-label="닫기" @click="notice = ''"><Icon name="close" :size="15" /></button>
    </div>
  </Transition>

  <!-- 「어디에 넣을까요?」: the place last open (a while ago) first, the rooms I talked in lately, my chat, the folders I opened lately -->
  <div v-if="choosing && payload" class="sa-veil" data-test="share-chooser-veil" @click.self="cancel">
    <section class="sa-sheet" role="dialog" aria-label="어디에 넣을까요?" data-test="share-chooser">
      <header>
        <span class="ic share" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="17.5" cy="5.5" r="2.5" /><circle cx="6.5" cy="12" r="2.5" /><circle cx="17.5" cy="18.5" r="2.5" /><path d="M8.7 10.8l6.6-4M8.7 13.2l6.6 4" /></svg>
        </span>
        <div class="ti"><strong>어디에 넣을까요?</strong><small data-test="share-what"><template v-for="(w, i) in what" :key="i"><span v-if="i"> · </span><span>{{ w }}</span></template></small></div>
        <button class="x press" aria-label="닫기" data-test="share-cancel" @click="cancel"><Icon name="close" :size="16" /></button>
      </header>
      <p v-if="payload.first" class="said" data-test="share-text">{{ payload.first }}</p>
      <p v-if="payload.notice" class="warnline" data-test="share-skipped">{{ payload.notice }}</p>
      <div class="list">
        <p v-if="!rows" class="wait">불러오는 중…</p>
        <template v-else>
          <template v-if="rows.first">
            <p class="sec">마지막으로 연 곳</p>
            <button class="row press" data-test="share-pick" :data-kind="rows.first.kind" :data-id="rows.first.id" data-first="1" @click="pick(rows.first)">
              <PersonAvatar v-if="rows.first.kind === 'room' && rows.first.group" kind="group" :size="34"><Icon name="team" :size="16" /></PersonAvatar>
              <PersonAvatar v-else-if="rows.first.kind === 'room'" :id="rows.first.other?.id" :name="rows.first.other?.name || rows.first.title" :size="34" />
              <PersonAvatar v-else-if="rows.first.kind === 'chat'" kind="ai" :size="34" />
              <span v-else class="fold" aria-hidden="true"><Icon :name="rows.first.kind === 'folder' ? 'folder' : rows.first.kind === 'routine' ? 'plan' : 'chat'" :size="17" /></span>
              <span class="nm"><b>{{ rows.first.title }}</b><small>{{ rows.first.sub }}</small></span>
              <Icon name="chevron" :size="16" />
            </button>
          </template>
          <template v-if="rows.rooms.length">
            <p class="sec">대화</p>
            <button v-for="r in rows.rooms" :key="'r' + r.id" class="row press" data-test="share-pick" data-kind="room" :data-id="r.id" @click="pick(r)">
              <PersonAvatar v-if="r.group" kind="group" :size="34"><Icon name="team" :size="16" /></PersonAvatar>
              <PersonAvatar v-else :id="r.other?.id" :name="r.other?.name || r.title" :size="34" />
              <span class="nm"><b>{{ r.title }}</b><small>{{ r.sub }}</small></span>
              <Icon name="chevron" :size="16" />
            </button>
          </template>
          <template v-if="rows.chat">
            <p class="sec">내 채팅</p>
            <button class="row press" data-test="share-pick" data-kind="chat" data-id="" @click="pick(rows.chat)">
              <PersonAvatar kind="ai" :size="34" />
              <span class="nm"><b>{{ rows.chat.title }}</b><small>{{ rows.chat.sub }}</small></span>
              <Icon name="chevron" :size="16" />
            </button>
          </template>
          <template v-if="rows.folders.length">
            <p class="sec">폴더</p>
            <button v-for="f in rows.folders" :key="'f' + f.id" class="row press" data-test="share-pick" data-kind="folder" :data-id="f.id" @click="pick(f)">
              <span class="fold" aria-hidden="true"><Icon name="folder" :size="17" /></span>
              <span class="nm"><b>{{ f.title }}</b><small>{{ f.sub }}</small></span>
              <Icon name="chevron" :size="16" />
            </button>
          </template>
        </template>
      </div>
      <p class="foot">넣기만 하고 보내지는 않아요. 보내기는 직접 눌러 주세요.</p>
    </section>
  </div>
  </Teleport>
</template>

<style scoped>
.sa-bar { position: fixed; z-index: 84; left: 50%; translate: -50% 0; top: calc(env(safe-area-inset-top, 0px) + 64px); width: max-content; max-width: min(560px, calc(100vw - 32px));
  display: flex; align-items: center; gap: 10px; padding: 9px 8px 9px 12px; border-radius: 18px; background: var(--regular-solid-bg); color: var(--text-primary);
  box-shadow: 0 12px 36px rgba(0, 0, 0, .22), 0 0 0 1px var(--hairline, rgba(127, 127, 127, .18)); -webkit-backdrop-filter: blur(30px); backdrop-filter: blur(30px); }
/* over the messenger's sheet: under its head (the room's name, ‹, 회의 시작), over the conversation */
.sa-bar.overms { top: calc(env(safe-area-inset-top, 0px) + 132px); }
.sa-bar .tx { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.sa-bar .tx b { font-size: 14px; font-weight: 600; line-height: 1.35; word-break: keep-all; }
.sa-bar .tx small { font-size: 12.5px; line-height: 1.4; color: var(--text-secondary); word-break: keep-all; }
.sa-bar .tx small.skip { color: var(--text-primary); }
.sa-bar .tx small.skip::before { content: ''; display: inline-block; width: 6px; height: 6px; margin: 0 6px 1px 0; border-radius: 3px; background: var(--color-attention); vertical-align: middle; }
.sa-bar.warn .tx b { font-weight: 500; }
.ic { flex: none; width: 30px; height: 30px; border-radius: 15px; display: grid; place-items: center; background: var(--button-bg); color: var(--text-primary); }
.ic.ok { background: var(--color-success); color: #fff; }
.sa-bar.warn .ic { background: var(--color-attention); color: #fff; }
.soft { flex: none; height: 32px; padding: 0 12px; border-radius: 16px; font-size: 13.5px; font-weight: 500; color: var(--text-primary); background: var(--button-bg); white-space: nowrap; }
.x { flex: none; width: 30px; height: 30px; border-radius: 15px; display: grid; place-items: center; color: var(--text-secondary); }
.sa-drop-enter-from, .sa-drop-leave-to { opacity: 0; transform: translateY(-8px); }
.sa-drop-enter-active, .sa-drop-leave-active { transition: opacity .2s, transform .25s var(--spring); }

.sa-veil { position: fixed; inset: 0; z-index: 82; display: grid; place-items: end center; background: rgba(0 0 0 / .32);
  padding: 16px 16px calc(16px + env(safe-area-inset-bottom, 0px)); animation: fade-in .2s both; }
@media (min-width: 761px) { .sa-veil { place-items: center; } }
.sa-sheet { width: min(420px, 100%); max-height: min(640px, calc(100dvh - 32px)); display: flex; flex-direction: column; gap: 10px; padding: 16px; border-radius: 26px;
  background: var(--regular-solid-bg); color: var(--text-primary); box-shadow: var(--shadow-card); -webkit-backdrop-filter: blur(40px); backdrop-filter: blur(40px);
  animation: pop-in .35s var(--spring) both; }
header { display: flex; align-items: center; gap: 12px; }
header .ic { width: 38px; height: 38px; border-radius: 12px; }
header .ic.share { background: var(--ink); color: var(--ink-inverse); }
header .ic.fold, .fold { background: rgba(42, 120, 214, .14); color: var(--color-info); }
.ti { flex: 1; min-width: 0; }
.ti strong { display: block; font-size: 16.5px; font-weight: 600; line-height: 1.3; word-break: keep-all; }
.ti small { display: block; margin-top: 2px; font-size: 12.5px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
header .x { background: var(--button-bg); }
.warnline { margin: 0; padding: 8px 12px; border-radius: 12px; font-size: 13px; line-height: 1.45; color: var(--text-primary); background: rgba(245, 158, 11, .16); word-break: keep-all; }
.list { flex: 1; min-height: 0; overflow-y: auto; margin: 0 -6px; }
.wait { margin: 14px 8px; font-size: 13px; color: var(--text-secondary); }
.sec { margin: 10px 8px 4px; font-size: 11.5px; font-weight: 600; color: var(--text-secondary); }
.row { width: 100%; display: flex; align-items: center; gap: 12px; min-height: 52px; padding: 8px; border-radius: 14px; text-align: left; color: var(--text-secondary); }
.row:hover { background: rgba(127, 127, 127, .1); }
.fold { flex: none; width: 34px; height: 34px; border-radius: 11px; display: grid; place-items: center; }
.nm { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.nm b { font-size: 15px; font-weight: 500; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nm small { font-size: 12.5px; color: var(--text-secondary); }
.foot { margin: 0 4px; font-size: 12px; color: var(--text-tertiary); word-break: keep-all; }
.files { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; max-height: 220px; overflow-y: auto; }
.files li { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 12px; background: var(--button-bg); font-size: 14px; min-width: 0; }
.files .fn { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.files small { flex: none; font-size: 12px; color: var(--text-secondary); }
.note { margin: 0 4px; font-size: 12.5px; color: var(--text-secondary); }
/* the first line of the words that came, as they came (the person sees what would go in) */
.said { margin: 0; padding: 8px 12px; border-left: 3px solid var(--hairline, rgba(127, 127, 127, .3)); border-radius: 4px 12px 12px 4px; background: var(--button-bg);
  font-size: 13.5px; line-height: 1.45; color: var(--text-primary); overflow-wrap: anywhere; white-space: pre-line; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.files .more { background: transparent; padding: 0 10px; color: var(--text-secondary); font-size: 13px; }
.acts { display: flex; flex-wrap: wrap; gap: 8px; }
.go { height: 40px; padding: 0 18px; border-radius: 20px; background: var(--ink); color: var(--ink-inverse); font-size: 14.5px; font-weight: 600; }
.go:disabled { opacity: .5; }
.acts .soft { height: 40px; border-radius: 20px; padding: 0 16px; }
.acts .go { flex: 1; min-width: 120px; }
</style>
