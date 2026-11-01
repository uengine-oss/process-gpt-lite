<script setup>
// 대화 맥락 하나를 보는 사람의 깊이로(spec pgpt-pro_context-visibility): 제목·주인·등급·한 줄 목적 ─ 요약·결정·열린 질문 ─ 턴(원문).
// 깊이 판정은 서버(GET /api/context/items/:conv)가 하고, 볼 수 없으면(비공개·조직도 밖·없는 맥락) 같은 404 — 화면도 한 문장만.
// 모자란 깊이는 「요약 요청하기 / 원문 요청하기」 → 참고 요청(POST /api/context/access-requests). 자동 허용이면 바로 다시 읽는다.
// ?thread=<대화 id> — 「이 작업 동안」 허락은 그 대화에서만 쓰인다.
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import TopBar from '../components/TopBar.vue'
import Icon from '../components/Icon.vue'
import GradePicker from '../components/context/GradePicker.vue'
import { api } from '../api.js'
import { useApp } from '../stores/app.js'
import { DEPTH, DURATION, gradeLabel, atLeast, ago, when, md } from '../components/context/gradeKit.js'

const app = useApp()
const route = useRoute()
const router = useRouter()
const conv = computed(() => String(route.params.conv || ''))
const thread = computed(() => (route.query.thread ? String(route.query.thread) : null))
const v = ref(null), gone = ref(false), err = ref(''), asking = ref(''), doing = ref(''), sent = ref({}), busy = ref(false)
const has = (d) => !!v.value && atLeast(v.value.depth, d)

async function load() {
  err.value = ''
  try {
    v.value = await api(`/context/items/${encodeURIComponent(conv.value)}${thread.value ? `?thread=${encodeURIComponent(thread.value)}` : ''}`)
    gone.value = false
  } catch (e) { v.value = null; if (e.status === 404 || e.status === 400) gone.value = true; else err.value = e.message }
}
watch(() => [conv.value, thread.value], () => { sent.value = {}; asking.value = ''; load() })

function ask(depth) { asking.value = asking.value === depth ? '' : depth; err.value = '' }
async function send(depth) {
  busy.value = true; err.value = ''
  try {
    const r = await api('/context/access-requests', { method: 'POST', body: { conversationId: conv.value, depth, doing: doing.value.trim(), ...(thread.value ? { threadId: thread.value } : {}) } })
    sent.value = { ...sent.value, [depth]: r }
    asking.value = ''
    if (r.status === 'granted') await load()
  } catch (e) { err.value = e.message }
  finally { busy.value = false }
}
// 주인이 결정하면(알림 이벤트, 놓치면 6초마다) 내 요청 상태를 다시 보고, 허락이면 다시 읽는다
const pendingIds = computed(() => Object.values(sent.value).filter((r) => r.status === 'pending').map((r) => r.request_id))
async function recheck() {
  if (!pendingIds.value.length) return
  try {
    const mine = await api('/context/access-requests?box=outgoing')
    let changed = false
    for (const [d, r] of Object.entries(sent.value)) {
      const now = r.status === 'pending' && mine.find((x) => x.id === r.request_id)
      if (now && now.status !== 'pending') { sent.value = { ...sent.value, [d]: { ...r, status: now.status, via: now.via } }; changed = changed || now.status === 'granted' }
    }
    if (changed) await load()
  } catch { /* 다음 번에 */ }
}
const onEvent = (e) => { if (e.detail?.type === 'notifications') recheck() }
let timer
onMounted(async () => {
  app.mode = 'context'
  if (!app.me) app.me = await api('/me').catch(() => null)
  load()
  window.addEventListener('pgpt:event', onEvent)
  timer = setInterval(recheck, 6000)
})
onUnmounted(() => { window.removeEventListener('pgpt:event', onEvent); clearInterval(timer) })

const resultText = (r) => r.status === 'granted' ? (r.already ? '이미 볼 수 있습니다' : `허락됨 — ${r.via === 'auto' ? '자동 허용' : '주인이 허락'}${r.grant ? ` · ${DURATION[r.grant.duration] || ''}` : ''}`)
  : r.status === 'pending' ? (r.via === 'sensitive' ? '요청을 보냈습니다 — 민감 항목이라 주인이 직접 결정합니다' : '요청을 보냈습니다 — 주인의 홈 카드에서 기다립니다')
  : r.status === 'expired' ? '응답이 없어 만료되었습니다' : '거절되었습니다'
const text = (d) => (typeof d === 'string' ? d : d?.text || '')
function onChanged(r) { if (r?.item && v.value) Object.assign(v.value, { visibility: r.item.visibility, reach: r.item.reach, sensitive: r.item.sensitive, purpose: r.item.purpose ?? v.value.purpose }) }
const back = () => (window.history.length > 1 ? router.back() : router.push('/settings/sharing'))
</script>

