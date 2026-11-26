<script setup>
// 내 PC 폴더 올리기 — 미리 보기(champion folders, spec openspec/specs/champion-folders): what the desktop app found in the folder the
// person picked on this computer — what goes up (top-level folders and files, each can be left out), what was left out and why, files
// to check (shaped like a key — the reason only, never the value), the agent assets found — then a name. 「올리기」 makes a Lite folder
// and hands it to the app (pglDesktop.folders.bind), which asks once more in a system dialog and uploads; when that does not happen the
// folder just made goes away again. The page never sees a path of this computer — only the folder's name (label) and paths inside it.
import { ref, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '../Icon.vue'
import FIcon from './FIcon.vue'
import { folders as F } from '../../foldersApi.js'
import { bridge, GROUP, INCLUDABLE, reasonText, WARNING, whyText, fmtBytes, PLATFORM, KIND } from '../../desktopFolders.js'

const props = defineProps({ pick: { type: Object, required: true } }) // {pickId, label, preview}
const emit = defineEmits(['close', 'done'])
const router = useRouter()
const preview = ref(props.pick.preview || {})
const name = ref(String(props.pick.label || '').slice(0, 80))
const description = ref('')
const exclude = ref(new Set())   // top-level entries the person left out
const include = ref(new Set())   // files put back in (a group that may be) · flagged files to upload anyway
const busy = ref('')             // 'scan' | 'upload'
const err = ref('')
const errPaths = ref([])
const note = ref('')
const open = ref(new Set())
// what the first look found stays on the sheet while choices change what the app reports (a left-out entry is not "found" again)
const tops = ref([...(props.pick.preview?.top || [])])
const flaggedSeen = ref(new Map((props.pick.preview?.flagged || []).map((x) => [x.path, x])))
watch(preview, (p) => {
  for (const t of p?.top || []) if (!tops.value.some((x) => x.path === t.path)) tops.value.push(t)
  for (const f of p?.flagged || []) if (!flaggedSeen.value.has(f.path)) flaggedSeen.value.set(f.path, f)
})
const flagged = computed(() => [...flaggedSeen.value.values()])
const topOf = (path) => (preview.value?.top || []).find((x) => x.path === path)
// flagged files stay out unless the person says to upload them anyway (a sure key shape: never)
const sendExclude = computed(() => [...new Set([...exclude.value, ...flagged.value.filter((f) => !include.value.has(f.path)).map((f) => f.path)])])
const sendInclude = computed(() => [...include.value])
const excludedGroups = computed(() => (preview.value?.excluded || []).filter((g) => g.count > 0))
const leftOut = computed(() => excludedGroups.value.reduce((a, g) => a + g.count, 0) + exclude.value.size)
const kitByPlatform = computed(() => {
  const m = new Map()
  for (const k of preview.value?.kit || []) {
    if (!m.has(k.platform)) m.set(k.platform, {})
    m.get(k.platform)[k.type] = (m.get(k.platform)[k.type] || 0) + 1
  }
  return [...m.entries()].map(([p, c]) => ({ platform: p, label: PLATFORM[p] || p, line: Object.keys(KIND).filter((t) => c[t]).map((t) => `${KIND[t]} ${c[t]}`).join(' · ') }))
})
const warnings = computed(() => (preview.value?.warnings || []).map((w) => WARNING[w]).filter(Boolean))
const tooBig = computed(() => (preview.value?.warnings || []).includes('too_big'))
const canUpload = computed(() => !busy.value && name.value.trim() && (preview.value?.files || 0) > 0 && !tooBig.value)

let again = null
async function rescan() {
  const b = bridge()
  if (!b?.preview) return
  busy.value = 'scan'
  try { preview.value = (await b.preview(props.pick.pickId, { exclude: sendExclude.value, include: sendInclude.value })) || preview.value } catch (e) { err.value = e.message } finally { busy.value = '' }
  if (again) { const f = again; again = null; f() }
}
const soon = () => { if (busy.value === 'scan') { again = rescan; return } rescan() }
function toggleTop(path) { const s = new Set(exclude.value); s.has(path) ? s.delete(path) : s.add(path); exclude.value = s; soon() }
function toggleInclude(path) { const s = new Set(include.value); s.has(path) ? s.delete(path) : s.add(path); include.value = s; soon() }
function toggleOpen(g) { const s = new Set(open.value); s.has(g) ? s.delete(g) : s.add(g); open.value = s }

async function upload() {
  if (!canUpload.value) return
  err.value = ''; errPaths.value = []; note.value = ''
  busy.value = 'upload'
  let made = null
  try {
    made = await F.create({ name: name.value.trim(), description: description.value.trim(), champion: true })
    const r = await bridge().bind({ pickId: props.pick.pickId, folderId: made.id, folderName: made.name, include: sendInclude.value, exclude: sendExclude.value })
    // (pending: it went up, and the server's answer comes a little later — the folder screen shows it)
    if (r?.ok) { emit('done', made); router.push(`/folders/${made.slug}`); return }
    await F.discard(made.slug).catch(() => {})
    if (r?.why === 'cancelled') note.value = '올리지 않았어요 — 폴더도 만들지 않았어요.'
    else { err.value = whyText(r?.why); errPaths.value = Array.isArray(r?.paths) ? r.paths : [] }
  } catch (e) {
    if (made) await F.discard(made.slug).catch(() => {})
    err.value = e.message
  } finally { busy.value = '' }
}
</script>

<template>
  <div class="veil" data-test="source-sheet" @click.self="!busy && emit('close')">
    <div class="box glass" role="dialog" aria-label="내 PC 폴더 올리기">
      <header class="hd">
        <FIcon name="pc" :size="19" /><b class="ttl">내 PC 폴더 올리기 — <span data-no-i18n>{{ pick.label }}</span></b><span class="sp" />
        <button class="ic press" title="닫기" :disabled="busy === 'upload'" @click="emit('close')"><Icon name="close" :size="16" /></button>
      </header>
      <div class="body scroll">
        <div class="sum">
          <div class="big" data-test="source-total"><b>파일 {{ (preview.files || 0).toLocaleString() }}개</b><span>{{ fmtBytes(preview.bytes) }}</span></div>
          <small>{{ busy === 'scan' ? '다시 훑는 중…' : `뺀 것 ${leftOut.toLocaleString()}개 · 확인할 파일 ${flagged.length}개` }}</small>
        </div>
        <p v-for="w in warnings" :key="w" class="warn" data-test="source-warning"><Icon name="alert" :size="14" /> {{ w }}</p>

        <div class="sec">올릴 것</div>
        <div class="tops">
          <label v-for="t in tops" :key="t.path" class="top" :class="{ off: exclude.has(t.path) }" data-test="source-top">
            <input type="checkbox" :checked="!exclude.has(t.path)" :disabled="!!busy" @change="toggleTop(t.path)" />
            <span class="tn" data-no-i18n>{{ t.path }}</span>
            <small>{{ exclude.has(t.path) ? '빼기로 함' : `파일 ${(topOf(t.path)?.files ?? t.files).toLocaleString()}개 · ${fmtBytes(topOf(t.path)?.bytes ?? t.bytes)}` }}</small>
          </label>
          <p v-if="!tops.length" class="none">올릴 파일이 없어요.</p>
        </div>

        <template v-if="flagged.length">
          <div class="sec warnc">확인이 필요해요 <span class="cnt">{{ flagged.length }}</span></div>
          <p class="fine">열쇠나 토큰처럼 생긴 글이 든 파일이에요. 값은 보여 주지 않아요 — 어느 줄인지와 까닭만 보여요. 기본은 빼고 올려요.</p>
          <div v-for="f in flagged" :key="f.path" class="flag" data-test="source-flagged">
            <span class="fp"><b data-no-i18n>{{ f.path }}</b><small>{{ f.line ? `${f.line}째 줄 · ` : '' }}{{ reasonText(f.reason) }}</small></span>
            <span v-if="f.level === 'block'" class="sure">서버가 받지 않아요</span>
            <button v-else class="tb press" :class="{ on: include.has(f.path) }" :disabled="!!busy" @click="toggleInclude(f.path)">{{ include.has(f.path) ? '그래도 올림 · 되돌리기' : '그래도 올리기' }}</button>
          </div>
        </template>

        <template v-if="excludedGroups.length || include.size">
          <div class="sec">뺀 것</div>
          <div v-for="g in excludedGroups" :key="g.group" class="grp" data-test="source-excluded" :data-group="g.group">
            <button class="gh press" @click="toggleOpen(g.group)">
              <span class="tw">{{ open.has(g.group) ? '▾' : '▸' }}</span><span class="gn">{{ GROUP[g.group] || g.group }}</span><span class="cnt">{{ g.count.toLocaleString() }}</span>
            </button>
            <div v-if="open.has(g.group)" class="samples">
              <div v-for="s in g.samples || []" :key="s" class="smp">
                <span class="sn" data-no-i18n>{{ s }}</span>
                <button v-if="INCLUDABLE.has(g.group)" class="tb press" :disabled="!!busy" @click="toggleInclude(s)">넣기</button>
              </div>
              <small v-if="(g.samples || []).length < g.count" class="more">외 {{ (g.count - (g.samples || []).length).toLocaleString() }}개</small>
            </div>
          </div>
          <div v-for="p in [...include].filter((x) => !flaggedSeen.has(x))" :key="p" class="smp back">
            <span class="sn" data-no-i18n>{{ p }}</span><small>다시 넣음</small><button class="tb press" :disabled="!!busy" @click="toggleInclude(p)">빼기</button>
          </div>
        </template>

        <template v-if="kitByPlatform.length">
          <div class="sec">찾은 에이전트 자산</div>
          <div class="kits" data-test="source-kit">
            <div v-for="k in kitByPlatform" :key="k.platform" class="kit"><b>{{ k.label }}</b><span>{{ k.line }}</span></div>
          </div>
          <p class="fine">폴더 안의 스킬 · 명령 · 지침은 그대로 함께 올라가고, 폴더 화면의 「에이전트 자산」에 보여요.</p>
        </template>

        <div class="sec">이름</div>
        <input v-model="name" class="fld" maxlength="80" data-test="source-name" placeholder="예: 영업 제안 키트" />
        <input v-model="description" class="fld" maxlength="200" placeholder="설명(선택) — 예: 견적 · 제안서를 쓸 때 쓰는 스킬과 양식" />
        <p class="fine">처음에는 나만 보는 폴더예요. 동료와 나누려면 올린 뒤 폴더의 「공유」에서 초대해요. 올린 뒤에도 내 PC 의 폴더는 그대로이고, 바뀐 것은 「지금 올리기」로 올려요.</p>
        <p v-if="note" class="note" data-test="source-note">{{ note }}</p>
        <div v-if="err" class="bad" data-test="source-error">
          <span>{{ err }}</span>
          <small v-for="p in errPaths" :key="p.path">{{ p.path }}{{ p.line ? `:${p.line}` : '' }} · {{ reasonText(p.reason) }}</small>
        </div>
      </div>
      <footer class="ft">
        <small>올리기를 누르면 이 컴퓨터가 한 번 더 물어요</small>
        <span class="sp" />
        <button class="pill-btn" :disabled="busy === 'upload'" @click="emit('close')">취소</button>
        <button class="dark-btn" data-test="source-upload" :disabled="!canUpload" @click="upload">{{ busy === 'upload' ? '올리는 중…' : '올리기' }}</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.veil { position: fixed; inset: 0; z-index: 45; background: rgba(20, 24, 32, .3); display: grid; place-items: center; padding: 24px; animation: fade-in .2s both; }
.box { width: min(680px, 100%); max-height: calc(100vh - 48px); border-radius: 24px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 18px 60px rgba(0, 0, 0, .3); animation: pop-in .4s var(--spring) both; --regular-bg: var(--regular-solid-bg); }
.hd { display: flex; align-items: center; gap: 10px; height: 58px; padding: 0 14px 0 20px; border-bottom: 1px solid var(--hairline); font-size: 16px; flex: none; }
.ttl { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 500; }
.sp { flex: 1; }
.ic { width: 30px; height: 30px; border-radius: 15px; display: grid; place-items: center; background: var(--button-bg); flex: none; }
.body { padding: 12px 20px 16px; overflow-y: auto; min-height: 0; }
.sum { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; flex-wrap: wrap; padding: 14px 16px; border-radius: 16px; background: var(--cell-bg); }
.big { display: flex; align-items: baseline; gap: 10px; } .big b { font-size: 22px; font-weight: 600; letter-spacing: -0.01em; } .big span { color: var(--text-secondary); font-size: 15px; }
.sum small { color: var(--text-secondary); font-size: 13px; }
.warn { display: flex; align-items: center; gap: 6px; margin: 10px 2px 0; font-size: 13px; color: #c2570c; }
.sec { font-size: 12.5px; color: var(--text-tertiary); margin: 18px 2px 8px; display: flex; align-items: center; gap: 6px; }
.sec.warnc { color: #c2570c; }
.cnt { height: 20px; min-width: 20px; padding: 0 7px; border-radius: 10px; background: var(--button-bg); font-size: 11.5px; display: inline-grid; place-items: center; color: var(--text-secondary); }
.tops { display: flex; flex-direction: column; border: 1px solid var(--hairline); border-radius: 14px; overflow: hidden; }
.top { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 9px 12px; font-size: 14px; border-bottom: 1px solid var(--hairline); cursor: pointer; }
.top:last-child { border-bottom: 0; }
.top.off .tn { color: var(--text-tertiary); text-decoration: line-through; }
.tn { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.top small { color: var(--text-secondary); font-size: 12.5px; white-space: nowrap; }
.flag { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-radius: 12px; background: rgba(255 160 60 / .1); margin-bottom: 6px; }
.fp { flex: 1; min-width: 0; display: flex; flex-direction: column; } .fp b { font-weight: 500; font-size: 13.5px; overflow-wrap: anywhere; } .fp small { font-size: 12px; color: var(--text-secondary); }
.sure { flex: none; font-size: 12px; color: var(--color-error); }
.tb { flex: none; height: 30px; padding: 0 12px; border-radius: 15px; font-size: 12.5px; font-weight: 500; background: var(--button-bg); white-space: nowrap; }
.tb.on { background: rgba(255 160 60 / .25); color: #c2570c; }
.grp { border: 1px solid var(--hairline); border-radius: 12px; margin-bottom: 6px; overflow: hidden; }
.gh { width: 100%; display: flex; align-items: center; gap: 8px; padding: 9px 12px; font-size: 13.5px; text-align: left; }
.gn { flex: 1; min-width: 0; }
.tw { width: 14px; color: var(--text-tertiary); font-size: 12px; }
.samples { padding: 0 12px 8px 34px; display: flex; flex-direction: column; gap: 2px; }
.smp { display: flex; align-items: center; gap: 8px; min-height: 30px; font-size: 13px; }
.smp.back { padding: 0 12px; }
.sn { flex: 1; min-width: 0; overflow-wrap: anywhere; color: var(--text-secondary); font-family: "SF Mono", Menlo, monospace; font-size: 12px; }
.smp small, .more { font-size: 12px; color: var(--text-tertiary); }
.kits { display: flex; flex-direction: column; gap: 6px; }
.kit { display: flex; align-items: baseline; gap: 10px; padding: 9px 12px; border-radius: 12px; background: var(--cell-bg); font-size: 13.5px; flex-wrap: wrap; }
.kit b { font-weight: 600; } .kit span { color: var(--text-secondary); }
.fld { width: 100%; height: 42px; border-radius: 12px; border: 1px solid var(--hairline); background: var(--field-bg); padding: 0 12px; font-size: 14px; outline: 0; margin-bottom: 8px; color: var(--text-primary); }
.fine { font-size: 12.5px; color: var(--text-secondary); line-height: 1.6; margin: 6px 2px 0; word-break: keep-all; }
.none { font-size: 13px; color: var(--text-secondary); padding: 10px 12px; margin: 0; }
.note { font-size: 13.5px; margin: 10px 2px 0; color: var(--text-primary); }
.bad { display: flex; flex-direction: column; gap: 2px; font-size: 13px; color: var(--color-error); margin: 10px 2px 0; }
.bad small { font-family: "SF Mono", Menlo, monospace; font-size: 12px; overflow-wrap: anywhere; }
.ft { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-top: 1px solid var(--hairline); flex: none; }
.ft small { color: var(--text-secondary); font-size: 12.5px; }
.ft > button { height: 42px; padding: 0 18px; }
.dark-btn { background: var(--ink); color: var(--ink-inverse); }
.dark-btn:disabled { opacity: .45; }
:root[data-theme="dark"] .warn, :root[data-theme="dark"] .sec.warnc, :root[data-theme="dark"] .tb.on { color: #ffb870; }

@media (max-width: 760px) {
  .veil { padding: 0; place-items: end stretch; }
  .box { width: 100%; max-height: 92vh; border-radius: 22px 22px 0 0; }
  .body { padding: 10px 14px 14px; }
  .ft { flex-wrap: wrap; padding: 10px 14px calc(10px + env(safe-area-inset-bottom)); }
  .ft small { flex-basis: 100%; }
  .ft .sp { display: none; }
  .ft > button { flex: 1; }
}
</style>
