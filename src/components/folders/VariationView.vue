<script setup>
// 변형 하나: main 과 비교한 바뀐 파일 목록, 파일별 차이(텍스트는 줄 단위, 문서·미디어는 양쪽 미리보기와
// "바뀐 점"), 커밋, 그리고 작업실·인계·반영·버리기.
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '../Icon.vue'
import FIcon from './FIcon.vue'
import Avatar from './Avatar.vue'
import HandoverSheet from './HandoverSheet.vue'
import MergeSheet from './MergeSheet.vue'
import { folders as F, rawUrl, whoOf, statusLabel, sourceLabel, ago, prLabel } from '../../foldersApi.js'
import { kindOf, kindLabel, baseName, dirName, lineDiff, highlight, viewOf } from './fileKind.js'

const props = defineProps({ slug: String, vid: String })
const emit = defineEmits(['preview'])
const router = useRouter()
const v = ref(null)
const folder = ref(null)
const err = ref('')
const sel = ref('')
const diff = ref(null)
const mainCard = ref(null)
const handing = ref(false)
const merging = ref(false)
const toast = ref('')
const review = ref(null)          // skill: {pr, verification, canMerge}
const asking = ref(false)
const say = (t) => { toast.value = t; setTimeout(() => { if (toast.value === t) toast.value = '' }, 3200) }

// a poll that fails (the server restarting, a proxy 502) keeps what is on screen and says so,
// instead of replacing the page with the error
const stale = ref(false)
async function load({ quiet = false } = {}) {
  try {
    const [d, f] = await Promise.all([F.variation(props.slug, props.vid), F.get(props.slug)])
    v.value = d; folder.value = f
    if (f.kind === 'skill') review.value = await F.review(props.slug, props.vid).catch(() => null)
    if (!sel.value || !d.changes.some((c) => c.path === sel.value)) sel.value = d.changes[0]?.path || ''
    stale.value = false
  } catch (e) { if (quiet && v.value) stale.value = true; else err.value = e.message }
}
onMounted(load)
watch(() => props.vid, () => { sel.value = ''; load() })
let poll = setInterval(() => { if ((v.value?.status === 'open' || review.value?.verification?.status === 'running') && !handing.value && !merging.value) load({ quiet: true }) }, 4000)
// how long a running verification has been at it (it stops by itself after 20 minutes)
const tick = ref(Date.now())
const clock = setInterval(() => { tick.value = Date.now() }, 30000)
onBeforeUnmount(() => clearInterval(clock))
const verMin = computed(() => (review.value?.verification?.created_at ? Math.max(0, Math.round((tick.value - new Date(review.value.verification.created_at)) / 60000)) : 0))
onBeforeUnmount(() => clearInterval(poll))

const change = computed(() => v.value?.changes.find((c) => c.path === sel.value))
watch([sel, () => v.value?.head_commit], async () => {
  diff.value = null; mainCard.value = null
  if (!sel.value || !v.value) return
  diff.value = await F.diff(props.slug, props.vid, sel.value).catch(() => null)
  if (diff.value?.binary) mainCard.value = (await F.file(props.slug, sel.value).catch(() => null))?.card || null
})
const lines = computed(() => (diff.value && !diff.value.binary ? lineDiff(diff.value.base, diff.value.head) : []))
// open the diff at its first change, with a few lines of context above
const ud = ref(null)
watch(lines, async () => {
  await nextTick()
  const first = ud.value?.querySelector('.dl.add, .dl.del')
  if (first) ud.value.scrollTop = Math.max(0, first.offsetTop - 120)
})
const isCode = computed(() => viewOf(sel.value) === 'code')
const role = computed(() => v.value?.role)
const rank = (r) => ({ viewer: 1, runner: 2, editor: 3, owner: 4 })[r] || 0
const live = computed(() => v.value && !['merged', 'discarded'].includes(v.value.status))
const running = computed(() => v.value?.status === 'open' && v.value.worktree_path && v.value.kind !== 'person')
const fileCardLine = computed(() => v.value?.change_card?.files?.[sel.value] || '')
const img = (p) => viewOf(p) === 'image'

