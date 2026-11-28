<script setup>
// One file of a turn's grouped card (FileGroupCard.vue — spec openspec/specs/chat-artifacts 「한 턴의 많은 파일은 카드 하나」): a compact row that
// does what its own file card would (Message.vue): pressed, it opens the file the same way (artifacts.js openArtifact — the office panel, the
// viewer, the workroom); held on a phone, right-clicked or its ⋯ on a computer, the card's menu (FileCardMenu.vue: 열기 · 팀원에게 공유 · 폴더에
// 정리), with the dot while a folder suggestion waits and the line once it is filed; dragged like any file of the app.
// hint: the folder that tells it apart from a same-named file of the turn ('' — at the top), or null when its name is alone.
import { computed, ref, markRaw } from 'vue'
import { useRouter } from 'vue-router'
import Icon from './Icon.vue'
import FileCardMenu from './FileCardMenu.vue'
import { useFiling } from './folders/useFiling.js'
import { hold } from './holdMenu.js'
import { closeHint, touchOnly } from '../holdHint.js'
import { useApp } from '../stores/app.js'
import { officeEditorFor, craftMissing } from '../officeEditor.js'
import { kindLabel, cardKind, openArtifact, openHint } from '../artifacts.js'
import { startDrag, cardItem } from '../fileDrag.js'

const props = defineProps({ msg: Object, hint: { type: String, default: null } })
const vHold = hold
const app = useApp()
const router = useRouter()
const c = computed(() => props.msg.content || {})
const fk = computed(() => cardKind(c.value))
// what pressing it does (the card's words — Message.vue)
const does = computed(() => {
  const ed = officeEditorFor(c.value.name)
  return ed && c.value.url && !craftMissing(ed) ? (c.value.edited ? '편집본 · 눌러서 이어 편집' : '눌러서 바로 편집') : openHint(c.value)
})
const open = () => openArtifact(app, router, props.msg)
const rowEl = ref(null)
const canFile = computed(() => !!(c.value.url || c.value.path) && !c.value.folder)
const filing = useFiling(() => (canFile.value ? { messageId: props.msg.id } : null), () => c.value.filing, () => rowEl.value)
const menu = ref(null)
const focusBack = () => { const a = document.activeElement; return a && a !== document.body ? a : null }
const openMenu = (from = null) => { closeHint(); menu.value = { from: from ? markRaw(from) : null } }
const onHold = (el, at) => openMenu(at?.touch ? null : focusBack())
const draggable = !touchOnly()
const drag = (e) => startDrag(e, [cardItem(props.msg)])
</script>

<template>
  <div class="fgr">
    <div ref="rowEl" class="frow" :draggable="draggable" data-test="file-card" data-in-group :data-file="c.name" :data-filing="filing?.pending ? 'suggested' : filing?.filed ? 'filed' : null" @dragstart="drag">
      <!-- pressed: opens the file; held · right-clicked: its menu (data-hold-tap — components/holdMenu.js) -->
      <button v-hold="onHold" data-hold-tap class="file press" :title="`${c.name} · ${does}`" @click="open">
        <span class="fic" :class="fk">{{ kindLabel[fk] || 'FILE' }}</span>
        <span class="fname"><b>{{ c.name }}</b><small v-if="hint != null" class="dir" data-test="file-dir">· <span v-if="hint" data-no-i18n>{{ hint }}</span><span v-else>맨 위</span></small><em v-if="c.edited">편집본</em></span>
        <span v-if="filing?.pending" class="fdot" data-test="filing-dot" role="img" aria-label="폴더 정리 제안이 있어요" title="폴더 정리 제안이 있어요" />
      </button>
      <button class="mbtn press" data-test="file-more" aria-haspopup="dialog" :aria-label="`${c.name} 메뉴 열기`" title="파일 메뉴" @click="openMenu($event.currentTarget)"><Icon name="more" :size="15" /></button>
    </div>
    <p v-if="filing?.filed" class="filed" data-test="filing-line"><Icon name="check" :size="11" />
      <span data-test="filing-done">{{ filing.filed.already ? `이미 ‘${filing.filed.name}’에 있어요` : `‘${filing.filed.name}’에 정리했어요` }}</span>
      <button class="alink press" data-test="filing-open" @click="filing.openFolder()">열기</button></p>
    <FileCardMenu v-if="menu" :msg="msg" :filing="canFile ? filing : null" :hint="does" :from="menu.from" @close="menu = null" @open="open" />
  </div>
</template>

<style scoped>
.fgr { display: flex; flex-direction: column; min-width: 0; }
.frow { position: relative; display: flex; align-items: center; gap: 4px; min-width: 0; border-radius: 12px; }
.frow[draggable="true"] { cursor: grab; }
.frow:hover { background: rgba(245, 245, 247, .07); }
.file { position: relative; flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 4px 8px; border-radius: 12px; text-align: left; color: #f5f5f7; }
.fic { flex: none; width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; font-size: 8.5px; font-weight: 700; color: #fff; background: #6b6b66; }
.fic.hwp { background: #1f6fd1; } .fic.doc { background: #2b579a; } .fic.xls { background: #217346; } .fic.ppt { background: #c43e1c; } .fic.pdf { background: #d93025; } .fic.md { background: #3d4451; } .fic.txt { background: #5f6670; } .fic.web { background: #e44d26; } .fic.map { background: #b8860b; } .fic.cad { background: #0b6f88; } .fic.vec { background: #c2570c; } .fic.img { background: #7b3fbf; } .fic.snd { background: #0f8a5f; } .fic.vid { background: #b0223c; }
.fic.md, .fic.txt { box-shadow: inset 0 0 0 1px rgba(245, 245, 247, .18); }
.fname { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 6px; overflow: hidden; white-space: nowrap; }
.fname b { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-size: 14px; font-weight: 500; }
.fname .dir { flex: none; max-width: 48%; overflow: hidden; text-overflow: ellipsis; font-size: 12px; color: rgba(245, 245, 247, .62); }
.fname em { flex: none; font-style: normal; font-size: 11px; color: #9fd0ff; }
.fdot { position: absolute; top: 5px; left: 31px; width: 8px; height: 8px; border-radius: 50%; background: #3b8cf0; box-shadow: 0 0 0 2px #1d1d1f; }
/* ⋯ — the row's menu on a computer: shown by the row under the pointer, and to the keyboard (as a card's) */
.mbtn { flex: none; width: 28px; height: 28px; margin-right: 4px; border-radius: 14px; display: grid; place-items: center; color: rgba(245, 245, 247, .75); background: rgba(245, 245, 247, .1); opacity: 0; transition: opacity .12s; }
.frow:hover .mbtn, .mbtn:focus-visible { opacity: 1; }
.mbtn:hover { color: #fff; }
/* a phone: a long press — the ⋯ takes no room, but stays for a screen reader and a keyboard */
@media (hover: none) {
  .mbtn:not(:focus-visible) { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; pointer-events: none; }
}
.filed { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin: 0 0 4px 46px; font-size: 11.5px; color: rgba(245, 245, 247, .7); overflow-wrap: anywhere; }
.filed > :deep(svg) { color: #8fe0a8; flex: none; }
.alink { margin-left: 2px; font-size: 11.5px; font-weight: 600; color: #f5f5f7; text-decoration: underline; text-underline-offset: 2px; }
@media (pointer: coarse) { .file { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; } }
</style>
