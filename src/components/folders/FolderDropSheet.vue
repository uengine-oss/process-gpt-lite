<script setup>
// 폴더 올리기 — 미리 보기 (spec openspec/specs/champion-folders 「컴퓨터의 폴더를 끌어다 놓아 올린다」): a folder of this computer,
// dropped on a folder's files (mode 'into' — its files go to that folder's main with the dropped folder's name first) or on the folder
// list (mode 'new' — a new folder by the dropped folder's name holds its contents), or picked with 「폴더 올리기」. Before anything goes
// up: how many files and how big, what stays here and why (the champion folders' rules — src/folderDrop.js), a git repository's remote,
// and — over one upload's limits — which limit and the biggest parts, which the person can leave out here. Then it goes up once, a
// request at a time (one commit each); nothing stays linked to the computer.
// In the desktop app with its folder bridge (0.2.5+), a new folder can instead be 「내 PC 폴더로 공유(계속 맞춤)」 — the champion folders'
// own flow (emit 'champion': the app's system dialog picks the folder, SourceSheet previews it). An app without the bridge says in one
// line that a newer one can.
import { ref, computed, watch, onMounted } from 'vue'
import Icon from '../Icon.vue'
import FIcon from './FIcon.vue'
import { folders as F } from '../../foldersApi.js'
import { planOf, leftCount, shapesIn, sendPlan } from '../../folderDrop.js'
import { GROUP, reasonText, fmtBytes } from '../../desktopFolders.js'

const props = defineProps({
  scan: { type: Object, required: true },     // folderDrop.js walk() · fromPicked()
  rules: { type: Object, required: true },    // folderDrop.js compileRules()
  mode: { type: String, default: 'into' },    // 'into' | 'new'
  folder: { type: Object, default: null },    // into: {slug, name}
  name: { type: String, default: '' },        // new: what the name starts as
  pc: { type: String, default: '' },          // new, in the desktop app: 'ready' (the bridge, paired) · 'unpaired' · 'old' (no bridge) · ''
})
const emit = defineEmits(['close', 'done', 'champion'])
const isNew = computed(() => props.mode === 'new')
const base = computed(() => (props.scan.roots.length === 1 && props.scan.roots[0].dir ? props.scan.roots[0].name : ''))
const exclude = ref(new Set())
const hits = ref([])                 // keys of a sure shape found ({rel, line, reason})
const checked = new Set()            // files already looked at for them
const checking = ref(false)
const fname = ref(String(props.name || base.value || '').slice(0, 80))
const description = ref('')
const way = ref('once')              // new, in the app with the bridge: 'once' | 'pc'
const busy = ref('')                 // 'upload'
const progress = ref({ done: 0, total: 0 })
const err = ref('')
const open = ref(new Set())

const plan = computed(() => planOf(props.scan, props.rules, { strip: isNew.value, exclude: exclude.value, shapes: hits.value }))
const leftN = computed(() => leftCount(plan.value))
const over = computed(() => plan.value.over)
const shownTops = computed(() => plan.value.tops.slice(0, 200))
// a folder's git: its remote (the address only), or a work tree of a repository elsewhere
const gitLine = computed(() => {
  const g = props.scan.git
  if (!g) return ''
  if (g.worktree) return 'git 작업 트리예요 — .git 은 빼고, 지금 있는 파일만 올려요'
  return `git 저장소예요${g.remote ? `(원격 ${g.remote})` : ''} — .git 과 지난 이력은 빼고, 지금 있는 파일만 올려요`
})
const WORDS = {
  git: 'git 저장소 자료(.git)',
  secret: GROUP.secret,
  personal: GROUP.personal,
  rebuildable: GROUP.rebuildable,
  structure: 'git 제어 파일(.gitmodules · .lfsconfig)',
  large: `큰 파일 — ${fmtBytes(props.rules.limits.largeFileBytes)} 넘는 파일은 올리지 않아요`,
  shape: '열쇠 · 토큰처럼 생긴 글이 든 파일',
}
const groups = computed(() => Object.keys(WORDS).map((g) => {
  const files = plan.value.left[g] || []
  const places = plan.value.places[g] || []
  return { g, files, places, label: WORDS[g], n: files.length + places.length }
}).filter((x) => x.n))
const shapeOf = computed(() => new Map(hits.value.map((h) => [h.rel, h])))
const overLines = computed(() => over.value.map((o) => (o.kind === 'files'
  ? `파일이 ${o.value.toLocaleString()}개${o.more ? '가 넘어요' : '예요'} — 한 번에 ${o.max.toLocaleString()}개까지 올릴 수 있어요`
  : `한 번에 올릴 수 있는 크기(${fmtBytes(o.max)})를 넘어요 — ${fmtBytes(o.value)}`)))
