<script setup>
// 자료 찾기 / 자료 띄우기 — finding material myself in a meeting, when speech did not work or to be sure:
// what I may see (this room's files, shared folders, work in progress, app data — the helper's own
// range, server/lib/meetings/materials.js search) by name or content, or a file from my computer.
// Inline in the 자료 tab, or as the sheet the bottom bar's 「자료 띄우기」 opens (like 화면 공유).
import { ref, onMounted, nextTick } from 'vue'
import { useMeetings } from '../../stores/meetings.js'
import { kindOf, kindLabel } from '../../artifacts.js'

const props = defineProps({ sheet: Boolean })
const emit = defineEmits(['close'])
const mt = useMeetings()
const q = ref('')
const found = ref(null)     // null: not searched yet · [] : nothing
const finding = ref(false)
const busy = ref('')
const err = ref('')
const box = ref(null)
const fileIn = ref(null)
const dragging = ref(false)
const KIND = { process: '진행 상황', panel: '앱 데이터', folder: '폴더 문서' }
const ext = (t) => String(t || '').split('.').pop().toUpperCase().slice(0, 4)
let seq = 0

async function find() {
  const n = ++seq
  finding.value = true; err.value = ''
  try { const r = await mt.searchMaterials(q.value.trim()); if (n === seq) found.value = r } catch (e) { err.value = e.message } finally { if (n === seq) finding.value = false }
}
const onKey = (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); find() } }
async function run(key, fn) {
  busy.value = key; err.value = ''
  try { await fn(); if (props.sheet) emit('close'); else { found.value = null; q.value = '' } } catch (e) { err.value = e.message || '처리하지 못했어요.' } finally { busy.value = '' }
}
const pick = (x, then) => run(`${then}${x.key}`, () => mt.pickMaterial(x.key, then))
async function upload(files) {
  const f = files?.[0]
  if (!f) return
  await run('upload', () => mt.uploadMaterial(f, 'present'))
  if (fileIn.value) fileIn.value.value = ''
}
const onDrop = (e) => { dragging.value = false; upload(e.dataTransfer?.files) }

// the sheet opens with what is nearest and the search box ready
onMounted(async () => { if (props.sheet) { find(); await nextTick(); box.value?.focus() } })
defineExpose({ find })
</script>

<template>
  <div class="mp" :class="{ sheet }" data-test="find" @dragover.prevent="dragging = true" @dragleave.self="dragging = false" @drop.prevent="onDrop">
    <div class="frow">
      <input ref="box" v-model="q" placeholder="자료 찾기 · 파일 이름이나 내용 (예: ERP PDF)" data-test="find-input" @keydown="onKey">
      <button class="main press" :disabled="finding" data-test="find-go" @click="find">{{ finding ? '찾는 중…' : '찾기' }}</button>
    </div>
    <button class="local press" :class="{ drag: dragging }" :disabled="busy === 'upload'" data-test="find-local" @click="fileIn?.click()">
      <span class="ic">⤴</span>
      <span>{{ busy === 'upload' ? '올리는 중…' : '내 컴퓨터에서 파일 고르기' }}<small>고른 파일을 바로 모두에게 띄워요 · 끌어다 놓아도 돼요</small></span>
    </button>
    <input ref="fileIn" type="file" hidden data-test="find-file" @change="upload($event.target.files)">
    <p v-if="err" class="ferr">{{ err }}</p>
    <template v-if="found">
      <p v-if="!found.length" class="fnone">내가 볼 수 있는 대화방 파일·공유 폴더·진행 상황에서 찾지 못했어요. 다른 검색어로 찾아보세요.</p>
      <div class="hits" :class="{ scroll: sheet }">
        <div v-for="x in found" :key="x.key" class="fhit" data-test="find-hit">
          <span class="fx" :class="x.kind === 'file' || x.folderFile ? kindOf(x.title) : x.kind">{{ x.kind === 'file' || x.folderFile ? kindLabel[kindOf(x.title)] || ext(x.title) : KIND[x.kind] || '자료' }}</span>
          <span class="ft"><b>{{ x.title }}</b><small>{{ x.where }}</small></span>
          <div class="fb">
            <button class="press" :disabled="!!busy" data-test="find-open" @click="pick(x, 'open')">{{ busy === `open${x.key}` ? '여는 중…' : '나만 보기' }}</button>
            <button class="main press" :disabled="!!busy" data-test="find-present" @click="pick(x, 'present')">{{ busy === `present${x.key}` ? '띄우는 중…' : '모두에게 띄우기' }}</button>
          </div>
        </div>
      </div>
      <button v-if="found.length && !sheet" class="fclose press" @click="found = null">닫기</button>
    </template>
  </div>
</template>

<style scoped>
.mp { display: flex; flex-direction: column; gap: 8px; margin: 2px 0 10px; }
.frow { display: flex; gap: 6px; }
.frow input { flex: 1; min-width: 0; height: 36px; border-radius: 18px; border: 1px solid #dfe1e5; padding: 0 14px; font-size: 14px; background: #fff; color: #1d1d1f; }
.frow button { height: 36px; padding: 0 14px; border-radius: 18px; font-size: 13.5px; background: #7a5af5; color: #fff; flex: none; }
.local { display: flex; align-items: center; gap: 10px; text-align: left; padding: 9px 12px; border-radius: 12px; border: 1.5px dashed #c9c2f2; background: #f8f6ff; color: #3b2c86; font-size: 13.5px; font-weight: 500; }
.local.drag { border-color: #7a5af5; background: #efeaff; }
.local .ic { width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; background: #7a5af5; color: #fff; font-size: 15px; flex: none; }
.local span:last-child { display: flex; flex-direction: column; }
.local small { font-weight: 400; font-size: 11.5px; color: #6b6f76; }
.ferr { margin: 0 4px; font-size: 12.5px; color: #c62828; }
.fnone { font-size: 12.5px; color: #8a8f98; margin: 4px; line-height: 1.45; }
.hits.scroll { max-height: min(52vh, 460px); overflow: auto; }
.fhit { display: grid; grid-template-columns: auto 1fr; grid-template-areas: 'x t' 'b b'; gap: 6px 10px; align-items: center; padding: 8px 4px; border-bottom: 1px solid #f0f1f3; }
.fhit .fx { grid-area: x; width: 34px; height: 34px; border-radius: 9px; display: grid; place-items: center; font-size: 9.5px; font-weight: 700; color: #fff; background: #6b6b66; }
.fhit .fx.hwp { background: #1f6fd1; } .fhit .fx.doc { background: #2b579a; } .fhit .fx.xls { background: #217346; } .fhit .fx.ppt { background: #c43e1c; } .fhit .fx.pdf { background: #d93025; } .fhit .fx.img { background: #7b3fbf; }
.fhit .fx.process, .fhit .fx.panel, .fhit .fx.folder { background: #7a5af5; font-size: 9px; }
.fhit .ft { grid-area: t; display: flex; flex-direction: column; min-width: 0; font-size: 13.5px; color: #1d1d1f; }
.fhit .ft b { font-weight: 500; word-break: break-all; }
.fhit .ft small { font-size: 11.5px; color: #8a8f98; }
.fhit .fb { grid-area: b; display: flex; gap: 6px; padding-left: 44px; }
.fhit .fb button { height: 28px; padding: 0 12px; border-radius: 14px; font-size: 12.5px; background: #e9ebef; color: #1d1d1f; }
.fhit .fb button.main { background: #7a5af5; color: #fff; }
.fclose { align-self: flex-start; font-size: 12.5px; color: #6b6f76; }
</style>
