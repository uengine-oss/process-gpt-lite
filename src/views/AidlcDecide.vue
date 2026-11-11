<script setup>
// AI-DLC 결정 (docs/robo-dlc/plan-team.md): 폴더의 Claude Code 세션이 지금 사람에게 묻는 것.
//   - 세션 화면의 선택 창(답하는 방식·요약 확인·단계 승인·도구 권한): 고른 번호가 그 선택 창에 그대로 들어가요
//   - 답이 빈 질문 파일: 여기서 적거나, 몹 회의에서 합의한 답을 확인해 적으면 세션에 알려요
//   - 이 폴더의 결정 기록(원장)
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import TopBar from '../components/TopBar.vue'
import { api } from '../api.js'
import { useTeam } from '../stores/team.js'
import { useApps } from '../stores/apps.js'

const route = useRoute()
const router = useRouter()
const team = useTeam()
// the review board and the document viewer, when this Lite has them (server/apps)
const apps = useApps()
apps.load()
const hasApp = (id) => !!apps.byId(id)
const original = (path, focus = '') => apps.open('artifact', slug.value, { path, focus })
const slug = computed(() => route.params.folder)
const v = ref(null)
const err = ref('')
const busy = ref('')
const toast = ref('')
const freeText = ref('')
const drafts = ref({})          // path -> { Q1: 'A', … }
const say = (t) => { toast.value = t; setTimeout(() => { if (toast.value === t) toast.value = '' }, 3200) }

async function load() {
  try {
    v.value = await api(`/aidlc/${encodeURIComponent(slug.value)}/decide`)
    err.value = ''
    // a mob meeting's agreed answers fill the form the first time it shows
    for (const f of v.value.questions) {
      if (drafts.value[f.path]) continue
      const p = v.value.proposal?.questions_path === f.path ? v.value.proposal.answers : {}
      drafts.value[f.path] = Object.fromEntries(f.questions.filter((x) => !x.answer).map((x) => [x.id, p[x.id]?.answer || '']))
    }
  } catch (e) { err.value = e.status === 403 ? '이 폴더의 구성원만 볼 수 있어요.' : e.message }
}
onMounted(load)
const timer = setInterval(load, 5000)
onBeforeUnmount(() => clearInterval(timer))

const choice = computed(() => v.value?.session?.choice || null)
const free = computed(() => choice.value?.options.find((o) => o.freeText) || null)
const why = (path, id) => (v.value?.proposal?.questions_path === path ? v.value.proposal.answers?.[id]?.why : '') || ''
const openQs = (f) => f.questions.filter((x) => !x.answer)
const kindText = { approval: '단계 승인', summary: '요약 확인', 'answer-mode': '질문에 답하는 방식', permission: '도구 권한', choice: '선택' }

async function pick(o) {
  if (o.freeText && !freeText.value.trim()) return say('보낼 글을 먼저 적어 주세요.')
  busy.value = `o${o.n}`
  try {
    const out = await api(`/aidlc/${encodeURIComponent(slug.value)}/decide`, { method: 'POST', body: { fingerprint: choice.value.fingerprint, option: o.n, text: o.freeText ? freeText.value : undefined } })
    say(`세션에 「${out.answered}」를 넣었어요.`)
    freeText.value = ''
    setTimeout(load, 1200)
  } catch (e) { say(e.status === 409 ? '세션 화면이 그새 바뀌었어요. 다시 볼게요.' : e.message); load() } finally { busy.value = '' }
}
async function submit(f) {
  const answers = Object.fromEntries(Object.entries(drafts.value[f.path] || {}).filter(([, a]) => String(a).trim()))
  if (!Object.keys(answers).length) return say('답을 하나 이상 골라 주세요.')
  busy.value = f.path
  try {
    const out = await api(`/aidlc/${encodeURIComponent(slug.value)}/answers`, { method: 'POST', body: { path: f.path, answers, proposalId: v.value.proposal?.questions_path === f.path ? v.value.proposal.id : undefined } })
    say(`질문 ${Object.keys(out.written).length}개의 답을 파일에 적었어요${out.told ? ' — 세션에도 알렸어요.' : '.'}`)
    delete drafts.value[f.path]
    setTimeout(load, 1200)
  } catch (e) { say(e.message) } finally { busy.value = '' }
}
async function mob() {
  busy.value = 'mob'
  try {
    const out = await api(`/aidlc/${encodeURIComponent(slug.value)}/mob`, { method: 'POST' })
    team.openMessenger(out.roomId)
  } catch (e) { say(e.message) } finally { busy.value = '' }
}
const when = (d) => new Date(d).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })
</script>

