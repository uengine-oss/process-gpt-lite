<script setup>
// 에이전트 자산 (champion folders, spec openspec/specs/champion-folders 「폴더 안의 에이전트 자산을 찾아 보여 준다」): the skills,
// commands, instructions, rules and specs the agent platforms keep in this folder's main (server lib/folders/kit.js — found by where a
// file is), grouped by platform, each opened like any file of the folder; settings that run something on the computer of whoever works
// here (hooks, MCP servers, allow lists) are marked. Above them, the computers that upload this folder (no path — their name for it).
import { ref, computed } from 'vue'
import FIcon from './FIcon.vue'
import { ago } from '../../foldersApi.js'
import { PLATFORM, PLATFORM_HINT, KIND, stateText, stopped, whyText, fmtBytes } from '../../desktopFolders.js'

const props = defineProps({ kit: { type: Array, default: () => [] }, sources: { type: Array, default: () => [] }, owner: Boolean, busy: String })
const emit = defineEmits(['open', 'source'])
const closed = ref(new Set())
const groups = computed(() => {
  const m = new Map()
  for (const k of props.kit) { if (!m.has(k.platform)) m.set(k.platform, []); m.get(k.platform).push(k) }
  return [...m.entries()].map(([platform, items]) => ({ platform, label: PLATFORM[platform] || platform, hint: PLATFORM_HINT[platform] || '', items,
    line: Object.keys(KIND).map((t) => [t, items.filter((i) => i.type === t).length]).filter(([, n]) => n).map(([t, n]) => `${KIND[t]} ${n}`).join(' · ') }))
})
const runs = computed(() => props.kit.filter((k) => k.runs))
function toggle(p) { const s = new Set(closed.value); s.has(p) ? s.delete(p) : s.add(p); closed.value = s }
const may = (s) => s.mine || props.owner
</script>

<template>
  <div class="kt scroll" data-test="kit-tab">
    <template v-if="sources.length">
      <div class="sec">이 폴더를 올리는 PC</div>
      <div v-for="s in sources" :key="s.id" class="src" data-test="kit-source">
        <span class="pic"><FIcon name="pc" :size="18" /></span>
        <span class="sm">
          <b>{{ s.label }}<span class="st" :class="{ stop: stopped(s.state) || s.why }">{{ s.why ? `멈춤 · ${whyText(s.why)}` : stateText(s.state) }}</span></b>
          <small class="meta"><span data-no-i18n>{{ s.userName || '—' }}</span><span v-if="s.deviceName" data-no-i18n>{{ s.deviceName }}</span><span>{{ s.lastPushedAt ? `${ago(s.lastPushedAt)} 올림` : '아직 올리지 않음' }}</span><span v-if="s.report?.files">파일 {{ s.report.files.toLocaleString() }}개 · {{ fmtBytes(s.report.bytes) }}</span></small>
        </span>
        <span v-if="may(s)" class="acts">
          <button class="tb press" :disabled="!!busy" @click="emit('source', { id: s.id, state: s.state === 'paused' ? 'active' : 'paused' })">{{ s.state === 'paused' ? '다시 켜기' : '멈추기' }}</button>
          <button class="tb press" :disabled="!!busy" @click="emit('source', { id: s.id, remove: true })">연결 빼기</button>
        </span>
      </div>
    </template>

    <div class="sec">에이전트 자산 <span class="cnt">{{ kit.length }}</span></div>
    <p v-if="runs.length" class="runs" data-test="kit-runs"><FIcon name="terminal" :size="15" /> 이 폴더에는 실행되는 설정이 있어요: {{ runs.map((r) => r.path).join(' · ') }} — 이 폴더에서 일하는 사람의 컴퓨터에서 훅 · MCP 서버 · 허용 목록이 돌아요</p>
    <div v-for="g in groups" :key="g.platform" class="grp" data-test="kit-group" :data-platform="g.platform">
      <button class="gh press" @click="toggle(g.platform)">
        <span class="tw">{{ closed.has(g.platform) ? '▸' : '▾' }}</span>
        <span class="gt"><b>{{ g.label }}</b><small>{{ g.hint }}</small></span>
        <span class="gl">{{ g.line }}</span>
      </button>
      <template v-if="!closed.has(g.platform)">
        <button v-for="k in g.items" :key="k.path" class="it press" data-test="kit-item" :data-path="k.path" @click="emit('open', k.path)">
          <span class="ty" :class="k.type">{{ KIND[k.type] || k.type }}</span>
          <span class="im">
            <b><span data-no-i18n>{{ k.name || k.path }}</span><span v-if="k.runs" class="rb">실행되는 설정</span></b>
            <small v-if="k.description" class="ds" data-no-i18n>{{ k.description }}</small>
            <code>{{ k.path }}</code>
          </span>
        </button>
      </template>
    </div>
    <p v-if="!kit.length" class="none">이 폴더에서 찾은 에이전트 자산이 없어요. <code>.claude/skills</code> · <code>CLAUDE.md</code> · <code>AGENTS.md</code> · <code>.cursor/rules</code> · <code>openspec/</code> 같은 자리에 있는 파일을 보여 줘요.</p>
  </div>
</template>

