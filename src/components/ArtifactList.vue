<script setup>
// The files the view on screen made, as a list in the right column (2026-11-24 사용자: 「우측 영역이 많이 남아돌기에 산출물 목록들이
// 쭉 보이고 클릭하면 이음오피스로 보일 수 있을 것임」 — spec openspec/specs/chat-thread-list 「산출물」): the whole chat's files (each with
// the conversation it came from), one conversation's, a project room's — newest first (app.artifacts, src/artifactScope.js). A row
// opens the file where its chat card would (artifacts.js openArtifact — a document in the IeumOffice panel); 공유 is beside it.
// Folded, a rail of the files' icons. MainView shows it only where the page has room beside the chat and no document is open;
// elsewhere the same files are the Dock-style pile (ArtifactStack.vue).
import { ref, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import Icon from './Icon.vue'
import ShareButton from './team/ShareButton.vue'
import { useApp } from '../stores/app.js'
import { kindOf, kindLabel, openArtifact } from '../artifacts.js'
import { CAPTION, filterArtifacts } from '../artifactScope.js'
import { whenText } from '../threadList.js'
// a row is dragged like any file of the app (src/fileDrag.js): a messenger conversation (a link or a share), a folder, the composer
import { startDrag, cardItem } from '../fileDrag.js'

const props = defineProps({ rail: { type: Boolean, default: false } })
const app = useApp()
const router = useRouter()
const query = ref('')
// a search box once there are more than a screenful's few
const SEARCH_FROM = 7
const items = computed(() => app.artifacts.items)
const scope = computed(() => app.artifacts.scope)
const shown = computed(() => (props.rail ? items.value : filterArtifacts(items.value, query.value)))
const caption = computed(() => CAPTION[scope.value] || '산출물')
const label = (m) => kindLabel[kindOf(m.content.name)] || 'FILE'
watch(scope, () => { query.value = '' })
const open = (m) => openArtifact(app, router, m)
</script>

<template>
  <aside class="alist" :class="{ rail }" data-testid="artifact-list" :data-scope="scope" :aria-label="`${caption} ${items.length}개`">
    <div class="head">
      <template v-if="!rail"><span class="title">산출물</span><small class="n" data-testid="artifact-count">{{ items.length }}</small></template>
      <button class="fold press" :aria-label="rail ? '산출물 목록 펼치기' : '산출물 목록 접기'" :title="rail ? '산출물 목록 펼치기' : '산출물 목록 접기'"
        :aria-expanded="!rail" data-testid="artifact-fold" @click="app.foldArtifacts(!rail)">
        <Icon :name="rail ? 'back' : 'chevron'" :size="16" />
        <b v-if="rail" class="rn">{{ items.length }}</b>
      </button>
    </div>
    <p v-if="!rail" class="cap">{{ caption }} · 누르면 그 자리에서 열려요</p>
    <label v-if="!rail && items.length >= SEARCH_FROM" class="find">
      <Icon name="search" :size="15" />
      <input v-model="query" type="search" placeholder="산출물 찾기" aria-label="산출물 찾기" data-testid="artifact-search" @keydown.esc="query = ''" />
    </label>
    <div class="rows scroll">
      <div v-for="x in shown" :key="x.msg.id" class="roww" draggable="true" data-testid="artifact-drag" :data-file="x.msg.content.name" @dragstart="startDrag($event, [cardItem(x.msg)])">
        <button class="row press" :title="x.msg.content.name" data-testid="artifact-row" :data-file="x.msg.content.name" @click="open(x.msg)">
          <span class="tile" :class="kindOf(x.msg.content.name)">{{ label(x.msg) }}</span>
          <span v-if="!rail" class="meta">
            <b>{{ x.msg.content.name }}<em v-if="x.msg.content.edited">편집본</em></b>
            <small>{{ whenText(x.msg.created_at) }}<template v-if="scope === 'chat' && x.convTitle"> · <span class="conv">{{ x.convTitle }}</span></template></small>
          </span>
        </button>
        <ShareButton v-if="!rail" :msg="x.msg" compact class="share" />
      </div>
      <p v-if="!rail && !shown.length" class="none" data-testid="artifact-none">「{{ query }}」와 맞는 산출물이 없어요.</p>
    </div>
  </aside>
</template>

<style scoped>
.alist { position: absolute; z-index: 5; top: 84px; right: 16px; max-height: calc(100% - 84px - 28px); width: 284px; display: flex; flex-direction: column; padding: 14px 10px 10px;
  border-radius: 24px; background: var(--thin-bg); -webkit-backdrop-filter: blur(40px); backdrop-filter: blur(40px); box-shadow: 0 8px 30px rgba(0, 0, 0, .10);
  transition: width .35s var(--spring); }
.alist.rail { width: 56px; padding: 8px 4px; right: 8px; align-items: center; }
.head { display: flex; align-items: center; gap: 8px; padding: 0 6px; }
.title { font-size: 17px; font-weight: 600; letter-spacing: -0.01em; color: var(--text-primary); }
.n { font-size: 13px; color: var(--text-tertiary); }
.fold { margin-left: auto; height: 30px; min-width: 30px; padding: 0 6px; border-radius: 15px; display: inline-flex; align-items: center; justify-content: center; gap: 2px;
  color: var(--text-secondary); background: var(--button-bg); }
.fold:hover { color: var(--text-primary); }
.rail .head { padding: 0; }
.rail .fold { margin: 0; flex-direction: column; height: auto; padding: 6px 4px; gap: 2px; border-radius: 14px; }
.rn { font-size: 11.5px; font-weight: 600; color: var(--text-primary); }
.cap { margin: 4px 6px 8px; font-size: 12px; line-height: 1.4; color: var(--text-tertiary); word-break: keep-all; }
.find { display: flex; align-items: center; gap: 6px; height: 34px; margin: 0 2px 8px; padding: 0 12px; border-radius: 17px; background: var(--field-bg); color: var(--text-tertiary); flex: none; }
.find input { flex: 1; min-width: 0; height: 100%; border: 0; outline: 0; background: transparent; font: inherit; font-size: 13.5px; color: var(--text-primary); }
.find input::placeholder { color: var(--text-tertiary); }
.rows { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 2px; overflow-x: hidden; overscroll-behavior: contain; }
.rail .rows { margin-top: 8px; align-items: center; gap: 6px; }
.roww { position: relative; display: flex; align-items: center; min-width: 0; border-radius: 14px; }
.roww:hover { background: var(--field-bg); }
.roww[draggable="true"] { cursor: grab; }
.row { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; padding: 7px 8px; text-align: left; border-radius: 14px; color: var(--text-primary); }
.rail .row { padding: 3px; flex: none; }
.rail .roww:hover { background: none; }
.meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.meta b { font-size: 13.5px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.meta b em { font-style: normal; margin-left: 6px; font-size: 11px; color: var(--color-info, #2a78d6); }
.meta small { font-size: 11.5px; color: var(--text-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.meta .conv { color: var(--text-secondary); }
/* 공유: on hover (always on a touch screen) */
.share { flex: none; margin-right: 6px; opacity: 0; transition: opacity .15s; }
.roww:hover .share, .share:focus-visible { opacity: 1; }
@media (hover: none) { .share { opacity: 1; } }
.none { margin: 10px 8px; font-size: 13px; color: var(--text-secondary); }
.tile { flex: none; width: 36px; height: 36px; border-radius: 10px; display: grid; place-items: center; font-size: 10px; font-weight: 700; color: #fff; background: #6b6b66; box-shadow: 0 2px 8px rgba(0, 0, 0, .14); }
.rail .tile { width: 40px; height: 40px; border-radius: 11px; }
/* the same colours as the pile's and the chat card's (ArtifactStack.vue) */
.tile.hwp { background: #1f6fd1; } .tile.doc { background: #2b579a; } .tile.xls { background: #217346; } .tile.ppt { background: #c43e1c; } .tile.pdf { background: #d93025; } .tile.md { background: #3d4451; } .tile.txt { background: #5f6670; } .tile.web { background: #e44d26; } .tile.map { background: #b8860b; } .tile.cad { background: #0b6f88; } .tile.vec { background: #c2570c; } .tile.img { background: #7b3fbf; } .tile.snd { background: #0f8a5f; } .tile.vid { background: #b0223c; }
</style>
