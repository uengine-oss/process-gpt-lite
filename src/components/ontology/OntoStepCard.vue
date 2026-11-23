<script setup>
// 건의 단계가 사람을 기다릴 때 주인에게 오는 카드(server lib/ontology/runmode.js askOwner): 단계마다 사람이 정함이면 「다음은 X예요 —
// 진행할까요?」(갈림길이면 왜 이쪽인지와 다른 갈래), 되돌릴 수 없는 단계면 만든 초안과 「보낼까요?」, 책임 단계면 「사람이 정해야 해요」.
// 답(진행 · 다른 갈래 · 멈추기)은 카드에 남아(server 가 content 를 고친다) 다른 화면에서도 같다.
import { ref, computed } from 'vue'
import { api } from '../../api.js'
import { pct } from './fmt.js'
import OntoSheet from './OntoSheet.vue'
import OntoCasePanel from './OntoCasePanel.vue'
import OntoBindings from './OntoBindings.vue'
import { RO, EUL, EUN, IEYO, holderText } from './ontoText.js'

const props = defineProps({ msg: Object })
const c = computed(() => props.msg.content || {})
const busy = ref('')
const err = ref('')
const sheet = ref(false)
const outward = computed(() => (c.value.why || []).includes('irreversible'))
// the step's role has nobody yet (server mapengine.js holdUnbound): the owner picks who does it — the step goes on then
const unbound = computed(() => (c.value.why || []).includes('unbound'))
const picked = ref(false)
const others = computed(() => c.value.proposal?.others || [])
const answered = computed(() => c.value.state !== 'ask')
// 해도 되고 안 해도 되는 단계(server steprule.js): 진행 · 건너뛰기. 꼭 하는 단계를 다른 갈래로 지나치려 하면 서버가 먼저 알리고 까닭을 받는다
const optional = computed(() => c.value.requirement === 'optional')
const pass = ref(null) // {action, to, line, reason}

async function decide(action, to = '', extra = {}) {
  busy.value = action; err.value = ''
  try {
    const r = await api(`/ontology/steps/${encodeURIComponent(c.value.stepId)}`, { method: 'POST', body: { action, to, ...extra } })
    pass.value = r?.confirm ? { action, to, line: r.line || '', reason: '' } : null
  } catch (e) { err.value = e.message } finally { busy.value = '' }
}
const result = computed(() => {
  const a = c.value.answer
  if (c.value.state === 'released') return c.value.note ? `${c.value.note} — 「${c.value.task}」${EUL(c.value.task)} 이어서 해요.` : `「${c.value.task}」${EUL(c.value.task)} 이어서 해요.`
  if (c.value.state === 'moved') return c.value.note || '이 단계는 닫혔어요.'
  if (!a) return ''
  if (a.action === 'stop') return '멈췄어요. 「이어 가기」를 누르면 다시 물어요.'
  if (a.action === 'other') return `「${a.to}」${RO(a.to)} 옮겨 이어 가요.`
  if (a.action === 'skip') return `「${c.value.task}」${EUL(c.value.task)} 건너뛰었어요${a.reason ? ` — ${a.reason}` : ''}.`
  return a.sent ? '보낸 것으로 기록했어요. 이 판에서는 실제로 보내지 않아요.' : `「${c.value.task}」${EUL(c.value.task)} 진행해요.`
})
</script>