<template>
  <div class="aidlc-decide">
    <TopBar />
    <div class="content scroll">
      <div class="mv">
        <p v-if="err" class="first glass" role="alert">{{ err }}</p>
        <template v-else-if="v">
          <div class="head">
            <h1>AI-DLC 결정</h1>
            <span class="sub">{{ v.folder.name }}<template v-if="v.intent"> · {{ v.intent.slug }} · {{ v.intent.scope }}</template></span>
            <span class="sp" />
            <button class="hbtn glass press" data-test="open-session" @click="router.push(`/workroom/aidlc/${v.folder.slug}`)">세션 보기</button>
            <button class="hbtn glass press" @click="router.push(`/folders/${v.folder.slug}`)">폴더</button>
          </div>
          <p v-if="v.stage" class="stage glass">
            <span>지금 단계 <b>{{ v.stage.name }}</b></span>
            <span>담당 역할 <b>{{ v.role }}</b><template v-if="v.deciders.length"> · {{ v.deciders.map((p) => p.name).filter(Boolean).join(', ') }}</template></span>
            <span v-if="!v.canDecide" class="muted">결정은 담당자나 폴더 편집 권한이 있는 사람이 해요. 보기만 할 수 있어요.</span>
          </p>

          <!-- the prompt on the session screen -->
          <section v-if="choice" class="card glass" data-test="aidlc-prompt">
            <div class="ct"><span class="kind">{{ kindText[choice.kind] || '선택' }}</span><b>{{ choice.title }}</b></div>
            <pre v-if="choice.detail" class="detail" data-test="aidlc-prompt-detail">{{ choice.detail }}</pre>
            <p v-if="choice.question" class="q">{{ choice.question }}</p>
            <div class="opts">
              <button v-for="o in choice.options.filter((x) => !x.freeText)" :key="o.n" class="opt press" :class="{ main: o.n === 1 }"
                :disabled="!v.canDecide || !!busy" :data-test="`opt-${o.n}`" @click="pick(o)">
                <b>{{ busy === `o${o.n}` ? '넣는 중…' : o.label }}</b><small v-if="o.hint">{{ o.hint }}</small>
              </button>
            </div>
            <form v-if="free" class="free" @submit.prevent="pick(free)">
              <input v-model="freeText" :disabled="!v.canDecide" placeholder="다른 답 — 예: Request Changes: 결정권자를 팀 리드로 바로잡아 주세요" data-test="free-text" />
              <button class="dark-btn" :disabled="!v.canDecide || !freeText.trim() || !!busy">보내기</button>
            </form>
            <p class="note">고른 답은 팀 세션의 이 선택 창에 그대로 들어가요. AI-DLC 감사 기록에는 사람의 답으로 남아요.</p>
            <!-- an approval is about documents: open the originals, whole -->
            <div v-if="choice.kind === 'approval' && v.docs?.length && hasApp('artifact')" class="docs" data-test="aidlc-originals">
              <span class="muted">원본 보기</span>
              <button v-for="d in v.docs" :key="d.path" class="doc press" @click="original(d.path)">📄 {{ d.name }}</button>
            </div>
            <div v-if="choice.kind === 'approval' && v.review?.findings?.length && hasApp('review')" class="row">
              <span class="muted">검토 지적 {{ v.review.findings.length }}개를 역할별로 나눠 함께 보고, 결정을 묶어 넣을 수 있어요.</span><span class="sp" />
              <button class="tb press" data-test="aidlc-to-board" @click="router.push(`/apps/review/${slug}`)">검토 보드에서 함께 보기</button>
            </div>
          </section>
          <p v-else-if="!v.session.running" class="first glass">이 폴더의 Claude Code 세션이 꺼져 있어요. 폴더 화면에서 「세션 시작」을 누르세요.</p>

          <!-- question files waiting for answers -->
          <section v-for="f in v.questions.filter((x) => x.open > 0)" :key="f.path" class="card glass" data-test="aidlc-questions">
            <div class="ct"><span class="kind">질문</span><b>{{ f.stage }} · 답을 기다리는 질문 {{ f.open }}개</b><span class="sp" />
              <button v-if="hasApp('review')" class="tb press" data-test="aidlc-to-board" @click="router.push(`/apps/review/${slug}`)">검토 보드에서 나눠 보기</button>
              <button class="tb press" :disabled="!!busy" data-test="aidlc-mob" @click="mob">몹 회의 열기</button></div>
            <p v-if="v.proposal?.questions_path === f.path" class="from-mob">몹 회의에서 합의한 답을 채워 두었어요. 확인하고 적으세요.</p>
            <div v-for="x in openQs(f)" :key="x.id" class="qa">
              <p class="qt"><b>{{ x.id }}</b><span v-if="x.tag" class="tag">{{ x.tag }}</span> {{ x.text }}</p>
              <div class="opts small">
                <button v-for="o in x.options" :key="o.key" class="opt press" :class="{ on: drafts[f.path]?.[x.id] === o.key }" :disabled="!v.canDecide"
                  @click="drafts[f.path][x.id] = o.key"><b>{{ o.key }}</b> {{ o.text }}</button>
              </div>
              <small v-if="why(f.path, x.id)" class="why">회의: {{ why(f.path, x.id) }}</small>
            </div>
            <div class="row"><code>{{ f.path }}</code><span class="sp" />
              <button class="dark-btn" :disabled="!v.canDecide || busy === f.path" data-test="aidlc-submit-answers" @click="submit(f)">{{ busy === f.path ? '적는 중…' : '파일에 적고 세션에 알리기' }}</button></div>
          </section>

          <section v-if="v.review" class="card glass">
            <div class="ct"><span class="kind">검토</span><b>{{ v.stage?.name }} 검토 · {{ v.review.verdict }}</b></div>
            <p class="muted">지적 {{ v.review.findings.length }}개(Major {{ v.review.major }} · Minor {{ v.review.minor }}) — 승인하면 남은 지적은 위험으로 받아들여요. 내용은 세션 화면과 <code>{{ v.review.path }}</code>에 있어요.</p>
            <ul class="findings">
              <li v-for="f in v.review.findings" :key="f.id"><b>{{ f.id }}</b> <span class="tag">{{ f.severity }}</span> {{ f.finding }}
                <span v-if="hasApp('artifact')" class="refs"><button v-for="r in f.refs || []" :key="r.path + r.focus" class="doc press" data-test="aidlc-finding-ref" @click="original(r.path, r.focus)">📄 {{ r.label }}</button></span></li>
            </ul>
          </section>

          <section v-if="v.ledger.length" class="card glass">
            <div class="ct"><span class="kind">기록</span><b>이 폴더의 결정 기록</b></div>
            <ul class="ledger">
              <li v-for="(d, i) in v.ledger" :key="i"><span class="muted">{{ when(d.created_at) }}</span> <b>{{ d.who }}</b> · {{ d.stage }} · {{ d.choice }}<template v-if="d.note"> — {{ d.note }}</template></li>
            </ul>
          </section>
        </template>
      </div>
    </div>
    <div v-if="toast" class="toast glass" role="status">{{ toast }}</div>
  </div>
