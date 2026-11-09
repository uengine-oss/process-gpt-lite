<script setup>
// 프로세스 마이닝 추천 (관리자)
//   /mining        반복되는 흐름 추천 목록
//   /mining/:id    찾은 흐름(단계·역할·도구·스킬·빈도·사례)과 결정(정식 등록 / 보류), 등록된 정의
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import TopBar from '../components/TopBar.vue'
import Icon from '../components/Icon.vue'
import BpmnView from '../components/BpmnView.vue'
import { useApp } from '../stores/app.js'
import { api } from '../api.js'

const app = useApp()
const route = useRoute()
const router = useRouter()
const id = computed(() => route.params.id || '')
const list = ref([])
const s = ref(null)
const def = ref(null)
const busy = ref('')
const err = ref('')
const denied = ref(false)
// 확인 필요: 마이너가 어느 업무인지 가리지 못한 사례. 관리자가 업무 범주를 정해 준다
const ask = ref({ cases: [], categories: [] })
const pick = ref({})
const askWhy = { no_category: '무슨 업무인지 아직 정하지 못했어요', no_core_step: '같은 업무의 단계를 하나도 거치지 않았어요' }

// the tools a step used, as recorded (lib/mining/catalog.js: Korean cases name them in Korean, English ones in English)
const toolIcon = { 메일: '✉', 캐드크래프트: '◫', 아래아한글: '한', 엑셀: '▦', '팀 공유': '⇄', Mail: '✉', CADCraft: '◫', Word: 'W', Excel: '▦', 'Team share': '⇄' }
const statusText = { suggested: '추천', registered: '정식 등록됨', held: '보류' }
const fmt = (d) => new Date(d).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' })
const span = computed(() => s.value ? `${fmt(s.value.pattern.first_seen)} ~ ${fmt(s.value.pattern.last_seen)}` : '')
const auto = computed(() => s.value ? Math.round((s.value.pattern.automation_rate || 0) * 100) : 0)

async function load() {
  err.value = ''
  try {
    if (id.value) {
      s.value = await api(`/mining/suggestions/${id.value}`)
      def.value = s.value.proc_def_id ? await api(`/processes/${encodeURIComponent(s.value.proc_def_id)}`).catch(() => null) : null
    } else {
      list.value = await api('/mining/suggestions')
      ask.value = await api('/mining/unclassified').catch(() => ({ cases: [], categories: [] }))
    }
  // (the admin-only refusal is a 403, in whichever language its message is)
  } catch (e) { if (e.status === 403) denied.value = true; else err.value = e.message }
}
async function decide(kind) {
  busy.value = kind
  err.value = ''
  try {
    s.value = await api(`/mining/suggestions/${id.value}/${kind}`, { method: 'POST' })
    def.value = s.value.proc_def_id ? await api(`/processes/${encodeURIComponent(s.value.proc_def_id)}`).catch(() => null) : null
  } catch (e) { err.value = e.message } finally { busy.value = '' }
}
async function rescan() {
  busy.value = 'scan'
  let failed = ''
  // (a proxy's HTML error page in place of our JSON: the plain notice, not the page source)
  try { await api('/mining/scan', { method: 'POST' }) } catch (e) { failed = e.message && !/^\s*</.test(e.message) ? e.message : '흐름을 찾지 못했어요. 잠시 후 다시 시도해 주세요.' }
  try { await load() } finally { busy.value = '' }
  // (load clears err: the failed search is shown after it)
  if (failed) err.value = failed
}
// 관리자가 고른 업무 범주는 판단을 덮고, 다음 찾기부터 그 범주로 묶인다
async function saveCategory(c) {
  const category = String(pick.value[c.case_id] || '').trim()
  if (!category) return
  busy.value = c.case_id
  err.value = ''
  try {
    await api('/mining/cases/category', { method: 'POST', body: { case_id: c.case_id, category } })
    delete pick.value[c.case_id]
    await load()
  } catch (e) { err.value = e.message } finally { busy.value = '' }
}
const defSteps = computed(() => (def.value?.steps || []).filter((x) => x.kind === 'human' || x.kind === 'agent'))
let timer
watch(() => s.value?.status, (v) => { clearInterval(timer); if (v === 'registered') timer = setInterval(() => api(`/mining/suggestions/${id.value}`).then((r) => { s.value = r }).catch(() => {}), 6000) })
watch(id, load)
onMounted(async () => {
  app.mode = 'mining'
  if (!app.me) app.me = await api('/me').catch(() => null)
  load()
})
</script>