function openSide(which) {
  const p = sel.value
  if (which === 'main') emit('preview', { folder: folder.value, file: { path: p, card: mainCard.value }, ref: 'main' })
  else emit('preview', { folder: folder.value, file: { path: p, change: fileCardLine.value }, ref: v.value.id, refLabel: v.value.branch })
}
async function workroom() {
  try { const r = await F.checkout(props.slug, props.vid); router.push(r.workroom) } catch (e) { say(e.message) }
}
async function saveCheckout() {
  try { const r = await F.commit(props.slug, props.vid, { release: false }); say(r.commit ? '작업 사본의 변경을 이 변형에 저장했어요' : '저장할 변경이 없어요'); load() } catch (e) { say(e.message) }
}
async function discard() {
  if (!confirm('이 변형을 버릴까요? 브랜치는 보존 기간 동안 남아요.')) return
  try { await F.discard(props.slug, props.vid); load() } catch (e) { say(e.message) }
}
function handed(r) {
  handing.value = false
  say(r.mode === 'fork' ? `${r.to.name} 님에게 새 갈래를 만들어 넘겼어요` : `${r.to.name} 님에게 넘겼어요 — ${r.to.isAgent ? '에이전트가 이 변형에서 바로 일을 시작해요' : '알림이 갔어요'}`)
  if (r.mode === 'fork') router.push(`/folders/${props.slug}/v/${r.variation.id}`)
  else load()
}
const isSkill = computed(() => folder.value?.kind === 'skill')
const mayMerge = computed(() => (isSkill.value ? !!review.value?.canMerge : rank(role.value) >= 3))
async function requestMerge() {
  asking.value = true
  try { await F.requestMerge(props.slug, props.vid); say('반영 요청을 보냈어요 — 작성자와 에이전트 담당자에게 알림이 가요'); await load() } catch (e) { say(e.message) } finally { asking.value = false }
}
async function runVerify() {
  try { await F.verify(props.slug, props.vid); await load(); say('병합 전 검증을 시작했어요 — 변경 전과 후를 같은 요청으로 돌려 봐요') } catch (e) { say(e.message) }
}
const ver = computed(() => review.value?.verification)
function merged(r) { merging.value = false; load(); if (r?.status === 'done') say('main 에 반영했어요') }
</script>

