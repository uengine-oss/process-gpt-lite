<script setup>
import { computed, ref } from 'vue'
import { marked } from 'marked'
import SkillShareCard from './SkillShareCard.vue'
import Icon from './Icon.vue'
import TaskCard from './TaskCard.vue'
import VaultCard from './VaultCard.vue'
import ProcessCard from './ProcessCard.vue'
import TodoCard from './TodoCard.vue'
import ProcessDraftCard from './ProcessDraftCard.vue'
import SkillDraftCard from './SkillDraftCard.vue'
import ChoiceCard from './ChoiceCard.vue'
import { useRouter } from 'vue-router'
import { useApp } from '../stores/app.js'
import { officeEditorFor } from '../officeEditor.js'

const props = defineProps({ msg: Object })
const emit = defineEmits(['connect'])
// a document the agent made opens in the editor in place; anything else opens its URL
const kindOf = (n) => ({ hwp: 'hwp', hwpx: 'hwp', docx: 'doc', odt: 'doc', xlsx: 'xls', xls: 'xls', csv: 'xls', pptx: 'ppt', pdf: 'pdf', dxf: 'cad', dwg: 'cad', svg: 'vec', vectorcraft: 'vec', psd: 'img', psb: 'img', pcraft: 'img', png: 'img', jpg: 'img', jpeg: 'img', webp: 'img', wav: 'snd', mp3: 'snd', flac: 'snd', ogg: 'snd', soundcraft: 'snd', scraftz: 'snd', mp4: 'vid', mov: 'vid', webm: 'vid', fcproj: 'vid' })[String(n || '').split('.').pop().toLowerCase()] || 'etc'
const kindLabel = { hwp: '한글', doc: 'DOC', xls: 'XLS', ppt: 'PPT', pdf: 'PDF', cad: 'CAD', vec: 'SVG', img: 'IMG', snd: 'AUD', vid: 'VID' }
function openFile() {
  const c = props.msg.content
  if (c.url && officeEditorFor(c.name)) app.officeDoc = { msgId: props.msg.id, url: c.url, name: c.name }
  else if (c.url) window.open(c.url, '_blank', 'noopener')
  else if (room(c.path)) router.push({ path: `/workroom/chat/${room(c.path)[1]}`, query: { open: room(c.path)[2] } })
}
// a file the agent left in its conversation folder opens in that folder's workroom
const room = (p) => /^\/workspace\/\.bpmn\/([^/]+)\/(.+)$/.exec(p || '')
const expanded = ref(false)
const router = useRouter()
const app = useApp()
const instStatus = { RUNNING: '진행 중', COMPLETED: '완료', NEW: '시작 전' }
const c = computed(() => props.msg.content || {})
// model output is rendered as markdown, never as raw HTML
const md = (t) => marked.parse(String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;'), { breaks: true })
const doc = computed(() => {
  if (props.msg.kind !== 'doc') return null
  const [first, ...rest] = c.value.text.split('\n')
  return { title: first.replace(/^#\s*/, ''), body: md(rest.join('\n')) }
})
const time = computed(() => new Date(props.msg.created_at).toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }))
const panelReq = computed(() => (/^새 패널 만들기:\s*/.test(c.value.text || '') ? c.value.text.replace(/^새 패널 만들기:\s*/, '') : null))
// "- 네, 이대로 진행 (설명)" style options at the end of an agent question become tappable replies
const replies = computed(() => {
  if (props.msg.role !== 'agent' || props.msg.kind !== 'text') return null
  const lines = String(c.value.text || '').trim().split('\n')
  let end = lines.length
  while (end > 0 && !lines[end - 1].trim().startsWith('- ')) end--
  let start = end
  while (start > 0 && lines[start - 1].trim().startsWith('- ')) start--
  const opts = lines.slice(start, end).map((l) => l.trim().slice(2))
  if (opts.length < 2 || opts.length > 4 || !/[?？]|선택|골라/.test(lines.join(' '))) return null
  const options = opts.map((o) => { const m = /^(.+?)\s*\((.+)\)\s*$/.exec(o); return { label: (m ? m[1] : o).replace(/\*\*/g, ''), hint: m?.[2] } })
  return { body: [...lines.slice(0, start), ...lines.slice(end)].join('\n').trim(), options }
})
const chipIcon = { clock: 'clock', panel: 'panel', check: 'check', bell: 'bell' }
const ctx = computed(() => (c.value.context && c.value.context.action !== 'stay' && c.value.context.title ? c.value.context : null))
const byName = { judge: '판단 모델', logprob: 'logprob', json: 'json', pinned: '대화에서 직접', trivial: '', none: '' }
const ctxBy = computed(() => (ctx.value ? (ctx.value.rechecked ? '판단 모델 재확인→logprob' : ctx.value.escalated ? '판단 모델→logprob' : byName[ctx.value.strategy] ?? ctx.value.strategy) : ''))
const ctxWhy = computed(() => (ctx.value ? `${ctx.value.action === 'new' ? '새 대화로 시작' : '이 대화로 이어감'} · ${ctxBy.value} 확신도 ${ctx.value.confidence ?? '-'}` : ''))
</script>

<template>
  <div class="row" :class="[`r-${msg.role}`, `k-${msg.kind}`, { pinned: msg.kind === 'task' && c.state === 'running', needs: c.state === 'needs_input' || c.state === 'pending' }]">
    <span v-if="msg.kind !== 'divider'" class="ts">{{ time }}</span>

    <!-- which context this answer belongs to, as the context-router decided (hark-style threads) -->
    <div v-if="msg.role === 'agent' && ctx" role="link" tabindex="0" @click="ctx.conversationId && router.push(`/chat/c/${encodeURIComponent(ctx.conversationId)}`)" class="ctx" :class="ctx.action" :title="ctxWhy">
      <span class="arrow">↳</span><span class="tt">{{ ctx.action === 'new' ? '새 주제 · ' : '' }}{{ ctx.title }}</span>
      <small v-if="ctxBy" class="by" :class="ctx.escalated || ctx.rechecked ? 'escalated' : ctx.strategy">{{ ctxBy }} {{ ctx.confidence != null ? ctx.confidence.toFixed(2) : '' }}</small>
    </div>
    <!-- a scheduled run's output is introduced by its task, tappable to manage it (hark) -->
    <button v-if="msg.kind === 'divider' && c.scheduleId" class="sched press" @click="router.push(`/settings/schedules?open=${c.scheduleId}`)"><Icon name="clock" :size="15" /> {{ c.text }} 관리</button>
    <div v-else-if="msg.kind === 'divider'" class="divider">{{ c.text }}</div>

    <template v-else-if="msg.kind === 'text' && msg.role === 'user'">
      <span v-if="panelReq" class="req">새 패널 만들기</span>
      <div class="bubble user">{{ panelReq ?? c.text }}</div>
    </template>
    <template v-else-if="msg.kind === 'text'">
      <div class="bubble agent md" v-html="md(replies ? replies.body : c.text)" />
      <div v-if="replies" class="replies">
        <button v-for="o in replies.options" :key="o.label" class="reply press" :title="o.hint" @click="app.send(o.label, msg.thread_id)">{{ o.label }}</button>
      </div>
    </template>

    <div v-else-if="doc" class="doc" :class="{ open: expanded }">
      <h3 class="serif">{{ doc.title }}</h3>
      <div class="inner md" v-html="doc.body" />
      <button class="more press" :aria-label="expanded ? '접기' : '펼치기'" @click="expanded = !expanded">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" :style="{ rotate: expanded ? '180deg' : '0deg' }"><path d="M6 9l6 6 6-6" /></svg>
      </button>
    </div>

    <TaskCard v-else-if="msg.kind === 'task'" :msg="msg" />
    <VaultCard v-else-if="msg.kind === 'vault'" :msg="msg" />
    <ChoiceCard v-else-if="msg.kind === 'choice'" :msg="msg" />
    <ProcessCard v-else-if="msg.kind === 'process'" :msg="msg" />
    <ProcessDraftCard v-else-if="msg.kind === 'process_draft'" :msg="msg" />
    <SkillDraftCard v-else-if="msg.kind === 'skill_draft'" :msg="msg" />
    <TodoCard v-else-if="msg.kind === 'todo'" :todo-id="c.todoId" :msg-id="msg.id" :done="c.state === 'submitted'" />

    <div v-else-if="msg.kind === 'catalog'" class="list glass">
      <div class="lh">시작할 수 있는 프로세스 {{ c.items.length }}개</div>
      <button v-for="d in c.items" :key="d.id" class="li press" @click="app.send(`'${d.name}' 프로세스 보여줘`)">
        <b>{{ d.name }}</b><small v-if="d.description">{{ d.description }}</small>
      </button>
    </div>
    <div v-else-if="msg.kind === 'instances'" class="list glass">
      <div class="lh">진행 중인 프로세스 {{ c.items.length }}건</div>
      <button v-for="it in c.items" :key="it.proc_inst_id" class="li press" @click="router.push(`/projects/p/${encodeURIComponent(it.proc_inst_id)}`)">
        <b>{{ it.proc_inst_name || it.def_name }}</b>
        <small>{{ it.def_name }} · {{ instStatus[it.status] || it.status }}<span v-if="it.needs_me" class="me"> · 입력 필요</span></small>
      </button>
      <p v-if="!c.items.length" class="empty">진행 중인 프로세스가 없어요.</p>
    </div>

    <button v-else-if="msg.kind === 'file'" class="file press" @click="openFile">
      <span class="fic" :class="kindOf(c.name)">{{ kindLabel[kindOf(c.name)] || 'FILE' }}</span>
      <span class="fmeta"><b>{{ c.name }}</b><small>{{ officeEditorFor(c.name) && c.url ? (c.edited ? '편집본 · 눌러서 이어 편집' : '눌러서 바로 편집') : c.url ? '열기' : '작업실에서 열기' }}</small></span>
    </button>

    <!-- an agent's change in a shared folder: a variation to review and merge (lib/folders/work.js) -->
    <button v-else-if="msg.kind === 'folder_variation'" class="fvar press" @click="router.push(c.url)">
      <span class="fvh"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 4v10M6 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM6 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 10c0 4-6 3-12 6" /></svg>
        {{ c.skill ? `스킬 ${c.skill}` : c.folderName }} · 새 변형</span>
      <b>{{ c.title }}</b>
      <small v-if="c.summary">{{ c.summary }}</small>
      <span class="fvf">{{ (c.files || []).map((f) => f.path.split('/').pop()).join(', ') }}</span>
      <span class="fvgo">{{ c.requested ? `반영 요청을 보냈어요 · ${c.requested.to} 님 검토 대기 →` : '검토하고 반영하기 →' }}</span>
    </button>
    <SkillShareCard v-else-if="msg.kind === 'skill_share'" class="sharecard" :skill="c.skill" :folder="c.folder" :after="c.after" />

    <button v-else-if="msg.kind === 'connect'" class="connect press" :class="{ done: c.state === 'done' }" :disabled="c.state === 'done'" @click="emit('connect')">
      <Icon v-if="c.state === 'done'" name="check" :size="16" />
      <svg v-else width="16" height="16" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.5-4.5 2.4-7.2 2.4-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
      {{ c.state === 'done' ? (c.doneText || '메일 연결됨') : c.text }}
    </button>

    <div v-else-if="msg.kind === 'chip'" class="chip"><Icon :name="chipIcon[c.icon] || 'check'" :size="16" /> {{ c.text }}</div>
  </div>
</template>

<style scoped>
.row { position: relative; display: flex; flex-direction: column; align-items: flex-start; animation: blur-in .5s var(--spring) both; }
.row.r-user { align-items: flex-end; }
/* a running browser task stays in view while the conversation scrolls under it */
.row.pinned { position: sticky; top: 0; z-index: 4; }
.row.k-task { align-self: stretch; }
.ts { position: absolute; right: calc(100% + 24px); top: 50%; translate: 0 -50%; white-space: nowrap; font-size: 14px; color: var(--text-secondary); opacity: 0; transition: opacity .2s; pointer-events: none; text-align: right; }
.row.r-user .ts { right: auto; left: -160px; }
.row:hover .ts { opacity: 1; }
.req { font-size: 14px; color: var(--text-secondary); margin: 0 6px 6px 0; }
.bubble { max-width: 424px; border-radius: 24px; padding: 13px 18px; font-size: 16px; line-height: 1.6; word-break: keep-all; overflow-wrap: anywhere; transition: background-color 1s; }
.bubble.agent { background: var(--bubble-agent-bg); -webkit-backdrop-filter: blur(50px); backdrop-filter: blur(50px); }
.bubble.user { background: var(--bubble-user-bg); -webkit-backdrop-filter: blur(50px); backdrop-filter: blur(50px); max-width: 512px; white-space: pre-wrap; }
.md :deep(p) { margin: 0 0 .6em; } .md :deep(p:last-child) { margin: 0; }
.md :deep(ul), .md :deep(ol) { margin: .2em 0 .6em; padding-left: 1.2em; }
.md :deep(strong) { font-weight: 600; }
.md :deep(code) { font-size: .9em; background: var(--cell-bg); padding: 1px 5px; border-radius: 6px; }
.md :deep(h1), .md :deep(h2), .md :deep(h3) { font-size: 16px; font-weight: 600; margin: .6em 0 .3em; }
.md :deep(table) { border-collapse: collapse; font-size: 14px; } .md :deep(td), .md :deep(th) { padding: 4px 8px; border-bottom: 1px solid var(--hairline); }
.doc { position: relative; width: 424px; max-width: 100%; border-radius: 24px; padding: 8px; background: var(--bubble-agent-bg); -webkit-backdrop-filter: blur(50px); backdrop-filter: blur(50px); box-shadow: var(--shadow-card); }
.doc h3 { font-size: 24px; font-weight: 400; letter-spacing: .02em; margin: 14px 14px 16px; line-height: 1.3; }
.doc .inner { background: var(--cell-bg); border-radius: 16px; padding: 14px 16px; font-size: 15px; line-height: 1.55; max-height: 150px; overflow: hidden;
  -webkit-mask-image: linear-gradient(#000 60%, transparent); mask-image: linear-gradient(#000 60%, transparent); transition: max-height .5s var(--spring); }
.doc.open .inner { max-height: 4000px; -webkit-mask-image: none; mask-image: none; }
.doc .more { position: absolute; left: 50%; bottom: -14px; translate: -50% 0; width: 32px; height: 32px; border-radius: 9999px; display: grid; place-items: center; background: var(--regular-solid-bg); box-shadow: 0 2px 10px rgba(0 0 0 / .1); }
.doc .more svg { transition: rotate .3s; }
.file { display: inline-flex; align-items: center; gap: 12px; height: 64px; padding: 0 22px; border-radius: 22px; background: #1d1d1f; color: #f5f5f7; font-size: 16px; font-weight: 500; }
.file { text-align: left; }
.fvar { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; width: 424px; max-width: 100%; padding: 14px 18px; border-radius: 22px; background: var(--bubble-agent-bg); -webkit-backdrop-filter: blur(30px); backdrop-filter: blur(30px); text-align: left; }
.fvh { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--text-secondary); }
.fvar b { font-size: 16px; font-weight: 500; line-height: 1.35; }
.fvar small { font-size: 13.5px; color: var(--text-secondary); line-height: 1.5; }
.sharecard { width: 424px; max-width: 100%; }
.fvf { font-size: 12.5px; color: var(--text-tertiary); }
.fvgo { margin-top: 6px; font-size: 13.5px; font-weight: 500; color: var(--color-info); }
.fic { flex: none; width: 40px; height: 40px; border-radius: 10px; display: grid; place-items: center; font-size: 11px; font-weight: 700; color: #fff; background: #6b6b66; }
.fic.hwp { background: #1f6fd1; } .fic.doc { background: #2b579a; } .fic.xls { background: #217346; } .fic.ppt { background: #c43e1c; } .fic.pdf { background: #d93025; } .fic.cad { background: #0b6f88; } .fic.vec { background: #c2570c; } .fic.img { background: #7b3fbf; } .fic.snd { background: #0f8a5f; } .fic.vid { background: #b0223c; }
.fmeta { display: flex; flex-direction: column; min-width: 0; }
.fmeta b { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fmeta small { color: rgba(245, 245, 247, .62); font-size: 12.5px; }
.connect { display: inline-flex; align-items: center; gap: 8px; height: 40px; padding: 0 16px; border-radius: 9999px; background: var(--regular-solid-bg); font-size: 14px; font-weight: 500; box-shadow: 0 2px 12px rgba(0 0 0 / .06); }
.connect.done { background: var(--bubble-user-bg); color: var(--text-primary); }
.chip { display: inline-flex; align-items: center; gap: 8px; min-height: 36px; padding: 6px 14px; border-radius: 9999px; background: var(--bubble-user-bg); -webkit-backdrop-filter: blur(30px); backdrop-filter: blur(30px); font-size: 14px; }
.replies { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.reply { height: 36px; padding: 0 16px; border-radius: 9999px; background: var(--regular-solid-bg); font-size: 14px; font-weight: 500; box-shadow: 0 2px 10px rgba(0 0 0 / .06); animation: pop-in .4s var(--spring) both; }
.list { width: 424px; max-width: 100%; border-radius: 24px; padding: 8px; display: flex; flex-direction: column; --regular-bg: var(--bubble-agent-bg); }
.lh { font-size: 13px; color: var(--text-secondary); margin: 10px 12px 6px; }
.li { text-align: left; padding: 12px; border-radius: 16px; display: flex; flex-direction: column; gap: 3px; }
.li:hover { background: var(--cell-bg); }
.li b { font-weight: 500; font-size: 15px; line-height: 1.35; }
.li small { color: var(--text-secondary); font-size: 13px; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.me { color: var(--color-attention); font-weight: 500; }
.empty { margin: 4px 12px 10px; font-size: 14px; color: var(--text-secondary); }
.ctx { cursor: pointer; display: inline-flex; align-items: center; gap: 7px; max-width: 424px; min-height: 28px; padding: 3px 5px 3px 11px; border-radius: 9999px; background: var(--bubble-user-bg); -webkit-backdrop-filter: blur(30px); backdrop-filter: blur(30px); font-size: 13px; color: var(--text-primary); margin: 0 0 6px 2px; animation: blur-in .4s var(--spring) both; }
.ctx .arrow { color: var(--text-secondary); }
.ctx .tt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.ctx .by { flex: none; font-size: 11.5px; padding: 2px 8px; border-radius: 9999px; color: #fff; background: #64748b; font-family: ui-monospace, Menlo, monospace; }
.ctx .by.judge { background: #0284c7; } .ctx .by.logprob { background: #7c3aed; } .ctx .by.escalated { background: linear-gradient(90deg, #0284c7, #7c3aed); }
.sched { display: inline-flex; align-items: center; gap: 7px; height: 36px; padding: 0 16px; border-radius: 9999px; background: var(--regular-solid-bg); color: var(--text-primary); font-size: 14px; font-weight: 500; box-shadow: 0 2px 10px rgba(0 0 0 / .06); margin-top: 6px; }
.row.k-divider { align-items: center; }
.divider { align-self: stretch; text-align: center; font-size: 14px; color: var(--text-tertiary); padding-top: 18px; border-top: 1px solid var(--hairline); margin-top: 10px; }
</style>
