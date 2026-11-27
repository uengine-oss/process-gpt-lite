<script setup>
// 폴더 하나: 왼쪽은 기준본(main) 파일 트리·이력·색인, 오른쪽은 변형 목록과 일괄 반영.
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
// a file row is dragged like any file of the app (src/fileDrag.js): into a messenger conversation (a link), the AI chat, another folder;
// files of the app dropped here go into this folder (server lib/fileRefs.js dropInto)
import { startDrag, folderItem, dragKind, dragging as draggedItems, itemsOf, zoneWords } from '../../fileDrag.js'
import Icon from '../Icon.vue'
import FIcon from './FIcon.vue'
import Avatar from './Avatar.vue'
// reference slots (참조 자리 — server lib/folders/refs.js): other folders' material this folder only points at
import RefSheet from './RefSheet.vue'
import MergeSheet from './MergeSheet.vue'
import ShareSheet from './ShareSheet.vue'
// 에이전트 자산 · the computers that upload this folder (champion folders — src/desktopFolders.js, server lib/folders/kit.js · sources.js)
import KitTab from './KitTab.vue'
import { bridge as pcBridge, pcFolders, refreshPcFolders, pcFolderOf, stateText, stopped, whyText, reasonText } from '../../desktopFolders.js'
import { folders as F, whoOf, holderName, roleLabel, statusLabel, sourceLabel, indexLabel, ago, prLabel } from '../../foldersApi.js'
import { kindOf, kindLabel, baseName, fmtSize } from './fileKind.js'
// files another app shared (Android's share sheet), put in this folder after 「이 폴더에 넣기」 (components/ShareArrival.vue)
import { inbox } from '../../shareInbox.js'
// a folder of the computer dropped here or picked with 「폴더 올리기」: walked, previewed, then up once (src/folderDrop.js)
import FolderDropSheet from './FolderDropSheet.vue'
import { compileRules, entriesOf, walk, fromPicked } from '../../folderDrop.js'

const props = defineProps({ slug: String })
const emit = defineEmits(['preview'])
const router = useRouter()
const route = useRoute()
const folder = ref(null)
// the work folder of an instance started from a mail (server lib/mailWork.js — settings.work)
const work = computed(() => folder.value?.settings?.work || null)
const files = ref([])
const err = ref('')
const tab = ref('files')
const showPast = ref(false)
const picked = ref([])
const merging = ref(null)       // {ids} or {integration}
const sharing = ref(false)
const toast = ref('')
const closed = ref(new Set())
const uploading = ref('')
const dragging = ref(false)
const cand = ref(null)
const skill = ref(null)        // skill folders: author, visibility, agents & bosses, contributions, merge right
const sharing2 = ref(false)
const fileInput = ref(null)
const dirInput = ref(null)
const dropSheet = ref(null)    // {scan, rules} — the preview of a folder from the computer
const scanning = ref('')       // 「폴더를 살피는 중…」 while a dropped folder is walked
// 「폴더 올리기」 where a folder can be picked (a computer's browser · the desktop app; not a phone's)
const canPickDir = typeof window !== 'undefined' && 'webkitdirectory' in HTMLInputElement.prototype && !!window.matchMedia?.('(hover: hover)').matches
// the folder's reference slots as I see them: ok (its files come with the tree, each with `ref`) · locked · dangling
const refs = ref([])
const addingRef = ref(false)
const say = (t) => { toast.value = t; setTimeout(() => { if (toast.value === t) toast.value = '' }, 2800) }

const can = (need) => ({ viewer: 1, runner: 2, editor: 3, owner: 4 })[folder.value?.role] >= ({ viewer: 1, runner: 2, editor: 3, owner: 4 })[need]
const kit = ref([])
const sources = ref([])
const champion = computed(() => !!folder.value?.settings?.champion)
// this computer's upload of this folder (only in the desktop app — its bridge's list(); no path)
const mine = computed(() => (folder.value && pcFolders.ready ? pcFolderOf(folder.value.id) : null))
const syncing = ref('')
async function load() {
  try {
    const [f, t, k, rs] = await Promise.all([F.get(props.slug), F.tree(props.slug), F.kit(props.slug).catch(() => []), F.refs(props.slug).catch(() => [])])
    folder.value = f; files.value = t; kit.value = k; refs.value = rs
    sources.value = f.settings?.champion ? await F.sources(props.slug).catch(() => []) : []
    if (pcBridge()?.list) refreshPcFolders()
    if (f.kind === 'skill') skill.value = await F.skillInfo(props.slug).catch(() => null)
    picked.value = picked.value.filter((id) => f.variations.some((v) => v.id === id && v.status === 'ready'))
    if (f.kind === 'linked' && !cand.value) cand.value = await F.candidates(props.slug).catch(() => null)
  } catch (e) { err.value = e.message }
}
onMounted(load)
defineExpose({ load })
watch(() => props.slug, () => { folder.value = null; cand.value = null; load() })
// agents finish runs and cards get made in the background: keep the view fresh meanwhile
const busy = computed(() => folder.value && (folder.value.variations.some((v) => v.status === 'open') || folder.value.index_state?.state === 'indexing'))
let poll = setInterval(() => { if (busy.value && !merging.value) load() }, 4000)
onBeforeUnmount(() => clearInterval(poll))

// the folder's own files by folder; a slot is a row of its own where it is — a folder-like one among the folders (its files under it),
// a readable file slot among the files
const ownFiles = computed(() => files.value.filter((f) => !f.ref))
const slotFiles = (s) => files.value.filter((f) => f.ref?.id === s.id)
const tree = computed(() => {
  const dirs = new Map(), top = []
  for (const f of ownFiles.value) {
    const i = f.path.lastIndexOf('/')
    if (i < 0) { top.push(f); continue }
    const d = f.path.slice(0, i)
    if (!dirs.has(d)) dirs.set(d, [])
    dirs.get(d).push(f)
  }
  const fileSlot = (s) => s.state === 'ok' && s.type === 'file'
  const groups = [...[...dirs.entries()].map(([d, list]) => ({ key: `d:${d}`, d, list })), ...refs.value.filter((s) => !fileSlot(s)).map((s) => ({ key: `s:${s.id}`, d: s.slot, slot: s, list: slotFiles(s) }))]
  const rows = [...top.map((f) => ({ key: `f:${f.path}`, f })), ...refs.value.filter(fileSlot).map((s) => ({ key: `s:${s.id}`, slot: s, f: slotFiles(s)[0] || { path: s.slot, ref: { id: s.id } } }))]
  return { dirs: groups.sort((a, b) => a.d.localeCompare(b.d)), top: rows.sort((a, b) => (a.f?.path || '').localeCompare(b.f?.path || '')) }
})
// a slot's second words: where it points (for a reader of the original), or why it gives nothing
// (hidden: files of this folder a commit from elsewhere put under the slot — the slot wins, they show again when it goes)
const slotMeta = (s) => (s.state === 'locked' ? '볼 수 없는 자료' : s.state === 'dangling' ? '원본에서 찾을 수 없음'
  : `${s.from?.name || ''}${s.type === 'folder' ? '' : ` / ${s.from?.path || ''}`} · main 따라감`) + (s.hidden ? ` · 이 폴더의 파일 ${s.hidden}개를 가림` : '')