<template>
  <div class="vv">
    <p v-if="err" class="missing">{{ err }}</p>
    <template v-else-if="v">
      <div class="head">
        <button class="back press" :title="folder?.name" @click="router.push(`/folders/${slug}`)"><Icon name="back" :size="18" /></button>
        <div class="ttl">
          <small class="crumb"><FIcon name="folder" :size="13" /> {{ folder?.name }} <span>/</span> 변형</small>
          <h1><span class="tt">{{ v.title }}</span> <span class="st" :class="v.status"><span v-if="running" class="spin" />{{ statusLabel[v.status] }}</span></h1>
          <span class="meta">
            <code><FIcon name="branch" :size="13" /> {{ v.branch }}</code>
            <span class="who"><Avatar :who="whoOf({ id: v.holder_id, name: v.holder_name, type: v.holder_type })" :size="20" /> 보유자 {{ v.holder_name }}</span>
            <span class="src" :class="v.kind">{{ sourceLabel[v.kind] }}</span><span class="lbl">{{ v.source?.label }}</span>
            <span class="ab">↑{{ v.ahead }} ↓{{ v.behind }}</span>
          </span>
        </div>
        <span class="sp" />
        <button v-if="live && rank(role) >= 2 && folder?.kind === 'managed'" class="pill-btn hbtn" :disabled="running" title="이 변형을 내 작업 사본으로 열어 파일·셸에서 고치기" @click="workroom"><FIcon name="terminal" :size="16" /> 작업실</button>
        <button v-if="v.kind === 'person' && v.worktree_path && live" class="pill-btn hbtn" @click="saveCheckout">변경 저장</button>
        <button v-if="live && rank(role) >= 2" class="pill-btn hbtn" :disabled="running" @click="handing = true"><FIcon name="handover" :size="16" /> 인계하기</button>
        <button v-if="isSkill && live && !mayMerge && !review?.pr" class="dark-btn hbtn" :disabled="v.status !== 'ready' || asking" @click="requestMerge"><FIcon name="merge" :size="16" /> {{ asking ? '보내는 중…' : '반영 요청' }}</button>
        <button v-if="live && mayMerge && folder?.kind !== 'linked'" class="dark-btn hbtn" :disabled="v.status !== 'ready'" @click="merging = true"><FIcon name="merge" :size="16" /> 이 변형 반영</button>
        <button v-if="live && rank(role) >= 2" class="ib press" title="버리기" @click="discard"><Icon name="trash" :size="16" /></button>
      </div>

      <div v-if="isSkill && review" class="rev glass">
        <div class="rh">
          <b>반영 요청</b>
          <span v-if="review.pr" class="prs" :class="review.pr.status">{{ prLabel[review.pr.status] }}</span>
          <span v-else class="muted">아직 보내지 않았어요</span>
          <span class="sp" />
          <b>병합 전 검증</b>
          <span v-if="ver?.status === 'running'" class="muted"><span class="spin" /> 변경 전·후로 돌려 보는 중…<template v-if="verMin"> {{ verMin }}분째(최대 20분)</template><template v-if="stale"> · 서버에 다시 연결하는 중</template></span>
          <span v-else-if="ver?.status === 'succeeded'" class="muted">시나리오 {{ ver.summary?.cases }}개 · 변경 전 통과 {{ ver.summary?.base_pass }} · 변경 후 통과 {{ ver.summary?.head_pass }}{{ ver.summary?.broken ? ` · 깨진 것 ${ver.summary.broken}` : '' }}</span>
          <span v-else-if="ver?.status === 'failed'" class="bad">검증 실패: {{ ver.error }}</span>
          <button v-if="live && ver?.status !== 'running'" class="tb press" @click="runVerify">{{ ver ? '다시 검증' : '검증 실행' }}</button>
        </div>
        <div v-if="ver?.status === 'succeeded'" class="vt2">
          <div class="vr th"><span>시나리오</span><span>변경 전 (main)</span><span>변경 후 (이 변형)</span></div>
          <div v-for="(r, i) in ver.results" :key="i" class="vr">
            <span class="cp">{{ r.case.prompt }}</span>
            <span :class="r.base.pass ? 'ok' : 'ng'"><i>{{ r.base.pass ? '통과' : '실패' }}</i> {{ r.base.note }}</span>
            <span :class="r.head.pass ? 'ok' : 'ng'"><i>{{ r.head.pass ? '통과' : '실패' }}</i> {{ r.head.note }}</span>
          </div>
        </div>
      </div>
      <p v-if="v.change_card?.summary" class="what glass"><FIcon name="index" :size="16" /> <span><b>바뀐 점</b> — {{ v.change_card.summary }}</span></p>

      <div class="cols">
        <aside class="side glass">
          <div class="sh">main 과 비교해 바뀐 파일 <b>{{ v.changes.length }}</b></div>
          <div class="cl scroll">
            <button v-for="c in v.changes" :key="c.path" class="ci press" :class="{ sel: sel === c.path }" @click="sel = c.path">
              <span class="ch" :class="c.change">{{ c.change }}</span>
              <span class="fic sm" :class="kindOf(c.path)">{{ kindLabel[kindOf(c.path)] }}</span>
              <span class="cn"><b>{{ baseName(c.path) }}</b><small>{{ dirName(c.path) || '/' }}</small></span>
              <span v-if="!c.binary" class="pm"><i class="a">+{{ c.add }}</i> <i class="d">−{{ c.del }}</i></span>
              <span v-else class="pm">문서</span>
            </button>
            <div v-if="!v.changes.length" class="wait">
              <template v-if="running"><span class="spin" /> {{ v.holder_name }}{{ v.holder_type === 'agent' ? '(에이전트)가' : ' 님이' }} 이 변형에서 일하는 중이에요. 끝나면 바뀐 파일이 여기 나타나요.</template>
              <template v-else>main 과 다른 파일이 없어요.</template>
            </div>
          </div>
          <div class="sh sm2">커밋</div>
          <div class="cm">
            <div v-for="c in v.commits" :key="c.sha" class="cmi"><code>{{ c.short }}</code><span>{{ c.msg }}</span><small><Avatar :who="whoOf({ name: c.name, id: c.name })" :size="16" /> {{ c.name }} · {{ ago(c.at) }}</small></div>
            <p v-if="!v.commits.length" class="muted">아직 커밋이 없어요. 실행이 끝나면 서버가 커밋해요.</p>
          </div>
        </aside>

        <section class="diff glass">
          <template v-if="change">
            <div class="dh">
              <span class="fic sm" :class="kindOf(change.path)">{{ kindLabel[kindOf(change.path)] }}</span>
              <code class="dp">{{ change.path }}</code>
              <span class="sp" />
              <button v-if="change.change !== 'A'" class="tb press" @click="openSide('main')">main 쪽 보기</button>
              <button v-if="change.change !== 'D'" class="tb press main" @click="openSide('var')">변형 쪽 보기</button>
            </div>
            <p v-if="!diff" class="muted pad">차이를 불러오는 중…</p>
            <div v-else-if="!diff.binary" ref="ud" class="ud scroll">
              <div v-for="(l, i) in lines" :key="i" class="dl" :class="{ add: l.t === '+', del: l.t === '-' }">
                <span class="no">{{ l.a || '' }}</span><span class="no">{{ l.b || '' }}</span><span class="sg">{{ l.t }}</span>
                <span class="tx" v-html="isCode ? highlight(l.s) : l.s.replace(/&/g, '&amp;').replace(/</g, '&lt;')" />
              </div>
            </div>
            <div v-else class="bin scroll">
              <p v-if="fileCardLine" class="whatf"><FIcon name="index" :size="16" /> <span><b>바뀐 점</b> — {{ fileCardLine }}</span></p>
              <div class="two">
                <div v-for="side in ['main', 'var']" :key="side" class="pane">
                  <div class="ph">{{ side === 'main' ? 'main' : '변형 · ' + v.branch }}</div>
                  <button class="thumb press" :disabled="(side === 'main' && change.change === 'A') || (side === 'var' && change.change === 'D')" @click="openSide(side)">
                    <img v-if="img(change.path)" :src="rawUrl(slug, change.path, side === 'main' ? 'main' : v.id)" />
                    <span v-else class="docph">
                      <span class="fic big" :class="kindOf(change.path)">{{ kindLabel[kindOf(change.path)] }}</span>
                      <b>{{ baseName(change.path) }}</b>
                      <small>{{ (side === 'main' && change.change === 'A') ? 'main 에는 없어요' : '눌러서 미리보기' }}</small>
                    </span>
                  </button>
                  <p class="cardtxt">{{ side === 'main' ? (mainCard?.abstract || '') : (fileCardLine || '') }}</p>
                </div>
              </div>
              <p class="muted">문서·이미지는 줄 단위로 합칠 수 없어서, 반영할 때 부딪치면 어느 쪽을 쓸지 골라요.</p>
            </div>
          </template>
          <div v-else class="empty">
            <FIcon name="branch" :size="28" />
            <p>{{ running ? '실행이 끝나면 main 과의 차이를 여기서 볼 수 있어요.' : '보여 줄 차이가 없어요.' }}</p>
          </div>
        </section>
      </div>

      <HandoverSheet v-if="handing" :folder="folder" :variation="v" :members="folder.members" @close="handing = false" @done="handed" />
      <MergeSheet v-if="merging" :folder="folder" :ids="[v.id]" @close="merging = false; load()" @done="merged" />
    </template>
    <Transition name="fade"><div v-if="toast" class="toast">{{ toast }}</div></Transition>
  </div>
