<script setup>
// 프로세스 마이닝 추천 (관리자)
//   /mining        반복되는 흐름 추천 목록
//   /mining/:id    찾은 흐름(단계·역할·도구·스킬·빈도·사례)과 결정(정식 등록 / 보류), 등록된 정의
//                  단계마다 필수·옵션(빈도 초안 / 관리자 확정), 새 사례 제안, 관리자와의 대화(lib/mining/talk.js)
import { ref, computed, onMounted, watch, nextTick } from 'vue'
import { marked } from 'marked'
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
// 대화: 이 추천의 식별 근거를 묻고, 단계 필수·옵션과 사례가 속한 프로세스를 고친다
const talkOpen = ref(false)
const talk = ref([])
const said = ref('')
const talking = ref(false)
const talkBox = ref(null)
const talkInput = ref(null)
const md = (t) => marked.parse(String(t || '').replace(/</g, '&lt;'), { breaks: true })
// 필수·옵션은 프로세스 정의(BPMN)가 말하는 것: 옵션 = 배타 게이트웨이로 건너뛰는 길이 있는 단계. 건수는 근거
const kindText = { required: '필수', optional: '옵션', absent: '정의에 없음' }
const stepTip = (d) => d ? `${kindText[d.kind]}${d.skip_when ? ` — ${d.skip_when} 건너뜀` : ''} · 사례 ${d.cases}/${d.total}건이 거침${d.by === 'admin' ? ' · 관리자 확정' : ''}` : ''
// 대표 순서에 없는 단계(분기·건너뜀으로만 나온 단계)
const moreSteps = computed(() => (s.value?.decided || []).filter((d) => !(s.value.steps || []).some((x) => x.activity === d.activity)))

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
      talk.value = await api(`/mining/suggestions/${id.value}/talk`).catch(() => [])
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
async function openTalk() {
  talkOpen.value = true
  await nextTick()
  talkInput.value?.focus()
  talkBox.value?.scrollTo({ top: 1e6 })
}
async function send() {
  const text = said.value.trim()
  if (!text || talking.value) return
  said.value = ''
  talking.value = true
  talk.value.push({ id: `me-${Date.now()}`, role: 'admin', text })
  await nextTick(); talkBox.value?.scrollTo({ top: 1e6, behavior: 'smooth' })
  try {
    const r = await api(`/mining/suggestions/${id.value}/talk`, { method: 'POST', body: { text } })
    talk.value.push(r.message)
    s.value = r.suggestion
  } catch (e) { talk.value.push({ id: `err-${Date.now()}`, role: 'agent', text: e.message || '답하지 못했어요.', failed: true }) }
  finally { talking.value = false; await nextTick(); talkBox.value?.scrollTo({ top: 1e6, behavior: 'smooth' }); talkInput.value?.focus() }
}
// 제안(같은 업무의 새 사례)을 버튼으로도 정할 수 있다 — 대화와 같은 서버 동작
async function proposal(accept) {
  said.value = accept ? '새 사례를 이 프로세스에 넣어 줘' : '새 사례는 이 프로세스가 아니야, 넣지 마'
  await openTalk()
  await send()
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
            <span class="n">{{ x.case_count }}건<i v-if="x.proposal_count" class="newdot" :title="`새 사례 ${x.proposal_count}건이 제안으로 와 있어요`">+{{ x.proposal_count }}</i></span>
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
              단계 빈도는 필수·옵션의 초안이에요. 추천을 열어 대화로 근거를 묻고 필수·옵션과 사례의 소속을 고쳐 확정해요.
              한 번 보인 추천과 정식 등록·보류한 프로세스는 관리자가 정하기 전에는 바뀌지 않아요. 같은 업무의 새 사례는 제안으로 와요.
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
                <span v-if="x.decided" class="req" :class="[x.decided.kind, x.decided.by]" :title="stepTip(x.decided)"><Icon v-if="x.decided.by === 'admin'" name="lock" :size="11" />{{ kindText[x.decided.kind] }}</span>
                <b class="nm">{{ x.activity }}</b>
                <span class="role">{{ x.role || x.performers[0] }}</span>
                <div class="tools">
                  <span v-for="t in x.tools" :key="t" class="tool"><i>{{ toolIcon[t] || '•' }}</i>{{ t }}</span>
                </div>
                <div class="skills"><code v-for="k in x.skills" :key="k">{{ k }}</code></div>
                <small class="who">{{ x.performers.join(', ') }}</small>
              </li>
            </ol>
            <div v-if="moreSteps.length" class="more">
              <span v-for="d in moreSteps" :key="d.activity" class="req" :class="[d.kind, d.by]" :title="stepTip(d)"><Icon v-if="d.by === 'admin'" name="lock" :size="11" />{{ d.activity }} · {{ d.cases }}/{{ d.total }}건 · {{ kindText[d.kind] }}</span>
            </div>
          </section>

          <section v-if="s.proposal?.case_count" class="prop">
            <div class="ph">
              <h2>제안 <small>같은 업무로 보이는 새 사례 {{ s.proposal.case_count }}건 · 정하기 전에는 프로세스가 바뀌지 않아요</small></h2>
              <span class="sp" />
              <button class="hold press" :disabled="talking" @click="proposal(false)">넣지 않기</button>
              <button class="go press" :disabled="talking" @click="proposal(true)">반영</button>
            </div>
            <div class="cases">
              <div v-for="c in s.proposal.cases" :key="c.case_id" class="case glass">
                <div class="ch"><b>{{ c.customer }}</b><span class="when">{{ fmt(c.created_at) }}</span></div>
                <small class="subj">{{ c.subject }}</small>
                <div class="trail">
                  <span v-for="(e, k) in c.steps" :key="k" class="dot" :class="{ agent: e.agent }" :title="`${e.activity} · ${e.who}`">{{ e.activity.split(' ')[0] }}</span>
                  <span v-for="m in c.missing" :key="m" class="dot miss" :title="`필수 단계 ${m} 를 거치지 않았어요`">{{ m }} ✕</span>
                </div>
              </div>
            </div>
          </section>

          <section>
            <h2>실제 처리 사례 <small>메일 한 통이 한 사례예요</small></h2>
            <div class="cases">
              <div v-for="c in s.cases" :key="c.case_id" class="case glass">
                <div class="ch"><b>{{ c.customer }}</b><span class="when">{{ fmt(c.created_at) }} · {{ c.minutes >= 60 ? `${Math.round(c.minutes / 6) / 10}시간` : `${c.minutes}분` }}</span><span v-if="c.demo" class="demo">예시 데이터</span></div>
                <small class="subj">{{ c.subject }}</small>
                <div class="trail">
                  <span v-for="(e, k) in c.steps" :key="k" class="dot" :class="{ agent: e.agent }" :title="`${e.activity} · ${e.who}`">{{ e.activity.split(' ')[0] }}</span>
                  <span v-for="m in c.missing" :key="m" class="dot miss" :title="`필수 단계 ${m} 를 거치지 않았어요`">{{ m }} ✕</span>
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

    <!-- 이 추천과의 대화: 둥근 버튼(다른 화면의 대화 버튼과 같은 모양)으로 열고 닫는다 -->
    <template v-if="id && s && !denied">
      <Transition name="drawer">
        <aside v-if="talkOpen" class="talk glass" aria-label="이 추천과 대화">
          <div class="th2"><b>{{ s.name }}</b><button class="x press" aria-label="대화 닫기" @click="talkOpen = false"><Icon name="close" :size="16" /></button></div>
          <div ref="talkBox" class="msgs">
            <p v-if="!talk.length" class="muted hint2">왜 이렇게 묶였는지 묻거나, 단계의 필수·옵션과 사례가 속한 프로세스를 말로 고쳐 주세요.</p>
            <div v-for="m in talk" :key="m.id" class="msg" :class="[m.role, { failed: m.failed }]">
              <div class="bubble md" v-html="md(m.text)" />
              <small v-if="m.change?.length" class="chg"><Icon name="check" :size="11" /> 반영됨</small>
            </div>
            <div v-if="talking" class="msg agent"><div class="bubble"><span class="shimmer-text">확인하는 중</span></div></div>
          </div>
          <form class="say" @submit.prevent="send">
            <input ref="talkInput" v-model="said" placeholder="예: 재무 검토는 옵션이야" :disabled="talking" aria-label="대화 입력">
            <button class="send press" :disabled="talking || !said.trim()" aria-label="보내기"><Icon name="up" :size="16" /></button>
          </form>
        </aside>
      </Transition>
      <button v-if="!talkOpen" class="dial press" :class="{ busy: talking }" aria-label="이 추천과 대화 열기" title="이 추천에 대해 묻고 고치기" @click="openTalk">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12a8.5 8.5 0 0 1-12.3 7.6L3 21l1.4-5.4A8.5 8.5 0 1 1 21 12z" />
          <path d="M8.5 11.5h.01M12 11.5h.01M15.5 11.5h.01" stroke-width="2.6" />
        </svg>
        <i v-if="s.proposal?.case_count" class="dialdot" />
      </button>
    </template>
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
/* 필수·옵션: 관리자 확정은 채운 배지(자물쇠), 빈도 초안은 점선 */
.req { display: inline-flex; align-items: center; gap: 3px; width: fit-content; font-size: 11.5px; padding: 1px 8px; border-radius: 9px; border: 1px dashed var(--hairline); color: var(--text-secondary); }
.req.required { color: var(--text-primary); }
.req.admin { border-style: solid; background: var(--chip-bg); }
.more { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.dot.miss { background: transparent; border: 1px dashed var(--color-attention); color: var(--color-attention); }
.newdot { font-style: normal; margin-left: 6px; font-size: 11.5px; padding: 1px 6px; border-radius: 8px; background: var(--color-attention); color: #fff; }
.prop .ph { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
.prop .ph h2 { margin: 0; }
.prop .ph .hold, .prop .ph .go { height: 36px; padding: 0 16px; font-size: 14px; }
/* 대화 */
.dial { position: absolute; right: 24px; bottom: 96px; width: 56px; height: 56px; border-radius: 50%; display: grid; place-items: center; z-index: 6;
  color: var(--text-primary); background: var(--button-bg); box-shadow: 0 8px 28px rgba(0, 0, 0, .28); animation: pop-in .4s var(--spring); }
.dial.busy::after { content: ''; position: absolute; inset: -5px; border-radius: 50%; border: 2px solid rgba(160, 140, 255, .9); border-right-color: transparent; animation: spin 1.1s linear infinite; }
.dialdot { position: absolute; top: 8px; right: 8px; width: 10px; height: 10px; border-radius: 50%; background: var(--color-attention); }
@keyframes spin { to { transform: rotate(360deg); } }
.talk { position: absolute; right: 16px; top: 96px; bottom: 16px; width: 400px; max-width: calc(100% - 32px); z-index: 6; border-radius: 24px; display: flex; flex-direction: column; overflow: hidden; }
.th2 { display: flex; align-items: center; gap: 8px; padding: 12px 12px 8px 18px; }
.th2 b { flex: 1; font-size: 15px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.x { width: 32px; height: 32px; border-radius: 16px; display: grid; place-items: center; }
.msgs { flex: 1; overflow-y: auto; padding: 4px 14px 10px; display: flex; flex-direction: column; gap: 8px; }
.hint2 { font-size: 13px; line-height: 1.5; margin: 8px 4px; }
.msg { display: flex; flex-direction: column; max-width: 92%; }
.msg.admin { align-self: flex-end; align-items: flex-end; }
.bubble { padding: 9px 13px; border-radius: 16px; font-size: 13.5px; line-height: 1.55; background: var(--field-bg); }
.msg.admin .bubble { background: var(--color-attention); color: #fff; }
.msg.failed .bubble { color: var(--color-error); }
.bubble :deep(p) { margin: 0 0 .4em; } .bubble :deep(p:last-child) { margin: 0; }
.bubble :deep(ul) { margin: 0 0 .4em; padding-left: 18px; }
.chg { display: inline-flex; align-items: center; gap: 3px; margin-top: 3px; font-size: 11.5px; color: var(--color-success); }
.say { display: flex; gap: 8px; padding: 10px 12px 12px; border-top: 1px solid var(--hairline); }
.say input { flex: 1; height: 40px; padding: 0 14px; border-radius: 20px; border: 1px solid var(--line, rgba(128, 128, 128, .35)); background: transparent; color: var(--text-primary); font-size: 14px; }
.send { width: 40px; height: 40px; border-radius: 20px; display: grid; place-items: center; background: var(--color-attention); color: #fff; }
.send:disabled { opacity: .5; }
.drawer-enter-active, .drawer-leave-active { transition: opacity .25s, transform .3s var(--spring); }
.drawer-enter-from, .drawer-leave-to { opacity: 0; transform: translateX(24px); }
@media (max-width: 720px) { .talk { left: 16px; right: 16px; width: auto; } }
</style>