<template>
  <div class="cview">
    <TopBar />
    <div class="content scroll">
      <div class="cv">
        <button class="back press" @click="back"><Icon name="back" :size="16" /> 돌아가기</button>
        <p v-if="gone" class="gone glass" data-testid="context-gone">볼 수 없는 맥락입니다</p>
        <p v-else-if="!v && !err" class="loading">읽는 중…</p>
        <p v-if="err" class="err">{{ err }}</p>

        <article v-if="v" class="card glass" :data-depth="v.depth" data-testid="context-view">
          <header class="hd">
            <div class="tags">
              <span class="tag">대화 맥락</span>
              <span class="sp" />
              <GradePicker v-if="v.mine" :conv="v.id" :title="v.title" :value="{ visibility: v.visibility, reach: v.reach, sensitive: v.sensitive, purpose: v.purpose }" @changed="onChanged" />
              <template v-else>
                <span class="tag grade" :class="'g-' + v.visibility" data-testid="context-grade"><i class="gdot" />{{ gradeLabel(v.visibility, v.reach) }}</span>
                <span v-if="v.sensitive === 'confirmed'" class="tag bad">민감</span>
              </template>
            </div>
            <h1>{{ v.title }}</h1>
            <div class="meta">
              <span>주인 <b>{{ v.owner_name }}</b><template v-if="v.mine"> (나)</template></span>
              <span>· 턴 {{ v.turns_count }}개</span>
              <span>· {{ ago(v.updated_at) }}</span>
            </div>
            <p v-if="v.purpose" class="purpose">{{ v.purpose }}</p>
          </header>

          <div class="depthbox" data-testid="context-depth">
            <div class="meter" aria-hidden="true"><span v-for="d in ['title', 'summary', 'content']" :key="d" :class="{ on: has(d) }">{{ DEPTH[d] }}</span></div>
            <div class="dtext"><b>내가 볼 수 있는 깊이: {{ DEPTH[v.depth] }}</b> <span>— 근거 {{ v.why.join(', ') }}</span></div>
          </div>

          <!-- 요약 깊이 -->
          <section class="blk">
            <h2>요약</h2>
            <template v-if="has('summary')">
              <p v-if="v.summary" class="sum">{{ v.summary }}</p>
              <p v-else class="dim">요약이 아직 없습니다.</p>
              <div v-if="v.decisions?.length"><h3>결정 사항</h3><ul><li v-for="(d, i) in v.decisions" :key="i">{{ text(d) }}</li></ul></div>
              <div v-if="v.questions?.length"><h3>열린 질문</h3><ul><li v-for="(d, i) in v.questions" :key="i">{{ text(d) }}</li></ul></div>
            </template>
            <div v-else class="lock" data-testid="lock-summary">
              <span>요약·결정 사항 — 요청하면 볼 수 있음</span>
              <span class="sp" />
              <span v-if="sent.summary" class="res" :class="sent.summary.status" data-testid="request-result">{{ resultText(sent.summary) }}</span>
              <button v-else class="b main press" data-testid="ask-summary" @click="ask('summary')">요약 요청하기</button>
            </div>
            <form v-if="asking === 'summary'" class="askform" @submit.prevent="send('summary')">
              <input v-model="doing" maxlength="200" placeholder="지금 하는 일(한 줄) — 예: 3분기 시장 보고서 가격 비교" />
              <button class="b main press" :disabled="busy">보내기</button>
            </form>
          </section>

          <!-- 원문 깊이 -->
          <section class="blk">
            <h2>원문</h2>
            <template v-if="has('content')">
              <ol class="turns">
                <li v-for="t in v.turns" :key="t.id" data-testid="context-turn">
                  <div class="when">{{ when(t.at) }}</div>
                  <div class="ask">{{ t.prompt }}</div>
                  <div class="ans md" v-html="md(t.answer)" />
                  <div v-for="s in t.sources" :key="s.id" class="src">참고: {{ s.owner_name }} 「{{ s.title }}」</div>
                </li>
              </ol>
              <p v-if="!v.turns?.length" class="dim">턴이 없습니다.</p>
              <p v-if="v.excluded" class="dim">주인이 뺀 턴 {{ v.excluded }}개는 보이지 않습니다.</p>
            </template>
            <div v-else class="lock" data-testid="lock-content">
              <span>대화 원문 — 요청하면 볼 수 있음</span>
              <span class="sp" />
              <span v-if="sent.content" class="res" :class="sent.content.status" data-testid="request-result">{{ resultText(sent.content) }}</span>
              <button v-else class="b main press" data-testid="ask-content" @click="ask('content')">원문 요청하기</button>
            </div>
            <form v-if="asking === 'content'" class="askform" @submit.prevent="send('content')">
              <input v-model="doing" maxlength="200" placeholder="지금 하는 일(한 줄) — 예: 3분기 시장 보고서 가격 비교" />
              <button class="b main press" :disabled="busy">보내기</button>
            </form>
            <p v-if="!has('content') && v.sensitive === 'confirmed'" class="dim">민감 항목은 자동 허용되지 않고 주인이 직접 결정합니다.</p>
          </section>
        </article>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cview { position: absolute; inset: 0; }
