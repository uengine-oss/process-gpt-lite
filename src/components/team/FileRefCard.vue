<script setup>
// A file mention in a messenger message: a link to a shared folder's file, not a copy (server lib/fileRefs.js). What it shows is this
// person's own state of it (decorate): it opens (a document in the office panel, anything else in its folder at that file); a newer
// version in the folder is said, with 「최신 열기」; without access to the folder 「폴더 권한이 없어요 · 권한 요청」 (the folder's owners are
// told), then 「권한을 요청했어요」. A file of a project's variation says that only the folder's members see it until it is merged.
// It can be dragged on like any file (src/fileDrag.js): into another conversation, the AI chat, a folder.
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '../Icon.vue'
import { useTeam } from '../../stores/team.js'
import { kindOf, kindLabel } from '../../artifacts.js'
import { startDrag, refItem } from '../../fileDrag.js'

const props = defineProps({ m: Object, r: Object, i: Number })
const team = useTeam()
const router = useRouter()
const busy = ref('')
const note = ref('')
const st = computed(() => props.r.state?.card || 'open')
const can = computed(() => !['noaccess', 'requested'].includes(st.value))
async function open(latest = false) {
  if (!can.value || busy.value) return
  busy.value = latest ? 'latest' : 'open'; note.value = ''
  try {
    const r = await team.openRef(props.m, props.i, router, { latest })
    if (!r?.opened) note.value = r?.reason || '열지 못했어요.'
  } catch (e) { note.value = e.message || '열지 못했어요.' } finally { busy.value = '' }
}
async function request() {
  busy.value = 'req'; note.value = ''
  try { await team.requestRef(props.m, props.i) } catch (e) { note.value = e.message || '요청하지 못했어요.' } finally { busy.value = '' }
}
const drag = (e) => { if (can.value) startDrag(e, [refItem(props.m, props.r, props.i)]); else e.preventDefault() }
</script>

<template>
  <div class="fref" :class="[st, { busy: !!busy }]" data-test="file-ref" :data-file="r.name" :data-state="st" :draggable="can" @dragstart="drag">
    <button class="fmain press" :disabled="!can" :title="can ? `${r.folder} › ${r.path}` : '폴더 권한이 없어 열 수 없어요'" data-test="file-ref-open" @click="open(false)">
      <span class="fic" :class="kindOf(r.name)">{{ kindLabel[kindOf(r.name)] || 'FILE' }}</span>
      <span class="meta">
        <b>{{ r.name }}</b>
        <small><Icon name="folder" :size="12" /> {{ r.folder }}<template v-if="r.variation"> · 반영 전 변형</template></small>
      </span>
      <span class="tag">링크</span>
    </button>
    <p v-if="st === 'noaccess'" class="line warn" data-test="file-ref-noaccess">
      <Icon name="lock" :size="13" /><span>폴더 권한이 없어요</span>
      <button class="act press" :disabled="busy === 'req'" data-test="file-ref-request" @click="request">{{ busy === 'req' ? '요청하는 중…' : '권한 요청' }}</button>
    </p>
    <p v-else-if="st === 'requested'" class="line wait" data-test="file-ref-requested"><Icon name="clock" :size="13" /><span>권한을 요청했어요 · 폴더에 추가되면 열 수 있어요</span></p>
    <p v-else-if="st === 'changed'" class="line new" data-test="file-ref-changed">
      <Icon name="refresh" :size="13" /><span>멘션한 뒤에 바뀌었어요</span>
      <button class="act press" :disabled="!!busy" data-test="file-ref-latest" @click="open(true)">{{ busy === 'latest' ? '여는 중…' : '최신 열기' }}</button>
    </p>
    <p v-else-if="st === 'gone'" class="line warn"><Icon name="alert" :size="13" /><span>지금은 폴더에 없어요</span></p>
    <p v-if="r.variation && can" class="line var"><span>「{{ r.variation.title }}」 변형의 파일 · 반영 전이라 폴더 구성원만 볼 수 있어요</span></p>
    <p v-if="note" class="line warn" role="status">{{ note }}</p>
  </div>
</template>

<style scoped>
.fref { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; padding: 6px; border-radius: 14px; background: rgba(127, 127, 127, .08); border: 1px solid rgba(42, 120, 214, .28); max-width: 100%; min-width: 0; }
.fref[draggable="true"] { cursor: grab; }
.fref.busy { opacity: .75; }
.fmain { display: flex; align-items: center; gap: 9px; min-width: 0; padding: 2px; border-radius: 10px; text-align: left; color: var(--text-primary); }
.fmain:disabled { cursor: default; }
.fic { flex: none; width: 30px; height: 30px; border-radius: 8px; display: grid; place-items: center; font-size: 9.5px; font-weight: 700; color: #fff; background: #6b6b66; }
.fic.hwp { background: #1f6fd1; } .fic.doc { background: #2b579a; } .fic.xls { background: #217346; } .fic.ppt { background: #c43e1c; } .fic.pdf { background: #d93025; } .fic.md { background: #3d4451; } .fic.img { background: #7b3fbf; }
.meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.meta b { font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta small { display: inline-flex; align-items: center; gap: 3px; font-size: 11.5px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tag { flex: none; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 8px; color: #2a78d6; background: rgba(42, 120, 214, .12); }
.line { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 6px; margin: 0; padding: 3px 6px 2px; font-size: 12px; line-height: 1.4; color: var(--text-secondary); }
.line span { min-width: 0; }
.line.warn { color: #b42318; }
.line.new { color: #0f6e48; }
.line.var { color: #7a5af5; }
.act { margin-left: auto; height: 26px; padding: 0 11px; border-radius: 13px; font-size: 12px; font-weight: 600; color: #fff; background: #2a78d6; }
.line.new .act { background: #0f8a5f; }
.act:disabled { opacity: .6; }
:root:not([data-theme="light"]) .line.warn { color: #ffb4ab; }
:root:not([data-theme="light"]) .line.new { color: #7ee2b8; }
</style>