// a slot's file is of its original's kind (the slot's name need not carry the extension)
const kindOfRow = (f) => kindOf(f.source_path || f.path)
const inSlot = (s, f) => (f.path.startsWith(`${s.slot}/`) ? f.path.slice(s.slot.length + 1) : baseName(f.path))
// the slot's menu (⋯): 원본 열기 · 이름 바꾸기 · 참조 빼기 — beside the button on a wide screen, a sheet from the bottom on a phone
const menu = ref(null)  // {s, x, y}
const slotActs = (s) => [...(s.state !== 'locked' && s.from ? ['open'] : []), ...(can('editor') ? ['rename', 'remove'] : [])]
function openMenu(e, s) {
  const b = e.currentTarget.getBoundingClientRect()
  menu.value = { s, x: Math.max(12, Math.min(window.innerWidth - 232, b.right - 220)), y: Math.min(window.innerHeight - 180, b.bottom + 6) }
}
function openSource(s) {
  menu.value = null
  if (!s.from) return
  // (a file that is there opens in its folder; a gone one opens the folder)
  router.push(s.type === 'file' && s.state === 'ok' ? { path: `/folders/${s.from.slug}`, query: { file: s.from.path } } : `/folders/${s.from.slug}`)
}
async function renameSlot(s) {
  menu.value = null
  const name = prompt('자리 이름 (이 폴더의 모든 구성원에게 보여요)', s.label)
  if (!name || name.trim() === s.label) return
  try { await F.renameRef(props.slug, s.id, { label: name.trim() }); await load(); say('자리 이름을 바꿨어요') } catch (e) { say(e.message) }
}
async function removeSlot(s) {
  menu.value = null
  if (!confirm(`참조 ‘${s.label}’를 뺄까요? 원본 폴더의 자료는 그대로예요.`)) return
  try { await F.removeRef(props.slug, s.id); await load(); say('참조를 뺐어요 · 원본은 그대로예요') } catch (e) { say(e.message) }
}
async function askAccess(s) {
  try { await F.requestRefAccess(props.slug, s.id); s.requested = true; say('원본 폴더의 주인에게 접근을 요청했어요') } catch (e) { say(e.message) }
}
// 「올리기 ▾」: 파일 올리기 · 참조 더하기
const upMenu = ref(null)  // {x, y}
function openUpMenu(e) {
  const b = e.currentTarget.getBoundingClientRect()
  upMenu.value = upMenu.value ? null : { x: Math.max(12, Math.min(window.innerWidth - 232, b.right - 220)), y: b.bottom + 6 }
}
function refAdded(r) { addingRef.value = false; load(); say(`‘${r.label}’를 참조로 더했어요`) }
function toggle(d) { const s = new Set(closed.value); s.has(d) ? s.delete(d) : s.add(d); closed.value = s }
const live = computed(() => (folder.value?.variations || []).filter((v) => ['open', 'ready', 'conflicted'].includes(v.status)))
const past = computed(() => (folder.value?.variations || []).filter((v) => ['merged', 'discarded'].includes(v.status)))
function pick(v) {
  if (v.status !== 'ready') return
  const s = new Set(picked.value)
  s.has(v.id) ? s.delete(v.id) : s.add(v.id)
  picked.value = folder.value.variations.filter((x) => s.has(x.id)).map((x) => x.id)
}
function preview(f) { emit('preview', { folder: folder.value, file: f, ref: 'main' }) }
// ⌘/Ctrl-click picks rows: dragging one of them drags them all (several files mentioned at once)
const sel = ref(new Set())
function clickRow(e, f) {
  if (e.metaKey || e.ctrlKey) { const s = new Set(sel.value); s.has(f.path) ? s.delete(f.path) : s.add(f.path); sel.value = s; return }
  sel.value = new Set()
  preview(f)
}
function dragRow(e, f) {
  const paths = sel.value.has(f.path) ? files.value.filter((x) => sel.value.has(x.path)) : [f]
  const commit = folder.value.history?.[0]?.sha || null
  startDrag(e, paths.map((x) => folderItem(folder.value, x, { commit })))
}
// files of the app dropped on this folder (a chat card, a received file, another folder's file): they go in, in my name
const pgl = ref(null)        // {words, ok} while such a drag is over the folder
const filedNote = ref(null)  // {text, file} — 「‘<폴더>’에 넣었어요 · 열기」
let pglDepth = 0
const fromHere = () => (draggedItems() || []).length > 0 && draggedItems().every((x) => x.src === 'folder' && x.slug === props.slug)
function onEnter(e) {
  const k = dragKind(e.dataTransfer?.types)
  if (k === 'files') { e.preventDefault(); dragging.value = can('editor'); return }
  if (k !== 'pgl' || fromHere()) return
  e.preventDefault(); pglDepth++
  const ok = can('editor') && folder.value?.kind === 'managed'
  pgl.value = { ok, words: ok ? zoneWords('folder') : folder.value?.kind !== 'managed' ? '이 폴더에는 넣을 수 없어요' : '편집 권한이 있어야 이 폴더에 넣을 수 있어요' }
}
function onOver(e) {
  const k = dragKind(e.dataTransfer?.types)
  if (k === 'files') { e.preventDefault(); dragging.value = can('editor'); return }
  if (k !== 'pgl' || fromHere()) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = pgl.value?.ok ? 'copy' : 'none'
}
function onLeave(e) {
  const k = dragKind(e.dataTransfer?.types)
  if (k === 'files') { if (e.target === e.currentTarget) dragging.value = false; return }
  if (k === 'pgl' && --pglDepth <= 0) { pglDepth = 0; pgl.value = null }
}
async function onPglDrop(e) {
  const ok = pgl.value?.ok
  pglDepth = 0; pgl.value = null
  if (!ok) return say('편집 권한이 있어야 이 폴더에 넣을 수 있어요.')
  const items = itemsOf(e)
  if (!items.length) return
  uploading.value = items.length > 1 ? `${items.length}개 넣는 중` : items[0].name
  try {
    const r = await F.drop(props.slug, items)
    const done = r.items.filter((x) => x.ok)
    const bad = r.items.filter((x) => !x.ok)
    await load()
    if (done.length) {
      const f = done[0].filed
      filedNote.value = { text: done.every((x) => x.filed?.already) ? `이미 ‘${folder.value.name}’에 있어요` : `‘${folder.value.name}’에 넣었어요`, path: f?.path, count: done.length }
      setTimeout(() => { if (filedNote.value?.path === f?.path) filedNote.value = null }, 9000)
    }
    if (bad.length) say(bad.map((x) => `${x.name || '파일'}: ${x.error}`).join(' · '))
  } catch (err2) { say(err2.message) } finally { uploading.value = '' }
}
const openFiled = () => { const f = files.value.find((x) => x.path === filedNote.value?.path); if (f) preview(f); filedNote.value = null }
// a 「권한 요청」 notice opens this folder with ?share=<who asked>: the 공유 sheet with that person picked
// — once: the request leaves the address as the sheet opens, and the watch reads plain values (it re-ran whenever load() replaced the
// folder, so the sheet could never be closed — PR #45 review)
const pickShare = ref('')
watch(() => (route.query.share && folder.value?.id ? `${route.query.share}:${folder.value.id}` : ''), (k) => {
  if (!k || !can('owner')) return
  pickShare.value = String(route.query.share)
  sharing.value = true
  const { share: _asked, ...rest } = route.query
  router.replace({ query: rest })
}, { immediate: true })