</template>

<style scoped>
.vv { position: absolute; inset: 0; display: flex; flex-direction: column; padding: 0 24px 16px; max-width: 1400px; margin: 0 auto; }
.missing { text-align: center; color: var(--text-secondary); margin-top: 80px; }
.head { display: flex; align-items: flex-start; gap: 10px; margin: 0 0 12px; }
.back { flex: none; width: 40px; height: 40px; border-radius: 20px; display: grid; place-items: center; background: var(--button-bg); margin-top: 6px; }
.ib { flex: none; width: 40px; height: 40px; border-radius: 20px; display: grid; place-items: center; background: var(--button-bg); margin-top: 6px; color: var(--text-secondary); }
.ttl { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1; }
.crumb { display: flex; align-items: center; gap: 5px; font-size: 12.5px; color: var(--text-secondary); } .crumb span { opacity: .5; }
h1 { margin: 0; font-size: 22px; font-weight: 500; letter-spacing: -0.02em; display: flex; align-items: center; gap: 10px; min-width: 0; }
.tt { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12.5px; color: var(--text-secondary); }
.meta code { display: inline-flex; align-items: center; gap: 4px; font: 12px "SF Mono", Menlo, monospace; color: var(--text-primary); }
.who { display: inline-flex; align-items: center; gap: 5px; }
.ab { font-family: "SF Mono", Menlo, monospace; font-size: 11.5px; }
.sp { flex: 1; }
.hbtn { height: 40px; font-size: 14px; display: inline-flex; align-items: center; gap: 6px; padding: 0 16px; margin-top: 6px; flex: none; }
.pill-btn:disabled, .dark-btn:disabled { opacity: .4; cursor: default; }
.st { flex: none; display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 10px; border-radius: 12px; font-size: 12px; font-weight: 500; background: var(--button-bg); }
.st.ready { background: rgba(161 208 255 / .2); color: var(--color-info); } .st.open { background: rgba(255 160 60 / .18); color: #e08a2c; } .st.merged { background: rgba(150 240 176 / .18); color: var(--color-success); } .st.conflicted { background: #e0613f; color: #fff; }
.src { height: 20px; padding: 0 8px; border-radius: 10px; font-size: 11px; display: inline-flex; align-items: center; background: var(--button-bg); }
.src.run, .src.chat { color: #9b7cf0; } .src.instance { color: #e2a93b; } .src.person, .src.handover { color: var(--color-info); } .src.imported { color: #d97757; }
.spin { width: 10px; height: 10px; border-radius: 9999px; border: 2px solid currentColor; border-right-color: transparent; animation: spin .8s linear infinite; flex: none; }
.rev { margin: 0 0 12px; border-radius: 16px; padding: 10px 14px; font-size: 13.5px; }
.rh { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; } .rh b { font-weight: 600; font-size: 13.5px; }
.prs { height: 22px; padding: 0 9px; border-radius: 11px; font-size: 12px; display: inline-flex; align-items: center; background: rgba(123 92 214 / .2); color: #9b7cf0; }
.prs.MERGED { background: rgba(150 240 176 / .2); color: var(--color-success); }
.bad { color: var(--color-error); }
.vt2 { margin-top: 10px; display: flex; flex-direction: column; gap: 4px; max-height: 190px; overflow-y: auto; }
.vr { display: grid; grid-template-columns: 1.2fr 1fr 1fr; gap: 10px; font-size: 12.5px; line-height: 1.5; padding: 6px 0; border-top: 1px solid var(--hairline); }
.vr.th { color: var(--text-tertiary); border-top: 0; padding: 0; }
.vr i { font-style: normal; font-weight: 600; margin-right: 4px; } .vr .ok i { color: var(--color-success); } .vr .ng i { color: var(--color-error); }
.cp { color: var(--text-secondary); }
.what { margin: 0 0 12px; display: flex; gap: 8px; align-items: flex-start; padding: 10px 14px; border-radius: 14px; font-size: 14px; line-height: 1.55; }
.what svg, .whatf svg { flex: none; margin-top: 2px; color: var(--color-info); }
.cols { flex: 1; min-height: 0; display: grid; grid-template-columns: 330px minmax(0, 1fr); gap: 14px; }
.side, .diff { border-radius: 22px; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.sh { padding: 16px 16px 8px; font-size: 13px; color: var(--text-secondary); } .sh b { color: var(--text-primary); }
.sh.sm2 { border-top: 1px solid var(--hairline); padding-top: 12px; }
.cl { overflow-y: auto; padding: 0 8px 8px; flex: 1; min-height: 0; }
.ci { width: 100%; display: flex; align-items: center; gap: 8px; padding: 8px; border-radius: 12px; text-align: left; }
.ci:hover { background: var(--cell-bg); } .ci.sel { background: var(--cell-bg); box-shadow: inset 0 0 0 1.5px var(--color-info); }
.ch { flex: none; width: 20px; height: 20px; border-radius: 6px; display: grid; place-items: center; font-size: 11px; font-weight: 700; background: rgba(255 160 60 / .2); color: #e08a2c; }
.ch.A { background: rgba(15 157 88 / .18); color: var(--color-success); } .ch.D { background: rgba(214 69 69 / .18); color: var(--color-error); }
.fic { flex: none; width: 36px; height: 36px; border-radius: 10px; display: grid; place-items: center; font-size: 10px; font-weight: 700; color: #fff; background: #6b6b66; }
.fic.sm { width: 26px; height: 26px; border-radius: 7px; font-size: 8.5px; } .fic.big { width: 56px; height: 56px; border-radius: 14px; font-size: 13px; }
.fic.hwp { background: #1f6fd1; } .fic.doc { background: #2b579a; } .fic.xls { background: #217346; } .fic.ppt { background: #c43e1c; } .fic.pdf { background: #d93025; } .fic.cad { background: #0b6f88; } .fic.vec { background: #c2570c; } .fic.img { background: #7b3fbf; } .fic.snd { background: #0f8a5f; } .fic.vid { background: #b0223c; } .fic.md { background: #3d4f6b; } .fic.code { background: #2d333b; }
.cn { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.cn b { font-weight: 500; font-size: 13.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .cn small { font-size: 11.5px; color: var(--text-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pm { font: 11.5px "SF Mono", Menlo, monospace; color: var(--text-secondary); white-space: nowrap; }
.pm i { font-style: normal; } .pm .a { color: var(--color-success); } .pm .d { color: var(--color-error); }
.wait { display: flex; gap: 8px; align-items: flex-start; padding: 12px 8px; font-size: 13.5px; color: var(--text-secondary); line-height: 1.6; }
.wait .spin { margin-top: 5px; }
.cm { padding: 0 12px 14px; display: flex; flex-direction: column; gap: 6px; max-height: 34%; overflow-y: auto; }
.cmi { display: grid; grid-template-columns: 62px 1fr; gap: 2px 8px; font-size: 13px; }
.cmi code { font: 11.5px "SF Mono", Menlo, monospace; color: var(--text-secondary); grid-row: span 2; padding-top: 2px; }
.cmi small { display: flex; align-items: center; gap: 4px; color: var(--text-tertiary); font-size: 11.5px; }
.muted { font-size: 13px; color: var(--text-secondary); margin: 0; line-height: 1.6; }
.muted.pad { padding: 16px; }
.dh { display: flex; align-items: center; gap: 10px; height: 54px; padding: 0 12px 0 16px; border-bottom: 1px solid var(--hairline); flex: none; }
.dp { font: 12.5px "SF Mono", Menlo, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tb { height: 32px; padding: 0 12px; border-radius: 16px; font-size: 13px; font-weight: 500; background: var(--button-bg); white-space: nowrap; }
.tb.main { background: var(--ink); color: var(--ink-inverse); }
.ud { position: relative; flex: 1; min-height: 0; overflow: auto; padding: 8px 0; font: 12.5px/1.75 "SF Mono", Menlo, monospace; background: #fbfbf9; color: #24292f; }
.dl { display: flex; white-space: pre; min-width: max-content; }
.dl.add { background: #e6ffec; } .dl.del { background: #ffebe9; }
.dl .no { flex: none; width: 40px; padding-right: 8px; text-align: right; color: #a9a9a2; user-select: none; }
.dl .sg { flex: none; width: 18px; text-align: center; color: #8a8a84; }
.dl.add .sg { color: #1a7f37; } .dl.del .sg { color: #cf222e; }
.tx :deep(.k) { color: #cf222e; font-style: normal; } .tx :deep(.s) { color: #0a3069; font-style: normal; } .tx :deep(.c) { color: #6e7781; font-style: italic; } .tx :deep(.n) { color: #0550ae; font-style: normal; }
.bin { flex: 1; min-height: 0; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.whatf { margin: 0; display: flex; gap: 8px; align-items: flex-start; padding: 12px 14px; border-radius: 14px; background: rgba(161 208 255 / .14); font-size: 14px; line-height: 1.55; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.pane { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.ph { font: 12px "SF Mono", Menlo, monospace; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.thumb { height: 230px; border-radius: 14px; background: repeating-conic-gradient(rgba(127 127 127 / .1) 0 25%, transparent 0 50%) 0 0 / 18px 18px; border: 1px solid var(--hairline); display: grid; place-items: center; overflow: hidden; }
.thumb:disabled { opacity: .5; cursor: default; }
.thumb img { max-width: 100%; max-height: 100%; }
.docph { display: flex; flex-direction: column; align-items: center; gap: 8px; } .docph b { font-weight: 500; font-size: 14px; } .docph small { color: var(--text-secondary); font-size: 12.5px; }
.cardtxt { margin: 0; font-size: 13px; line-height: 1.6; color: var(--text-secondary); }
.empty { margin: auto; display: flex; flex-direction: column; align-items: center; gap: 8px; color: var(--text-tertiary); font-size: 14px; }
.dark-btn { background: var(--ink); color: var(--ink-inverse); }
.toast { position: fixed; left: 50%; bottom: 28px; translate: -50% 0; padding: 12px 18px; border-radius: 14px; background: #1d1d1f; color: #f5f5f7; font-size: 14px; z-index: 50; max-width: 90vw; }
</style>