<template>
  <div class="os" data-testid="onto-case-ask" :data-state="c.state" :data-task="c.task" :data-why="(c.why || []).join(',')">
    <div class="q">
      <span v-if="c.subject" class="sub">{{ c.subject }}<template v-if="c.from"> · {{ c.from }}</template></span>
      <template v-if="unbound">「{{ c.task }}」{{ EUL(c.task) }} 하려면 「{{ c.role }}」{{ EUL(c.role || '') }} 맡을 사람을 정해야 해요.</template>
      <template v-else-if="outward">「{{ c.task }}」 초안을 만들었어요. 회사 밖으로 나가는 단계라 되돌릴 수 없어요 — 보낼까요?</template>
      <template v-else-if="(c.why || []).includes('hitl')">다음은 「{{ c.task }}」{{ IEYO(c.task) }} — {{ optional ? '진행할까요, 건너뛸까요?' : '진행할까요?' }}</template>
      <template v-else-if="(c.why || []).includes('optional')">「{{ c.task }}」, 이 건에도 할까요? 해도 되고 안 해도 되는 단계라 건너뛸 수 있어요.</template>
      <template v-else>「{{ c.task }}」{{ EUL(c.task) }} 하기 전에 사람이 정해야 해요. 진행할까요?</template>
    </div>
    <ul class="why"><li v-for="(w, i) in c.whyText || []" :key="i">{{ w }}</li></ul>
    <small v-if="c.reqLine" class="hold" data-testid="onto-case-ask-req" :data-requirement="c.requirement || ''">{{ c.reqLine }}</small>
    <p v-if="c.proposal?.why && !outward" class="prop">
      <span v-if="c.proposal.from" class="cap">{{ c.proposal.from }}에서</span> {{ c.proposal.why }}<template v-if="c.proposal.split && c.proposal.p != null"> · {{ pct(c.proposal.p) }}</template>
    </p>
    <div v-if="c.preview" class="pv">
      <small v-if="c.preview.to">받는 사람 · {{ c.preview.to }}</small>
      <small v-if="c.preview.subject">제목 · {{ c.preview.subject }}</small>
      <p>{{ c.preview.text }}</p>
    </div>
    <small v-if="c.holder && !c.holder.agent" class="hold">넘어갈 사람 · {{ holderText(c.holder) }}</small>
    <template v-if="!answered && unbound">
      <OntoBindings v-if="c.binding && !picked" :bindings="[c.binding]" :case-id="c.caseId" :only="c.role" @changed="picked = true" />
      <small v-if="picked" class="res" data-testid="onto-case-ask-bound">정했어요 — 「{{ c.task }}」{{ EUL(c.task) }} 이어서 해요.</small>
      <div class="btns"><button class="lk press" data-testid="onto-case-ask-open" @click="sheet = true">건 보기</button></div>
    </template>
    <template v-else-if="!answered">
      <div class="btns">
        <button class="pill yes press" :disabled="!!busy" data-testid="onto-case-ask-go" @click="decide('go')">{{ busy === 'go' ? '…' : outward ? '보내기' : '진행' }}</button>
        <button v-for="o in others" :key="o.to" class="chip press" :disabled="!!busy" data-testid="onto-case-ask-other" :title="o.cond || ''" @click="decide('other', o.to)">{{ o.to }}<small v-if="o.p != null"> {{ pct(o.p) }}</small></button>
        <button v-if="optional" class="pill press" :disabled="!!busy" data-testid="onto-case-ask-skip" @click="decide('skip')">{{ busy === 'skip' ? '…' : '건너뛰기' }}</button>
        <button class="pill press" :disabled="!!busy" data-testid="onto-case-ask-stop" @click="decide('stop')">멈추기</button>
        <button class="lk press" data-testid="onto-case-ask-open" @click="sheet = true">건 보기</button>
      </div>
      <div v-if="pass" class="pass" data-testid="onto-case-ask-pass">
        <small>「{{ c.task }}」{{ EUN(c.task) }} 꼭 하는 단계예요.{{ pass.line ? ` ${pass.line}.` : '' }} 그래도 {{ pass.action === 'skip' ? '건너뛸까요' : `「${pass.to}」${RO(pass.to)} 갈까요` }}? 까닭을 적어 주세요.</small>
        <input v-model="pass.reason" class="in" maxlength="300" placeholder="지나치는 까닭" data-testid="onto-case-ask-pass-reason" />
        <div class="btns">
          <button class="pill press" :disabled="!!busy" @click="pass = null">그만두기</button>
          <button class="pill yes press" :disabled="!!busy || !pass.reason.trim()" data-testid="onto-case-ask-pass-confirm" @click="decide(pass.action, pass.to, { confirm: true, reason: pass.reason.trim() })">그래도 할게요</button>
        </div>
      </div>
      <small v-if="outward" class="stub">이 판에서는 실제 메일이 나가지 않아요 — 보낼 내용만 건에 남겨요.</small>
    </template>
    <small v-else class="res" data-testid="onto-case-ask-done">{{ result }} <button class="lk press" @click="sheet = true">건 보기</button></small>
    <small v-if="err" class="err">{{ err }}</small>
    <OntoSheet v-if="sheet" title="건" @close="sheet = false">
      <OntoCasePanel :case-id="c.caseId" />
    </OntoSheet>
  </div>
</template>

<style scoped>
.os { word-break: keep-all; overflow-wrap: anywhere; display: flex; flex-direction: column; align-items: flex-start; gap: 7px; max-width: 440px; }
.q { border-radius: 24px; padding: 13px 18px; font-size: 16px; line-height: 1.6; background: var(--bubble-agent-bg); -webkit-backdrop-filter: blur(50px); backdrop-filter: blur(50px); }
.q .sub { display: block; font-size: 12.5px; color: var(--text-secondary); }
.why { margin: 0 0 0 8px; padding-left: 16px; font-size: 12.5px; color: var(--text-secondary); line-height: 1.5; }
.prop { margin: 0 0 0 8px; font-size: 13px; line-height: 1.5; }
.cap { font-size: 12px; color: var(--text-tertiary); margin-right: 2px; }
.pv { margin-left: 8px; display: flex; flex-direction: column; gap: 2px; padding: 8px 12px; border-radius: 14px; background: var(--bubble-user-bg); max-width: 100%; }
.pv small { font-size: 12px; color: var(--text-secondary); }
.pv p { margin: 4px 0 0; font-size: 13px; line-height: 1.5; white-space: pre-wrap; max-height: 8em; overflow: auto; }
.hold { margin-left: 8px; font-size: 12.5px; color: var(--text-secondary); }
.btns { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.pill { height: 36px; padding: 0 16px; border-radius: 9999px; background: var(--regular-solid-bg); color: var(--text-primary); font-size: 14px; font-weight: 500; box-shadow: 0 2px 10px rgba(0 0 0 / .06); animation: pop-in .4s var(--spring) both; }
.pill.yes { background: var(--ink); color: var(--ink-inverse); }
.pill:disabled, .chip:disabled { opacity: .55; }
.chip { height: 30px; padding: 0 12px; border-radius: 9999px; background: var(--bubble-user-bg); font-size: 13px; box-shadow: inset 0 0 0 1px var(--hairline); }
.chip small { color: var(--text-secondary); margin-left: 2px; }
.stub, .res { margin-left: 8px; font-size: 12.5px; color: var(--text-tertiary); line-height: 1.5; }
.res { color: var(--text-secondary); }
.lk { margin-left: 4px; font-size: 12.5px; color: var(--color-info); }
.err { margin-left: 8px; font-size: 12.5px; color: var(--color-error); }
.pass { margin-left: 8px; display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-radius: 14px; background: var(--bubble-user-bg); max-width: 100%; }
.pass small { font-size: 12.5px; color: var(--text-secondary); line-height: 1.5; }
.in { height: 34px; padding: 0 12px; border-radius: 12px; border: 0; outline: 0; background: var(--regular-solid-bg); font-size: 13px; color: var(--text-primary); }
</style>
