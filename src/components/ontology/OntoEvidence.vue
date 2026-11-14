<script setup>
// 근거(design-v0.3 §23): 이 일이 지도에 있는 까닭 — 그 일로 읽힌 메일 · 대화 메시지 · 채팅 인계를 하나씩.
// 줄마다 언제 · 어디서 · 누가 누구에게 · 부탁/결과 · AI 가 읽은 원래 말 · 이어 묶은 줄기(와 그 까닭).
// 제목 · 원문은 그 메일함 주인에게만 서버가 준다(다른 사람에게는 날짜 · 출처 · 역할만). 「더 보기」는 마지막 줄의 시각 앞으로.
import { ref, computed, watch } from 'vue'
import { api } from '../../api.js'
import { dateTimeKo } from './fmt.js'
import { ACT_KO } from './ontoText.js'

const props = defineProps({ taskKey: { type: String, required: true } })
const SRC = { mail: '메일', chat: '대화방', handover: '채팅 인계' }
const PAGE = 6
const items = ref([])
const counts = ref(null)
const loading = ref(false)
const more = ref(false)
const err = ref('')
const open = ref(new Set())

async function load(before = null) {
  loading.value = true; err.value = ''
  try {
    const qs = new URLSearchParams({ limit: String(PAGE), ...(before ? { before } : {}) })
    const r = await api(`/ontology/tasks/${encodeURIComponent(props.taskKey)}/evidence?${qs}`)
    counts.value = r.counts
    items.value = before ? [...items.value, ...r.items] : r.items
    more.value = r.items.length >= PAGE
  } catch (e) { err.value = e.message } finally { loading.value = false }
}
watch(() => props.taskKey, () => { items.value = []; open.value = new Set(); load() }, { immediate: true })

const total = computed(() => (counts.value ? counts.value.mail + counts.value.chat + counts.value.handover : 0))
const countLine = computed(() => Object.entries(counts.value || {}).filter(([, n]) => n > 0).map(([k, n]) => `${SRC[k]} ${n}건`).join(' · '))
const whoText = (p) => (!p ? '' : p.name && p.role && p.name !== p.role && !p.name.startsWith('고객') ? `${p.name} · ${p.role}` : p.name || p.role || '누군가')
const key = (it) => `${it.source}:${it.id}`
const hasMore = (it) => !!(it.text || it.why || it.files?.length || it.link || it.export)
function toggle(it) { const s = new Set(open.value); s.has(key(it)) ? s.delete(key(it)) : s.add(key(it)); open.value = s }
</script>

<template>
  <div class="sec ev" data-testid="onto-evidence">
    <h4>근거 <small v-if="total">{{ countLine }}</small></h4>
    <p class="how">AI(프로세스 찾기 스킬)가 메일 · 대화를 하나씩 읽고 무슨 일인지 이름을 붙였어요. 이름이 비슷한 것을 이 일로 모았어요. 아래는 그렇게 모인 기록이에요.</p>
    <p v-if="loading && !items.length" class="muted pulse">불러오는 중…</p>
    <p v-else-if="err" class="err">{{ err }}</p>
    <p v-else-if="!items.length" class="muted">관련 메일 · 대화가 없어요. 문서나 역할 루틴에서 찾은 일일 수 있어요.</p>
    <ol v-else class="list">
      <li v-for="it in items" :key="key(it)" :class="['it', it.source, { open: open.has(key(it)) }]" data-testid="onto-evidence-item">
        <button class="row press" :disabled="!hasMore(it)" :aria-expanded="open.has(key(it))" @click="toggle(it)">
          <span class="src" :class="it.source">{{ SRC[it.source] }}</span>
          <span class="main">
            <span class="top"><time>{{ dateTimeKo(it.at) }}</time><span v-if="it.act" class="act">{{ ACT_KO[it.act] || it.act }}</span></span>
            <span class="who">{{ whoText(it.from) }}<template v-if="it.to"> → {{ whoText(it.to) }}</template></span>
            <b v-if="it.subject" class="subj">{{ it.subject }}</b>
            <span class="raw">AI가 읽은 말 <q>{{ it.raw }}</q></span>
            <span v-if="it.stream" class="stream" title="AI가 같은 고객 · 프로젝트로 이어 묶은 건들">묶음 · {{ it.stream }}</span>
          </span>
          <span v-if="hasMore(it)" class="chev" aria-hidden="true" />
        </button>
        <div v-if="open.has(key(it))" class="detail" data-testid="onto-evidence-detail">
          <p v-if="it.text" class="text">{{ it.text }}</p>
          <p v-else-if="it.source !== 'handover'" class="muted sm">원문은 메일함 소유자만 볼 수 있어요.</p>
          <p v-if="it.why" class="sm"><span class="k">묶은 이유</span> {{ it.why }}</p>
          <p v-if="it.files?.length" class="sm"><span class="k">첨부</span> {{ it.files.join(' · ') }}</p>
          <p v-if="it.export" class="sm"><span class="k">올린 파일</span> {{ it.export }}</p>
          <a v-if="it.link" class="lnk" :href="it.link" target="_blank" rel="noopener" data-testid="onto-evidence-open">Gmail에서 열기 ↗</a>
        </div>
      </li>
    </ol>
    <button v-if="more && items.length" class="more press" :disabled="loading" data-testid="onto-evidence-more" @click="load(items.at(-1).at)">{{ loading ? '불러오는 중…' : '더 보기' }}</button>
  </div>