// files another app shared, after 「이 폴더에 넣기」 (components/ShareArrival.vue): this folder's own upload — the editor's right, the progress, 「올렸어요」
watch(() => (inbox.forFolder?.slug === props.slug && folder.value ? inbox.forFolder : null), (s) => {
  if (!s) return
  inbox.forFolder = null
  uploadFiles(s.files)
}, { immediate: true })
async function uploadFiles(list, dir = '') {
  if (!can('editor')) return say('올리려면 편집 권한이 필요해요.')
  let failed = 0
  for (const file of list) {
    const rel = (file.webkitRelativePath || '').trim() || (dir ? `${dir}/${file.name}` : file.name)
    uploading.value = rel
    try { await F.upload(props.slug, rel, file) } catch (e) { failed++; say(`${file.name}: ${e.message}`) }
  }
  uploading.value = ''
  await load()
  // (a refusal — a reference slot's name, say — stays on screen instead of 「올렸어요」)
  if (!failed) say('올렸어요 — 문서 카드는 잠시 뒤 생겨요')
}
function onDrop(e) {
  const k = dragKind(e.dataTransfer?.types)
  if (k === 'pgl') { if (pgl.value) { e.preventDefault(); onPglDrop(e) } return }
  e.preventDefault()
  dragging.value = false
  // (the entries are read now: a drop's items are gone once this returns) a folder among them: walked and previewed first
  const entries = entriesOf(e.dataTransfer)
  if (entries.some((x) => x.isDirectory)) return dropFolder(entries)
  if (e.dataTransfer?.files?.length) uploadFiles([...e.dataTransfer.files])
}
// a folder from the computer: the champion folders' rules (what stays here), the walk down, then the sheet
let rules = null
const rulesNow = async () => (rules ||= compileRules(await F.uploadRules()))
async function dropFolder(entries) {
  if (!can('editor') || folder.value?.kind !== 'managed') return say(folder.value?.kind !== 'managed' ? '이 폴더에는 올릴 수 없어요.' : '올리려면 편집 권한이 필요해요.')
  scanning.value = '폴더를 살피는 중…'
  try {
    const r = await rulesNow()
    const scan = await walk(entries, r, { onProgress: (n) => { scanning.value = `폴더를 살피는 중… 파일 ${n.toLocaleString()}개` } })
    dropSheet.value = { scan, rules: r }
  } catch (e) { say(e.message) } finally { scanning.value = '' }
}
async function pickedDir(e) {
  const list = [...(e.target.files || [])]
  e.target.value = ''
  if (!list.length) return
  try { const r = await rulesNow(); dropSheet.value = { scan: fromPicked(list, r), rules: r } } catch (err2) { say(err2.message) }
}
function pickedFiles(e) {
  const list = [...(e.target.files || [])]
  e.target.value = ''
  if (list.length) uploadFiles(list)
}
function dropDone(r) {
  dropSheet.value = null
  load()
  const bad = r.refused || []
  if (r.partial) return say(`파일 ${Number(r.written || 0).toLocaleString()}개를 올린 뒤 멈췄어요 — ${r.partial}`)
  say(`올렸어요 — 파일 ${Number(r.written || 0).toLocaleString()}개${bad.length ? ` · 서버가 받지 않은 것 ${bad.length}개(${bad.slice(0, 3).map((x) => `${x.path} ${reasonText(x.reason)}`).join(', ')})` : ''}`)
}
// 「파일 올리기」 · 「폴더 올리기」: the system's file window, opened from the click itself — the inputs stay in the page whatever the
// menu or the tab row do (a menu item that closes does not take its input with it), out of sight rather than display:none
function choose(input) {
  upMenu.value = null
  if (!input) return say('이 폴더에는 올릴 수 없어요.')
  input.click()
}
async function removeFile(f) {
  if (!confirm(`'${f.path}' 을(를) main 에서 지울까요? 이력에는 남아요.`)) return
  try { await F.removeFile(props.slug, f.path); await load() } catch (e) { say(e.message) }
}
async function newVariation() {
  const title = prompt('새 변형 이름', '내 수정안')
  if (!title) return
  try { const v = await F.newVariation(props.slug, { title }); router.push(`/folders/${props.slug}/v/${v.id}`) } catch (e) { say(e.message) }
}
async function importAll() {
  const names = cand.value.branches.filter((b) => !b.imported).map((b) => b.name)
  try { const out = await F.importBranches(props.slug, names); say(`변형 ${out.length}개를 가져왔어요 (저장소는 그대로예요)`); cand.value = await F.candidates(props.slug); load() } catch (e) { say(e.message) }
}
function merged(r) {
  merging.value = null
  picked.value = []
  load()
  if (r?.status === 'done') say('main 에 반영했어요')
}
const isSkill = computed(() => folder.value?.kind === 'skill')
const canMerge = computed(() => (isSkill.value ? !!skill.value?.canMerge : can('editor')))
async function shareSkill() {
  sharing2.value = true
  try { await F.share(props.slug); say('전사에 공유했어요 — 이제 누구나 이 스킬을 쓰고 고칠 점을 제안할 수 있어요'); await load() } catch (e) { say(e.message) } finally { sharing2.value = false }
}
async function keepPrivate() { await F.keepPrivate(props.slug).catch(() => {}); skill.value = { ...skill.value, askShare: false } }
async function beBoss(a) { try { await F.setBoss(a.id); await load(); say(`${a.name} 의 담당자가 됐어요`) } catch (e) { say(e.message) } }
// a kit item opens like any file of main
function openKit(path) {
  const f = files.value.find((x) => x.path === path)
  if (f) preview(f)
  else emit('preview', { folder: folder.value, file: { path }, ref: 'main' })
}
async function onSource(a) {
  syncing.value = 'source'
  try { sources.value = a.remove ? await F.removeSource(props.slug, a.id) : await F.setSource(props.slug, a.id, a.state) } catch (e) { say(e.message) } finally { syncing.value = '' }
  refreshPcFolders()
}
// 「지금 올리기」: the app looks at the folder again and uploads what changed (its own rules, its own confirmation)
async function syncNow() {
  if (syncing.value) return
  syncing.value = 'push'
  try {
    const r = await pcBridge().syncNow(folder.value.id)
    syncing.value = ''
    if (r?.ok && r.changed === false) say('바뀐 것이 없어요')
    else if (r?.ok) { say(r.behind ? whyText('behind') : r.pushed?.files != null ? `올렸어요 — 파일 ${r.pushed.files.toLocaleString()}개` : '올렸어요'); await load() }
    else say(r?.paths?.length ? `${whyText(r.why)} — ${r.paths.map((p) => `${p.path}${p.line ? `:${p.line}` : ''} (${reasonText(p.reason)})`).join(', ')}` : whyText(r?.why))
  } catch (e) { say(e.message) } finally { syncing.value = ''; refreshPcFolders() }
}
const revealPc = () => pcBridge()?.reveal?.(folder.value.id)
const CTYPE = { CREATED: '만듦', MODIFIED: '고침', PROPOSAL_APPROVED: '제안 반영' }
const cardOf = (f) => f.card?.abstract
// (the folder's own index: what a slot holds is its original's, never copied in here)
const indexLines = computed(() => ownFiles.value.map((f) => `${f.path}  ·  ${fmtSize(Number(f.size))}${cardOf(f) ? '\n    └ ' + cardOf(f) : ''}`).join('\n'))
const ix = computed(() => folder.value?.index_state || {})
</script>

