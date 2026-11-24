<script setup>
// 지도에서 바로 도는 건의 인스턴스 화면에서 「이 건 다루기」: 역할마다 맡는 사람(OntoBindings) · 지도 고정(OntoCasePin) · 다른 일로 옮기기(OntoCaseMove) —
// 지도의 건 패널(OntoCasePanel)과 같은 조각, 같은 서버 경로. 진행 · 멈추기 · 기다리는 단계는 흐름도 아래의 OntoCaseRun(controls)이 맡는다.
// caseId · emits changed(바꾼 뒤 — 인스턴스 화면이 흐름도 · 단계를 다시 읽는다) · reload()
import { ref, watch } from 'vue'
import { api } from '../../api.js'
import OntoBindings from './OntoBindings.vue'
import OntoCasePin from './OntoCasePin.vue'
import OntoCaseMove from './OntoCaseMove.vue'

const props = defineProps({ caseId: { type: String, required: true } })
const emit = defineEmits(['changed'])
const c = ref(null)
const err = ref('')
async function load() {
  try { c.value = await api(`/ontology/cases/${encodeURIComponent(props.caseId)}`); err.value = '' } catch (e) { err.value = e.message }
}
watch(() => props.caseId, () => { c.value = null; load() }, { immediate: true })
async function changed(r) { await load(); emit('changed', r) }
defineExpose({ reload: load })
</script>

<template>
  <section class="cm" data-testid="map-case-manage">
    <div class="ch">이 건 다루기</div>
    <p v-if="!c && !err" class="muted pulse">불러오는 중…</p>
    <template v-if="c">
      <div v-if="c.bindings?.length" class="sec" data-testid="onto-case-bindings">
        <OntoBindings :bindings="c.bindings" :case-id="caseId" :editable="c.status === 'running'" @changed="changed" />
      </div>
      <div class="sec">
        <OntoCasePin :case-data="c" @changed="changed" />
      </div>
      <div class="sec">
        <OntoCaseMove :case-data="c" @moved="changed" />
      </div>
    </template>
    <small v-if="err" class="err">{{ err }}</small>
  </section>
</template>

<style scoped>
.cm { display: flex; flex-direction: column; gap: 8px; min-width: 0; word-break: keep-all; overflow-wrap: anywhere; }
.ch { font-size: 13px; color: var(--text-secondary); margin: 0 0 2px 8px; }
.sec { padding: 12px 14px; border-radius: 18px; background: var(--bubble-agent-bg); -webkit-backdrop-filter: blur(50px); backdrop-filter: blur(50px); min-width: 0; }
.muted { margin: 0 8px; font-size: 13px; color: var(--text-secondary); }
.err { margin: 0 8px; font-size: 12.5px; color: var(--color-error); }
</style>
