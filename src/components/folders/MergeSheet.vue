<script setup>
// 일괄 반영: 고른 변형의 순서를 정하고 → 서버가 차례로 합치고 → 충돌이면 멈춰서(stop) 쪽을 고르거나
// 해결 에이전트에게 맡기고 → 모두 들어가면 main 이 한 번에 바뀐다.
import { ref, computed, onMounted } from 'vue'
import Icon from '../Icon.vue'
import FIcon from './FIcon.vue'
import Avatar from './Avatar.vue'
import { folders as F, whoOf } from '../../foldersApi.js'
import { baseName, lineDiff } from './fileKind.js'

const props = defineProps({ folder: Object, ids: Array, integration: Object })
const emit = defineEmits(['close', 'done'])
const byId = (id) => props.folder.variations.find((v) => v.id === id)
const order = ref([...(props.ids || [])])
const policy = ref('stop')
const run = ref(props.integration || null)   // the server's integration row
const phase = computed(() => !run.value ? 'order' : run.value.status === 'done' ? 'done' : ['conflicted', 'resolving'].includes(run.value.status) ? 'conflict' : run.value.status === 'aborted' ? 'aborted' : 'running')
const working = ref(false)
const err = ref('')
const sides = ref([])          // per conflicted file: {path, binary, ours, theirs, base, variation}
const choice = ref({})
const siblings = ref([])
const drop = ref([])
const vars = computed(() => order.value.map(byId).filter(Boolean))
function move(i, d) { const o = [...order.value]; const [x] = o.splice(i, 1); o.splice(i + d, 0, x); order.value = o }

async function loadSides() {
  sides.value = []
  choice.value = {}
  for (const c of run.value.conflicts || []) sides.value.push(await F.mergeSides(props.folder.slug, run.value.id, c.path))
}
onMounted(() => { if (run.value && phase.value === 'conflict') loadSides() })
async function after(r) {
  run.value = r
  if (phase.value === 'conflict') await loadSides()
  if (phase.value === 'done') {
    const merged = new Set(r.variation_ids)
    // siblings = other runs of the same step of the same instance (parallel or reworked attempts)
    const key = (v) => (v?.kind === 'run' && v.source?.proc_inst_id ? `${v.source.proc_inst_id}|${v.source.label}` : null)
    const groups = new Set(r.variation_ids.map((id) => key(byId(id))).filter(Boolean))
    siblings.value = props.folder.variations.filter((v) => !merged.has(v.id) && v.status === 'ready' && groups.has(key(v)))
    drop.value = siblings.value.map((v) => v.id)
  }
}
async function act(fn) {
  working.value = true; err.value = ''
  try { await after(await fn()) } catch (e) { err.value = e.message } finally { working.value = false }
}
const start = () => act(() => F.merge(props.folder.slug, order.value, policy.value))
const choose = () => act(() => F.mergeChoose(props.folder.slug, run.value.id, choice.value))
const agent = () => act(() => F.mergeAgent(props.folder.slug, run.value.id))
async function abort() {
  await act(() => F.mergeAbort(props.folder.slug, run.value.id))
  emit('close')
}
async function close() {
  if (phase.value === 'done') {
    for (const id of drop.value) await F.discard(props.folder.slug, id).catch(() => {})
    emit('done', run.value)
  } else emit('close')
}
const diffLines = (a, b) => lineDiff(a || '', b || '').filter((l) => l.t !== ' ')
const allChosen = computed(() => sides.value.length && sides.value.every((s) => choice.value[s.path]))
const stepTitle = (s) => s.title || byId(s.variation_id)?.title
const policyText = { stop: '멈추고 알려 줘요', agent: '해결 에이전트에게 맡겨요', choose: '파일마다 한쪽을 골라요' }
const conflictVar = computed(() => sides.value[0]?.variation)
</script>