</template>

<style scoped>
.aidlc-decide { position: absolute; inset: 0; }
.content { position: absolute; top: 84px; left: 0; right: 0; bottom: 0; }
.content.scroll { overflow-y: auto; }
.mv { max-width: 880px; margin: 0 auto; padding: 0 24px 60px; }
.head { display: flex; align-items: baseline; gap: 14px; margin: 6px 0 14px; flex-wrap: wrap; }
h1 { margin: 0; font-size: 30px; font-weight: 500; letter-spacing: -0.02em; }
.sub, .muted { color: var(--text-secondary); font-size: 14px; }
.sp { flex: 1; }
.hbtn { height: 38px; padding: 0 15px; border-radius: 19px; font-size: 14px; align-self: center; }
.first { border-radius: 22px; padding: 28px; text-align: center; color: var(--text-secondary); }
.stage { display: flex; gap: 18px; flex-wrap: wrap; align-items: center; border-radius: 18px; padding: 12px 18px; margin: 0 0 14px; font-size: 14px; }
.card { border-radius: 22px; padding: 18px 20px; margin-bottom: 14px; }
.ct { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.ct b { font-size: 16px; font-weight: 600; }
.kind { font-size: 12px; padding: 2px 9px; border-radius: 9px; background: rgba(10 132 255 / .14); color: #0a84ff; }
.q { margin: 0 0 12px; line-height: 1.6; white-space: pre-wrap; }
.detail { margin: 0 0 10px; padding: 10px 12px; border-radius: 12px; background: rgba(0 0 0 / .06); font: 12.5px/1.6 ui-monospace, Menlo, monospace; white-space: pre-wrap; }
.opts { display: flex; flex-direction: column; gap: 8px; }
.opts.small { flex-direction: row; flex-wrap: wrap; gap: 6px; }
.opt { text-align: left; border-radius: 14px; padding: 10px 14px; border: 1px solid var(--line, rgba(0 0 0 / .1)); background: var(--chip-bg); color: inherit; font: inherit; display: flex; flex-direction: column; gap: 2px; }
.opts.small .opt { flex-direction: row; gap: 6px; padding: 6px 11px; font-size: 13.5px; }
.opt.main { border-color: #0a84ff; }
.opt.on { background: #0a84ff; color: #fff; border-color: #0a84ff; }
.opt small { color: var(--text-secondary); font-size: 12.5px; }
.free { display: flex; gap: 8px; margin-top: 10px; }
.free input { flex: 1; font: inherit; padding: 9px 12px; border-radius: 12px; border: 1px solid var(--line, rgba(0 0 0 / .12)); background: transparent; color: inherit; }
.note { margin: 10px 0 0; font-size: 12.5px; color: var(--text-tertiary); }
.qa { padding: 10px 0; border-top: 1px solid var(--line, rgba(0 0 0 / .06)); }
.qt { margin: 0 0 8px; line-height: 1.55; }
.tag { font-size: 11.5px; margin: 0 4px; padding: 1px 6px; border-radius: 6px; background: var(--chip-bg); color: var(--text-secondary); }
.why { display: block; margin-top: 6px; color: var(--text-secondary); }
.from-mob { margin: 0 0 6px; font-size: 13px; color: #0a84ff; }
.row { display: flex; align-items: center; gap: 10px; margin-top: 12px; }
.row code { font-size: 12px; color: var(--text-tertiary); }
.ledger { list-style: none; margin: 0; padding: 0; font-size: 13.5px; line-height: 1.8; }
.docs { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 12px; font-size: 13px; }
.doc { font-size: 12.5px; padding: 4px 10px; border-radius: 99px; background: rgba(10 132 255 / .1); color: #0a84ff; border: 0; }
.findings { list-style: none; margin: 8px 0 0; padding: 0; font-size: 13.5px; line-height: 1.55; display: flex; flex-direction: column; gap: 8px; }
.findings .refs { display: inline-flex; flex-wrap: wrap; gap: 4px; margin-left: 4px; }
.toast { position: fixed; left: 50%; bottom: 28px; translate: -50% 0; padding: 10px 18px; border-radius: 16px; font-size: 14px; z-index: 50; }
</style>