<template>
  <div class="fd" data-test="folder-detail" @dragenter="onEnter" @dragover="onOver" @dragleave="onLeave" @drop="onDrop">
    <p v-if="err" class="missing">{{ err }}</p>
    <template v-else-if="folder">
      <div class="head">
        <button class="back press" title="폴더 목록" @click="router.push('/folders')"><Icon name="back" :size="18" /></button>
        <span class="fic folder" :class="{ linked: folder.kind === 'linked', skill: isSkill }"><FIcon :name="folder.kind === 'linked' ? 'link' : isSkill ? 'agent' : 'folder'" :size="22" /></span>
        <div class="ttl">
          <h1><span class="hn">{{ folder.name }}</span> <span v-if="isSkill" class="kb" :class="skill?.visibility">{{ skill?.visibility === 'private' ? '내 스킬' : '전사 공유 스킬' }}</span><span v-else-if="work" class="kb work" data-test="folder-work-badge">작업 폴더</span></h1>
          <small v-if="isSkill">작성자 {{ skill?.author?.name || '—' }} · {{ canMerge ? '반영할 수 있어요' : '고칠 점은 변형으로 제안해요' }}</small>
          <small v-else>{{ folder.description }} · 내 권한 {{ roleLabel[folder.role] }}</small>
          <!-- a work folder (server lib/mailWork.js): back to the instance it belongs to -->
          <router-link v-if="work" class="wk" :to="`/routines/${encodeURIComponent(work.instId)}`" data-test="folder-work-inst"><Icon name="refresh" :size="13" /> 루틴 · {{ work.inst || folder.name }}</router-link>
        </div>
        <span class="sp" />
        <button class="mem press" :title="folder.members.map((m) => `${m.name}(${roleLabel[m.role]})`).join(', ')" @click="sharing = true">
          <Avatar v-for="m in folder.members.slice(0, 6)" :key="m.type + m.id" :who="whoOf(m)" :size="30" />
        </button>
 <button v-if="!isSkill" class="pill-btn hbtn" @click="sharing = true"><FIcon name="people" :size="16" /> 공유</button>
        <button v-if="can('editor') && folder.kind === 'managed'" class="pill-btn hbtn" title="main 을 작업실(파일·셸)에서 열기" @click="router.push(`/workroom/folder/${folder.slug}`)"><FIcon name="terminal" :size="16" /> 작업실</button>
      </div>

      <template v-if="can('editor') && folder.kind === 'managed'">
        <input ref="fileInput" class="pick" type="file" multiple tabindex="-1" aria-hidden="true" data-test="folder-file-input" @change="pickedFiles($event)" />
        <input ref="dirInput" class="pick" type="file" webkitdirectory multiple tabindex="-1" aria-hidden="true" data-test="folder-dir-input" @change="pickedDir($event)" />
      </template>
      <div v-if="mine" class="pcbar glass" data-test="folder-pc-sync" :class="{ stop: stopped(mine.state) || mine.why }">
        <FIcon name="pc" :size="17" />
        <span class="pt"><b>이 PC 의 「{{ mine.label }}」 폴더와 연결됨</b><small class="meta"><span>{{ mine.why ? `멈춤 · ${whyText(mine.why)}` : stateText(mine.state) }}</span><span v-if="mine.lastPushedAt">{{ ago(mine.lastPushedAt) }} 올림</span></small></span>
        <button v-if="pcBridge()?.reveal" class="tb press" @click="revealPc">폴더 열기</button>
        <button class="tb press dk" data-test="folder-pc-sync-now" :disabled="!!syncing || mine.state === 'pushing'" @click="syncNow">{{ syncing === 'push' || mine.state === 'pushing' ? '올리는 중…' : '지금 올리기' }}</button>
      </div>
      <div v-if="isSkill && skill?.visibility === 'private' && skill?.mine" class="banner ask glass">
        <FIcon name="people" :size="18" />
        <span><b>이 스킬을 전사에 공유하시겠어요?</b> 지금은 나와 내 에이전트만 써요. 공유하면 누구나 쓰고 고칠 점을 변형으로 제안할 수 있고, 반영은 나(작성자)와 이 스킬을 쓰는 에이전트의 담당자만 해요.</span>
        <span class="sp" />
        <button class="dark-btn sm2" :disabled="sharing2" @click="shareSkill">{{ sharing2 ? '공유하는 중…' : '전사에 공유' }}</button>
        <button v-if="skill.askShare" class="tb press" @click="keepPrivate">나만 쓰기</button>
      </div>
      <div v-if="folder.kind === 'linked' && cand" class="banner glass">
        <FIcon name="branch" :size="18" />
        <span>이 저장소에 에이전트 브랜치 <b>{{ cand.branches.length }}개</b>와 작업 사본 <b>{{ cand.worktrees }}개</b>(디렉터리가 사라진 것 {{ cand.staleWorktrees }}개)가 있어요. 저장소는 건드리지 않고 목록만 보여 드려요.</span>
        <span class="sp" />
        <button v-if="cand.branches.some((b) => !b.imported) && can('editor')" class="tb press" @click="importAll">변형으로 가져오기</button>
      </div>

      <div class="cols">
        <section class="pane glass">
          <div class="ph">
            <div class="seg">
              <button :class="{ on: tab === 'files' }" @click="tab = 'files'">파일</button>
              <button :class="{ on: tab === 'history' }" @click="tab = 'history'">이력</button>
              <button :class="{ on: tab === 'index' }" @click="tab = 'index'">색인</button>
              <button v-if="isSkill" :class="{ on: tab === 'skill' }" @click="tab = 'skill'">스킬</button>
              <button v-if="champion || kit.length" :class="{ on: tab === 'kit' }" data-test="folder-kit-tab" @click="tab = 'kit'">에이전트 자산<span v-if="kit.length" class="tc">{{ kit.length }}</span></button>
            </div>
            <span class="ref"><FIcon name="branch" :size="14" /> {{ folder.default_branch }} · <code>{{ folder.history[0]?.short }}</code></span>
            <span class="sp" />
            <span v-if="uploading" class="up"><span class="spin" /> {{ uploading }}</span>
            <button v-if="tab === 'files' && can('editor') && folder.kind === 'managed'" class="tb press" data-test="folder-add-menu" :aria-expanded="!!upMenu" @click="openUpMenu"><FIcon name="upload" :size="15" /> 올리기<span class="caret" aria-hidden="true">▾</span></button>
          </div>

          <div v-if="tab === 'files'" class="files scroll" :class="{ drag: dragging }">
            <div class="fr th"><span>이름</span><span>마지막 수정</span><span>크기</span></div>
            <template v-for="g in tree.dirs" :key="g.key">
              <!-- a reference slot shown like a folder: ↗ · 「참조」 · where it points (or why it gives nothing) · ⋯ -->
              <div v-if="g.slot" class="fr dir slot" :class="g.slot.state" data-test="folder-slot" :data-slot="g.slot.slot" :data-state="g.slot.state">
                <button class="fn press" :disabled="g.slot.state !== 'ok'" @click="toggle(g.d)">
                  <span class="tw">{{ g.slot.state === 'ok' ? (closed.has(g.d) ? '▸' : '▾') : '' }}</span>
                  <span class="si" :class="g.slot.state"><FIcon :name="g.slot.state === 'locked' ? 'lock' : g.slot.state === 'ok' ? 'folder' : 'warn'" :size="17" /><i v-if="g.slot.state === 'ok'" class="arr"><FIcon name="ref" :size="11" /></i></span>
                  <span class="sl"><span class="sn"><span class="nm">{{ g.slot.label }}</span><span class="rp" data-test="slot-pill">참조</span><span class="ra" aria-hidden="true"><FIcon name="ref" :size="13" /></span></span><small class="sm-meta">참조 · {{ slotMeta(g.slot) }}</small></span>
                </button>
                <span class="by meta" :title="slotMeta(g.slot)">{{ slotMeta(g.slot) }}</span>
                <span class="sz">
                  <template v-if="g.slot.state === 'ok'">{{ g.slot.count ?? g.list.length }}개</template>
                  <button v-else-if="g.slot.state === 'locked' && !g.slot.requested" class="ask press" data-test="slot-request" @click="askAccess(g.slot)">접근 요청</button>
                  <span v-else-if="g.slot.state === 'locked'" class="asked" data-test="slot-requested">요청했어요</span>
                  <button v-if="slotActs(g.slot).length" class="more press" title="참조 메뉴" data-test="slot-more" @click="openMenu($event, g.slot)"><FIcon name="more" :size="18" /></button>
                </span>
              </div>
              <button v-else class="fr dir" @click="toggle(g.d)">
                <span class="fn"><span class="tw">{{ closed.has(g.d) ? '▸' : '▾' }}</span><FIcon name="folder" :size="17" /> {{ g.d }}</span><span /><span class="sz">{{ g.list.length }}개</span>
              </button>
              <template v-if="!closed.has(g.d)">
                <!-- a slot's files: read only here (no drag, no delete) — opened, they read the original -->
                <div v-for="f in g.list" :key="f.path" class="fr file" :class="{ sel: !g.slot && sel.has(f.path), reffile: !!g.slot }" :draggable="!g.slot" data-test="folder-file" :data-file="f.path" @dragstart="!g.slot && dragRow($event, f)">
                  <button class="fn in press" @click="g.slot ? preview(f) : clickRow($event, f)"><span class="fic sm" :class="kindOfRow(f)">{{ kindLabel[kindOfRow(f)] }}</span><span class="nm">{{ g.slot ? inSlot(g.slot, f) : baseName(f.path) }}</span><span v-if="f.has_card" class="cd" :title="cardOf(f)">카드</span></button>
                  <span class="by"><Avatar v-if="f.author" :who="whoOf({ name: f.author, id: f.author })" :size="20" /> {{ f.author }} · {{ ago(f.mtime) }}</span>
                  <span class="sz">{{ fmtSize(Number(f.size)) }}<button v-if="!g.slot && can('editor') && folder.kind === 'managed'" class="del" title="지우기" @click="removeFile(f)"><Icon name="trash" :size="14" /></button></span>
                </div>
                <!-- more than are listed here: the rest in the original folder -->
                <button v-if="g.slot && g.slot.count > g.list.length" class="fr file more-row press" data-test="slot-more-files" @click="openSource(g.slot)">
                  <span class="fn in"><span class="nm">… 외 {{ (g.slot.count - g.list.length).toLocaleString() }}개 · 원본 폴더에서 보기</span></span><span /><span />
                </button>
              </template>
            </template>
            <template v-for="t in tree.top" :key="t.key">
              <!-- a readable file slot -->
              <div v-if="t.slot" class="fr file slot ok" data-test="folder-slot" :data-slot="t.slot.slot" data-state="ok">
                <button class="fn press" @click="preview(t.f)"><span class="fw"><span class="fic sm" :class="kindOfRow(t.f)">{{ kindLabel[kindOfRow(t.f)] }}</span><i class="arr"><FIcon name="ref" :size="11" /></i></span><span class="sl"><span class="sn"><span class="nm">{{ baseName(t.f.path) }}</span><span class="rp" data-test="slot-pill">참조</span><span class="ra" aria-hidden="true"><FIcon name="ref" :size="13" /></span></span><small class="sm-meta">참조 · {{ slotMeta(t.slot) }}</small></span></button>
                <span class="by meta" :title="slotMeta(t.slot)">{{ slotMeta(t.slot) }}</span>
                <span class="sz">{{ t.f.size != null ? fmtSize(Number(t.f.size)) : '' }}<button v-if="slotActs(t.slot).length" class="more press" title="참조 메뉴" data-test="slot-more" @click="openMenu($event, t.slot)"><FIcon name="more" :size="18" /></button></span>
              </div>
              <div v-else class="fr file" :class="{ sel: sel.has(t.f.path) }" draggable="true" data-test="folder-file" :data-file="t.f.path" @dragstart="dragRow($event, t.f)">
                <button class="fn press" @click="clickRow($event, t.f)"><span class="fic sm" :class="kindOf(t.f.path)">{{ kindLabel[kindOf(t.f.path)] }}</span><span class="nm">{{ baseName(t.f.path) }}</span><span v-if="t.f.has_card" class="cd" :title="cardOf(t.f)">카드</span></button>
                <span class="by"><Avatar v-if="t.f.author" :who="whoOf({ name: t.f.author, id: t.f.author })" :size="20" /> {{ t.f.author }} · {{ ago(t.f.mtime) }}</span>
                <span class="sz">{{ fmtSize(Number(t.f.size)) }}<button v-if="can('editor') && folder.kind === 'managed'" class="del" title="지우기" @click="removeFile(t.f)"><Icon name="trash" :size="14" /></button></span>
              </div>
            </template>
            <p v-if="!files.length && !refs.length" class="none">아직 파일이 없어요.</p>
            <p v-if="can('editor') && folder.kind === 'managed'" class="drop" data-test="folder-drop-hint">파일이나 폴더를 여기로 끌어다 놓으면 main 에 올라가요 · 폴더는 올릴 내용을 먼저 확인해요 · 올린 사람과 시각이 이력에 남아요 · 파일을 대화방이나 채팅으로 끌어다 놓으면 링크로 멘션돼요(⌘/Ctrl 로 여럿 고르기)</p>
          </div>

          <div v-else-if="tab === 'history'" class="hist scroll">
            <div v-for="h in folder.history" :key="h.sha" class="hr">
              <code>{{ h.short }}</code><span class="hm">{{ h.msg }}</span><span class="by"><Avatar :who="whoOf({ name: h.name, id: h.name })" :size="20" /> {{ h.name }} · {{ ago(h.at) }}</span>
            </div>
          </div>

          <KitTab v-else-if="tab === 'kit'" :kit="kit" :sources="sources" :owner="folder.role === 'owner'" :busy="syncing" @open="openKit" @source="onSource" />

          <div v-else-if="tab === 'skill'" class="idx scroll">
            <dl class="sk">
              <dt>작성자</dt><dd>{{ skill?.author?.name || '—' }}</dd>
              <dt>공개 범위</dt><dd>{{ skill?.visibility === 'private' ? '내 스킬 — 작성자와 작성자의 에이전트만 써요' : '전사 공유 — 누구나 쓰고 변형으로 제안해요' }}</dd>
              <dt>반영</dt><dd>작성자, 그리고 이 스킬을 쓰는 에이전트의 담당자만 할 수 있어요{{ skill?.canMerge ? ' · 나도 할 수 있어요' : '' }}</dd>
              <dt>저장소</dt><dd>{{ skill?.mode === 'provider' ? 'process-gpt git 공급자' : '이 폴더의 git (git 공급자 미연결)' }}</dd>
            </dl>
            <div class="sec">이 스킬을 쓰는 에이전트와 담당자</div>
            <div v-for="a in skill?.agents || []" :key="a.id" class="ar">
              <Avatar :who="whoOf({ id: a.id, name: a.name, type: 'agent', agent_type: a.agent_type })" :size="24" /><b>{{ a.name }}</b>
              <span class="sp" /><span class="bn">{{ a.boss_name ? `담당 ${a.boss_name}` : '담당자 없음' }}</span>
              <button v-if="!a.boss_id" class="tb press" @click="beBoss(a)">내가 담당할게요</button>
            </div>
            <p v-if="!skill?.agents?.length" class="none">이 스킬을 쓰도록 지정된 에이전트가 없어요.</p>
            <div class="sec">기여 기록</div>
            <div v-for="(c, i) in skill?.contributions || []" :key="i" class="ar">
              <Avatar :who="whoOf({ id: c.id, name: c.name })" :size="22" /><b>{{ c.name }}</b><span class="bn">{{ CTYPE[c.type] || c.type }} · {{ ago(c.created_at) }}</span>
            </div>
            <p v-if="!skill?.contributions?.length" class="none">아직 반영된 제안이 없어요.</p>
          </div>

          <div v-else class="idx scroll">
            <div class="ist">
              <span class="badge" :class="ix.state">{{ indexLabel[ix.state] || '색인 전' }}</span>
              <span>파일 {{ (ix.files || 0).toLocaleString() }}개 · 카드 {{ ix.cards || 0 }}개 · {{ fmtSize(ix.size || 0) }} · {{ ago(ix.at) }}{{ ix.fulltext ? ' · 본문 색인 켜짐' : '' }}</span>
            </div>
            <p v-if="ix.state === 'list'" class="exp">파일이 많고 코드가 대부분이라 <b>파일 목록만</b> 색인해요. 에이전트는 경로와 이름으로 찾고, 필요한 파일만 열어 읽어요.</p>
            <p v-else class="exp">문서마다 1~2문장 <b>문서 카드</b>를 만들어 두었어요. 에이전트는 아래 목록을 먼저 읽고 알맞은 파일을 골라 열어요. 문서가 200개를 넘거나 카드 목록이 길어지면(약 12k 토큰, 본문 5MB) <b>본문 색인</b>이 자동으로 켜져요.</p>
            <div class="sec">에이전트가 보는 목록</div>
            <pre class="cat">{{ indexLines }}</pre>
          </div>
            <Transition name="fade">
              <div v-if="pgl" class="pgldrop" :class="{ no: !pgl.ok }" data-test="folder-dropzone"><div><FIcon name="folder" :size="28" /><p>{{ pgl.words }}</p><small v-if="pgl.ok">‘{{ folder.name }}’ main 에 내 이름으로 들어가요</small></div></div>
            </Transition>
        </section>

        <section class="vars glass">
          <div class="vh">
            <b>변형</b><span class="cnt">{{ live.length }}</span>
            <span class="sp" />
            <button v-if="can('runner') && folder.kind === 'managed'" class="tb press" @click="newVariation"><FIcon name="branch" :size="15" /> 새 변형</button>
          </div>
          <div class="vl scroll">
            <div v-for="v in live" :key="v.id" class="vc" :class="{ sel: picked.includes(v.id) }">
              <button class="chk" :class="{ on: picked.includes(v.id) }" :disabled="v.status !== 'ready' || !canMerge || folder.kind === 'linked'" :title="v.status === 'ready' ? '반영할 변형으로 고르기' : '실행이 끝나야 고를 수 있어요'" @click="pick(v)">
                <Icon v-if="picked.includes(v.id)" name="check" :size="14" />
              </button>
              <button class="vb press" @click="router.push(`/folders/${folder.slug}/v/${v.id}`)">
                <span class="vt"><b>{{ v.title }}</b><span class="st" :class="v.status"><span v-if="v.status === 'open' && v.worktree_path" class="spin" />{{ statusLabel[v.status] }}</span></span>
                <code class="br">{{ v.branch }}</code>
                <span class="vmeta">
                  <Avatar :who="whoOf({ id: v.holder_id, name: holderName(v), type: v.holder_type })" :size="20" /> {{ holderName(v) }}
                  <span class="src" :class="v.kind">{{ sourceLabel[v.kind] }}</span>
                  <span class="ab" title="main 보다 앞선 커밋 / 뒤처진 커밋">↑{{ v.ahead }} ↓{{ v.behind }}</span>
                  <span class="when">{{ ago(v.updated_at) }}</span>
                </span>
                <span v-if="v.source?.pr_id" class="prb">반영 요청됨</span>
                <span v-if="v.change_card?.summary" class="from">{{ v.change_card.summary }}</span>
                <span v-else class="from">{{ v.source?.label }}</span>
              </button>
            </div>
            <p v-if="!live.length" class="none">진행 중인 변형이 없어요. 채팅에서 "{{ isSkill ? `${folder.name} 스킬을 … 고쳐줘` : `${folder.name} 폴더의 … 고쳐줘` }}" 라고 하면 에이전트가 변형을 만들어 일해요.</p>
            <button v-if="past.length" class="past" @click="showPast = !showPast">{{ showPast ? '지난 변형 접기' : `지난 변형 ${past.length}개 (반영됨·버림)` }}</button>
            <template v-if="showPast">
              <div v-for="v in past" :key="v.id" class="vc past-c">
                <span class="chk ghost" />
                <button class="vb press" @click="router.push(`/folders/${folder.slug}/v/${v.id}`)">
                  <span class="vt"><b>{{ v.title }}</b><span class="st" :class="v.status">{{ statusLabel[v.status] }}</span></span>
                  <code class="br">{{ v.branch }}</code>
                </button>
              </div>
            </template>
          </div>
          <div v-if="folder.integration" class="vf on">
            <span>반영이 멈춰 있어요<small>충돌을 풀거나 그만둘 수 있어요</small></span>
            <button class="dark-btn" @click="merging = { integration: folder.integration }"><FIcon name="merge" :size="17" /> 이어서 하기</button>
          </div>
          <div v-else-if="isSkill && !canMerge" class="vf">
            <span>반영은 작성자·에이전트 담당자가 해요<small>변형을 열어 "반영 요청" 을 보내면 알림이 가요</small></span>
          </div>
          <div v-else class="vf" :class="{ on: picked.length }">
            <span>{{ picked.length ? `${picked.length}개 골랐어요` : '반영할 변형을 골라 주세요' }}<small>충돌이 나면 멈추고 알려 줘요</small></span>
            <button class="dark-btn" :disabled="!picked.length" @click="merging = { ids: picked }"><FIcon name="merge" :size="17" /> 일괄 반영</button>
          </div>
        </section>
      </div>

      <MergeSheet v-if="merging" :folder="folder" :ids="merging.ids" :integration="merging.integration" @close="merging = null; load()" @done="merged" />
      <ShareSheet v-if="sharing" :folder="folder" :pick="pickShare" @close="sharing = false; pickShare = ''; load()" />
      <FolderDropSheet v-if="dropSheet" :scan="dropSheet.scan" :rules="dropSheet.rules" mode="into" :folder="folder" @close="dropSheet = null" @done="dropDone" />
      <RefSheet v-if="addingRef" :folder="folder" :taken="[...refs.map((r) => r.label), ...refs.map((r) => r.slot)]" @close="addingRef = false" @added="refAdded" />
      <!-- the menus: beside their button on a wide screen, a sheet from the bottom on a phone -->
      <div v-if="upMenu" class="mveil" @click.self="upMenu = null">
        <div class="pop glass" role="menu" :style="{ left: `${upMenu.x}px`, top: `${upMenu.y}px` }">
          <button class="mi press" role="menuitem" data-test="folder-upload-files" @click="choose(fileInput)"><FIcon name="upload" :size="16" /> 파일 올리기</button>
          <button v-if="canPickDir" class="mi press" role="menuitem" data-test="folder-upload-dir" @click="choose(dirInput)"><FIcon name="folder" :size="16" /> 폴더 올리기<small>폴더째 — 안의 파일을 경로 그대로</small></button>
          <button class="mi press" role="menuitem" data-test="folder-add-ref" @click="upMenu = null; addingRef = true"><FIcon name="ref" :size="16" /> 참조 더하기<small>다른 폴더 · 파일을 가리키기만 해요</small></button>
        </div>
      </div>
      <div v-if="menu" class="mveil" @click.self="menu = null">
        <div class="pop glass" role="menu" data-test="slot-menu" :style="{ left: `${menu.x}px`, top: `${menu.y}px` }">
          <div class="mh">{{ menu.s.label }}<small>참조 · {{ slotMeta(menu.s) }}</small></div>
          <button v-if="slotActs(menu.s).includes('open')" class="mi press" role="menuitem" data-test="slot-open-source" @click="openSource(menu.s)"><FIcon name="open" :size="16" /> 원본 열기</button>
          <button v-if="slotActs(menu.s).includes('rename')" class="mi press" role="menuitem" data-test="slot-rename" @click="renameSlot(menu.s)"><FIcon name="index" :size="16" /> 이름 바꾸기</button>
          <button v-if="slotActs(menu.s).includes('remove')" class="mi press danger" role="menuitem" data-test="slot-remove" @click="removeSlot(menu.s)"><Icon name="trash" :size="15" /> 참조 빼기<small>원본은 그대로예요</small></button>
        </div>
      </div>
    </template>
    <Transition name="fade"><div v-if="toast" class="toast" data-test="folder-toast">{{ toast }}</div></Transition>
    <Transition name="fade"><div v-if="scanning" class="toast scan" data-test="folder-scanning" role="status"><span class="spin" /> {{ scanning }}</div></Transition>
    <Transition name="fade">
      <div v-if="filedNote" class="toast filed" data-test="folder-filed" role="status">
        <FIcon name="folder" :size="16" /><span>{{ filedNote.text }}{{ filedNote.count > 1 ? ` · ${filedNote.count}개` : '' }}</span>
        <button v-if="filedNote.path" class="press" data-test="folder-filed-open" @click="openFiled">열기</button>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.fd { position: absolute; inset: 0; display: flex; flex-direction: column; padding: 0 24px 16px; max-width: 1400px; margin: 0 auto; }
