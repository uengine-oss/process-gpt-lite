<script setup>
// The agent's workroom (/workroom/:kind/:id), laid out like agent-share: the agent's terminal is
// the screen (Claude Code resumed on the run's own session, or a shell in its folder), the run's
// files sit in a side panel, and a file opens in place of the terminal (✕ 터미널 to go back) in
// the viewer the shared folders use too (components/files/FileView.vue). A deepagents run gets a
// steer box under the terminal instead (it has no terminal session of its own).
import { ref, computed, onMounted, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Icon from '../components/Icon.vue'
import WorkroomTerminal from '../components/WorkroomTerminal.vue'
import FileView from '../components/files/FileView.vue'
import { viewOf, fmtSize } from '../components/folders/fileKind.js'
import { api, auth } from '../api.js'
import { BASE } from '../base.js'

const route = useRoute()
const router = useRouter()
const kind = computed(() => route.params.kind)
const id = computed(() => route.params.id)
const base = computed(() => `/workroom/${kind.value}/${encodeURIComponent(id.value)}`)

const room = ref(null)
const err = ref('')
const filter = ref('')
const openDirs = ref(new Set(['']))
const file = ref(null)          // { path, content?, mtime }
const mode = ref('preview')     // markdown: preview | edit
const dirty = ref(false)
const viewer = ref(null)
const saving = ref(false)
const note = ref('')
const side = ref(window.innerWidth > 900)
const tab = ref('claude')       // claude | shell
const opened = ref({ shell: false, claude: false })
const termState = ref({})
const terms = ref({})
const steerText = ref('')
const steerNote = ref('')

const isClaude = computed(() => room.value?.agent === 'claude-code')
async function load() {
  err.value = ''
  try { room.value = await api(base.value) }
  catch (e) { err.value = e.status === 403 || /403|권한/.test(e.message) ? '이 작업실을 볼 권한이 없어요 — 이 실행의 담당자·참여자나 관리자만 열 수 있어요.' : '이 실행의 작업 폴더를 찾지 못했어요.'; return }
  if (!isClaude.value) tab.value = 'shell'
  opened.value[tab.value] = true
  if (route.query.open && !file.value) openFile(String(route.query.open))
}
onMounted(load)

const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
const shown = computed(() => {
  const all = room.value?.files || []
  const k = filter.value.trim().toLowerCase()
  if (k) return all.filter((f) => !f.dir && f.path.toLowerCase().includes(k))
  return all.filter((f) => { let p = parentOf(f.path); while (p) { if (!openDirs.value.has(p)) return false; p = parentOf(p) } return true })
})
function toggle(d) { const s = new Set(openDirs.value); s.has(d.path) ? s.delete(d.path) : s.add(d.path); openDirs.value = s }

const rawUrl = (p) => `${BASE}/api${base.value}/raw?path=${encodeURIComponent(p)}&token=${encodeURIComponent(auth.get()?.session?.access_token || '')}`
const isTextView = (p) => ['markdown', 'code', 'text', 'csv'].includes(viewOf(p)) || viewOf(p) === 'none'

async function openFile(p) {
  if (dirty.value && !confirm('저장하지 않은 변경이 있어요. 버릴까요?')) return
  note.value = ''
  mode.value = 'preview'
  dirty.value = false
  if (!isTextView(p)) file.value = { path: p }
  else {
    try { file.value = { path: p, ...(await api(`${base.value}/file?path=${encodeURIComponent(p)}`)) } }
    catch { note.value = '파일을 열지 못했어요.'; return }
  }
  if (window.innerWidth <= 900) side.value = false
  router.replace({ query: { ...route.query, open: p } })
}
function closeFile() {
  if (dirty.value && !confirm('저장하지 않은 변경이 있어요. 버릴까요?')) return
  file.value = null; dirty.value = false; note.value = ''
  const { open, ...rest } = route.query
  router.replace({ query: rest })
  nextTick(() => terms.value[tab.value]?.focus())
}
// office documents and ArtCraft files open in their editors, which load a published copy
const publish = async () => (await api(`${base.value}/publish`, { method: 'POST', body: { path: file.value.path } })).url

async function save(content) {
  saving.value = true
  try {
    const r = await api(`${base.value}/file`, { method: 'PUT', body: { path: file.value.path, content, mtime: file.value.mtime } })
    file.value = { ...file.value, content, mtime: r.mtime }
    note.value = '저장했어요 — 에이전트가 다음에 이 파일을 읽을 때 반영돼요.'
  } catch (e) {
    note.value = /409/.test(e.message) ? '에이전트가 그사이 이 파일을 바꿨어요. 다시 열어 확인해 주세요.' : '저장하지 못했어요.'
  } finally { saving.value = false }
}

function openTab(t) { tab.value = t; opened.value[t] = true; if (file.value) closeFile() }
const live = computed(() => termState.value[tab.value] === 'live')
const statusText = computed(() => {
  const s = termState.value[tab.value]
  return s === 'live' ? '연결됨' : s === 'denied' ? '열 수 없음' : s === 'exited' ? '끝남' : '연결 중'
})
// "@path" into Claude Code: the agent reads that file as part of the next instruction
async function mention() {
  const p = file.value?.path
  if (!p) return
  closeFile()
  tab.value = 'claude'; opened.value.claude = true
  await nextTick()
  terms.value.claude?.paste(`@${p} `)
}
async function sendSteer() {
  const text = steerText.value.trim()
  if (!text) return
  const r = await api(`${base.value}/steer`, { method: 'POST', body: { text } })
  steerNote.value = r.ok ? '실행 중인 에이전트에 전달했어요 — 다음 단계부터 반영돼요.' : r.status === 409 || r.status === 404 ? '지금 진행 중인 실행이 없어요.' : `전달하지 못했어요 (${r.status})`
  steerText.value = ''
}
</script>

<template>
  <div class="wr">
    <header class="hd">
      <button class="ib" title="뒤로" @click="router.back()"><Icon name="back" :size="17" /></button>
      <span class="brand"><b>&gt;_</b> {{ !room ? '작업실' : isClaude ? 'Claude Code' : 'deepagents' }}</span>
      <span v-if="room" class="chip" :title="room.cwd"><Icon name="doc" :size="13" /> {{ room.folder }}<template v-if="room.branch"> · {{ room.branch }}</template></span>
      <span v-if="room" class="st" :class="{ on: live, bad: termState[tab] === 'denied' }"><i />{{ statusText }}</span>
      <span class="ttl">{{ room?.title }}<template v-if="room?.sub"> · {{ room.sub }}</template><b v-if="room?.running" class="run"> · 실행 중</b></span>
      <span class="sp" />
      <div v-if="isClaude" class="seg">
        <button :class="{ on: tab === 'claude' }" @click="openTab('claude')">Claude Code</button>
        <button :class="{ on: tab === 'shell' }" @click="openTab('shell')">셸</button>
      </div>
      <button v-if="room" class="hb" :class="{ on: side }" @click="side = !side"><Icon name="doc" :size="14" /> 파일</button>
    </header>
    <p v-if="err" class="err">{{ err }}</p>

    <div v-else class="body" :class="{ side }">
      <main class="main">
        <!-- a file in place of the terminal -->
        <section v-if="file" class="fbox">
          <div class="fbar">
            <b class="fname">{{ file.path.split('/').pop() }}</b>
            <code class="fpath">{{ file.path }}</code>
            <span class="sp" />
            <div v-if="viewOf(file.path) === 'markdown'" class="mini">
              <button :class="{ on: mode === 'preview' }" @click="mode = 'preview'">미리보기</button>
              <button :class="{ on: mode === 'edit' }" @click="mode = 'edit'">편집</button>
            </div>
            <button v-if="file.content !== undefined" class="fb" :disabled="!dirty || saving" @click="save(viewer.draft)">{{ saving ? '저장 중…' : dirty ? '저장 ⌘S' : '저장됨' }}</button>
            <button v-if="isClaude" class="fb" title="Claude Code 에 이 파일을 가리켜요" @click="mention">@ Claude</button>
            <a class="fb" :href="rawUrl(file.path)" target="_blank" title="원본 받기">원본</a>
            <button class="fb" @click="closeFile"><Icon name="close" :size="13" /> 터미널</button>
          </div>
          <p v-if="note" class="note">{{ note }}</p>
          <FileView ref="viewer" dark :path="file.path" :text="file.content ?? null" :url="rawUrl(file.path)" :editor-url="publish"
            :editable="file.content !== undefined" :mode="mode" @save="save" @dirty="(d) => (dirty = d)" />
        </section>

        <!-- the terminals stay connected while a file is open -->
        <div v-show="!file" class="terms">
          <template v-if="room">
            <WorkroomTerminal v-for="m in ['claude', 'shell'].filter((x) => opened[x])" v-show="tab === m" :key="m"
              :ref="(c) => (terms[m] = c)" :kind="kind" :id="id" :mode="m" :active="tab === m && !file"
              @state="(s) => (termState[m] = s)" />
          </template>
          <p v-if="termState[tab] === 'denied'" class="deny">이 작업실의 터미널을 열 수 없어요 — 이 실행의 담당자·참여자나 관리자만 열 수 있어요.</p>
        </div>
        <form v-if="room && !isClaude" class="steer" @submit.prevent="sendSteer">
          <input v-model="steerText" placeholder="실행 중인 에이전트에게 방향 지시 — 다음 단계부터 반영돼요" />
          <button class="fb main" :disabled="!steerText.trim()">보내기</button>
          <small v-if="steerNote">{{ steerNote }}</small>
        </form>
      </main>

      <aside v-show="side" class="files">
        <div class="fh"><b>작업 파일</b><span class="sp" /><button class="ib sm" title="새로고침" @click="load"><Icon name="refresh" :size="14" /></button>
          <button class="ib sm" title="닫기" @click="side = false"><Icon name="close" :size="14" /></button></div>
        <div class="crumb">{{ room?.folder }}</div>
        <input v-model="filter" class="flt" placeholder="파일 찾기" />
        <div class="list">
          <button v-for="f in shown" :key="f.path" class="node" :class="{ dir: f.dir, sel: file?.path === f.path }"
            :style="{ paddingLeft: (filter ? 12 : 12 + f.depth * 14) + 'px' }" @click="f.dir ? toggle(f) : openFile(f.path)">
            <span class="ico">{{ f.dir ? (openDirs.has(f.path) ? '▾' : '▸') : '·' }}</span>
            <span class="nm">{{ filter ? f.path : f.path.split('/').pop() }}</span>
            <small v-if="!f.dir">{{ fmtSize(f.size) }}</small>
          </button>
          <p v-if="room && !room.files.length" class="empty">아직 파일이 없어요.</p>
        </div>
        <p class="tip">파일을 누르면 터미널 자리에서 열려요. 고친 내용은 에이전트가 다음에 읽을 때 그대로 반영돼요.</p>
      </aside>
    </div>
  </div>
</template>

<style scoped>
/* agent-share's look: dark, the terminal is the screen */
.wr { position: fixed; inset: 0; z-index: 30; display: flex; flex-direction: column; background: #1b1d24; color: #d8dbe2; font-size: 13.5px; }
.hd { display: flex; align-items: center; gap: 10px; height: 48px; padding: 0 12px; border-bottom: 1px solid #2b2f3a; background: #1b1d24; flex: none; }
.ib { width: 32px; height: 32px; border-radius: 8px; display: grid; place-items: center; color: #aeb3bf; }
.ib:hover { background: #2a2e38; } .ib.sm { width: 28px; height: 28px; border: 1px solid #2f3440; }
.brand { font-weight: 600; color: #f0f1f4; white-space: nowrap; } .brand b { color: #9aa0ab; font-weight: 500; margin-right: 2px; }
.chip { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 10px; border-radius: 6px; border: 1px solid #343a63; background: #23263a; color: #8ab4ff; font: 12.5px "SF Mono", Menlo, monospace; white-space: nowrap; max-width: 34vw; overflow: hidden; text-overflow: ellipsis; }
.st { display: inline-flex; align-items: center; gap: 6px; color: #9aa0ab; font-size: 12.5px; white-space: nowrap; }
.st i { width: 8px; height: 8px; border-radius: 50%; background: #6b7280; } .st.on i { background: #7ccf6b; } .st.bad i { background: #f87171; }
.ttl { color: #8a909c; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.run { color: #f5a524; font-weight: 500; }
.sp { flex: 1; }
.seg { display: flex; border: 1px solid #2f3440; border-radius: 8px; overflow: hidden; flex: none; }
.seg button { height: 30px; padding: 0 12px; font-size: 12.5px; color: #aeb3bf; } .seg button.on { background: #2f3550; color: #fff; }
.hb { height: 32px; padding: 0 12px; border-radius: 8px; border: 1px solid #2f3440; color: #aeb3bf; display: inline-flex; align-items: center; gap: 6px; font-size: 13px; flex: none; }
.hb.on { border-color: #4b5bd6; background: #23284a; color: #c8d1ff; }
.err { margin: 40px auto; color: #f87171; }
.body { flex: 1; min-height: 0; display: grid; grid-template-columns: 1fr; }
.body.side { grid-template-columns: 1fr 360px; }
.main { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.terms { flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative; }
.terms :deep(.wt) { flex: 1; min-height: 0; background: #1b1d24; }
.terms :deep(.xt) { padding: 8px 6px 0 12px; }
.deny { position: absolute; left: 50%; top: 40%; transform: translate(-50%, -50%); margin: 0; padding: 14px 18px; border-radius: 10px; background: #2a1f24; color: #f3b2b2; font-size: 13.5px; }
.fbox { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.fbar { display: flex; align-items: center; gap: 8px; height: 46px; padding: 0 12px; border-bottom: 1px solid #2b2f3a; flex: none; }
.fname { color: #f0f1f4; font-weight: 600; white-space: nowrap; }
.fpath { color: #7d8390; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.mini { display: flex; border: 1px solid #2f3440; border-radius: 7px; overflow: hidden; }
.mini button { height: 28px; padding: 0 11px; font-size: 12.5px; color: #aeb3bf; } .mini button.on { background: #2f3550; color: #c8d1ff; }
.fb { height: 30px; padding: 0 11px; border-radius: 7px; border: 1px solid #2f3440; color: #c3c8d2; font-size: 12.5px; display: inline-flex; align-items: center; gap: 5px; text-decoration: none; white-space: nowrap; }
.fb:hover { background: #262a34; } .fb:disabled { opacity: .45; } .fb.main { background: #3b4bd1; border-color: #3b4bd1; color: #fff; }
.note { margin: 0; padding: 6px 14px; font-size: 12.5px; color: #8ab4ff; background: #20253a; }
.steer { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-top: 1px solid #2b2f3a; flex-wrap: wrap; flex: none; }
.steer input { flex: 1; min-width: 200px; height: 34px; border-radius: 8px; border: 1px solid #2f3440; background: #22252e; color: #fff; padding: 0 12px; font-size: 13.5px; }
.steer small { width: 100%; color: #8fbf8f; font-size: 12px; }
.files { min-height: 0; display: flex; flex-direction: column; border-left: 1px solid #2b2f3a; background: #1a1c22; }
.fh { display: flex; align-items: center; gap: 6px; height: 48px; padding: 0 12px 0 16px; border-bottom: 1px solid #2b2f3a; } .fh b { color: #f0f1f4; }
.crumb { padding: 10px 16px; color: #8ab4ff; font: 12.5px "SF Mono", Menlo, monospace; border-bottom: 1px solid #2b2f3a; }
.flt { margin: 10px 12px; height: 32px; border-radius: 7px; border: 1px solid #2f3440; background: #22252e; color: #e6e6e6; padding: 0 10px; font-size: 13px; }
.list { flex: 1; overflow: auto; padding: 0 6px 10px; }
.node { display: flex; align-items: center; gap: 8px; width: 100%; height: 34px; border-radius: 7px; text-align: left; color: #d8dbe2; padding-right: 10px; }
.node:hover { background: #242833; } .node.sel { background: #2a3150; }
.ico { width: 12px; color: #7d8390; flex: none; text-align: center; }
.node.dir .nm { color: #e9c46a; }
.nm { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.node small { color: #6d7380; font-size: 11.5px; flex: none; }
.empty { color: #7d8390; padding: 14px; }
.tip { margin: 0; padding: 12px 16px; border-top: 1px solid #2b2f3a; color: #7d8390; font-size: 12px; line-height: 1.55; }
@media (max-width: 900px) {
  .body.side { grid-template-columns: 1fr; }
  .files { position: fixed; top: 48px; right: 0; bottom: 0; width: min(360px, 92vw); z-index: 2; box-shadow: -10px 0 30px rgba(0, 0, 0, .4); }
  .ttl, .chip { display: none; }
}
</style>
