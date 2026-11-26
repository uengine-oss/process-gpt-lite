<script setup>
// 참조 더하기 (server lib/folders/refs.js add): ① 내가 읽을 수 있는 폴더 고르기 → ② 그 폴더 전체, 또는 안으로 들어가 하위 폴더 · 파일 하나 →
// ③ 자리 이름 → 더하기. 원본의 최신(main)을 따라간다. 휴대폰에서는 아래에서 올라오는 전체 높이 시트로, 단계를 한 화면씩 보여 준다.
// 자리 이름은 이 폴더의 모든 구성원에게 보이므로 처음 이름은 「참조 N」이다(원본의 이름이 아님). 파일의 형식(확장자)도 붙이기로 할 때만 붙는다.
import { ref, computed, onMounted, nextTick } from 'vue'
import Icon from '../Icon.vue'
import FIcon from './FIcon.vue'
import { folders as F } from '../../foldersApi.js'
import { kindOf, kindLabel, baseName } from './fileKind.js'

// taken: the names and slots this folder's references already have (the first free 「참조 N」 is offered)
const props = defineProps({ folder: Object, taken: { type: Array, default: () => [] } })
const emit = defineEmits(['close', 'added'])
const step = ref(1)
const all = ref(null)
const find = ref('')
const src = ref(null)
const files = ref([])
const cwd = ref('')
const pick = ref({ path: '', type: 'folder' })
const name = ref('')
const keepExt = ref(false)
const busy = ref(false)
const err = ref('')
const nameBox = ref(null)

onMounted(async () => {
  try { all.value = (await F.list()).filter((f) => f.id !== props.folder.id && f.kind !== 'skill') } catch (e) { err.value = e.message; all.value = [] }
})
const shown = computed(() => {
  const k = find.value.trim().toLowerCase()
  return (all.value || []).filter((f) => !k || `${f.name} ${f.description || ''}`.toLowerCase().includes(k))
})
async function choose(f) {
  src.value = f; err.value = ''; cwd.value = ''; pick.value = { path: '', type: 'folder' }; files.value = []
  step.value = 2
  // (the original's own files only: a slot of it is not followed — references go one level deep)
  try { files.value = (await F.tree(f.slug)).filter((x) => !x.ref && x.path !== '.gitattributes') } catch (e) { err.value = e.message }
}
// what is right inside the place being looked at: its folders, then its files
const here = computed(() => {
  const pre = cwd.value ? `${cwd.value}/` : ''
  const dirs = new Map(), list = []
  for (const f of files.value) {
    if (!f.path.startsWith(pre)) continue
    const rest = f.path.slice(pre.length)
    const i = rest.indexOf('/')
    if (i < 0) list.push(f)
    else { const d = pre + rest.slice(0, i); dirs.set(d, (dirs.get(d) || 0) + 1) }
  }
  return { dirs: [...dirs.entries()].sort((a, b) => a[0].localeCompare(b[0])), files: list.sort((a, b) => a.path.localeCompare(b.path)) }
})
const into = (d) => { cwd.value = d; pick.value = { path: d, type: 'dir' } }
const up = () => { const i = cwd.value.lastIndexOf('/'); into(i < 0 ? '' : cwd.value.slice(0, i)); if (!cwd.value) pick.value = { path: '', type: 'folder' } }
const whole = () => { pick.value = cwd.value ? { path: cwd.value, type: 'dir' } : { path: '', type: 'folder' } }
const pickFile = (f) => { pick.value = { path: f.path, type: 'file' } }
const picked = computed(() => (pick.value.path ? `${src.value?.name} / ${pick.value.path}` : `${src.value?.name} · 폴더 전체`))
async function next() {
  // (a neutral name — every member of this folder sees it, also those who cannot read the original)
  const taken = new Set(props.taken)
  let n = 1
  while (taken.has(`참조 ${n}`)) n++
  name.value = `참조 ${n}`
  keepExt.value = false
  step.value = 3
  await nextTick(); nameBox.value?.focus()
}
function back() { err.value = ''; if (step.value === 3) step.value = 2; else if (step.value === 2) { step.value = 1; src.value = null } }
async function add() {
  if (busy.value || !name.value.trim()) return
  busy.value = true; err.value = ''
  try {
    const r = await F.addRef(props.folder.slug, { source: src.value.slug, path: pick.value.path, label: name.value.trim(), keepExt: pick.value.type === 'file' && keepExt.value })
    emit('added', r)
  } catch (e) { err.value = e.message } finally { busy.value = false }
}
const extOf = computed(() => (/\.[^./]+$/.exec(pick.value.path || '') || [''])[0])
const TITLE = { 1: '참조 더하기 — 원본 고르기', 2: '무엇을 가리킬까요', 3: '자리 이름' }
</script>

