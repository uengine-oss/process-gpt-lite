<script setup>
// One turn's many files as one card (2026-11-28 phone recording: a turn wrote 21 files and the chat stacked 21 big file cards — 「이게 파일이
// 너무 많아져 버리지」; spec openspec/specs/chat-artifacts 「한 턴의 많은 파일은 카드 하나」). ChatColumn draws it in place of the run's files
// (src/fileGroups.js fileRuns: more than three documents of one turn — the stored messages are not changed, so older chats read the same).
// The head says 「파일 21개 · 폴더 3개」 and the work folder they are in (「커리큘럼 · v2」); under it the files at the top, then one line per
// folder, folded — pressed, its files open as compact rows (FileGroupRow.vue), each opening and with its menu as its own card would.
import { computed, reactive, ref } from 'vue'
import Icon from './Icon.vue'
import FileGroupRow from './FileGroupRow.vue'
import { fileTree, shownRows } from '../fileGroups.js'
import { startDrag, cardItem, MAX } from '../fileDrag.js'
import { touchOnly } from '../holdHint.js'
import { kindLabel, cardKind } from '../artifacts.js'

const props = defineProps({ msgs: { type: Array, default: () => [] } })
const tree = computed(() => fileTree(props.msgs))
const top = computed(() => tree.value.sections.find((s) => !s.dir) || null)
const folders = computed(() => tree.value.sections.filter((s) => s.dir))
// the folders pressed open, and the sections shown in full (beyond their first rows)
const opened = reactive(new Set())
const full = reactive(new Set())
const allOpen = computed(() => folders.value.length > 0 && folders.value.every((s) => opened.has(s.dir)))
const toggle = (dir) => (opened.has(dir) ? opened.delete(dir) : opened.add(dir))
function toggleAll() {
  const shut = allOpen.value
  for (const s of folders.value) (shut ? opened.delete(s.dir) : opened.add(s.dir))
}
const rowsOf = (s) => s.rows.slice(0, shownRows(s.rows.length, full.has(s.dir)))
const head = computed(() => (tree.value.folders ? `파일 ${tree.value.files}개 · 폴더 ${tree.value.folders}개` : `파일 ${tree.value.files}개`))
// the folder all of them are in: its work folder and version (server lib/workFolder.js), else its path
const where = computed(() => (tree.value.work ? `${tree.value.work.folder} · v${tree.value.work.version}` : tree.value.common ? `${tree.value.common}/` : ''))
// a folded folder's first names (and how many more)
const peek = (s) => s.rows.slice(0, 2).map((r) => r.name).join(' · ')
// the head's little pile: the first three files' badges
const pile = computed(() => props.msgs.slice(0, 3).map((m) => cardKind(m.content)).reverse())
const time = computed(() => new Date(props.msgs[0]?.created_at).toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }))
// (dragging the head takes the files along — as many as a drag carries — on a computer)
const draggable = !touchOnly()
const dragAll = (e) => startDrag(e, props.msgs.slice(0, MAX).map(cardItem))
const el = ref(null)
</script>

<template>
  <div ref="el" class="row r-agent k-filegroup" :data-id="msgs[0]?.id">
    <span class="ts">{{ time }}</span>
    <section class="fgroup" data-test="file-group" :data-count="tree.files" :data-folders="tree.folders" :aria-label="head">
      <div class="fgh" :draggable="draggable" data-test="file-group-head" @dragstart="dragAll">
        <span class="pile" aria-hidden="true">
          <span v-for="(k, i) in pile" :key="i" class="fic layer" :class="k" :style="{ transform: `translate(${(pile.length - 1 - i) * -3}px, ${(pile.length - 1 - i) * -3}px) rotate(${(pile.length - 1 - i) * -5}deg)`, zIndex: i }">{{ kindLabel[k] || 'FILE' }}</span>
        </span>
        <span class="ht"><b data-test="file-group-count">{{ head }}</b><small v-if="where" data-test="file-group-where" data-no-i18n>{{ where }}</small></span>
        <button v-if="folders.length > 1" class="all press" data-test="file-group-toggle" :aria-expanded="allOpen" @click="toggleAll">{{ allOpen ? '모두 접기' : '모두 펼치기' }}</button>
      </div>
      <div class="tree">
        <template v-if="top">
          <FileGroupRow v-for="r in rowsOf(top)" :key="r.msg.id" :msg="r.msg" :hint="r.hint" />
          <button v-if="rowsOf(top).length < top.rows.length" class="more press" data-test="file-group-more" @click="full.add(top.dir)">{{ top.rows.length - rowsOf(top).length }}개 더 보기</button>
        </template>
        <div v-for="s in folders" :key="s.dir" class="fsec" :class="{ open: opened.has(s.dir) }">
          <button class="fold press" data-test="file-group-folder" :data-dir="s.dir" :aria-expanded="opened.has(s.dir)" @click="toggle(s.dir)">
            <Icon name="chevron" :size="13" class="chev" />
            <Icon name="folder" :size="16" class="fi" />
            <span class="fn"><b data-no-i18n>{{ s.dir }}/</b><small v-if="!opened.has(s.dir)" class="peek"><span data-no-i18n>{{ peek(s) }}</span><span v-if="s.rows.length > 2"> 외 {{ s.rows.length - 2 }}개</span></small></span>
            <small class="n">{{ s.rows.length }}</small>
          </button>
          <div v-if="opened.has(s.dir)" class="rows" data-test="file-group-rows" :data-dir="s.dir">
            <FileGroupRow v-for="r in rowsOf(s)" :key="r.msg.id" :msg="r.msg" :hint="r.hint" />
            <button v-if="rowsOf(s).length < s.rows.length" class="more press" data-test="file-group-more" @click="full.add(s.dir)">{{ s.rows.length - rowsOf(s).length }}개 더 보기</button>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.row { position: relative; display: flex; flex-direction: column; align-items: flex-start; min-width: 0; max-width: 100%; animation: blur-in .5s var(--spring) both; }
