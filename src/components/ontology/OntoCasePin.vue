<script setup>
// 지도에서 바로 도는 건의 지도 고정(server lib/ontology/mapengine.js setPin): 끝난 단계는 그대로, 다음 단계는 그때의 지도로(기본) · 건을 시작한
// 날의 지도로(고정). 바꾸기는 관리자, 진행 중인 건만. 지도의 건 패널(OntoCasePanel)과 인스턴스 화면의 「이 건 다루기」(OntoCaseManage)가 같이 쓴다.
// caseData: GET /ontology/cases/:id · emits changed(바꾼 뒤 — 부르는 쪽이 건을 다시 읽는다)
import { ref, watch } from 'vue'
import { api } from '../../api.js'
import { dateTimeKo } from './fmt.js'

const props = defineProps({ caseData: { type: Object, required: true } })
const emit = defineEmits(['changed'])
const admin = ref(false)
watch(() => props.caseData?.engine === 'map', async (m) => { if (m && !admin.value) { try { admin.value = !!(await api('/ontology/engine')).admin } catch { admin.value = false } } }, { immediate: true })
const busy = ref(false)
const err = ref('')
async function setPin(on) {
  busy.value = true; err.value = ''
  try { await api(`/ontology/cases/${encodeURIComponent(props.caseData.id)}/map-pin`, { method: 'PUT', body: { pin: on } }); emit('changed') } catch (e) { err.value = e.message } finally { busy.value = false }
}
</script>

<template>
  <div class="pin" data-testid="onto-case-pin" :data-pinned="caseData.map_pin ? '1' : '0'">
    <small>{{ caseData.map_pin ? `다음 단계를 건을 시작한 날(${dateTimeKo(caseData.map_pin)})의 지도로 정해요 — 그 뒤에 바뀐 지도는 이 건에 쓰지 않아요.` : '끝난 단계는 그대로, 다음 단계는 그때의 지도로 정해요.' }}</small>
    <button v-if="admin && caseData.status === 'running'" class="lnk press" :disabled="busy" data-testid="onto-case-pin-toggle" @click="setPin(!caseData.map_pin)">{{ caseData.map_pin ? '그때의 지도를 따라가기' : '시작한 날의 지도로 고정' }}</button>
    <small v-if="err" class="err">{{ err }}</small>
  </div>
</template>

<style scoped>
.pin { display: flex; flex-direction: column; gap: 4px; }
.pin small { font-size: 12px; color: var(--text-secondary); line-height: 1.45; }
.lnk { align-self: flex-start; font-size: 12.5px; color: var(--color-info); }
.lnk:disabled { opacity: .5; }
.pin .err { color: var(--color-error); }
</style>
