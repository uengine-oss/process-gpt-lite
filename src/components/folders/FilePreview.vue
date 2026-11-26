<script setup>
// 파일을 누르면 그 자리에서 열리는 미리보기 시트. 본문은 작업실과 같은 FileView(같은 방식으로 보임),
// 오른쪽은 색인의 문서 카드와 파일 정보. 이음오피스·ArtCraft 는 스토리지에 올린 사본으로 연다.
// 폴더의 편집자가 main 의 문서(워드·엑셀·PPT·한글)를 열면 이음오피스가 편집으로 열리고, 고친 내용은 저절로 저장돼
// 폴더 main 에 「이음오피스에서 고침」으로 남는다(같은 편집은 이력 한 줄). 닫을 때는 남은 수정을 저장한 뒤에 닫는다.
// 연 뒤에 다른 사람이 먼저 고쳤으면 덮어쓰지 않고 「… (이름 수정본)」으로 옆에 둔다.
// 머리의 「내려받기」(DownloadButton — 파일이 열리는 모든 곳의 같은 단추, 스펙 file-download)는 이 판의 파일을 그 이름으로 받는다. 편집 중이면
// 남은 수정을 먼저 폴더에 저장하고 받으며(따로 저장된 수정본이면 그 파일), 저장하지 못하면 마지막으로 저장된 판을 받을지 묻는다.
import { ref, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '../Icon.vue'
import DownloadButton from '../DownloadButton.vue'
import { freshToken } from '../../api.js'
import FIcon from './FIcon.vue'
import Avatar from './Avatar.vue'
import FileView from '../files/FileView.vue'
import { folders as F, rawUrl, whoOf, ago } from '../../foldersApi.js'
import { useApp } from '../../stores/app.js'
import { viewOf, kindOf, kindLabel, baseName, fmtSize } from './fileKind.js'

const props = defineProps({
  file: Object,          // { path, card?, change? }
  folder: Object,        // { slug, name }
  ref_: { type: String, default: 'main' }, // 'main' or a variation id
  refLabel: String,
})
const emit = defineEmits(['close', 'changed'])
const router = useRouter()
const app = useApp()
const maximized = ref(false)
const text = ref(null)
const info = ref(null)       // index row of main: card, size, author, mtime
const err = ref('')

// (a file under a reference slot is of its original's kind — the slot's name need not carry the extension)
const kindPath = computed(() => props.file?.source_path || info.value?.ref?.from?.path || props.file?.path)
const view = computed(() => viewOf(kindPath.value))
const isText = computed(() => ['markdown', 'code', 'text', 'csv'].includes(view.value) || view.value === 'none')
const url = computed(() => rawUrl(props.folder.slug, props.file.path, props.ref_))
const card = computed(() => info.value?.card || props.file.card || null)
// a file under a reference slot (server lib/folders/refs.js): read from its original folder, never edited from here — 「원본 열기」 goes there
const origin = computed(() => (props.ref_ === 'main' && info.value?.ref?.from) || null)
function openOrigin() {
  const o = origin.value
  emit('close')
  router.push({ path: `/folders/${o.slug}`, query: { file: o.path } })
}

watch(() => [props.file?.path, props.ref_], async () => {
  text.value = null; info.value = null; err.value = ''
  if (props.ref_ === 'main') info.value = await F.file(props.folder.slug, props.file.path).catch(() => null)
  if (isText.value) {
    try { text.value = await F.text(props.folder.slug, props.file.path, props.ref_) } catch (e) { err.value = e.message }
  }
}, { immediate: true })
// editing main's document in IeumOffice: {path, base (the version opened), session} while it is open
const editing = ref(null)
const fv = ref(null)
const saveNote = ref(null)   // { kind: 'busy'|'ok'|'copy'|'err', text }
let chain = Promise.resolve()
let closing = false
let changed = false
const session = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
async function editorUrl() {
  const r = await F.publishInfo(props.folder.slug, props.file.path, props.ref_)
  editing.value = r.editable ? { path: props.file.path, base: r.sha, session: session() } : null
  return { url: r.url, editable: !!r.editable }
}
// each copy the editor saved becomes main's file (in order; a later save of the session folds into its entry)
let lastFail = null // a copy that did not go into the folder: tried again before the sheet closes
function officeSaved({ url }) {
  if (!editing.value || !url) return
  chain = chain.then(() => commitCopy(url))
  return chain
}
async function commitCopy(url) {
  const e = editing.value
  saveNote.value = { kind: 'busy', text: '폴더에 저장하는 중…' }
  try {
    const r = await F.officeSave(props.folder.slug, { path: e.path, base: e.base, url, session: e.session, final: closing })
    editing.value = { ...e, path: r.path, base: r.sha }
    changed = true; lastFail = null
    saveNote.value = r.copied
      ? { kind: 'copy', text: `다른 사람이 먼저 고쳐서, 내 수정은 「${baseName(r.path)}」로 따로 저장했어요.` }
      : { kind: 'ok', text: '폴더에 저장했어요 · 이력에 남았어요' }
    emit('changed')
  } catch (err) { lastFail = { url }; saveNote.value = { kind: 'err', text: `폴더에 저장하지 못했어요: ${err.message}` } }
}
function onEdited(v) { if (v && saveNote.value?.kind === 'ok') saveNote.value = null }
// Leaving (closing, or another screen — FoldersView asks before the route changes): what is left is saved
// first and a copy that did not go into the folder is tried again. When that does not work the sheet stays
// once and says so; leaving again goes without saving.
let triedClose = false
async function leave() {
  if (!editing.value || triedClose) return true
  closing = true
  saveNote.value = { kind: 'busy', text: '닫기 전에 저장하는 중…' }
  const r = await (fv.value?.flush?.(20000) || Promise.resolve({ clean: true }))
  await chain
  if (lastFail) { const { url } = lastFail; chain = chain.then(() => commitCopy(url)); await chain }
  if (r?.timeout || r?.error || lastFail) {
    triedClose = true; closing = false
    saveNote.value = { kind: 'err', text: `${lastFail ? '폴더에 저장하지 못했어요' : `저장을 마치지 못했어요${r.error ? `(${r.error})` : ''}`}. 한 번 더 닫으면 저장하지 않고 닫아요.` }
    return false
  }
  // the card follows the last version once editing ends
  if (changed && !r?.url) await F.officeSave(props.folder.slug, { path: editing.value.path, final: true }).catch(() => {})
  return true
}
async function close() { if (await leave()) emit('close') }
// 「내려받기」: what is left of an edit goes into the folder first (its version is then the one downloaded); a copy saved beside the
// file because someone else changed it first is that copy, said so
async function prepareDownload() {
  if (!editing.value) return { ok: true, version: 'current' }
  const r = await (fv.value?.flush?.(20000) || Promise.resolve({ clean: true }))
  await chain
  if (lastFail) { const { url } = lastFail; chain = chain.then(() => commitCopy(url)); await chain }
  if (r?.timeout || r?.error || lastFail) return { ok: false, why: lastFail ? '폴더에 저장하지 못했어요' : r?.error || '편집기가 답하지 않았어요' }
  return { ok: true, version: r?.saved ? 'saved' : 'current' }
}
async function downloadSource({ last = false } = {}) {
  await freshToken()
  const p = (!last && editing.value?.path) || props.file.path
  const moved = p !== props.file.path
  // (a slot named without the extension: the original's, for the saved file)
  const ext = !/\.[^./]+$/.test(baseName(p)) ? (/\.[^./]+$/.exec(kindPath.value || '') || [''])[0] : ''
  return { url: rawUrl(props.folder.slug, p, props.ref_, true), name: baseName(p) + ext, ...(moved ? { note: `다른 사람이 먼저 고쳐 내 수정은 따로 저장돼 있어요 — 그 파일을 내려받았어요 · ${baseName(p)}` } : {}) }
}
defineExpose({ leave })
// (a commit: the version a file mention named — 멘션한 때의 판)
const where = computed(() => (props.ref_ === 'main' ? '기준본(main)' : /^[0-9a-f]{40}$/.test(props.ref_ || '') ? props.refLabel || '이전 판' : `변형 ${props.refLabel || ''}`))
// the chat composer gets the question started; the folder name makes the agent work in this folder
function ask() {
  const draft = `${props.folder.name} 폴더의 ${props.file.path} `
  emit('close')
  router.push('/chat').then(() => setTimeout(() => { app.prefill = draft }, 700))
}
</script>

<template>
  <div class="veil" :class="{ max: maximized }" @click.self="close">
    <div class="sheet glass" :class="{ max: maximized }">
      <section class="main">
        <header class="hd">
          <span class="fic" :class="kindOf(file.path)">{{ kindLabel[kindOf(file.path)] }}</span>
          <div class="ttl">
            <b>{{ baseName(file.path) }}</b>
            <small><FIcon :name="ref_ === 'main' ? 'folder' : 'branch'" :size="13" /> {{ folder.name }} · {{ ref_ === 'main' ? 'main' : refLabel }} · {{ file.path }}</small>
          </div>
          <span v-if="saveNote" class="sv" :class="saveNote.kind" :title="saveNote.text">{{ saveNote.text }}</span>
          <DownloadButton class="tb" :source="downloadSource" :prepare="prepareDownload" />
          <button class="tb ic press" :title="maximized ? '원래 크기' : '크게 보기'" @click="maximized = !maximized"><Icon :name="maximized ? 'shrink' : 'expand'" :size="15" /></button>
          <button class="tb ic press" title="닫기" @click="close"><Icon name="close" :size="16" /></button>
        </header>
        <div class="body">
          <div v-if="origin" class="refband" data-test="ref-band" role="note">
            <FIcon name="ref" :size="15" />
            <span class="rbt"><b>참조된 자료</b><span class="rbo"> · 원본: {{ origin.name }}/{{ origin.path }}</span></span>
            <button class="tb press" data-test="ref-open-source" @click="openOrigin">원본 열기</button>
          </div>
          <p v-if="err" class="none">{{ err }}</p>
          <p v-else-if="isText && text === null" class="none">여는 중…</p>
          <FileView v-else ref="fv" :path="kindPath" :text="text" :url="url" :editor-url="editorUrl" mode="preview" @office-saved="officeSaved" @office-edited="onEdited" />
        </div>
      </section>

      <aside v-if="!maximized" class="side scroll">
        <template v-if="file.change">
          <div class="sec">이 변형에서 바뀐 점</div>
          <p class="abs">{{ file.change }}</p>
        </template>
        <div class="sec">문서 카드</div>
        <template v-if="card?.abstract">
          <p class="abs">{{ card.abstract }}</p>
          <div v-if="card.keywords?.length" class="kws"><span v-for="k in card.keywords" :key="k">{{ k }}</span></div>
        </template>
        <p v-else-if="ref_ !== 'main'" class="muted">문서 카드는 main 에 반영된 파일에 만들어요.</p>
        <p v-else-if="info?.card_error" class="muted">카드를 만들지 못했어요({{ info.card_error }}). 파일은 이름과 위치로 찾아져요.</p>
        <p v-else-if="info && /\.(md|txt|csv|docx|xlsx|pptx|hwpx|pdf)$/i.test(file.path)" class="muted">카드를 만드는 중이에요. 잠시 뒤 다시 열어 보세요.</p>
        <p v-else class="muted">카드가 없는 파일이에요. 이미지·소리·영상·도면은 이름과 위치로만 찾아져요.</p>

        <dl class="meta">
          <template v-if="card?.n_pages"><dt>쪽</dt><dd>{{ card.n_pages }}쪽</dd></template>
          <template v-if="info?.size"><dt>크기</dt><dd>{{ fmtSize(Number(info.size)) }}</dd></template>
          <template v-if="info?.author"><dt>마지막 수정</dt><dd class="who"><Avatar :who="whoOf({ name: info.author, id: info.author })" :size="20" /> {{ info.author }} · {{ ago(info.mtime) }}</dd></template>
          <dt>위치</dt><dd>{{ where }}</dd>
          <template v-if="origin"><dt>원본</dt><dd>{{ origin.name }}/{{ origin.path }} · 읽기 전용</dd></template>
          <dt>색인</dt><dd>{{ card?.abstract ? '문서 카드' : '파일 목록' }}</dd>
        </dl>

        <div class="acts">
          <button class="act press" @click="ask"><FIcon name="chat" :size="16" /> 에이전트에게 이 파일로 묻기</button>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.veil { position: fixed; inset: 0; z-index: 40; background: rgba(20, 24, 32, .22); display: flex; justify-content: flex-end; align-items: stretch; padding: 76px 16px 16px; animation: fade-in .2s both; }
.veil.max { padding: 0; }
.sheet { width: min(1180px, 92vw); border-radius: 22px; overflow: hidden; display: flex; box-shadow: 0 18px 60px rgba(0, 0, 0, .25); animation: blur-in .35s var(--spring) both; --regular-bg: var(--regular-solid-bg); }
.sheet.max { width: 100%; border-radius: 0; }
.main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.hd { display: flex; align-items: center; gap: 8px; height: 60px; padding: 0 12px 0 16px; border-bottom: 1px solid var(--hairline); flex: none; }
.ttl { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.ttl b { font-size: 15.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ttl small { display: flex; align-items: center; gap: 4px; color: var(--text-secondary); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fic { flex: none; width: 36px; height: 36px; border-radius: 10px; display: grid; place-items: center; font-size: 10.5px; font-weight: 700; color: #fff; background: #6b6b66; }
.fic.hwp { background: #1f6fd1; } .fic.doc { background: #2b579a; } .fic.xls { background: #217346; } .fic.ppt { background: #c43e1c; } .fic.pdf { background: #d93025; } .fic.cad { background: #0b6f88; } .fic.vec { background: #c2570c; } .fic.img { background: #7b3fbf; } .fic.snd { background: #0f8a5f; } .fic.vid { background: #b0223c; } .fic.md { background: #3d4f6b; } .fic.code { background: #2d333b; }
.tb { height: 32px; padding: 0 13px; border-radius: 16px; font-size: 13px; font-weight: 500; background: var(--button-bg); color: var(--text-primary); display: inline-flex; align-items: center; gap: 6px; text-decoration: none; white-space: nowrap; }
.tb.ic { width: 32px; padding: 0; justify-content: center; }
.body { flex: 1; min-height: 0; display: flex; flex-direction: column; background: var(--surface-secondary); }
.body > :deep(*) { flex: 1; min-height: 0; }
.none { margin: auto; color: var(--text-secondary); flex: none !important; }
.side { width: 300px; flex: none; border-left: 1px solid var(--hairline); padding: 18px 18px 24px; display: flex; flex-direction: column; gap: 12px; }
.sec { font-size: 12.5px; color: var(--text-tertiary); letter-spacing: .04em; }
.abs { margin: 0; font-size: 14.5px; line-height: 1.65; }
.muted { margin: 0; font-size: 13.5px; color: var(--text-secondary); line-height: 1.6; }
.kws { display: flex; flex-wrap: wrap; gap: 6px; }
.kws span { height: 26px; padding: 0 10px; border-radius: 13px; background: var(--button-bg); font-size: 12.5px; display: inline-flex; align-items: center; }
.meta { display: grid; grid-template-columns: 76px 1fr; gap: 8px 10px; margin: 6px 0 0; font-size: 13px; }
.meta dt { color: var(--text-secondary); } .meta dd { margin: 0; min-width: 0; }
.who { display: flex; align-items: center; gap: 6px; }
.acts { display: flex; flex-direction: column; gap: 8px; margin-top: 6px; }
.act { height: 40px; border-radius: 12px; background: var(--button-bg); display: flex; align-items: center; gap: 8px; padding: 0 12px; font-size: 13.5px; font-weight: 500; }
@media (max-width: 900px) { .side { display: none; } .sheet { width: 100%; } }
.sv { flex: 0 1 auto; min-width: 0; max-width: 46%; font-size: 12.5px; padding: 4px 10px; border-radius: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; background: var(--button-bg); color: var(--text-secondary); }
.sv.ok { background: rgba(40, 160, 90, .12); color: #1e8a4c; }
.sv.copy { background: rgba(230, 150, 20, .14); color: #a86400; white-space: normal; }
.sv.err { background: rgba(200, 60, 50, .1); color: #b3261e; white-space: normal; }
.body > .refband { flex: none; display: flex; align-items: center; gap: 8px; padding: 8px 10px 8px 14px; border-bottom: 1px solid var(--hairline); background: rgba(42, 120, 214, .08); color: #1f63b8; font-size: 13px; }
.rbt { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text-primary); }
.rbt b { font-weight: 600; color: #1f63b8; }
.rbo { color: var(--text-secondary); }
:root[data-theme="dark"] .body > .refband { background: rgba(120, 175, 255, .12); color: #9cc7ff; }
:root[data-theme="dark"] .rbt b { color: #9cc7ff; }
/* a phone: the status takes the title's row room */
@media (max-width: 520px) { .hd { flex-wrap: wrap; height: auto; min-height: 60px; padding-top: 8px; padding-bottom: 8px; } .sv { order: 10; max-width: 100%; flex-basis: 100%; } }
/* 「내려받기」 folds to its arrow on a phone (DownloadButton), round like the buttons beside it */
@media (max-width: 520px) { .hd .dlb { width: 32px; padding: 0; justify-content: center; } }
</style>