.ts { position: absolute; right: calc(100% + 24px); top: 28px; white-space: nowrap; font-size: 14px; color: var(--text-secondary); opacity: 0; transition: opacity .2s; pointer-events: none; text-align: right; }
.row:hover .ts { opacity: 1; }
/* the file card's look (Message.vue .file): dark in both themes */
.fgroup { width: 424px; max-width: 100%; box-sizing: border-box; border-radius: 22px; padding: 8px 8px 8px; background: #1d1d1f; color: #f5f5f7; display: flex; flex-direction: column; gap: 2px; }
.fgh { display: flex; align-items: center; gap: 12px; min-height: 48px; padding: 2px 6px 6px 10px; }
.fgh[draggable="true"] { cursor: grab; }
.pile { position: relative; flex: none; width: 40px; height: 40px; }
.fic { width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; font-size: 8.5px; font-weight: 700; color: #fff; background: #6b6b66; }
.fic.layer { position: absolute; left: 8px; top: 8px; box-shadow: 0 1px 4px rgba(0, 0, 0, .35); }
.fic.hwp { background: #1f6fd1; } .fic.doc { background: #2b579a; } .fic.xls { background: #217346; } .fic.ppt { background: #c43e1c; } .fic.pdf { background: #d93025; } .fic.md { background: #3d4451; } .fic.txt { background: #5f6670; } .fic.web { background: #e44d26; } .fic.map { background: #b8860b; } .fic.cad { background: #0b6f88; } .fic.vec { background: #c2570c; } .fic.img { background: #7b3fbf; } .fic.snd { background: #0f8a5f; } .fic.vid { background: #b0223c; }
.ht { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.ht b { font-size: 16px; font-weight: 500; }
.ht small { font-size: 12.5px; color: rgba(245, 245, 247, .62); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.all { flex: none; height: 28px; padding: 0 11px; border-radius: 14px; font-size: 12.5px; color: #f5f5f7; background: rgba(245, 245, 247, .12); }
.all:hover { background: rgba(245, 245, 247, .2); }
.tree { display: flex; flex-direction: column; gap: 1px; padding: 4px 0 0; border-top: 1px solid rgba(245, 245, 247, .1); }
.fold { width: 100%; display: flex; align-items: center; gap: 8px; min-height: 40px; padding: 4px 10px 4px 8px; border-radius: 12px; text-align: left; color: #f5f5f7; }
.fold:hover { background: rgba(245, 245, 247, .07); }
.chev { flex: none; color: rgba(245, 245, 247, .55); transition: rotate .2s; }
.fsec.open .chev { rotate: 90deg; }
.fi { flex: none; color: #8ab4f8; }
.fn { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; overflow: hidden; white-space: nowrap; }
.fn b { flex: none; max-width: 60%; overflow: hidden; text-overflow: ellipsis; font-size: 14px; font-weight: 600; }
.fn .peek { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-size: 12px; color: rgba(245, 245, 247, .5); }
.n { flex: none; min-width: 22px; height: 20px; padding: 0 6px; border-radius: 10px; display: grid; place-items: center; font-size: 11.5px; color: rgba(245, 245, 247, .8); background: rgba(245, 245, 247, .1); }
.rows { display: flex; flex-direction: column; gap: 1px; margin: 0 0 4px 14px; padding-left: 8px; border-left: 1px solid rgba(245, 245, 247, .12); }
.more { align-self: flex-start; height: 30px; margin: 2px 0 2px 8px; padding: 0 12px; border-radius: 15px; font-size: 12.5px; color: rgba(245, 245, 247, .85); background: rgba(245, 245, 247, .08); }
.more:hover { background: rgba(245, 245, 247, .16); }
</style>