<template>
  <div class="veil" @click.self="!working && close()">
    <div class="box glass">
      <header class="hd">
        <FIcon name="merge" :size="20" />
        <b>일괄 반영 — {{ folder.name }}</b>
        <span class="sp" />
        <button class="ic press" title="닫기" :disabled="working" @click="close"><Icon name="close" :size="16" /></button>
      </header>

      <div class="body scroll">
        <template v-if="phase === 'order'">
          <p class="lead">고른 변형 {{ vars.length }}개를 위에서부터 차례로 합친 뒤, 모두 잘 합쳐졌을 때만 main 을 한 번에 바꿔요.</p>
          <ol class="ord">
            <li v-for="(v, i) in vars" :key="v.id">
              <span class="n">{{ i + 1 }}</span>
              <Avatar :who="whoOf({ id: v.holder_id, name: v.holder_name, type: v.holder_type })" :size="26" />
              <span class="vm"><b>{{ v.title }}</b><small>{{ v.branch }}</small></span>
              <button class="ic press" :disabled="i === 0" title="위로" @click="move(i, -1)"><Icon name="up" :size="15" /></button>
              <button class="ic press" :disabled="i === vars.length - 1" title="아래로" @click="move(i, 1)"><Icon name="up" :size="15" style="rotate: 180deg" /></button>
            </li>
          </ol>
          <div class="sec">충돌이 나면</div>
          <div class="pol">
            <label v-for="(t, k) in policyText" :key="k" :class="{ on: policy === k }"><input v-model="policy" type="radio" :value="k" /> {{ t }}<small v-if="k === 'stop'"> · 기본</small></label>
          </div>
          <p class="fine">반영하기 전에 main 에서 사람이 고친 내용을 먼저 저장해 두어요. 문서·미디어 파일이 부딪치면 어느 쪽을 쓸지 고르는 방법만 쓸 수 있어요.</p>
        </template>

        <template v-else>
          <ol class="run">
            <li v-for="s in run.steps" :key="s.variation_id" :class="{ bad: !s.ok }">
              <span class="st"><Icon v-if="s.ok" name="check" :size="15" /><Icon v-else name="alert" :size="15" /></span>
              <span class="vm"><b>{{ stepTitle(s) }}</b><small>{{ s.ok ? (s.resolved ? (s.resolved.agent ? '해결 에이전트가 풀고 합쳤어요' : '고른 쪽으로 풀고 합쳤어요') : '합쳤어요') : '여기서 충돌이 났어요 — main 은 그대로예요' }}</small></span>
            </li>
            <li v-if="working" class="wait"><span class="spin" /> {{ run.status === 'resolving' || phase === 'conflict' ? '해결하는 중…' : '합치는 중…' }}</li>
          </ol>

          <div v-if="phase === 'conflict'" class="conf">
            <div v-for="sd in sides" :key="sd.path" class="cf">
              <div class="ch"><Icon name="alert" :size="16" /> <b>{{ baseName(sd.path) }}</b> 을(를) 양쪽에서 다르게 고쳤어요</div>
              <div class="sides">
                <div v-for="w in ['ours', 'theirs']" :key="w" class="side" :class="{ pick: choice[sd.path] === w }">
                  <div class="sh">{{ w === 'ours' ? 'main (앞서 합친 것 포함)' : `변형 · ${sd.variation.title}` }}</div>
                  <pre v-if="!sd.binary"><span v-for="(l, j) in diffLines(sd.base, sd[w])" :key="j" :class="l.t === '+' ? 'add' : 'del'">{{ l.t }} {{ l.s }}
</span></pre>
                  <p v-else class="bin">문서·미디어 파일이라 줄 단위로 합칠 수 없어요.</p>
                  <button class="pick-btn press" @click="choice = { ...choice, [sd.path]: w }">{{ choice[sd.path] === w ? '이쪽을 써요 ✓' : '이쪽 쓰기' }}</button>
                </div>
              </div>
            </div>
            <div class="fix">
              <button v-if="sides.every((s) => !s.binary)" class="tb press" :disabled="working" @click="agent"><FIcon name="agent" :size="15" /> 해결 에이전트에게 맡기기</button>
              <span class="hint2">{{ conflictVar ? `'${conflictVar.title}' 을(를) 합치다 멈췄어요` : '' }}</span>
            </div>
          </div>

          <div v-if="phase === 'done'" class="done">
            <div class="big"><Icon name="check" :size="22" /> main 에 반영했어요</div>
            <p>새 기준 <code>{{ String(run.result_commit || '').slice(0, 7) }}</code> · 변형 {{ run.variation_ids.length }}개가 '반영됨' 이 됐어요. 색인과 문서 카드도 새로 만들어요.</p>
            <div v-if="siblings.length" class="sib">
              <div class="sec">같이 돌린 갈래 중 고르지 않은 것</div>
              <label v-for="v in siblings" :key="v.id"><input v-model="drop" type="checkbox" :value="v.id" /> {{ v.title }} <small>— 버림으로 표시해요</small></label>
            </div>
          </div>
          <p v-if="phase === 'aborted'" class="fine">반영을 그만뒀어요. main 은 그대로예요.</p>
        </template>
        <p v-if="err" class="badmsg">{{ err }}</p>
      </div>

      <footer class="ft">
        <template v-if="phase === 'order'">
          <span class="hint">충돌 시: {{ policyText[policy] }}</span>
          <button class="dark-btn" :disabled="working || !vars.length" @click="start">{{ working ? '반영하는 중…' : '반영 시작' }}</button>
        </template>
        <template v-else-if="phase === 'conflict'">
          <span class="hint">풀고 나면 남은 변형을 이어서 합쳐요</span>
          <button class="pill-btn" :disabled="working" @click="abort">그만두기</button>
          <button class="dark-btn" :disabled="!allChosen || working" @click="choose">계속</button>
        </template>
        <template v-else><button class="dark-btn" @click="close">확인</button></template>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.veil { position: fixed; inset: 0; z-index: 45; background: rgba(20, 24, 32, .3); display: grid; place-items: center; padding: 24px; animation: fade-in .2s both; }
