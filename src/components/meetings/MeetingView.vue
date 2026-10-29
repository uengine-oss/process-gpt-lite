<script setup>
// The meeting (회의) over the page: lobby (camera preview + 받아쓰기·기록 동의) → tiles of everyone,
// the assistant's tile ("프로세스 GPT 라이트 도우미"), the side panel (자막 · 자료 · 부탁 제안) and the
// stage — the material someone put up for everyone ("모두에게 띄우기"), opened in the same editors
// the rest of the app uses (OfficeEditorFrame / CraftEditorFrame), each person on their own copy.
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { useMeetings } from '../../stores/meetings.js'
import { useApp } from '../../stores/app.js'
import { useTeam } from '../../stores/team.js'
import { openArtifact } from '../../artifacts.js'
import { officeEditorFor, CRAFT_APPS } from '../../officeEditor.js'

import { api } from '../../api.js'
import VideoTile from './VideoTile.vue'
import { MAIN_LANGS, langLabel } from '../../i18n/mainLangs.js'
import MaterialBody from './MaterialBody.vue'
import OfficeEditorFrame from '../OfficeEditorFrame.vue'
import CraftEditorFrame from '../CraftEditorFrame.vue'

const mt = useMeetings()
const app = useApp()
const team = useTeam()
const router = useRouter()
const draft = ref('')
const busy = ref('')
const lineBox = ref(null)
const preview = ref(null)
const now = ref(Date.now())
const tick = setInterval(() => (now.value = Date.now()), 1000)
onBeforeUnmount(() => clearInterval(tick))

const m = computed(() => mt.m)
const others = computed(() => Object.values(mt.peers))
const elapsed = computed(() => {
  if (!m.value) return ''
  const s = Math.max(0, Math.round((now.value - new Date(m.value.startedAt)) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
})
const declined = computed(() => (m.value?.peers || []).filter((p) => !p.consent).map((p) => p.name))
const shown = computed(() => mt.stage || mt.mine)
const KIND = { file: '파일', process: '진행 상황', panel: '앱 데이터', folder: '폴더 문서', result: '에이전트 결과' }
const hhmm = (d) => new Date(d).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
const editorOf = (msg) => (msg ? officeEditorFor(msg.content?.name || msg.content?.url) : null)

watch(() => mt.lines.length, async () => { await nextTick(); const el = lineBox.value; if (el) el.scrollTop = el.scrollHeight })
watch(() => mt.tab, (t) => { if (t === 'materials') mt.unseen = 0 })
watch(() => mt.flash, (id) => { if (id) setTimeout(() => { if (mt.flash === id) mt.flash = null }, 2600) })
// the lobby preview
watch(() => [mt.local, preview.value], () => { if (preview.value && mt.local) preview.value.srcObject = mt.local })

async function run(key, fn) {
  busy.value = key; mt.error = ''
  try { await fn() } catch (e) { mt.error = e.message || '처리하지 못했어요.' } finally { busy.value = '' }
}
const join = () => run('join', () => mt.join())
const send = () => run('say', async () => { const t = draft.value.trim(); if (!t) return; await mt.say(t); draft.value = '' })
const onKey = (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); send() } }
const openMine = (x) => run(`o${x.id}`, () => mt.openMine(x))
const present = (x) => run(`p${x.id}`, () => mt.present(x))
const startTask = (s) => run(`s${s.id}`, () => mt.startTask(s))
// the full editor over the page; the meeting shrinks to a corner meanwhile
function bigEditor(msg) {
  if (!msg) return
  const list = (app.messages[msg.thread_id] ||= [])
  if (!list.some((x) => x.id === msg.id)) list.push(msg)
  openArtifact(app, router, msg)
  mt.mini = true
}
async function openShare(f) {
  await run(`f${f.shareId}`, async () => {
    const { message } = await api(`/team/shares/${f.shareId}/open`, { method: 'POST' })
    mt.mine = { material: { id: `share:${f.shareId}`, kind: 'file', title: message.content.name, file: { own: true } }, message }
  })
}
async function saved(msg, { url, name }) {
  if (!url || !msg?.id) return
  await api(`/messages/${msg.id}/file`, { method: 'POST', body: { url, name } }).catch(() => {})
}
const back = () => { mt.mini = false; app.officeDoc = null }
onMounted(() => mt.boot())

