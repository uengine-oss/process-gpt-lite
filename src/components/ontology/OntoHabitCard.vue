<script setup>
// 열린 일의 다음 걸음(server lib/ontology/run.js checkCases → habitFor): 스냅샷이 끝난 건에서 가장 흔한 다음 일을
// 「지난번처럼 …로 넘길까요?」로 묻는다(수락할 확률이 50% 이상일 때만, state 'ask'). 아니면(quiet) 후보만 한 줄.
// 답은 이 기기에 남겨 다시 열어도 답한 상태로 보인다.
import { ref, computed } from 'vue'
import { api } from '../../api.js'
import { pct } from './fmt.js'
import OntoSheet from './OntoSheet.vue'
import OntoCasePanel from './OntoCasePanel.vue'
import { local, RO, EUL } from './ontoText.js'

const props = defineProps({ msg: Object })
const c = computed(() => props.msg.content || {})
const answered = ref(local.get(`habit:${props.msg.id}`))
const busy = ref('')
const err = ref('')
const sheet = ref(false)
const others = computed(() => (c.value.others || []).filter((o) => o.to && o.to !== c.value.to))

async function answer(to, accepted, p) {
  busy.value = `${to}:${accepted}`; err.value = ''
  try {
    const r = await api(`/ontology/cases/${encodeURIComponent(c.value.caseId)}/habit`, { method: 'POST', body: { to, accepted, p, from: c.value.from, messageId: props.msg.id } })
    answered.value = { to, accepted, moved: !!r?.moved }
    local.set(`habit:${props.msg.id}`, answered.value)
  } catch (e) { err.value = e.message } finally { busy.value = '' }
}
</script>

<template>
  <div class="oh" data-testid="onto-habit-card" :data-state="c.state">
    <!-- 묻지 않을 때: 후보만 한 줄 -->
    <p v-if="c.state !== 'ask'" class="quiet" data-testid="onto-habit-quiet">
      「{{ c.from }}」 다음 후보 · {{ c.to }} {{ pct(c.p) }}<template v-for="o in others" :key="o.to"> · {{ o.to }} {{ pct(o.p) }}</template>
      <button v-if="c.caseId" class="lk press" @click="sheet = true">건 보기</button>
    </p>

    <template v-else>
      <div class="q">
        <span v-if="c.from" class="done">「{{ c.from }}」{{ EUL(c.from) }} 마쳤어요.</span>
        지난번처럼 「{{ c.to }}」{{ RO(c.to) }} 넘길까요?
      </div>
      <template v-if="!answered">
        <div class="btns">
          <button class="pill yes press" :disabled="!!busy" data-testid="onto-habit-yes" @click="answer(c.to, true, c.p)">{{ busy === `${c.to}:true` ? '넘기는 중…' : '네, 넘겨 주세요' }}</button>
          <button class="pill press" :disabled="!!busy" data-testid="onto-habit-no" @click="answer(c.to, false, c.p)">아니요</button>
        </div>
        <div v-if="others.length" class="alt">
          <span class="cap">다른 일</span>
          <button v-for="o in others" :key="o.to" class="chip press" :disabled="!!busy" data-testid="onto-habit-other" @click="answer(o.to, true, o.p)">{{ o.to }} <small>{{ pct(o.p) }}</small></button>
        </div>
        <small class="why">지난 건의 {{ pct(c.p) }}가 이렇게 넘겼어요<template v-if="c.accept != null"> · 수락할 확률 {{ pct(c.accept) }}{{ c.calibrated ? '' : ' (답이 더 모이면 맞춰요)' }}</template></small>
      </template>
      <small v-else class="res" data-testid="onto-habit-done">
        {{ answered.accepted ? `「${answered.to}」${RO(answered.to)} 넘겼어요.` : '이번에는 넘기지 않았어요.' }}
        <button v-if="c.caseId" class="lk press" @click="sheet = true">건 보기</button>
      </small>
    </template>
    <small v-if="err" class="err">{{ err }}</small>

    <OntoSheet v-if="sheet" title="건" @close="sheet = false">
      <OntoCasePanel :case-id="c.caseId" />
    </OntoSheet>
  </div>
</template>

<style scoped>
.oh { word-break: keep-all; overflow-wrap: anywhere; display: flex; flex-direction: column; align-items: flex-start; gap: 8px; max-width: 424px; }
.q { border-radius: 24px; padding: 13px 18px; font-size: 16px; line-height: 1.6; background: var(--bubble-agent-bg); -webkit-backdrop-filter: blur(50px); backdrop-filter: blur(50px); word-break: keep-all; overflow-wrap: anywhere; }
.q .done { display: block; font-size: 13.5px; color: var(--text-secondary); }
.btns { display: flex; flex-wrap: wrap; gap: 6px; }
.pill { height: 36px; padding: 0 16px; border-radius: 9999px; background: var(--regular-solid-bg); color: var(--text-primary); font-size: 14px; font-weight: 500; box-shadow: 0 2px 10px rgba(0 0 0 / .06); animation: pop-in .4s var(--spring) both; }
.pill.yes { background: var(--ink); color: var(--ink-inverse); }
.pill:disabled, .chip:disabled { opacity: .55; }
.alt { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-left: 4px; }
.cap { font-size: 12px; color: var(--text-tertiary); }
.chip { height: 30px; padding: 0 12px; border-radius: 9999px; background: var(--bubble-user-bg); -webkit-backdrop-filter: blur(30px); backdrop-filter: blur(30px); font-size: 13px; box-shadow: inset 0 0 0 1px var(--hairline); }
.chip small { color: var(--text-secondary); margin-left: 2px; }
.why, .res { margin-left: 8px; font-size: 12.5px; color: var(--text-tertiary); line-height: 1.5; }
.res { color: var(--text-secondary); }
.quiet { margin: 0; max-width: 424px; padding: 6px 12px; border-radius: 14px; background: var(--bubble-user-bg); font-size: 13px; line-height: 1.5; color: var(--text-secondary); overflow-wrap: anywhere; }
.lk { margin-left: 6px; font-size: 12.5px; color: var(--color-info); }
.err { margin-left: 8px; font-size: 12.5px; color: var(--color-error); }
</style>