</template>

<style scoped>
.sec { padding: 12px; border-radius: 16px; background: var(--cell-bg); min-width: 0; }
h4 { margin: 0 0 6px; font-size: 13px; font-weight: 600; color: var(--text-secondary); }
h4 small { font-weight: 400; color: var(--text-tertiary); margin-left: 4px; }
.how { margin: 0 0 10px; font-size: 12.5px; line-height: 1.5; color: var(--text-secondary); }
.muted { margin: 0; font-size: 13px; color: var(--text-secondary); line-height: 1.5; }
.err { margin: 0; font-size: 13px; color: var(--color-error); }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.it { border-radius: 12px; background: var(--field-bg); overflow: hidden; }
.row { display: flex; align-items: flex-start; gap: 10px; width: 100%; padding: 9px 10px; text-align: left; }
.row:disabled { cursor: default; }
.src { flex: none; min-width: 44px; padding: 2px 7px; border-radius: 9999px; font-size: 11px; font-weight: 600; text-align: center; color: #fff; background: #6b6b66; }
.src.mail { background: #2b6cb0; } .src.chat { background: #b7791f; } .src.handover { background: #6b46c1; }
.main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.top { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.act { padding: 0 6px; border-radius: 6px; background: var(--chip-bg, var(--cell-bg)); color: var(--text-primary); font-size: 11.5px; }
.who { font-size: 13px; overflow-wrap: anywhere; }
.subj { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.raw { font-size: 12px; color: var(--text-tertiary); }
.raw q { color: var(--text-secondary); quotes: '“' '”'; }
.stream { font-size: 12px; color: var(--color-info); }
.chev { flex: none; width: 8px; height: 8px; margin-top: 6px; border-right: 1.5px solid var(--text-tertiary); border-bottom: 1.5px solid var(--text-tertiary); rotate: 45deg; transition: rotate .2s; }
.open .chev { rotate: 225deg; margin-top: 10px; }
.detail { padding: 0 12px 10px 64px; display: flex; flex-direction: column; gap: 6px; }
.text { margin: 0; padding: 8px 10px; border-radius: 10px; background: var(--cell-bg); font-size: 12.5px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.sm { margin: 0; font-size: 12px; line-height: 1.5; color: var(--text-secondary); overflow-wrap: anywhere; }
.k { color: var(--text-tertiary); margin-right: 4px; }
.lnk { font-size: 12.5px; color: var(--color-info); text-decoration: none; }
.more { margin-top: 8px; font-size: 12.5px; color: var(--color-info); }
@media (max-width: 480px) { .detail { padding-left: 12px; } }
</style>