<template>
  <div class="veil" data-test="ref-sheet" @click.self="emit('close')">
    <div class="box glass" role="dialog" aria-modal="true" :aria-label="TITLE[step]">
      <header class="hd">
        <button v-if="step > 1" class="ic press" title="뒤로" data-test="ref-back" @click="back"><Icon name="back" :size="16" /></button>
        <span v-else class="fi"><FIcon name="ref" :size="18" /></span>
        <b>{{ TITLE[step] }}</b>
        <span class="sp" />
        <button class="ic press" title="닫기" @click="emit('close')"><Icon name="close" :size="16" /></button>
      </header>

      <div v-if="step === 1" class="body scroll">
        <p class="lead">다른 폴더의 자료를 이 폴더 안에 참조로 두면, 내용은 원본에만 있고 이 폴더는 가리키기만 해요. 에이전트에게 이 폴더를 주면 참조된 자료까지 함께 읽어요.</p>
        <input v-model="find" class="field" placeholder="폴더 찾기" data-test="ref-find" />
        <p v-if="all === null" class="none">불러오는 중…</p>
        <p v-else-if="!shown.length" class="none">참조할 수 있는 폴더가 없어요. 내가 구성원인 폴더만 보여요.</p>
        <button v-for="f in shown" :key="f.id" class="row press" data-test="ref-source" :data-slug="f.slug" @click="choose(f)">
          <span class="fic folder" :class="{ linked: f.kind === 'linked' }"><FIcon :name="f.kind === 'linked' ? 'link' : 'folder'" :size="17" /></span>
          <span class="rt"><b>{{ f.name }}</b><small v-if="f.description">{{ f.description }}</small></span>
          <span class="chev">›</span>
        </button>
      </div>

      <div v-else-if="step === 2" class="body scroll">
        <div class="where"><FIcon name="folder" :size="15" /> <b>{{ src.name }}</b><template v-if="cwd"> / {{ cwd }}</template></div>
        <button class="row press opt" :class="{ on: pick.type !== 'file' && pick.path === cwd }" data-test="ref-whole" @click="whole">
          <span class="dot" /><span class="rt"><b>{{ cwd ? `「${baseName(cwd)}」 폴더 전체` : '폴더 전체' }}</b><small>{{ cwd ? '이 하위 폴더 아래의 파일을 모두 가리켜요' : '이 폴더의 파일을 모두 가리켜요' }}</small></span>
        </button>
        <button v-if="cwd" class="row press" data-test="ref-up" @click="up"><span class="fic sm up">‹</span><span class="rt"><b>위로</b></span></button>
        <button v-for="[d, n] in here.dirs" :key="d" class="row press" data-test="ref-dir" :data-path="d" @click="into(d)">
          <span class="fic sm folder"><FIcon name="folder" :size="15" /></span>
          <span class="rt"><b>{{ baseName(d) }}</b><small>파일 {{ n }}개</small></span>
          <span class="chev">›</span>
        </button>
        <button v-for="f in here.files" :key="f.path" class="row press opt" :class="{ on: pick.type === 'file' && pick.path === f.path }" data-test="ref-file" :data-path="f.path" @click="pickFile(f)">
          <span class="dot" /><span class="fic sm" :class="kindOf(f.path)">{{ kindLabel[kindOf(f.path)] }}</span>
          <span class="rt"><b>{{ baseName(f.path) }}</b></span>
        </button>
        <p v-if="!files.length && !err" class="none">이 폴더에는 아직 파일이 없어요. 폴더 전체를 가리키면 파일이 생길 때 함께 보여요.</p>
      </div>

      <div v-else class="body scroll">
        <div class="where"><FIcon name="ref" :size="15" /> {{ picked }}</div>
        <label class="lab" for="ref-name">이 폴더에서 보일 이름</label>
        <input id="ref-name" ref="nameBox" v-model="name" class="field" maxlength="80" data-test="ref-name" @keydown.enter="add" />
        <label v-if="pick.type === 'file' && extOf" class="chk"><input v-model="keepExt" type="checkbox" data-test="ref-keep-ext" /> 이름에 파일 형식({{ extOf }})을 붙여요 — 형식도 모든 구성원에게 보여요</label>
        <ul class="notes">
          <li>원본의 최신(main)을 따라가요 — 원본이 바뀌면 여기서도 바뀐 내용을 읽어요.</li>
          <li>이 이름은 이 폴더의 모든 구성원에게 보여요. 내용은 원본 폴더의 구성원만 볼 수 있어요.</li>
          <li>이 폴더에서는 읽기만 해요. 고치려면 원본 폴더에서 고쳐요.</li>
        </ul>
      </div>

      <p v-if="err" class="bad" role="alert">{{ err }}</p>
      <footer v-if="step > 1" class="ft">
        <span class="pk">{{ step === 2 ? picked : '' }}</span>
        <button v-if="step === 2" class="dark-btn" data-test="ref-next" @click="next">다음</button>
        <button v-else class="dark-btn" :disabled="busy || !name.trim()" data-test="ref-add" @click="add">{{ busy ? '더하는 중…' : '더하기' }}</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.veil { position: fixed; inset: 0; z-index: 45; background: rgba(20, 24, 32, .3); display: grid; place-items: center; padding: 24px; animation: fade-in .2s both; }
