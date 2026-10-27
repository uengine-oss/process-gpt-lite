<script setup>
// What a meeting material shows (자료 panel card and the stage): a file's tile, a process instance's
// steps with step-output chips, a panel app's rows, a folder variation's changes, an agent result.
import { useRouter } from 'vue-router'
import { kindOf, kindLabel } from '../../artifacts.js'

const props = defineProps({ m: Object, big: Boolean })
const emit = defineEmits(['open-share'])
const router = useRouter()
const STATE = { done: '완료', active: '진행 중', pending: '대기', skipped: '건너뜀', cancelled: '취소' }
const go = (path) => router.push(path)
</script>

<template>
  <div class="mb" :class="{ big }">
    <div v-if="m.kind === 'file'" class="file">
      <span class="fic" :class="kindOf(m.title)">{{ kindLabel[kindOf(m.title)] || 'FILE' }}</span>
      <span class="fn">{{ m.title }}<small v-if="m.file && !m.file.own">공유받은 파일 · 열면 내 사본</small><small v-else-if="m.file?.own">내 파일</small></span>
    </div>

    <div v-else-if="m.kind === 'process' && m.process" class="proc">
      <p class="pn">{{ m.process.name }} <i :class="{ run: m.process.status === 'RUNNING' }">{{ m.process.status === 'COMPLETED' ? '완료' : '진행 중' }}</i></p>
      <ol class="steps">
        <li v-for="(s, i) in m.process.steps" :key="i" :class="s.state"><b>{{ s.name }}</b><small>{{ STATE[s.state] || s.state }}{{ s.assignee && s.state === 'active' ? ` · ${s.assignee}` : '' }}</small></li>
      </ol>
      <div v-if="m.process.outputs.length" class="chips">
        <span class="cap">단계 산출물</span>
        <button v-for="(o, i) in m.process.outputs" :key="i" class="chip press" :title="o.text || o.name" @click="go(`/projects/p/${m.process.instId}`)">
          {{ o.label || o.name || o.field }}<small> · {{ o.activity }}</small>
        </button>
      </div>
    </div>
    <p v-else-if="m.kind === 'process'" class="none">진행 상황을 불러오지 못했어요.</p>

    <div v-else-if="m.kind === 'panel' && m.panel" class="panel">
      <table>
        <thead><tr><th v-for="f in m.panel.fields" :key="f.key">{{ f.label }}</th></tr></thead>
        <tbody><tr v-for="(r, i) in m.panel.rows" :key="i"><td v-for="f in m.panel.fields" :key="f.key">{{ r[f.key] }}</td></tr></tbody>
      </table>
      <small v-if="m.panel.total > m.panel.rows.length" class="more">외 {{ m.panel.total - m.panel.rows.length }}건</small>
    </div>

    <div v-else-if="m.kind === 'folder' && m.folder" class="fold">
      <p class="pn">{{ m.folder.name }} <i>{{ m.folder.statusLabel }}</i></p>
      <ul><li v-for="(c, i) in m.folder.changes" :key="i"><code>{{ c.status }}</code> {{ c.path }}</li></ul>
      <button class="chip press" @click="go(`/folders/${m.folder.slug}/v/${m.folder.variationId}`)">폴더에서 보기</button>
    </div>

    <div v-else-if="m.kind === 'result' && m.result" class="res">
      <p class="txt">{{ m.result.text }}</p>
      <div class="chips">
        <button v-for="f in m.result.files" :key="f.name" class="art press" :disabled="!f.shareId" @click="emit('open-share', f)">
          <span class="fic" :class="kindOf(f.name)">{{ kindLabel[kindOf(f.name)] || 'FILE' }}</span>{{ f.name }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mb { font-size: 13.5px; color: var(--text-primary); }
.file { display: flex; align-items: center; gap: 10px; }
.fn { display: flex; flex-direction: column; font-weight: 500; word-break: break-all; }
.fn small { font-weight: 400; font-size: 11.5px; color: var(--text-tertiary); }
.fic { flex: none; width: 34px; height: 34px; border-radius: 9px; display: grid; place-items: center; font-size: 10px; font-weight: 700; color: #fff; background: #6b6b66; }
.fic.hwp { background: #1f6fd1; } .fic.doc { background: #2b579a; } .fic.xls { background: #217346; } .fic.ppt { background: #c43e1c; } .fic.pdf { background: #d93025; } .fic.cad { background: #0b6f88; } .fic.vec { background: #c2570c; } .fic.img { background: #7b3fbf; } .fic.snd { background: #0f8a5f; } .fic.vid { background: #b0223c; }
.pn { margin: 0 0 8px; font-weight: 600; }
.pn i { font-style: normal; font-weight: 500; font-size: 11.5px; padding: 2px 8px; border-radius: 8px; background: rgba(127, 127, 127, .16); margin-left: 4px; }
.pn i.run { background: #e7f3ff; color: #1662b8; }
.steps { list-style: none; margin: 0; padding: 0; display: flex; gap: 6px; flex-wrap: wrap; }
.steps li { display: flex; flex-direction: column; padding: 6px 10px; border-radius: 10px; background: rgba(127, 127, 127, .1); border: 1px solid transparent; min-width: 90px; }
.steps li b { font-weight: 500; font-size: 12.5px; }
.steps li small { font-size: 11px; color: var(--text-tertiary); }
.steps li.done { background: rgba(60, 207, 145, .14); }
.steps li.active { border-color: #2a78d6; background: rgba(42, 120, 214, .1); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; align-items: center; }
.cap { font-size: 11.5px; color: var(--text-tertiary); margin-right: 2px; }
.chip { height: 28px; padding: 0 10px; border-radius: 14px; font-size: 12.5px; background: rgba(122, 90, 245, .12); color: #5a3fd0; }
.chip small { color: var(--text-tertiary); }
table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid rgba(127, 127, 127, .18); white-space: nowrap; }
th { font-weight: 600; color: var(--text-secondary); }
.more, .none { font-size: 12px; color: var(--text-tertiary); }
.fold ul { margin: 0; padding-left: 16px; font-size: 12.5px; }
.res .txt { margin: 0; white-space: pre-wrap; line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 5; -webkit-box-orient: vertical; overflow: hidden; }
.art { display: inline-flex; align-items: center; gap: 8px; height: 36px; padding: 0 12px 0 4px; border-radius: 12px; background: #1d1d1f; color: #f5f5f7; font-size: 13px; }
.art .fic { width: 28px; height: 28px; }
.big { font-size: 15px; }
.big .steps li { min-width: 140px; padding: 10px 14px; }
.big .steps li b { font-size: 14.5px; }
.big table { font-size: 15px; }
.big th, .big td { padding: 9px 12px; }
.big .chip { height: 32px; font-size: 14px; }
</style>