<template>
  <div class="mining">
    <TopBar />
    <div class="content scroll">
      <div class="mv">
        <p v-if="denied" class="first glass">관리자만 볼 수 있어요.</p>

        <!-- 목록 -->
        <template v-else-if="!id">
          <div class="head">
            <h1>프로세스 마이닝</h1>
            <span class="sub">사람과 에이전트가 주고받은 인계 기록에서 반복되는 흐름을 찾아 정식 프로세스로 추천해요.</span>
            <span class="sp" />
            <button class="hbtn glass press" :disabled="busy === 'scan'" @click="rescan"><Icon name="refresh" :size="15" /> {{ busy === 'scan' ? '찾는 중…' : '지금 다시 찾기' }}</button>
          </div>
          <p v-if="err" class="err" role="alert">{{ err }}</p>
          <p v-if="!list.length && !err" class="first glass">아직 반복되는 흐름이 없어요. 같은 일이 몇 번 더 쌓이면 여기에 추천이 나와요.</p>
          <button v-for="x in list" :key="x.id" class="row glass press" @click="router.push(`/mining/${x.id}`)">
            <span class="st" :class="x.status">{{ statusText[x.status] }}</span>
            <b>{{ x.name }}</b>
            <small>{{ (x.steps || []).join(' → ') }}</small>
            <span class="n">{{ x.case_count }}건</span>
          </button>
          <section v-if="ask.cases.length" class="askbox">
            <h2>확인 필요 <small>어떤 업무인지 알려 주시면 다음 찾기부터 그 업무로 묶여요</small></h2>
            <div v-for="c in ask.cases" :key="c.case_id" class="arow glass">
              <b>{{ c.subject || c.case_id }}</b>
              <small class="why">{{ askWhy[c.category_ask] || c.category_ask }}</small>
              <small class="st2">{{ (c.steps || []).join(' → ') }}</small>
              <div class="pickrow">
                <input v-model="pick[c.case_id]" list="mining-categories" class="cat" placeholder="업무 범주" @keyup.enter="saveCategory(c)">
                <button class="hbtn glass press" :disabled="busy === c.case_id || !String(pick[c.case_id] || '').trim()" @click="saveCategory(c)">
                  {{ busy === c.case_id ? '…' : '정하기' }}
                </button>
              </div>
            </div>
            <datalist id="mining-categories"><option v-for="t in ask.categories" :key="t" :value="t" /></datalist>
          </section>
          <details class="rule">
            <summary>사례는 어떻게 묶이나요?</summary>
            <p>메일 한 통이 사례 하나예요. 고객에게 회신하면 그 사례는 끝나고, 그 뒤의 공유는 사례에 넣지 않아요.
              사례가 끝나면 무엇을 요청받은 업무인지(업무 범주)를 한 번 정해 두고, 같은 범주의 사례끼리 묶어요. 단계 이름이 얼마나 겹치는지는 보지 않아요.
              그래서 검토 단계가 다르거나 한 단계를 건너뛴 사례도 같은 업무면 한 추천으로 모여요. 여러 건(기본 4건 이상) 모이면 추천이 돼요.
              정식 등록하거나 보류한 프로세스는 경계가 그대로 지켜져요. 두 프로세스가 사례가 쌓였다고 한 추천으로 합쳐지지 않아요.
              팀 공유는 공유한 문서(평면도·제안서·견적서)로 검토 단계 이름이 정해지고, 문서가 없을 때만 받는 사람의 역할로 정해져요.</p>
          </details>
        </template>

        <!-- 한 추천 -->
        <template v-else-if="s">
          <button class="back press" @click="router.push('/mining')"><Icon name="back" :size="16" /> 프로세스 마이닝</button>
          <div class="hero">
            <span class="badge">프로세스 마이닝이 찾은 반복 흐름</span>
            <span class="st" :class="s.status">{{ statusText[s.status] }}</span>
            <h1 class="serif">{{ s.name }}</h1>
            <p v-if="s.summary" class="sum">{{ s.summary }}</p>
            <div class="stats">
              <span><b>{{ s.pattern.case_count }}</b>건 반복</span>
              <span><b>{{ s.pattern.event_count }}</b>개 인계 기록</span>
              <span>에이전트 처리 <b>{{ auto }}</b>%</span>
              <span>{{ span }}</span>
            </div>
          </div>

          <section>
            <h2>찾은 흐름 <small>단계마다 맡은 역할, 쓴 도구와 스킬, 몇 건에서 나왔는지</small></h2>
            <ol class="flow">
              <li v-for="(x, i) in s.steps" :key="x.activity" class="step glass" :style="{ '--i': i }">
                <div class="top"><span class="no">{{ i + 1 }}</span><span class="kind" :class="x.kind">{{ x.kind === 'agent' ? '에이전트' : '사람' }}</span><span class="freq">{{ x.cases }}/{{ s.pattern.case_count }}건</span></div>
                <b class="nm">{{ x.activity }}</b>
                <span class="role">{{ x.role || x.performers[0] }}</span>
                <div class="tools">
                  <span v-for="t in x.tools" :key="t" class="tool"><i>{{ toolIcon[t] || '•' }}</i>{{ t }}</span>
                </div>
                <div class="skills"><code v-for="k in x.skills" :key="k">{{ k }}</code></div>
                <small class="who">{{ x.performers.join(', ') }}</small>
              </li>
            </ol>
          </section>

          <section>
            <h2>실제 처리 사례 <small>메일 한 통이 한 사례예요</small></h2>
            <div class="cases">
              <div v-for="c in s.cases" :key="c.case_id" class="case glass">
                <div class="ch"><b>{{ c.customer }}</b><span class="when">{{ fmt(c.created_at) }} · {{ c.minutes >= 60 ? `${Math.round(c.minutes / 6) / 10}시간` : `${c.minutes}분` }}</span><span v-if="c.demo" class="demo">예시 데이터</span></div>
                <small class="subj">{{ c.subject }}</small>
                <div class="trail">
                  <span v-for="(e, k) in c.steps" :key="k" class="dot" :class="{ agent: e.agent }" :title="`${e.activity} · ${e.who}`">{{ e.activity.split(' ')[0] }}</span>
                </div>
              </div>
            </div>
          </section>

          <section class="evid">
            <h2>근거</h2>
            <p v-for="v in s.pattern.variants" :key="v.trace.join()" class="var"><b>{{ v.count }}건</b> {{ v.trace.join(' → ') }}</p>
            <p v-if="s.pr" class="pr">process-gpt 제안 <code>{{ s.pr.title }}</code> · 브랜치 <code>{{ s.pr.branch_name }}</code> · {{ s.pr.status }}</p>
          </section>

          <div v-if="s.status === 'suggested'" class="decide glass">
            <div class="dt">
              <b>{{ busy === 'register' ? '프로세스 정의를 만드는 중이에요…' : '이 흐름을 정식 프로세스로 등록할까요?' }}</b>
              <small>등록하면 BPMN·양식·역할·단계별 스킬이 담긴 프로세스 정의가 만들어지고, 다음 비슷한 메일부터 이 프로세스가 알아서 시작돼요.</small>
            </div>
            <button class="hold press" :disabled="!!busy" @click="decide('hold')">{{ busy === 'hold' ? '보류하는 중…' : '보류' }}</button>
            <button class="go press" :disabled="!!busy" @click="decide('register')">{{ busy === 'register' ? '만드는 중…' : '정식 등록' }}</button>
          </div>
          <p v-if="err" class="err">{{ err }}</p>

          <template v-if="s.status === 'registered'">
            <section class="reg">
              <h2>등록된 프로세스 <small>{{ s.proc_def_id }} · 양식 {{ s.saved?.forms || defSteps.length }}개</small></h2>
              <BpmnView v-if="s.proc_def_id" :def-id="s.proc_def_id" :height="300" class="bpmn glass" />
              <div class="tbl glass">
                <div class="tr th"><span>단계</span><span>담당</span><span>실행</span><span>스킬</span></div>
                <div v-for="x in defSteps" :key="x.id" class="tr">
                  <span><b>{{ x.name }}</b></span>
                  <span>{{ x.role }}</span>
                  <span><span class="kind" :class="x.kind">{{ x.kind === 'agent' ? '에이전트 자동 실행' : '사람 · 역할 담당자에게 알림' }}</span></span>
                  <span class="skills"><code v-for="k in x.skills" :key="k">{{ k }}</code></span>
                </div>
              </div>
            </section>
            <section>
              <h2>이 프로세스로 처리 중인 메일</h2>
              <p v-if="!s.runs.length" class="muted">아직 없어요. 비슷한 메일이 오면 여기에 나와요.</p>
              <button v-for="r in s.runs" :key="r.proc_inst_id" class="run glass press" @click="router.push(`/projects/p/${encodeURIComponent(r.proc_inst_id)}`)">
                <span class="st" :class="r.status === 'COMPLETED' ? 'registered' : 'suggested'">{{ r.status === 'COMPLETED' ? '완료' : '진행 중' }}</span>
                <b>{{ r.mail.customer }}</b><small>{{ r.mail.subject }}</small><Icon name="chevron" :size="14" />
              </button>
            </section>
          </template>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mining { position: absolute; inset: 0; }