.box { width: min(560px, 100%); height: min(640px, calc(100vh - 48px)); border-radius: 24px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 18px 60px rgba(0, 0, 0, .3); animation: pop-in .4s var(--spring) both; --regular-bg: var(--regular-solid-bg); }
.hd { display: flex; align-items: center; gap: 10px; height: 58px; padding: 0 14px 0 16px; border-bottom: 1px solid var(--hairline); font-size: 16px; flex: none; }
.hd b { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fi { color: #2a78d6; display: grid; place-items: center; }
.sp { flex: 1; }
.ic { width: 32px; height: 32px; border-radius: 16px; display: grid; place-items: center; background: var(--button-bg); flex: none; }
.body { flex: 1; min-height: 0; padding: 12px 16px 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
.lead { margin: 2px 2px 10px; font-size: 13.5px; line-height: 1.6; color: var(--text-secondary); word-break: keep-all; }
.field { height: 42px; border-radius: 12px; border: 1px solid var(--hairline); background: var(--field-bg); padding: 0 12px; font-size: 14.5px; color: var(--text-primary); margin-bottom: 6px; }
.row { display: flex; align-items: center; gap: 10px; min-height: 52px; padding: 6px 8px; border-radius: 14px; text-align: left; width: 100%; }
/* (a phone has no hover: a tapped row would stay lit on the next step) */
@media (hover: hover) { .row:hover { background: var(--cell-bg); } }
.row.opt.on { background: rgba(42, 120, 214, .1); }
.rt { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.rt b { font-weight: 500; font-size: 14.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rt small { font-size: 12.5px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chev { color: var(--text-tertiary); font-size: 20px; padding: 0 4px; }
.dot { flex: none; width: 18px; height: 18px; border-radius: 9px; border: 1.5px solid var(--text-tertiary); }
.opt.on .dot { border: 5.5px solid #2a78d6; }
.fic { flex: none; width: 36px; height: 36px; border-radius: 11px; display: grid; place-items: center; font-size: 10px; font-weight: 700; color: #fff; background: #6b6b66; }
.fic.sm { width: 28px; height: 28px; border-radius: 8px; font-size: 9px; }
.fic.up { background: var(--button-bg); color: var(--text-primary); font-size: 16px; }
.fic.folder { background: #e2a93b; } .fic.folder.linked { background: #4a5f9a; }
.fic.hwp { background: #1f6fd1; } .fic.doc { background: #2b579a; } .fic.xls { background: #217346; } .fic.ppt { background: #c43e1c; } .fic.pdf { background: #d93025; } .fic.cad { background: #0b6f88; } .fic.vec { background: #c2570c; } .fic.img { background: #7b3fbf; } .fic.snd { background: #0f8a5f; } .fic.vid { background: #b0223c; } .fic.md { background: #3d4f6b; } .fic.code { background: #2d333b; }
.where { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-secondary); margin: 0 2px 8px; min-width: 0; overflow-wrap: anywhere; }
.where b { color: var(--text-primary); font-weight: 500; }
.lab { font-size: 12.5px; color: var(--text-tertiary); margin: 6px 2px 6px; }
.chk { display: flex; align-items: center; gap: 8px; margin: 2px 2px 4px; font-size: 13px; color: var(--text-secondary); word-break: keep-all; }
.chk input { width: 16px; height: 16px; flex: none; }
.notes { margin: 6px 0 0; padding-left: 18px; font-size: 13px; line-height: 1.7; color: var(--text-secondary); word-break: keep-all; }
.none { font-size: 13.5px; color: var(--text-secondary); padding: 10px 4px; margin: 0; line-height: 1.6; word-break: keep-all; }
.bad { margin: 0; padding: 8px 18px; font-size: 13px; color: var(--color-error); flex: none; word-break: keep-all; }
.ft { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-top: 1px solid var(--hairline); flex: none; }
.pk { flex: 1; min-width: 0; font-size: 12.5px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dark-btn { height: 42px; padding: 0 20px; background: var(--ink); color: var(--ink-inverse); flex: none; }
.dark-btn:disabled { opacity: .4; }
/* phone: a full-height sheet from the bottom, one step a screen (‹ goes back) */
@media (max-width: 760px) {
  .veil { place-items: end stretch; padding: 0; }
  .box { width: 100%; height: calc(100% - 28px); border-radius: 22px 22px 0 0; animation: sheet-up .32s var(--spring) both; }
  .ft { padding-bottom: calc(12px + env(safe-area-inset-bottom)); }
}
@keyframes sheet-up { from { transform: translateY(40px); opacity: 0; } to { transform: none; opacity: 1; } }
</style>