.missing { text-align: center; color: var(--text-secondary); margin-top: 80px; }
.head { display: flex; align-items: center; gap: 12px; margin: 0 0 14px; }
.back { flex: none; width: 40px; height: 40px; border-radius: 20px; display: grid; place-items: center; background: var(--button-bg); }
.ttl { display: flex; flex-direction: column; min-width: 0; }
/* a long name ends in "…" on one line (the skill badge stays whole); Korean never breaks inside a word */
h1 { display: flex; align-items: center; gap: 8px; min-width: 0; margin: 0; font-size: 24px; font-weight: 500; letter-spacing: -0.02em; }
h1 .hn { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; word-break: keep-all; }
h1 .kb { flex: none; align-items: center; line-height: 1; }
.ttl small { color: var(--text-secondary); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sp { flex: 1; }
.mem { flex: none; display: flex; } .mem > * + * { margin-left: -8px; }
.hbtn { flex: none; white-space: nowrap; height: 40px; font-size: 14px; display: inline-flex; align-items: center; gap: 6px; }
.fic { flex: none; width: 44px; height: 44px; border-radius: 13px; display: grid; place-items: center; font-size: 10.5px; font-weight: 700; color: #fff; background: #6b6b66; }
.fic.sm { width: 28px; height: 28px; border-radius: 8px; font-size: 9px; }
.fic.folder { background: #e2a93b; } .fic.folder.linked { background: #4a5f9a; }
.fic.hwp { background: #1f6fd1; } .fic.doc { background: #2b579a; } .fic.xls { background: #217346; } .fic.ppt { background: #c43e1c; } .fic.pdf { background: #d93025; } .fic.cad { background: #0b6f88; } .fic.vec { background: #c2570c; } .fic.img { background: #7b3fbf; } .fic.snd { background: #0f8a5f; } .fic.vid { background: #b0223c; } .fic.md { background: #3d4f6b; } .fic.code { background: #2d333b; }
.banner.ask { border: 1px solid rgba(123 92 214 / .45); }
.sm2 { height: 36px; padding: 0 16px; font-size: 13.5px; }
.kb { display: inline-flex; vertical-align: middle; height: 24px; padding: 0 10px; border-radius: 12px; font-size: 12px; font-weight: 500; background: rgba(150 240 176 / .2); color: var(--color-success); letter-spacing: 0; }
.kb.private { background: rgba(255 160 60 / .18); color: #e08a2c; }
.kb.work { background: rgba(226 169 59 / .2); color: #c98a1a; }
.wk { align-self: flex-start; display: inline-flex; align-items: center; gap: 4px; margin-top: 2px; font-size: 13px; color: var(--text-secondary); text-decoration: none; }
.wk:hover { color: var(--text-primary); }
.fic.folder.skill { background: #7b5cd6; }
dl.sk { display: grid; grid-template-columns: 90px 1fr; gap: 8px 12px; margin: 8px 6px; font-size: 13.5px; } dl.sk dt { color: var(--text-secondary); } dl.sk dd { margin: 0; }
.ar { display: flex; align-items: center; gap: 8px; padding: 8px 6px; border-bottom: 1px solid var(--hairline); font-size: 14px; } .ar b { font-weight: 500; }
.bn { font-size: 12.5px; color: var(--text-secondary); }
.prb { align-self: flex-start; height: 20px; padding: 0 8px; border-radius: 10px; font-size: 11px; display: inline-flex; align-items: center; background: rgba(123 92 214 / .2); color: #9b7cf0; }
.banner { display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-radius: 16px; font-size: 13.5px; margin-bottom: 12px; }
.pcbar { display: flex; align-items: center; gap: 10px; padding: 8px 10px 8px 14px; border-radius: 16px; margin-bottom: 12px; color: #2a78d6; flex-wrap: wrap; }
.pcbar.stop { color: #e08a2c; }
.pt { flex: 1 1 220px; min-width: 0; display: flex; flex-direction: column; color: var(--text-primary); }
.pt b { font-size: 13.5px; font-weight: 500; } .pt small { font-size: 12.5px; color: var(--text-secondary); }
.pt .meta span + span::before { content: ' · '; }
.pcbar .tb.dk { background: var(--ink); color: var(--ink-inverse); }
.tc { margin-left: 6px; font-size: 11px; opacity: .75; }
:root[data-theme="dark"] .pcbar { color: #8cc1ff; }
:root[data-theme="dark"] .pcbar.stop { color: #ffb870; }
.cols { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 440px; gap: 14px; }
.pane, .vars { border-radius: 22px; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.ph, .vh { display: flex; align-items: center; gap: 10px; height: 56px; padding: 0 12px 0 14px; border-bottom: 1px solid var(--hairline); flex: none; }
.seg { flex: none; display: flex; background: var(--button-bg); border-radius: 18px; padding: 3px; }
.seg button { flex: none; white-space: nowrap; height: 30px; padding: 0 14px; border-radius: 15px; font-size: 13.5px; color: var(--text-secondary); }
.seg button.on { background: var(--ink); color: var(--ink-inverse); }
.ref { display: inline-flex; align-items: center; gap: 4px; min-width: 0; white-space: nowrap; overflow: hidden; font-size: 12.5px; color: var(--text-secondary); }
.up { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--color-info); max-width: 220px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
code { font-family: "SF Mono", Menlo, monospace; font-size: 12px; }
.tb { height: 32px; padding: 0 12px; border-radius: 16px; font-size: 13px; font-weight: 500; background: var(--button-bg); display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.files, .hist, .idx { flex: 1; min-height: 0; overflow-y: auto; padding: 6px 8px 14px; }
.fr.file.sel { background: rgba(42, 120, 214, .12); }
.fr.file[draggable="true"] { cursor: grab; }
section.pane { position: relative; }
.pgldrop { position: absolute; inset: 6px; z-index: 6; display: grid; place-items: center; border-radius: 18px; background: rgba(42, 120, 214, .1); border: 2.5px dashed rgba(42, 120, 214, .7); pointer-events: none; }
/* (the same card as the messenger's 「여기에 놓으면 …」, in both themes) */
.pgldrop div { text-align: center; color: #1a56c4; background: rgba(255, 255, 255, .94); padding: 16px 26px; border-radius: 18px; box-shadow: 0 8px 28px rgba(0, 0, 0, .14); }
.pgldrop p { margin: 6px 0 2px; font-size: 16px; font-weight: 600; }
.pgldrop small { font-size: 12px; color: #5b6472; }
.pgldrop.no { background: rgba(127, 127, 127, .08); border-color: rgba(127, 127, 127, .5); }
.pgldrop.no div { color: #4b5563; }
.toast.filed { display: inline-flex; align-items: center; gap: 8px; }
.toast.filed button { margin-left: 4px; padding: 3px 12px; border-radius: 10px; font-size: 13px; font-weight: 600; color: #fff; background: #2a78d6; }
.files.drag { outline: 2px dashed var(--color-info); outline-offset: -8px; border-radius: 18px; }
.fr { width: 100%; display: grid; grid-template-columns: minmax(0, 1fr) 190px 92px; align-items: center; gap: 10px; min-height: 42px; padding: 4px 10px; border-radius: 12px; text-align: left; font-size: 14px; }
.fr.th { min-height: 30px; font-size: 12px; color: var(--text-tertiary); }
.fr.file:hover, .fr.dir:hover { background: var(--cell-bg); }
.fn { display: flex; align-items: center; gap: 10px; min-width: 0; text-align: left; font-size: 14px; }
.fn.in { padding-left: 26px; }
.dir .fn { gap: 6px; font-weight: 500; color: var(--text-primary); }
.tw { width: 14px; color: var(--text-tertiary); font-size: 12px; }
.nm { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cd { flex: none; height: 20px; padding: 0 7px; border-radius: 10px; font-size: 11px; background: rgba(150 240 176 / .18); color: var(--color-success); display: inline-flex; align-items: center; }
.by { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; }
.sz { font-size: 12.5px; color: var(--text-secondary); text-align: right; display: flex; align-items: center; justify-content: flex-end; gap: 6px; }
.del { width: 24px; height: 24px; border-radius: 12px; display: grid; place-items: center; opacity: 0; color: var(--text-secondary); }
.fr.file:hover .del { opacity: 1; } .del:hover { background: var(--button-bg); color: var(--color-error); }
.none { font-size: 13.5px; color: var(--text-secondary); padding: 10px; margin: 0; line-height: 1.6; }
.drop { margin: 14px 10px 0; padding: 14px; border-radius: 14px; border: 1.5px dashed var(--hairline); font-size: 13px; color: var(--text-tertiary); text-align: center; }
.hr { display: grid; grid-template-columns: 76px 1fr auto; gap: 10px; align-items: center; padding: 10px; border-bottom: 1px solid var(--hairline); font-size: 14px; }
.hr code { color: var(--text-secondary); }
.ist { display: flex; align-items: center; gap: 10px; font-size: 13.5px; padding: 8px 6px; }
.badge { display: inline-flex; align-items: center; height: 24px; padding: 0 10px; border-radius: 12px; font-size: 12px; font-weight: 500; background: var(--button-bg); }
.badge.cards { background: rgba(150 240 176 / .2); color: var(--color-success); } .badge.indexing { color: var(--color-info); }
.exp { font-size: 14px; line-height: 1.65; margin: 4px 6px 4px; }
.sec { font-size: 12.5px; color: var(--text-tertiary); margin: 16px 6px 8px; letter-spacing: .04em; }
.cat { margin: 0 6px; padding: 14px; border-radius: 14px; background: var(--cell-bg); font: 12px/1.7 "SF Mono", Menlo, monospace; white-space: pre-wrap; color: var(--text-primary); }
.vh b { font-size: 15px; font-weight: 600; }
.cnt { height: 22px; min-width: 22px; padding: 0 7px; border-radius: 11px; background: var(--button-bg); font-size: 12px; display: grid; place-items: center; }
.vl { flex: 1; min-height: 0; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.vc { display: flex; gap: 8px; align-items: flex-start; padding: 10px 10px 10px 8px; border-radius: 16px; border: 1px solid transparent; }
.vc:hover { background: var(--cell-bg); }
.vc.sel { background: var(--cell-bg); border-color: var(--color-info); }
.chk { flex: none; width: 22px; height: 22px; margin-top: 2px; border-radius: 7px; border: 1.5px solid var(--text-tertiary); display: grid; place-items: center; }
.chk.on { background: var(--color-info); border-color: var(--color-info); color: #fff; }
.chk:disabled { opacity: .3; cursor: not-allowed; }
.chk.ghost { border-color: transparent; }
.vb { flex: 1; min-width: 0; text-align: left; display: flex; flex-direction: column; gap: 4px; }
.vt { display: flex; align-items: center; gap: 8px; }
.vt b { font-weight: 500; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.st { flex: none; display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 9px; border-radius: 11px; font-size: 11.5px; font-weight: 500; background: var(--button-bg); }
.st.ready { background: rgba(161 208 255 / .2); color: var(--color-info); }
.st.open { background: rgba(255 160 60 / .18); color: #e08a2c; }
.st.conflicted { background: #e0613f; color: #fff; }
.st.merged { background: rgba(150 240 176 / .18); color: var(--color-success); }
.br { color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vmeta { display: flex; align-items: center; gap: 6px; font-size: 12.5px; flex-wrap: wrap; }
.src { height: 20px; padding: 0 8px; border-radius: 10px; font-size: 11px; display: inline-flex; align-items: center; background: var(--button-bg); }
.src.run, .src.chat { color: #9b7cf0; } .src.instance { color: #e2a93b; } .src.person, .src.handover { color: var(--color-info); } .src.imported { color: #d97757; }
.ab { font-family: "SF Mono", Menlo, monospace; font-size: 11.5px; color: var(--text-secondary); }
.when { color: var(--text-tertiary); margin-left: auto; }
.from { font-size: 12.5px; color: var(--text-secondary); line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.spin { width: 9px; height: 9px; border-radius: 9999px; border: 2px solid currentColor; border-right-color: transparent; animation: spin .8s linear infinite; }
.past { font-size: 13px; color: var(--text-secondary); padding: 8px 10px; text-align: left; }
.past-c { opacity: .6; }
.vf { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-top: 1px solid var(--hairline); flex: none; }
.vf span { flex: 1; display: flex; flex-direction: column; font-size: 14px; font-weight: 500; }
.vf small { font-size: 12px; color: var(--text-secondary); font-weight: 400; }
.vf .dark-btn { height: 44px; }
.dark-btn { background: var(--ink); color: var(--ink-inverse); }
.toast { position: fixed; left: 50%; bottom: 28px; translate: -50% 0; padding: 12px 18px; border-radius: 14px; background: #1d1d1f; color: #f5f5f7; font-size: 14px; z-index: 50; max-width: 90vw; }
/* reference slots: ↗ and a 「참조」 pill, where it points in the date column; locked · gone · taken ones muted */
.fr.slot { position: relative; }
.fr.slot .fn:disabled { cursor: default; opacity: 1; }
.si { position: relative; flex: none; display: grid; place-items: center; width: 17px; margin-right: 4px; color: var(--text-primary); }
.si.locked { color: var(--text-secondary); } .si.dangling { color: #c27a12; }
.fw { position: relative; flex: none; display: grid; }
.fw .arr { position: absolute; right: -4px; bottom: -4px; width: 14px; height: 14px; border-radius: 7px; display: grid; place-items: center; background: #2a78d6; color: #fff; box-shadow: 0 0 0 1.5px var(--regular-solid-bg); }
.si .arr { position: absolute; right: -5px; bottom: -4px; width: 13px; height: 13px; border-radius: 7px; display: grid; place-items: center; background: #2a78d6; color: #fff; }
.sl { min-width: 0; display: flex; flex-direction: column; }
.sn { display: flex; align-items: center; gap: 6px; min-width: 0; }
.rp { flex: none; height: 20px; padding: 0 8px; border-radius: 10px; font-size: 11px; font-weight: 500; display: inline-flex; align-items: center; background: rgba(42, 120, 214, .14); color: #1f63b8; }
.slot.locked .rp, .slot.dangling .rp { background: var(--button-bg); color: var(--text-secondary); }
.ra { display: none; color: #2a78d6; }
.sm-meta { display: none; font-size: 12px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.by.meta { display: block; text-overflow: ellipsis; color: var(--text-secondary); }
.slot.locked .nm, .slot.dangling .nm { color: var(--text-secondary); }
.slot.dangling .by.meta { color: #b06a0c; }
.fr.reffile .fn.in { padding-left: 34px; }
.more-row .nm { color: var(--text-secondary); font-size: 13px; }
.caret { font-size: 10px; margin-left: -2px; opacity: .7; }
.more { flex: none; width: 28px; height: 28px; border-radius: 14px; display: grid; place-items: center; color: var(--text-secondary); }
.more:hover { background: var(--button-bg); color: var(--text-primary); }
.ask { flex: none; height: 26px; padding: 0 10px; border-radius: 13px; font-size: 12px; font-weight: 500; background: var(--ink); color: var(--ink-inverse); white-space: nowrap; }
.asked { font-size: 12px; color: var(--text-secondary); white-space: nowrap; }
.mveil { position: fixed; inset: 0; z-index: 46; }
/* the system's file window opens from these (not display:none — kept in the page, out of sight) */
.pick { position: fixed; left: -9999px; top: 0; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.toast.scan { display: inline-flex; align-items: center; gap: 8px; }
.pop { position: fixed; width: 220px; padding: 6px; border-radius: 16px; display: flex; flex-direction: column; gap: 2px; box-shadow: 0 12px 40px rgba(0, 0, 0, .22); --regular-bg: var(--regular-solid-bg); animation: pop-in .25s var(--spring) both; }
.mh { padding: 8px 10px 6px; font-size: 13.5px; font-weight: 600; display: flex; flex-direction: column; min-width: 0; overflow-wrap: anywhere; }
.mh small, .mi small { font-size: 11.5px; font-weight: 400; color: var(--text-secondary); }
.mi { display: grid; grid-template-columns: 20px 1fr; align-items: center; column-gap: 8px; min-height: 40px; padding: 6px 10px; border-radius: 11px; text-align: left; font-size: 14px; }
.mi small { grid-column: 2; }
@media (hover: hover) { .mi:hover { background: var(--cell-bg); } }
.mi.danger { color: var(--color-error); }
:root[data-theme="dark"] .rp { background: rgba(120, 175, 255, .2); color: #9cc7ff; }
:root[data-theme="dark"] .slot.locked .rp, :root[data-theme="dark"] .slot.dangling .rp { background: var(--button-bg); color: var(--text-secondary); }
:root[data-theme="dark"] .si.dangling, :root[data-theme="dark"] .slot.dangling .by.meta { color: #f0b45a; }
:root[data-theme="dark"] .ra { color: #8cc1ff; }
@media (max-width: 1000px) { .cols { grid-template-columns: 1fr; overflow-y: auto; } .fd { overflow-y: auto; } }
/* phone (src/viewport.js): the title gets the first line, members and 공유·작업실 the next; the tab row
   scrolls sideways instead of wrapping; file rows drop the date column */
@media (max-width: 760px) {
  .fd { padding: 0 12px 12px; }
  .head { flex-wrap: wrap; gap: 6px 10px; margin-bottom: 12px; }
  .back { width: 36px; height: 36px; }
  .head > .fic { width: 36px; height: 36px; border-radius: 11px; }
  .ttl { flex: 1 1 0; }
  h1 { font-size: 20px; }
  .head > .sp { flex-basis: 100%; height: 0; }
  .mem { margin-right: auto; }
  .hbtn { height: 36px; font-size: 13.5px; }
  .banner { flex-wrap: wrap; padding: 10px 12px; }
  .pcbar { padding: 8px 10px; }
  .pcbar .tb { flex: 1; }
  .banner > span:not(.sp) { flex: 1 1 220px; word-break: keep-all; }
  .pane, .vars { border-radius: 18px; }
  .ph { gap: 8px; padding: 0 10px; overflow-x: auto; scrollbar-width: none; }
  .ph::-webkit-scrollbar { display: none; }
  .ph .ref { display: none; }
  .up { max-width: 120px; }
  .fr { grid-template-columns: minmax(0, 1fr) auto; padding: 4px 6px; }
  .fr > :nth-child(2) { display: none; }
  /* a slot: two lines — its name with ↗ (no pill words), then 「참조 · where it points」 */
  .fr.slot { min-height: 54px; }
  .slot .rp { display: none; }
  .slot.ok .ra { display: inline-flex; }
  .slot .sm-meta { display: block; }
  .slot.dangling .sm-meta { color: #b06a0c; }
  :root[data-theme="dark"] .slot.dangling .sm-meta { color: #f0b45a; }
  .fr.reffile .fn.in { padding-left: 22px; }
  /* the menus come up from the bottom */
  .pop { left: 0 !important; right: 0; top: auto !important; bottom: 0; width: auto; border-radius: 20px 20px 0 0; padding: 10px 10px calc(14px + env(safe-area-inset-bottom)); animation: sheet-up .28s var(--spring) both; }
  .mveil { background: rgba(20, 24, 32, .28); }
  .mi { min-height: 48px; font-size: 15px; }
  .fn.in { padding-left: 14px; }
  .del { opacity: .6; }
  .hr { grid-template-columns: 64px minmax(0, 1fr); row-gap: 4px; padding: 10px 6px; }
  .hr .hm { word-break: keep-all; overflow-wrap: anywhere; }
  .hr .by { grid-column: 2; }
  .ist { flex-wrap: wrap; }
  .none, .exp, .drop { word-break: keep-all; overflow-wrap: anywhere; }
  .cat { overflow-wrap: anywhere; }
  dl.sk { grid-template-columns: 76px 1fr; }
  .vc { padding: 10px 6px 10px 4px; }
  .vf span { word-break: keep-all; }
  .vf .dark-btn { flex: none; white-space: nowrap; }
}
@keyframes sheet-up { from { transform: translateY(30px); opacity: 0; } to { transform: none; opacity: 1; } }
</style>