.content { position: absolute; top: 84px; left: 0; right: 0; bottom: 0; }
.content.scroll { overflow-y: auto; }
.mv { max-width: 1120px; margin: 0 auto; padding: 0 24px 60px; }
.head { display: flex; align-items: baseline; gap: 14px; margin: 6px 0 18px; flex-wrap: wrap; }
h1 { margin: 0; font-size: 30px; font-weight: 500; letter-spacing: -0.02em; }
.sub, .muted { color: var(--text-secondary); font-size: 14.5px; }
.sp { flex: 1; }
.hbtn { height: 40px; padding: 0 16px; border-radius: 20px; font-size: 14px; display: inline-flex; align-items: center; gap: 6px; align-self: center; }
.rule { margin: 14px 4px 0; font-size: 13px; color: var(--text-secondary); }
.rule summary { cursor: pointer; }
.rule p { margin: 8px 0 0; line-height: 1.6; }
.first { border-radius: 22px; padding: 36px; text-align: center; color: var(--text-secondary); }
.row { width: 100%; display: grid; grid-template-columns: 96px 220px 1fr 60px; gap: 14px; align-items: center; text-align: left; padding: 14px 18px; border-radius: 20px; margin-bottom: 8px; }
.row small { color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.n { text-align: right; color: var(--text-secondary); }
/* 확인 필요: 어느 업무인지 가리지 못한 사례 — 관리자가 업무 범주를 정한다 */
.askbox { margin-top: 18px; }
.arow { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px 14px; align-items: center; padding: 12px 18px; border-radius: 20px; margin-bottom: 8px; }
.arow b { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.arow .why { grid-column: 1; color: var(--color-attention); font-size: 12.5px; }
.arow .st2 { grid-column: 1; color: var(--text-secondary); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pickrow { grid-column: 2; grid-row: 1 / span 3; display: flex; gap: 8px; align-items: center; }
.cat { height: 40px; width: 160px; padding: 0 14px; border-radius: 20px; border: 1px solid var(--line, rgba(128, 128, 128, .35)); background: transparent; color: var(--text-primary); font-size: 14px; }
@media (max-width: 720px) {
  .arow { grid-template-columns: minmax(0, 1fr); }
  .pickrow { grid-column: 1; grid-row: auto; }
  .cat { width: 100%; }
}
.st { display: inline-flex; align-items: center; justify-content: center; height: 24px; padding: 0 10px; border-radius: 12px; font-size: 12.5px; background: var(--color-attention); color: #fff; width: fit-content; }
.st.registered { background: var(--color-success); color: #0b2a17; }
.st.held { background: var(--chip-bg); color: var(--text-secondary); }
.back { display: inline-flex; align-items: center; gap: 6px; color: var(--text-secondary); font-size: 14px; margin: 2px 0 10px; }
.hero { margin-bottom: 18px; }
.badge { font-size: 13px; color: var(--text-secondary); margin-right: 8px; }
.hero h1 { font-size: 40px; margin: 8px 0 4px; }
.sum { margin: 0 0 10px; color: var(--text-primary); opacity: .85; font-size: 16px; }
.stats { display: flex; gap: 18px; flex-wrap: wrap; color: var(--text-secondary); font-size: 14px; }
.stats b { color: var(--text-primary); font-size: 18px; font-weight: 600; margin-right: 2px; }
section { margin-top: 24px; }
h2 { font-size: 17px; font-weight: 500; margin: 0 0 10px; }
h2 small { font-size: 13px; color: var(--text-tertiary); font-weight: 400; margin-left: 8px; }
.flow { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; }
.step { position: relative; border-radius: 20px; padding: 12px 12px 12px; display: flex; flex-direction: column; gap: 5px; min-width: 0; animation: blur-in .45s var(--spring) both; animation-delay: calc(var(--i) * 70ms); }
.step:not(:last-child)::after { content: '›'; position: absolute; right: -9px; top: 50%; translate: 0 -50%; color: var(--text-tertiary); font-size: 18px; z-index: 1; }
.top { display: flex; align-items: center; gap: 6px; }
.no { width: 20px; height: 20px; border-radius: 10px; background: var(--chip-bg); display: grid; place-items: center; font-size: 11.5px; }
.kind { font-size: 11.5px; padding: 1px 7px; border-radius: 8px; background: var(--chip-bg); color: var(--text-secondary); }
.kind.agent { background: rgba(161 208 255 / .2); color: var(--color-info); }
.freq { margin-left: auto; font-size: 11.5px; color: var(--text-secondary); }
.nm { font-size: 15.5px; font-weight: 600; line-height: 1.3; }
.role { font-size: 13px; color: var(--text-secondary); }
.tools { display: flex; flex-wrap: wrap; gap: 4px; }
.tool { font-size: 12px; padding: 2px 8px 2px 4px; border-radius: 10px; background: var(--field-bg); display: inline-flex; align-items: center; gap: 4px; }
.tool i { font-style: normal; width: 16px; height: 16px; border-radius: 5px; background: var(--chip-bg); display: inline-grid; place-items: center; font-size: 10px; }
.skills { display: flex; flex-wrap: wrap; gap: 4px; }
code { font-size: 11.5px; padding: 1px 6px; border-radius: 6px; background: rgba(150 240 176 / .14); color: var(--color-success); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.who { font-size: 11.5px; color: var(--text-tertiary); }
.cases { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.case { border-radius: 18px; padding: 12px 16px; display: flex; flex-direction: column; gap: 4px; }
.ch { display: flex; align-items: baseline; gap: 10px; }
.when { color: var(--text-secondary); font-size: 13px; }
.demo { margin-left: auto; font-size: 11px; color: var(--text-tertiary); border: 1px solid var(--hairline); border-radius: 8px; padding: 0 6px; }
.subj { color: var(--text-secondary); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.trail { display: flex; gap: 4px; margin-top: 4px; flex-wrap: wrap; }
.dot { font-size: 11.5px; padding: 2px 8px; border-radius: 9px; background: var(--chip-bg); }
.dot.agent { background: rgba(161 208 255 / .2); color: var(--color-info); }
.evid .var { margin: 3px 0; font-size: 14px; color: var(--text-secondary); }
.evid .var b { color: var(--text-primary); margin-right: 6px; }
.pr { font-size: 13px; color: var(--text-secondary); }
.pr code { background: var(--field-bg); color: var(--text-primary); }
.decide { position: sticky; bottom: 16px; margin-top: 24px; border-radius: 24px; padding: 14px 14px 14px 22px; display: flex; align-items: center; gap: 12px; }
.dt { flex: 1; display: flex; flex-direction: column; gap: 3px; }
.dt small { color: var(--text-secondary); font-size: 13px; }
.hold, .go { height: 44px; padding: 0 22px; border-radius: 22px; font-size: 15.5px; }
.hold { background: var(--button-bg); }
.go { background: var(--color-attention); color: #fff; font-weight: 500; }
.go:disabled, .hold:disabled { opacity: .6; }
.err { color: var(--color-error); }
.bpmn { border-radius: 20px; padding: 8px; margin-bottom: 10px; overflow: hidden; }
.tbl { border-radius: 20px; padding: 6px 8px; }
.tr { display: grid; grid-template-columns: 1.2fr 1fr 1.4fr 1.2fr; gap: 12px; padding: 9px 12px; align-items: center; font-size: 14px; border-top: 1px solid var(--hairline); }
.tr.th { border-top: 0; font-size: 12.5px; color: var(--text-tertiary); }
.run { width: 100%; display: flex; align-items: center; gap: 12px; padding: 12px 18px; border-radius: 18px; margin-bottom: 8px; text-align: left; }
.run small { color: var(--text-secondary); flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