// ---- languages (통역) ----
const myLang = computed(() => mt.myLang)
// the lobby: the language I will speak and read in (my main language, saved for my account)
const lobbyLang = ref('')
watch(() => mt.lobby, (l) => { if (l) lobbyLang.value = app.me?.mainLang || 'ko' }, { immediate: true })
async function saveLobbyLang() {
  const v = lobbyLang.value
  await run('lang', async () => {
    await api('/me/main-lang', { method: 'PUT', body: { lang: v } })
    if (app.me) app.me = { ...app.me, mainLang: v, mainLangSet: v }
  })
}
const interp = computed(() => mt.interp)
const langsLine = computed(() => (interp.value?.langs || []).map(langLabel).join(' ⇄ '))
// a subtitle line as I read it: my language's translation first (the original under it), or the original
const other = (l) => !!l.lang && l.lang !== myLang.value
const trOf = (l) => (other(l) ? l.tr?.[myLang.value] || null : null)
</script>

<template>
  <!-- lobby: before joining -->
  <div v-if="mt.lobby && !m" class="veil lobby">
    <section class="lob" role="dialog" aria-label="회의 참여">
      <h2>{{ mt.lobby.title || '팀 대화' }} · 회의</h2>
      <div class="pv"><video ref="preview" autoplay playsinline muted /><span v-if="!mt.local" class="pvn">카메라 없음</span></div>
      <div class="lobtg">
        <button class="tg press" :class="{ off: !mt.mic }" @click="mt.toggle('mic')">{{ mt.mic ? '마이크 켬' : '마이크 끔' }}</button>
        <button class="tg press" :class="{ off: !mt.cam }" @click="mt.toggle('cam')">{{ mt.cam ? '카메라 켬' : '카메라 끔' }}</button>
      </div>
      <div class="lobl">
        <span><b>내가 말하는 언어</b><small>다른 언어로 말하는 분의 말은 이 언어로 통역해 들려 드리고, 자막은 원문과 번역을 함께 보여 드려요 (AI 통역)</small></span>
        <select v-model="lobbyLang" data-test="lobby-lang" data-no-i18n :disabled="busy === 'lang'" @change="saveLobbyLang">
          <option v-for="[code, name] in MAIN_LANGS" :key="code" :value="code">{{ name }}</option>
        </select>
      </div>
      <label class="consent" :class="{ on: mt.consent }">
        <input v-model="mt.consent" type="checkbox" data-test="consent">
        <span><b>받아쓰기와 대화방 기록에 동의해요</b>
          <small>동의한 분의 말만 글로 바꿔 자막으로 보여 주고, 회의록으로 이 대화방에 남겨요. 도우미가 말의 의도에 맞는 자료를 찾을 때 판단 모델에는 최근 몇 줄만 가요. 동의하지 않으면 내 소리는 서버로 가지 않아요.</small></span>
      </label>
      <p v-if="mt.error" class="err">{{ mt.error }}</p>
      <div class="lobbtn"><button class="ghost press" @click="mt.cancelLobby()">취소</button><button class="main press" data-test="join" :disabled="busy === 'join'" @click="join">{{ busy === 'join' ? '들어가는 중…' : '참여하기' }}</button></div>
    </section>
  </div>

  <!-- the meeting -->
  <div v-else-if="m" class="veil meet" :class="{ mini: mt.mini }" data-test="meeting-view">
    <template v-if="mt.mini">
      <div class="minibox glass">
        <VideoTile v-if="others[0]" :stream="others[0].stream" :name="others[0].name" :consent="others[0].consent" />
        <VideoTile v-else :stream="mt.local" :name="m.me.name" me :cam-off="!mt.cam" :consent="m.me.consent" />
        <div class="minibar"><span>회의 중 · {{ m.peers.length }}명 · {{ elapsed }}</span><button class="main press" @click="back">회의로 돌아가기</button></div>
      </div>
    </template>
    <template v-else>
      <header class="mh">
        <span class="live" /> <b>{{ m.title || '팀 대화' }} · 회의</b>
        <span class="meta">{{ m.peers.length }}명 · {{ elapsed }}</span>
        <span v-if="m.agent" class="chip ag" :class="{ off: !m.me.consent }">{{ m.me.consent ? '받아쓰기·기록 중' : '내 말은 기록 안 함' }}</span>
        <span v-else class="chip off">도우미 꺼짐</span>
        <span v-if="declined.length && m.agent" class="chip warn">기록 안 함: {{ declined.join(', ') }}</span>
        <span v-if="interp?.on" class="chip ai" data-test="ai-interp" :title="'AI가 각자의 언어로 통역해요'">AI 통역 · <span data-no-i18n>{{ langsLine }}</span></span>
        <button v-if="interp?.available && m.agent && (interp.mixed || interp.setting !== null)" class="chip tgl press" :class="{ on: interp.on }" data-test="interp-switch" @click="mt.setInterp(!interp.on)">{{ interp.on ? '통역 켬' : '통역 끔' }}</button>
      </header>
      <p v-if="mt.interpNote" class="inote" data-test="interp-note">{{ mt.interpNote }}</p>

      <div class="body">
        <main class="area" :class="{ staged: !!shown }">
          <!-- the stage: what everyone (or only I) is looking at -->
          <section v-if="shown" class="stage" data-test="stage">
            <div class="sh">
              <span class="who">{{ mt.stage ? `${mt.stage.by}님이 모두에게 띄웠어요` : '나만 보는 중' }}</span>
              <b v-if="shown.material">{{ KIND[shown.material.kind] }} · {{ shown.material.title }}</b>
              <span class="sp" />
              <button v-if="mt.mine && !mt.stage && shown.material && !String(shown.material.id).startsWith('share:')" class="sb main press" @click="present(shown.material)">모두에게 띄우기</button>
              <button v-if="shown.message" class="sb press" @click="bigEditor(shown.message)">편집기로 크게</button>
              <button v-if="mt.stage && mt.stage.byId === m.me.id" class="sb press" @click="mt.clearStage()">내리기</button>
              <button v-if="mt.mine && !mt.stage" class="sb press" @click="mt.mine = null">닫기</button>
            </div>
            <div class="sbody">
              <p v-if="shown.hidden" class="hidden">{{ shown.by }}님이 띄운 자료는 볼 권한이 없어요. 띄운 분께 공유를 부탁해 주세요.</p>
              <template v-else-if="shown.material?.kind === 'file'">
                <template v-if="shown.message">
                  <CraftEditorFrame v-if="CRAFT_APPS.has(editorOf(shown.message))" :key="shown.message.id" :file-url="shown.message.content.url" :name="shown.message.content.name" @saved="(e) => saved(shown.message, e)" />
                  <OfficeEditorFrame v-else-if="editorOf(shown.message)" :key="shown.message.id" :file-url="shown.message.content.url" :name="shown.message.content.name" assistant @saved="(e) => saved(shown.message, e)" />
                  <MaterialBody v-else :m="shown.material" big />
                </template>
                <p v-else class="hidden">여는 중…</p>
              </template>
              <div v-else-if="shown.material" class="pad"><MaterialBody :m="shown.material" big @open-share="openShare" /></div>
            </div>
          </section>

          <div class="tiles" :class="[`n${Math.min(others.length + 2, 6)}`, { strip: !!shown }]">
            <VideoTile :stream="mt.screen ? mt.screenStream : mt.local" :name="m.me.name" me :muted="!mt.mic" :cam-off="!mt.cam && !mt.screen" :consent="m.me.consent || !m.agent" :level="mt.level" :screen="mt.screen" :lang="myLang" :show-lang="!!interp?.mixed" />
            <VideoTile v-for="p in others" :key="p.id" :stream="p.stream" :name="p.name" :consent="p.consent || !m.agent" :state="p.state" :muted="p.media && !p.media.mic" :cam-off="p.media && !p.media.cam && !p.media.screen" :screen="p.media?.screen"
              :lang="p.lang || m.peers.find((x) => x.id === p.id)?.lang" :show-lang="!!interp?.mixed" :interpreting="!!mt.onAir[p.id] && mt.listen === 'interp'" @el="(el) => mt.registerEl(p.id, el)" />
            <div v-if="m.agent" class="tile agent" data-test="agent-tile">
              <div class="orb"><span /><span /><span /></div>
              <b>프로세스 GPT 라이트 도우미</b>
              <small class="say">{{ mt.agentSay }}</small>
            </div>
          </div>
        </main>

        <aside class="side">
          <nav class="tabs">
            <button :class="{ on: mt.tab === 'lines' }" data-test="tab-lines" @click="mt.tab = 'lines'">자막</button>
            <button :class="{ on: mt.tab === 'materials' }" data-test="tab-materials" @click="mt.tab = 'materials'">자료<i v-if="mt.materials.length">{{ mt.materials.length }}</i><em v-if="mt.unseen" class="new">새 자료</em></button>
          </nav>
          <div v-if="mt.suggestions.length" class="sugs">
            <div v-for="s in mt.suggestions" :key="s.id" class="sug" :class="s.state" data-test="meeting-suggestion">
              <template v-if="s.state === 'open'">
                <p class="sq"><span class="vb">{{ s.kind }}</span> 이 일을 도와드릴까요? · <b>{{ s.title }}</b></p>
                <p class="why">{{ s.reason }}</p>
                <div class="sbtn"><button class="main press" :disabled="busy === `s${s.id}`" data-test="suggestion-start" @click="startTask(s)">{{ busy === `s${s.id}` ? '시작하는 중…' : '시작' }}</button><button class="ghost press" @click="mt.dismissTask(s)">아니요</button><small>내 에이전트로 해요 · 결과는 자료와 대화방에</small></div>
              </template>
              <p v-else-if="s.state === 'running'" class="sq"><span class="shimmer-text">{{ team.assistStatus[s.id] || mt.tasks[s.id]?.by + '님의 에이전트가 작업하는 중' }}</span></p>
              <p v-else-if="s.state === 'done'" class="sq done">✓ {{ s.title }} — 자료에 결과가 올라왔어요</p>
              <p v-else class="sq bad">{{ s.title }} — 작업하지 못했어요</p>
            </div>
          </div>

          <div v-if="mt.tab === 'lines'" ref="lineBox" class="lines scroll" data-test="lines">
            <p v-if="!m.agent" class="empty">이 회의는 도우미가 꺼져 있어 자막이 없어요.</p>
            <p v-else-if="!mt.lines.length" class="empty">말하면 여기에 화자별 자막이 떠요. 동의한 분의 말만 받아써요.</p>
            <button v-if="interp?.mixed && mt.lines.some(trOf)" class="origtog press" data-test="subs-original" @click="mt.showOriginal = !mt.showOriginal">{{ mt.showOriginal ? '내 언어로 먼저 보기' : '원문 먼저 보기' }}</button>
            <div v-for="l in mt.lines" :key="l.id" class="ln" :class="{ me: l.userId === m.me.id, tr: !!trOf(l) }" :data-lang="l.lang" data-test="line">
              <span class="sp">{{ l.speaker }}</span>
              <span class="tx" data-no-i18n>
                <template v-if="trOf(l) && !mt.showOriginal"><span class="mtx" data-test="line-tr">{{ trOf(l) }}</span><span class="orig" data-test="line-orig"><i>{{ langLabel(l.lang) }}</i> {{ l.text }}</span></template>
                <template v-else-if="trOf(l)"><span class="mtx" data-test="line-orig">{{ l.text }}</span><span class="orig" data-test="line-tr"><i>{{ langLabel(myLang) }}</i> {{ trOf(l) }}</span></template>
                <template v-else><span class="mtx">{{ l.text }}</span><span v-if="other(l) && interp?.available && interp?.on !== false" class="orig wait">…</span></template>
              </span>
              <small>{{ hhmm(l.at) }}</small>
            </div>
          </div>
          <div v-else class="mats scroll" data-test="materials">
            <p v-if="!mt.materials.length" class="empty">회의 중에 "지난번 견적서 다시 보자" 처럼 말하면, 도우미가 볼 수 있는 자료를 찾아 여기에 띄워요.</p>
            <article v-for="x in [...mt.materials].reverse()" :key="x.id" class="mat" :class="{ flash: mt.flash === x.id, on: shown?.material?.id === x.id }" :data-kind="x.kind" data-test="material">
              <p class="mk">{{ KIND[x.kind] }}<template v-if="x.presentedBy"> · 띄웠어요</template></p>
              <MaterialBody :m="x" @open-share="openShare" />
              <p v-if="x.reason" class="why">{{ x.byAgent ? '도우미가 찾았어요 · ' : '' }}{{ x.reason }}</p>
              <div class="mbtn">
                <button class="press" :disabled="busy === `o${x.id}`" @click="openMine(x)">열기</button>
                <button v-if="x.kind !== 'result'" class="main press" :disabled="busy === `p${x.id}`" data-test="present" @click="present(x)">모두에게 띄우기</button>
              </div>
            </article>
          </div>
          <footer v-if="mt.tab === 'lines' && m.agent" class="type">
            <input v-model="draft" :placeholder="m.me.consent ? '말 대신 적어도 돼요' : '기록에 동의하면 적을 수 있어요'" :disabled="!m.me.consent" @keydown="onKey">
            <button class="main press" :disabled="!draft.trim() || busy === 'say'" @click="send">보내기</button>
          </footer>
        </aside>
      </div>

      <footer class="bar">
        <button class="ctl press" :class="{ off: !mt.mic }" data-test="mic" @click="mt.toggle('mic')">{{ mt.mic ? '🎙 마이크' : '🔇 음소거' }}</button>
        <button class="ctl press" :class="{ off: !mt.cam }" @click="mt.toggle('cam')">{{ mt.cam ? '📷 카메라' : '📷 꺼짐' }}</button>
        <button class="ctl press" :class="{ on: mt.screen }" @click="mt.toggleScreen()">🖥 {{ mt.screen ? '공유 중지' : '화면 공유' }}</button>
        <button v-if="m.agent" class="ctl press" :class="{ on: m.me.consent }" data-test="consent-toggle" @click="mt.setConsent(!m.me.consent)">{{ m.me.consent ? '✓ 기록 동의' : '기록 동의 안 함' }}</button>
        <button v-if="interp?.on && interp?.voice" class="ctl press" :class="{ on: mt.listen === 'interp' }" data-test="listen-toggle" @click="mt.setListen(mt.listen === 'interp' ? 'original' : 'interp')">{{ mt.listen === 'interp' ? '🎧 통역 듣는 중' : '🔊 원래 소리 듣는 중' }}</button>
        <span class="sp" />
        <span v-if="mt.sending" class="send">받아쓰는 중…</span>
        <p v-if="mt.error" class="err">{{ mt.error }}</p>
        <button class="ctl press" data-test="leave" @click="mt.leave()">나가기</button>
        <button class="ctl red press" data-test="end" @click="mt.endAll()">회의 끝내기</button>
      </footer>
    </template>
  </div>