<style scoped>
.kt { flex: 1; min-height: 0; overflow-y: auto; padding: 6px 10px 16px; }
.sec { font-size: 12.5px; color: var(--text-tertiary); margin: 14px 4px 8px; display: flex; align-items: center; gap: 6px; }
.cnt { height: 20px; min-width: 20px; padding: 0 7px; border-radius: 10px; background: var(--button-bg); font-size: 11.5px; display: inline-grid; place-items: center; color: var(--text-secondary); }
.src { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 14px; background: var(--cell-bg); margin-bottom: 6px; flex-wrap: wrap; }
.pic { flex: none; width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; background: rgba(42 120 214 / .14); color: #2a78d6; }
.sm { flex: 1 1 220px; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.sm b { font-weight: 500; font-size: 14.5px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sm small { font-size: 12.5px; color: var(--text-secondary); word-break: keep-all; overflow-wrap: anywhere; }
.meta span + span::before { content: ' · '; }
.st { height: 20px; padding: 0 8px; border-radius: 10px; font-size: 11.5px; font-weight: 500; display: inline-flex; align-items: center; background: rgba(150 240 176 / .2); color: var(--color-success); }
.st.stop { background: rgba(255 160 60 / .18); color: #e08a2c; }
.acts { display: flex; gap: 6px; margin-left: auto; }
.tb { height: 30px; padding: 0 12px; border-radius: 15px; font-size: 12.5px; font-weight: 500; background: var(--button-bg); white-space: nowrap; }
.runs { display: flex; gap: 6px; align-items: flex-start; font-size: 12.5px; line-height: 1.55; color: #c2570c; background: rgba(255 160 60 / .1); border-radius: 12px; padding: 8px 12px; margin: 0 2px 8px; word-break: keep-all; overflow-wrap: anywhere; }
.runs svg { flex: none; margin-top: 2px; }
.grp { border: 1px solid var(--hairline); border-radius: 16px; margin-bottom: 8px; overflow: hidden; }
.gh { width: 100%; display: flex; align-items: center; gap: 8px; padding: 10px 12px; text-align: left; }
.gh:hover { background: var(--cell-bg); }
.tw { flex: none; width: 14px; color: var(--text-tertiary); font-size: 12px; }
.gt { flex: 1; min-width: 0; display: flex; flex-direction: column; } .gt b { font-size: 14.5px; font-weight: 600; } .gt small { font-size: 12px; color: var(--text-secondary); word-break: keep-all; }
.gl { flex: none; font-size: 12px; color: var(--text-secondary); max-width: 45%; text-align: right; word-break: keep-all; }
.it { width: 100%; display: flex; gap: 10px; align-items: flex-start; padding: 9px 12px 9px 34px; text-align: left; border-top: 1px solid var(--hairline); }
.it:hover { background: var(--cell-bg); }
.ty { flex: none; min-width: 52px; height: 22px; padding: 0 8px; border-radius: 11px; font-size: 11.5px; font-weight: 500; display: inline-grid; place-items: center; background: var(--button-bg); color: var(--text-secondary); margin-top: 1px; }
.ty.skill { background: rgba(123 92 214 / .18); color: #8a6ee0; }
.ty.command, .ty.prompt { background: rgba(42 120 214 / .14); color: #2a78d6; }
.ty.instructions, .ty.rules { background: rgba(150 240 176 / .2); color: var(--color-success); }
.ty.settings, .ty.mcp { background: rgba(255 160 60 / .18); color: #e08a2c; }
.ty.spec, .ty.change { background: rgba(226 169 59 / .2); color: #c98a1a; }
.im { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.im b { font-weight: 500; font-size: 14px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; overflow-wrap: anywhere; }
.ds { font-size: 12.5px; color: var(--text-secondary); line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.im code { font-family: "SF Mono", Menlo, monospace; font-size: 11.5px; color: var(--text-tertiary); overflow-wrap: anywhere; }
.rb { height: 18px; padding: 0 7px; border-radius: 9px; font-size: 10.5px; font-weight: 500; background: rgba(255 160 60 / .2); color: #e08a2c; display: inline-flex; align-items: center; }
.none { font-size: 13.5px; color: var(--text-secondary); padding: 10px; margin: 0; line-height: 1.7; word-break: keep-all; }
.none code { font-family: "SF Mono", Menlo, monospace; font-size: 12px; }
/* the night theme: the same hues, light enough to read on the dark glass */
:root[data-theme="dark"] .runs, :root[data-theme="dark"] .rb, :root[data-theme="dark"] .st.stop, :root[data-theme="dark"] .ty.settings, :root[data-theme="dark"] .ty.mcp { color: #ffb870; }
:root[data-theme="dark"] .ty.skill { color: #c4b2ff; background: rgba(150 120 255 / .22); }
:root[data-theme="dark"] .ty.command, :root[data-theme="dark"] .ty.prompt, :root[data-theme="dark"] .pic { color: #8cc1ff; }
:root[data-theme="dark"] .ty.spec, :root[data-theme="dark"] .ty.change { color: #f3c969; }
@media (max-width: 760px) {
  .kt { padding: 4px 6px 14px; }
  .gh { flex-wrap: wrap; }
  .gl { max-width: none; flex-basis: 100%; text-align: left; padding-left: 22px; }
  .it { padding-left: 14px; }
  .acts { margin-left: 44px; }
}
</style>