.content { position: absolute; top: 84px; left: 0; right: 0; bottom: 0; }
.cv { max-width: 880px; margin: 0 auto; padding: 0 24px 60px; display: flex; flex-direction: column; gap: 12px; }
.back { align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; color: var(--text-secondary); font-size: 14px; margin: 2px 0 0; }
.gone { border-radius: 22px; padding: 40px; text-align: center; color: var(--text-secondary); font-size: 16px; margin: 0; }
.loading, .dim { color: var(--text-secondary); font-size: 14px; margin: 0; }
.err { color: var(--color-error); font-size: 14px; margin: 0; }
.card { border-radius: 24px; padding: 22px 26px; display: flex; flex-direction: column; gap: 18px; }
.hd { display: flex; flex-direction: column; gap: 6px; }
.tags { display: flex; align-items: center; gap: 8px; }
.sp { flex: 1; }
.tag { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 11px; border-radius: 13px; font-size: 12.5px; background: var(--field-bg); color: var(--text-secondary); }
.tag.grade { color: var(--text-primary); }
.tag.bad { background: color-mix(in srgb, var(--color-error) 18%, transparent); color: var(--color-error); }
.gdot { width: 9px; height: 9px; border-radius: 50%; background: var(--text-tertiary); }
.g-listed .gdot { background: #9b8cff; } .g-summary .gdot { background: var(--color-info); } .g-open .gdot { background: var(--color-success); }
h1 { margin: 4px 0 0; font-size: 30px; font-weight: 500; letter-spacing: -0.02em; }
.meta { display: flex; gap: 6px; flex-wrap: wrap; color: var(--text-secondary); font-size: 14px; }
.meta b { color: var(--text-primary); font-weight: 500; }
.purpose { margin: 2px 0 0; font-size: 15.5px; color: var(--text-primary); opacity: .85; }
.depthbox { display: flex; align-items: center; gap: 14px; padding: 12px 14px; border-radius: 14px; background: var(--field-bg); flex-wrap: wrap; }
.meter { display: inline-flex; border: 1px solid var(--hairline); border-radius: 999px; overflow: hidden; flex: none; }
.meter span { padding: 4px 14px; font-size: 13px; color: var(--text-tertiary); }
.meter span + span { border-left: 1px solid var(--hairline); }
.meter span.on { background: var(--ink); color: var(--ink-inverse); font-weight: 600; }
.dtext { font-size: 14px; color: var(--text-secondary); }
.dtext b { color: var(--text-primary); font-weight: 600; }
.blk { display: flex; flex-direction: column; gap: 8px; }
.blk h2 { margin: 0; font-size: 17px; font-weight: 500; }
.blk h3 { margin: 6px 0 2px; font-size: 13px; color: var(--text-secondary); font-weight: 500; }
.blk ul { margin: 0; padding-left: 20px; font-size: 15px; line-height: 1.6; }
.sum { margin: 0; font-size: 15.5px; line-height: 1.7; }
.lock { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border: 1px dashed var(--hairline); border-radius: 14px; color: var(--text-secondary); font-size: 14.5px; flex-wrap: wrap; }
.res { font-size: 14px; }
.res.granted { color: var(--color-success); } .res.pending { color: #d9822b; } .res.denied, .res.expired { color: var(--color-error); }
.askform { display: flex; gap: 8px; }
.askform input { flex: 1; height: 40px; border-radius: 20px; padding: 0 16px; border: 1px solid var(--hairline); background: var(--field-bg); color: var(--text-primary); font-size: 14.5px; outline: 0; }
.b { height: 38px; padding: 0 18px; border-radius: 19px; font-size: 14.5px; white-space: nowrap; }
.b.main { background: var(--ink); color: var(--ink-inverse); }
.b:disabled { opacity: .4; }
.turns { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.turns li { padding: 10px 14px; border-radius: 14px; background: var(--field-bg); border-left: 3px solid var(--color-info); }
.when { font-size: 12px; color: var(--text-tertiary); }
.ask { font-size: 15px; font-weight: 500; margin: 2px 0 4px; }
.ans { font-size: 14.5px; line-height: 1.6; color: var(--text-primary); opacity: .9; }
.ans :deep(p) { margin: 0 0 6px; }
.ans :deep(table) { border-collapse: collapse; margin: 4px 0; font-size: 13.5px; }
.ans :deep(th), .ans :deep(td) { border: 1px solid var(--hairline); padding: 4px 10px; text-align: left; }
.src { font-size: 12.5px; color: var(--text-secondary); margin-top: 4px; }
</style>