.box { width: min(760px, 100%); max-height: calc(100vh - 48px); border-radius: 24px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 18px 60px rgba(0, 0, 0, .3); animation: pop-in .4s var(--spring) both; --regular-bg: var(--regular-solid-bg); }
.hd { display: flex; align-items: center; gap: 10px; height: 58px; padding: 0 14px 0 20px; border-bottom: 1px solid var(--hairline); font-size: 16px; flex: none; }
.sp { flex: 1; }
.ic { width: 32px; height: 32px; border-radius: 16px; display: grid; place-items: center; background: var(--button-bg); }
.ic:disabled { opacity: .3; cursor: default; }
.body { flex: 1; min-height: 0; padding: 18px 20px; overflow-y: auto; }
.lead { margin: 0 0 14px; font-size: 14.5px; line-height: 1.6; }
.ord, .run { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.ord li, .run li { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 14px; background: var(--cell-bg); border: 1px solid var(--hairline); }
.n { width: 22px; height: 22px; border-radius: 11px; display: grid; place-items: center; font-size: 12px; font-weight: 600; background: var(--ink); color: var(--ink-inverse); }
.vm { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.vm b { font-weight: 500; font-size: 14.5px; } .vm small { color: var(--text-secondary); font-size: 12.5px; }
.ord .vm small { font-family: "SF Mono", Menlo, monospace; }
.st { width: 26px; height: 26px; border-radius: 13px; display: grid; place-items: center; background: rgba(15 157 88 / .15); color: var(--color-success); }
.run li.bad { border-color: rgba(224 97 63 / .5); } .run li.bad .st { background: #e0613f; color: #fff; }
.wait { color: var(--text-secondary); font-size: 14px; }
.spin { width: 14px; height: 14px; border-radius: 9999px; border: 2px solid currentColor; border-right-color: transparent; animation: spin .8s linear infinite; }
.sec { font-size: 12.5px; color: var(--text-tertiary); margin: 18px 0 8px; letter-spacing: .04em; }
.pol { display: flex; flex-wrap: wrap; gap: 8px; }
.pol label { height: 38px; padding: 0 14px; border-radius: 19px; background: var(--button-bg); display: inline-flex; align-items: center; gap: 6px; font-size: 13.5px; cursor: pointer; }
.pol label.on { background: var(--ink); color: var(--ink-inverse); }
.pol input { display: none; } .pol small { opacity: .7; }
.fine { font-size: 12.5px; color: var(--text-secondary); line-height: 1.6; margin: 14px 0 0; }
.conf { margin-top: 14px; border-radius: 16px; border: 1px solid rgba(224 97 63 / .45); padding: 14px; background: rgba(224 97 63 / .06); }
.cf + .cf { margin-top: 14px; }
.ch { display: flex; align-items: center; gap: 6px; font-size: 14px; color: #e0613f; } .ch b { color: var(--text-primary); }
.sides { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 12px; }
.side { border-radius: 12px; background: var(--regular-solid-bg); border: 2px solid transparent; padding: 10px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.side.pick { border-color: var(--color-info); }
.sh { font-size: 13px; font-weight: 500; }
pre { margin: 0; font: 11.5px/1.6 "SF Mono", Menlo, monospace; white-space: pre-wrap; word-break: break-all; max-height: 220px; overflow: auto; }
.add { display: block; background: rgba(15 157 88 / .14); } .del { display: block; background: rgba(214 69 69 / .14); }
.bin { font-size: 13px; color: var(--text-secondary); margin: 0; }
.pick-btn { height: 32px; border-radius: 10px; background: var(--button-bg); font-size: 13px; font-weight: 500; }
.fix { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; align-items: center; }
.hint2 { font-size: 12.5px; color: var(--text-secondary); }
.tb { height: 34px; padding: 0 12px; border-radius: 17px; background: var(--button-bg); font-size: 13px; display: inline-flex; align-items: center; gap: 6px; }
.tb:disabled { opacity: .45; cursor: default; }
.done { margin-top: 14px; }
.big { display: flex; align-items: center; gap: 8px; font-size: 19px; font-weight: 500; color: var(--color-success); }
.done p { font-size: 14px; color: var(--text-secondary); }
.sib label { display: flex; align-items: center; gap: 8px; font-size: 14px; padding: 4px 0; } .sib small { color: var(--text-secondary); }
.badmsg { color: var(--color-error); font-size: 13.5px; margin: 12px 0 0; }
.ft { display: flex; align-items: center; justify-content: flex-end; gap: 10px; padding: 12px 16px; border-top: 1px solid var(--hairline); flex: none; }
.ft .hint { margin-right: auto; font-size: 13px; color: var(--text-secondary); }
.ft .dark-btn, .ft .pill-btn { height: 42px; }
.dark-btn { background: var(--ink); color: var(--ink-inverse); }
</style>