const dest = computed(() => (isNew.value ? '' : `‘${props.folder?.name || ''}’ main 에 ${base.value ? `${base.value}/ ` : ''}그대로 올라가요 · 올린 사람과 시각이 이력에 남아요`))
const canGo = computed(() => !busy.value && !checking.value && (way.value === 'pc' || (plan.value.files > 0 && !over.value.length && (!isNew.value || fname.value.trim()))))

function toggleTop(t) { const s = new Set(exclude.value); s.has(t) ? s.delete(t) : s.add(t); exclude.value = s }
function toggleOpen(g) { const s = new Set(open.value); s.has(g) ? s.delete(g) : s.add(g); open.value = s }

// keys of a sure shape in what would go up — looked for once a plan is within the limits (a folder over them is not read)
async function check() {
  if (checking.value || over.value.length) return
  const todo = plan.value.up.filter((u) => !checked.has(u.rel))
  if (!todo.length) return
  checking.value = true
  try {
    const found = await shapesIn(todo, props.rules)
    for (const u of todo) checked.add(u.rel)
    if (found.length) hits.value = [...hits.value, ...found]
  } finally { checking.value = false }
  check()
}
onMounted(check)
watch(() => over.value.length, (n) => { if (!n) check() })
watch(exclude, () => check())

async function go() {
  if (!canGo.value) return
  if (way.value === 'pc') { emit('champion'); return }
  err.value = ''
  busy.value = 'upload'
  let slug = props.folder?.slug || ''
  let made = null
  progress.value = { done: 0, total: plan.value.files }
  try {
    if (isNew.value) { made = await F.create({ name: fname.value.trim(), description: description.value.trim() }); slug = made.slug }
    const label = isNew.value ? made.name : base.value || `${plan.value.files}개`
    const r = await sendPlan(plan.value, { label, send: (batch, meta) => F.uploadBatch(slug, batch, meta), onProgress: (done, total) => { progress.value = { done, total } } })
    emit('done', { slug, folder: made, written: r.written, refused: r.refused, left: leftN.value })
  } catch (e) {
    err.value = made ? `‘${made.name}’ 폴더는 만들었지만 다 올리지 못했어요 — ${e.message}` : e.message
    if (made) emit('done', { slug, folder: made, written: progress.value.done, refused: [], left: leftN.value, partial: e.message })
  } finally { busy.value = '' }
}
</script>