</template>

<style scoped>
.veil { position: fixed; inset: 0; z-index: 60; }
.lobby { background: rgba(10, 12, 18, .72); display: grid; place-items: center; padding: 16px; }
.lob { width: min(520px, 100%); background: #fff; color: #1d1d1f; border-radius: 24px; padding: 22px; box-shadow: 0 24px 80px rgba(0, 0, 0, .4); animation: pop-in .3s var(--spring); }
.lob h2 { margin: 0 0 14px; font-size: 19px; font-weight: 600; }
.pv { position: relative; border-radius: 16px; overflow: hidden; background: #1c1f26; aspect-ratio: 16 / 9; }
.pv video { width: 100%; height: 100%; object-fit: cover; }
.pvn { position: absolute; inset: 0; display: grid; place-items: center; color: #aaa; }
.lobtg { display: flex; gap: 8px; margin: 10px 0; }
.tg { height: 32px; padding: 0 14px; border-radius: 16px; background: #eef1f6; font-size: 13.5px; }
.tg.off { background: #fde8e8; color: #c62828; }
.consent { display: flex; gap: 10px; padding: 12px; border-radius: 14px; background: #f5f6f8; cursor: pointer; border: 1.5px solid transparent; }
.consent.on { border-color: #7a5af5; background: #f3f0ff; }
.consent input { margin-top: 3px; width: 18px; height: 18px; accent-color: #7a5af5; }
.consent span { display: flex; flex-direction: column; gap: 4px; font-size: 14px; }
.consent small { font-size: 12.5px; color: #5f6368; line-height: 1.5; }
.lobbtn { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.lobbtn button, .main, .ghost { height: 38px; padding: 0 18px; border-radius: 19px; font-size: 14.5px; }
.main { background: #7a5af5; color: #fff; }
.ghost { background: transparent; color: #5f6368; }
.err { color: #e5484d; font-size: 13px; margin: 8px 0 0; }
.lobl { display: flex; align-items: center; gap: 10px; padding: 10px 12px; margin-bottom: 8px; border-radius: 14px; background: #f5f6f8; }
.lobl span { flex: 1; display: flex; flex-direction: column; gap: 3px; font-size: 14px; }
.lobl small { font-size: 12px; color: #5f6368; line-height: 1.45; }
.lobl select { height: 34px; border-radius: 10px; border: 1px solid #dfe1e5; padding: 0 8px; font-size: 14px; background: #fff; }
.chip.ai { background: linear-gradient(90deg, rgba(122, 90, 245, .45), rgba(42, 120, 214, .45)); color: #fff; font-weight: 500; }
.chip.tgl { border: 1px solid rgba(255, 255, 255, .25); background: transparent; color: #cfd3da; }
.chip.tgl.on { background: rgba(122, 90, 245, .3); color: #e3dcff; border-color: rgba(122, 90, 245, .6); }
.inote { margin: 0 18px 8px; padding: 7px 12px; border-radius: 10px; background: rgba(255, 196, 0, .14); color: #ffd877; font-size: 13px; }
.ln .tx { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ln .orig { font-size: 12.5px; color: #80858d; }
.ln .orig i { font-style: normal; font-size: 10.5px; padding: 0 5px; margin-right: 3px; border-radius: 5px; background: #eef0f3; color: #5f6368; }
.ln .orig.wait { letter-spacing: 2px; }
.ln.tr .mtx { color: #1d1d1f; }
.origtog { display: block; margin: 2px auto 6px; font-size: 12px; height: 26px; padding: 0 12px; border-radius: 13px; background: #f0f1f4; color: #5f6368; }

.meet { background: #0f1115; color: #f2f3f5; display: flex; flex-direction: column; }
.mh { height: 50px; flex: none; display: flex; align-items: center; gap: 10px; padding: 0 18px; font-size: 15px; }
.live { width: 9px; height: 9px; border-radius: 5px; background: #e5484d; box-shadow: 0 0 0 4px rgba(229, 72, 77, .25); }
.meta { color: #9aa0a6; font-size: 13.5px; }
.chip { font-size: 12px; padding: 3px 10px; border-radius: 10px; background: rgba(122, 90, 245, .25); color: #cfc3ff; }
.chip.off { background: rgba(255, 255, 255, .1); color: #9aa0a6; }
.chip.warn { background: rgba(229, 72, 77, .2); color: #ffb3b5; }
.body { flex: 1; min-height: 0; display: flex; gap: 12px; padding: 0 12px; }
.area { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.tiles { flex: 1; min-height: 0; display: grid; gap: 10px; grid-template-columns: repeat(2, 1fr); align-content: center; }
.tiles.n5, .tiles.n6 { grid-template-columns: repeat(3, 1fr); }
.tiles.strip { flex: none; display: flex; height: 112px; }
.tiles.strip > * { height: 100%; aspect-ratio: 16 / 9; flex: none; }
.tile.agent { border-radius: 18px; aspect-ratio: 16 / 9; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; text-align: center; padding: 10px;
  background: radial-gradient(circle at 50% 40%, #3b2c86, #1a1638 70%); border: 1px solid rgba(122, 90, 245, .5); }
.tile.agent b { font-size: 15px; font-weight: 600; }
.strip .tile.agent b { font-size: 11px; }
.strip .tile.agent .orb { transform: scale(.6); margin: -8px 0; }
.say { font-size: 12.5px; color: #cfc3ff; max-width: 90%; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.strip .say { display: none; }
.orb { display: flex; gap: 6px; height: 36px; align-items: center; }
.orb span { width: 10px; height: 22px; border-radius: 5px; background: #a996ff; animation: wave 1.2s ease-in-out infinite; }
.orb span:nth-child(2) { animation-delay: .2s; } .orb span:nth-child(3) { animation-delay: .4s; }
@keyframes wave { 0%, 100% { transform: scaleY(.5); opacity: .7 } 50% { transform: scaleY(1.3); opacity: 1 } }
.stage { flex: 1; min-height: 0; display: flex; flex-direction: column; border-radius: 18px; overflow: hidden; background: #fff; color: #1d1d1f; }
.sh { flex: none; display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: #f1effc; font-size: 13.5px; }
.sh .who { color: #5a3fd0; font-weight: 500; }
.sh .sp, .bar .sp { flex: 1; }
.sb { height: 30px; padding: 0 12px; border-radius: 15px; font-size: 13px; background: #fff; color: #1d1d1f; }
.sb.main { background: #7a5af5; color: #fff; }
.sbody { flex: 1; min-height: 0; position: relative; display: flex; }
.sbody > :deep(*) { flex: 1; min-width: 0; }
.pad { padding: 18px 22px; overflow: auto; }
.hidden { margin: auto; color: #5f6368; font-size: 14px; }
.side { width: 360px; flex: none; display: flex; flex-direction: column; min-height: 0; background: #fff; color: #1d1d1f; border-radius: 18px; overflow: hidden; }
.tabs { display: flex; gap: 4px; padding: 8px; flex: none; }
.tabs button { flex: 1; height: 34px; border-radius: 17px; font-size: 14px; color: #5f6368; position: relative; }
.tabs button.on { background: #1d1d1f; color: #fff; }
.tabs i { font-style: normal; margin-left: 6px; font-size: 11.5px; padding: 1px 6px; border-radius: 8px; background: #7a5af5; color: #fff; }
.tabs .new { position: absolute; top: -4px; right: 6px; font-style: normal; font-size: 10.5px; padding: 1px 6px; border-radius: 7px; background: #e5484d; color: #fff; }
.sugs { flex: none; padding: 0 8px 6px; display: flex; flex-direction: column; gap: 6px; max-height: 40%; overflow: auto; }
.sug { border: 1px solid rgba(122, 90, 245, .45); background: #f6f3ff; border-radius: 14px; padding: 10px 12px; }
.sug.done { border-color: rgba(60, 207, 145, .5); background: #effbf5; }
.sq { margin: 0; font-size: 13.5px; line-height: 1.45; }
.sq.bad { color: #c62828; }
.vb { display: inline-block; padding: 1px 7px; border-radius: 6px; background: #7a5af5; color: #fff; font-size: 12px; margin-right: 4px; }
.why { margin: 5px 0 0; font-size: 12px; color: #6b6f76; line-height: 1.4; }
.sbtn { display: flex; align-items: center; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
.sbtn button { height: 30px; padding: 0 14px; font-size: 13px; border-radius: 15px; }
.sbtn small { font-size: 11px; color: #8a8f98; }
.lines, .mats { flex: 1; min-height: 0; overflow: auto; padding: 4px 10px 10px; }
.empty { font-size: 13px; color: #8a8f98; text-align: center; margin: 24px 10px; line-height: 1.5; }
.ln { display: grid; grid-template-columns: auto 1fr auto; gap: 8px; padding: 7px 4px; border-bottom: 1px solid #f0f1f3; font-size: 14px; line-height: 1.45; animation: pop-in .25s var(--spring); }
.ln .sp { font-weight: 600; color: #3b5bdb; white-space: nowrap; }
.ln.me .sp { color: #0f8a5f; }
.ln small { font-size: 11px; color: #a0a4ab; padding-top: 2px; }
.mat { border-radius: 14px; padding: 10px 12px; margin-bottom: 8px; background: #f6f7f9; border: 1.5px solid transparent; transition: border-color .3s, background .3s; }
.mat.flash { border-color: #7a5af5; background: #f3f0ff; animation: pop-in .35s var(--spring); }
.mat.on { border-color: #2a78d6; }
.mk { margin: 0 0 6px; font-size: 11.5px; font-weight: 600; color: #7a5af5; }
.mbtn { display: flex; gap: 6px; margin-top: 8px; }
.mbtn button { height: 30px; padding: 0 13px; border-radius: 15px; font-size: 13px; background: #e9ebef; }
.mbtn button.main { background: #7a5af5; color: #fff; }
.type { flex: none; display: flex; gap: 6px; padding: 8px; border-top: 1px solid #eee; }
.type input { flex: 1; height: 36px; border-radius: 18px; border: 1px solid #dfe1e5; padding: 0 14px; font-size: 14px; }
.type button { height: 36px; padding: 0 14px; border-radius: 18px; font-size: 13.5px; }
.bar { height: 64px; flex: none; display: flex; align-items: center; gap: 8px; padding: 0 16px; }
.ctl { height: 40px; padding: 0 16px; border-radius: 20px; background: #2a2d35; color: #f2f3f5; font-size: 14px; }
.ctl.off { background: #5c2629; color: #ffb3b5; }
.ctl.on { background: #3d2f80; color: #e3dcff; }
.ctl.red { background: #e5484d; color: #fff; }
.send { font-size: 12.5px; color: #9aa0a6; }
.bar .err { margin: 0; }
.meet.mini { inset: auto 16px 16px auto; width: 300px; background: none; }
.minibox { border-radius: 18px; overflow: hidden; padding: 6px; box-shadow: 0 16px 50px rgba(0, 0, 0, .35); background: rgba(15, 17, 21, .92); }
.minibar { display: flex; align-items: center; gap: 8px; padding: 8px 4px 2px; font-size: 12.5px; color: #e8eaed; }
.minibar span { flex: 1; }
.minibar button { height: 30px; font-size: 12.5px; padding: 0 12px; }
@media (max-width: 760px) { .body { flex-direction: column; } .side { width: auto; height: 45%; } .tiles { grid-template-columns: 1fr 1fr; } }
</style>