<template>
  <div class="veil" data-test="drop-sheet" :data-mode="mode" @click.self="!busy && emit('close')">
    <div class="box glass" role="dialog" :aria-label="isNew ? '새 폴더로 올리기' : '폴더 올리기'">
      <header class="hd">
        <FIcon name="upload" :size="19" />
        <b class="ttl">{{ isNew ? '새 폴더로 올리기' : '폴더 올리기' }}<template v-if="base"> — <span data-no-i18n>{{ base }}</span></template></b>
        <span class="sp" />
        <button class="ic press" title="닫기" :disabled="!!busy" @click="emit('close')"><Icon name="close" :size="16" /></button>
      </header>
      <div class="body scroll">
        <div class="sum">
          <div class="big" data-test="drop-total" :data-files="plan.files"><b>파일 {{ plan.files.toLocaleString() }}개</b><span>{{ fmtBytes(plan.bytes) }}</span></div>
          <small>{{ checking ? '열쇠 · 토큰처럼 생긴 글을 찾는 중…' : `자동으로 빠지는 것 ${leftN.toLocaleString()}개${exclude.size ? ` · 직접 뺀 것 ${exclude.size}개` : ''}` }}</small>
        </div>
        <p v-if="gitLine" class="note git" data-test="drop-git"><FIcon name="branch" :size="15" /> <span>{{ gitLine }}</span></p>
        <div v-if="over.length" class="over" data-test="drop-over" role="alert">
          <p v-for="l in overLines" :key="l"><Icon name="alert" :size="14" /> {{ l }}</p>
          <small v-if="plan.biggest.length">가장 큰 것: <template v-for="(t, i) in plan.biggest" :key="t.top">{{ i ? ', ' : '' }}<span data-no-i18n>{{ t.top }}</span> {{ fmtBytes(t.bytes) }} · 파일 {{ t.files.toLocaleString() }}개</template> — 아래 「올릴 것」에서 체크를 풀어 빼 주세요</small>
        </div>
        <p v-if="dest" class="fine dest" data-test="drop-dest">{{ dest }}</p>

        <div class="sec">올릴 것</div>
        <div class="tops">
          <label v-for="t in shownTops" :key="t.top" class="top" :class="{ off: t.out }" data-test="drop-top" :data-top="t.top">
            <input type="checkbox" :checked="!t.out" :disabled="!!busy" @change="toggleTop(t.top)" />
            <span class="tn" data-no-i18n>{{ t.top }}</span>
            <small>{{ t.out ? '직접 뺀 것' : `파일 ${t.files.toLocaleString()}개 · ${fmtBytes(t.bytes)}` }}</small>
          </label>
          <small v-if="plan.tops.length > shownTops.length" class="more">외 {{ (plan.tops.length - shownTops.length).toLocaleString() }}개</small>
          <p v-if="!plan.tops.length" class="none">올릴 파일이 없어요.</p>
        </div>

        <template v-if="groups.length">
          <div class="sec">빠지는 것 <span class="cnt">{{ leftN.toLocaleString() }}</span></div>
          <div v-for="x in groups" :key="x.g" class="grp" data-test="drop-left" :data-group="x.g">
            <button class="gh press" @click="toggleOpen(x.g)">
              <span class="tw">{{ open.has(x.g) ? '▾' : '▸' }}</span><span class="gn">{{ x.label }}</span>
              <span class="cnt">{{ x.places.length ? `폴더 ${x.places.length}곳${x.files.length ? ` · 파일 ${x.files.length}개` : ''}` : x.files.length.toLocaleString() }}</span>
            </button>
            <div v-if="open.has(x.g)" class="samples">
              <div v-for="p in [...x.places, ...x.files].slice(0, 12)" :key="p" class="smp">
                <span class="sn" data-no-i18n>{{ p }}</span>
                <small v-if="shapeOf.get(p)">{{ shapeOf.get(p).line }}째 줄 · {{ reasonText(shapeOf.get(p).reason) }}</small>
              </div>
              <small v-if="x.n > 12" class="more">외 {{ (x.n - 12).toLocaleString() }}개</small>
            </div>
          </div>
          <p class="fine">비밀 파일 · 내 PC 에만 두는 설정 · 다시 만들 수 있는 것은 「내 PC 폴더 올리기」와 같은 규칙으로 빼요. 열쇠 값은 숨기고 몇 번째 줄에 있는지만 보여 드려요.</p>
        </template>
        <p v-if="scan.unreadable.length" class="fine warnc" data-test="drop-unreadable">읽지 못한 것 {{ scan.unreadable.length }}개 — 올리지 않아요</p>

        <template v-if="isNew">
          <div class="sec">이름</div>
          <input v-model="fname" class="fld" maxlength="80" data-test="drop-name" placeholder="예: 11월 고객 세미나" :disabled="!!busy" />
          <input v-model="description" class="fld" maxlength="200" placeholder="설명(선택)" :disabled="!!busy" />
          <!-- the desktop app with its folder bridge: once, or kept in step with this computer's folder (champion folders) -->
          <div v-if="pc === 'ready'" class="ways" role="radiogroup" data-test="drop-ways">
            <label class="way" :class="{ on: way === 'once' }" data-test="drop-way-once">
              <input v-model="way" type="radio" value="once" :disabled="!!busy" />
              <span><b>한 번 올리기</b><small>지금 있는 파일을 새 폴더에 올려요. 내 PC 의 폴더와는 연결하지 않아요.</small></span>
            </label>
            <label class="way" :class="{ on: way === 'pc' }" data-test="drop-way-pc">
              <input v-model="way" type="radio" value="pc" :disabled="!!busy" />
              <span><b>내 PC 폴더로 공유(계속 맞춤)</b><small>이 PC 의 폴더를 연결해 두고, 바뀐 내용은 「지금 올리기」로 올려요. 시스템 창에서 이 폴더를 한 번 더 골라 주세요.</small></span>
            </label>
          </div>
          <p v-else-if="pc === 'old'" class="fine pcline" data-test="drop-pc-old"><FIcon name="pc" :size="14" /> 데스크톱 앱을 새 판으로 바꾸면 내 PC 폴더를 그대로 공유할 수 있어요</p>
          <p v-else-if="pc === 'unpaired'" class="fine pcline" data-test="drop-pc-unpaired"><FIcon name="pc" :size="14" /> 이 PC 를 이 서버에 연결하면 내 PC 폴더를 그대로 공유할 수 있어요</p>
        </template>
        <div v-if="err" class="bad" data-test="drop-error" role="alert">{{ err }}</div>
      </div>
      <footer class="ft">
        <small v-if="busy" data-test="drop-progress">올리는 중… {{ progress.done.toLocaleString() }} / {{ progress.total.toLocaleString() }}</small>
        <small v-else-if="way === 'pc'">이어서 「내 PC 폴더 올리기」와 같은 미리 보기를 확인해요</small>
        <small v-else>한 번 올리고 끝나요 — 내 PC 의 폴더는 그대로예요</small>
        <span class="sp" />
        <button class="pill-btn" :disabled="!!busy" @click="emit('close')">취소</button>
        <button class="dark-btn" data-test="drop-go" :disabled="!canGo" @click="go">{{ busy ? '올리는 중…' : way === 'pc' ? '시스템 창에서 고르기' : isNew ? '만들고 올리기' : '올리기' }}</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.veil { position: fixed; inset: 0; z-index: 47; background: rgba(20, 24, 32, .3); display: grid; place-items: center; padding: 24px; animation: fade-in .2s both; }
.box { width: min(660px, 100%); max-height: calc(100vh - 48px); border-radius: 24px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 18px 60px rgba(0, 0, 0, .3); animation: pop-in .4s var(--spring) both; --regular-bg: var(--regular-solid-bg); }
.hd { display: flex; align-items: center; gap: 10px; height: 58px; padding: 0 14px 0 20px; border-bottom: 1px solid var(--hairline); font-size: 16px; flex: none; }
.ttl { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 500; }
.sp { flex: 1; }
.ic { width: 30px; height: 30px; border-radius: 15px; display: grid; place-items: center; background: var(--button-bg); flex: none; }
.body { padding: 12px 20px 16px; overflow-y: auto; min-height: 0; }
.sum { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; flex-wrap: wrap; padding: 14px 16px; border-radius: 16px; background: var(--cell-bg); }
.big { display: flex; align-items: baseline; gap: 10px; } .big b { font-size: 22px; font-weight: 600; letter-spacing: -0.01em; } .big span { color: var(--text-secondary); font-size: 15px; }
.sum small { color: var(--text-secondary); font-size: 13px; }
.note { display: flex; align-items: flex-start; gap: 6px; margin: 10px 2px 0; font-size: 13px; line-height: 1.5; color: var(--text-secondary); word-break: keep-all; overflow-wrap: anywhere; }
.note.git { color: #2a78d6; } .note svg { flex: none; margin-top: 2px; }
.over { margin: 10px 0 0; padding: 10px 12px; border-radius: 14px; background: rgba(255 160 60 / .12); color: #b4530b; font-size: 13px; line-height: 1.5; }
.over p { display: flex; align-items: center; gap: 6px; margin: 0; font-weight: 500; }
.over small { display: block; margin-top: 4px; color: var(--text-secondary); word-break: keep-all; overflow-wrap: anywhere; }
.dest { margin-top: 10px; }
.sec { font-size: 12.5px; color: var(--text-tertiary); margin: 18px 2px 8px; display: flex; align-items: center; gap: 6px; }
.cnt { height: 20px; min-width: 20px; padding: 0 7px; border-radius: 10px; background: var(--button-bg); font-size: 11.5px; display: inline-grid; place-items: center; color: var(--text-secondary); white-space: nowrap; }
.tops { display: flex; flex-direction: column; border: 1px solid var(--hairline); border-radius: 14px; overflow: hidden; max-height: 280px; overflow-y: auto; }
.top { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 9px 12px; font-size: 14px; border-bottom: 1px solid var(--hairline); cursor: pointer; }
.top:last-child { border-bottom: 0; }
.top.off .tn { color: var(--text-tertiary); text-decoration: line-through; }
.tn { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.top small { color: var(--text-secondary); font-size: 12.5px; white-space: nowrap; }
.grp { border: 1px solid var(--hairline); border-radius: 12px; margin-bottom: 6px; overflow: hidden; }
.gh { width: 100%; display: flex; align-items: center; gap: 8px; padding: 9px 12px; font-size: 13.5px; text-align: left; }
.gn { flex: 1; min-width: 0; }
.tw { width: 14px; color: var(--text-tertiary); font-size: 12px; }
.samples { padding: 0 12px 8px 34px; display: flex; flex-direction: column; gap: 2px; }
.smp { display: flex; align-items: center; gap: 8px; min-height: 28px; font-size: 13px; flex-wrap: wrap; }
.sn { flex: 1; min-width: 0; overflow-wrap: anywhere; color: var(--text-secondary); font-family: "SF Mono", Menlo, monospace; font-size: 12px; }
.smp small, .more { font-size: 12px; color: var(--text-tertiary); }
.more { padding: 6px 12px; }
.fld { width: 100%; height: 42px; border-radius: 12px; border: 1px solid var(--hairline); background: var(--field-bg); padding: 0 12px; font-size: 14px; outline: 0; margin-bottom: 8px; color: var(--text-primary); }
.fine { font-size: 12.5px; color: var(--text-secondary); line-height: 1.6; margin: 6px 2px 0; word-break: keep-all; overflow-wrap: anywhere; }
.fine.warnc { color: #c2570c; }
.pcline { display: flex; align-items: center; gap: 6px; }
.none { font-size: 13px; color: var(--text-secondary); padding: 10px 12px; margin: 0; }
.ways { display: flex; flex-direction: column; gap: 8px; margin-top: 6px; }
.way { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; border-radius: 14px; border: 1.5px solid var(--hairline); cursor: pointer; }
.way.on { border-color: #2a78d6; background: rgba(42, 120, 214, .07); }
.way input { margin-top: 3px; }
.way span { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.way b { font-size: 14px; font-weight: 600; } .way small { font-size: 12.5px; color: var(--text-secondary); line-height: 1.5; word-break: keep-all; }
.bad { font-size: 13px; color: var(--color-error); margin: 10px 2px 0; overflow-wrap: anywhere; }
.ft { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-top: 1px solid var(--hairline); flex: none; }
.ft small { color: var(--text-secondary); font-size: 12.5px; min-width: 0; }
.ft > button { height: 42px; padding: 0 18px; white-space: nowrap; }
.dark-btn { background: var(--ink); color: var(--ink-inverse); }
.dark-btn:disabled { opacity: .45; }
:root[data-theme="dark"] .over { color: #ffb870; }
:root[data-theme="dark"] .note.git { color: #8cc1ff; }
:root[data-theme="dark"] .way.on { border-color: #8cc1ff; background: rgba(140, 193, 255, .1); }
:root[data-theme="dark"] .fine.warnc { color: #ffb870; }

@media (max-width: 760px) {
  .veil { padding: 0; place-items: end stretch; }
  .box { width: 100%; max-height: 92vh; border-radius: 22px 22px 0 0; }
  .body { padding: 10px 14px 14px; }
  .ft { flex-wrap: wrap; padding: 10px 14px calc(10px + env(safe-area-inset-bottom)); }
  .ft small { flex-basis: 100%; }
  .ft .sp { display: none; }
  .ft > button { flex: 1; }
  .top small { white-space: normal; text-align: right; }
}
</style>
