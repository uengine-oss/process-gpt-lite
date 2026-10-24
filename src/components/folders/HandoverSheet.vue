<script setup>
// 변형 인계: 받는 사람(사람·에이전트), 이어받기/갈래 만들기, 지금까지 한 일·다음에 할 일.
// process-gpt 의 업무 인계와 같은 기록(받는 방·할 일·인계 이벤트)에 폴더 변형이 실려요.
import { ref, computed, onMounted } from 'vue'
import Icon from '../Icon.vue'
import FIcon from './FIcon.vue'
import Avatar from './Avatar.vue'
import { folders as F, whoOf } from '../../foldersApi.js'

const props = defineProps({ folder: Object, variation: Object, members: Array })
const emit = defineEmits(['close', 'done'])
const people = ref([])
const to = ref(null)
const mode = ref('continue')
const done = ref(props.variation.change_card?.summary || props.variation.commits?.[0]?.msg || '')
const next = ref('')
const grant = ref(true)
const busy = ref(false)
const err = ref('')
onMounted(async () => { people.value = (await F.people().catch(() => [])).filter((p) => String(p.id) !== String(props.variation.holder_id)) })
const member = (p) => (props.members || []).some((m) => m.id === String(p.id))
const ok = computed(() => to.value && next.value.trim() && (member(to.value) || grant.value) && !busy.value)
async function submit() {
  busy.value = true; err.value = ''
  try {
    const r = await F.handover(props.folder.slug, props.variation.id, { to: { id: to.value.id, name: to.value.name, email: to.value.email, isAgent: to.value.isAgent, description: to.value.description }, mode: mode.value, done: done.value, next: next.value, grant: grant.value })
    emit('done', { ...r, to: to.value, mode: mode.value })
  } catch (e) { err.value = e.message } finally { busy.value = false }
}
</script>

<template>
  <div class="veil" @click.self="emit('close')">
    <div class="box glass">
      <header class="hd"><FIcon name="handover" :size="19" /><b>변형 인계 — {{ variation.title }}</b><span class="sp" /><button class="ic press" title="닫기" @click="emit('close')"><Icon name="close" :size="16" /></button></header>
      <div class="body scroll">
        <div class="sec">누구에게</div>
        <div class="who">
          <button v-for="p in people" :key="p.id" class="cand press" :class="{ on: to?.id === p.id }" @click="to = p">
            <Avatar :who="whoOf(p)" :size="28" /><span><b>{{ p.name }}</b><small>{{ p.isAgent ? (p.agent_type || '에이전트') : '사람' }}{{ member(p) ? '' : ' · 구성원 아님' }}</small></span>
          </button>
          <p v-if="!people.length" class="fine">넘길 수 있는 팀원·에이전트가 없어요. 설정 → 팀·역할에서 팀원을 더해 주세요.</p>
        </div>
        <label v-if="to && !member(to)" class="warn"><input v-model="grant" type="checkbox" /> {{ to.name }} 님은 이 폴더 구성원이 아니에요. 실행 권한을 함께 줄게요</label>

        <div class="sec">어떻게</div>
        <div class="modes">
          <label :class="{ on: mode === 'continue' }"><input v-model="mode" type="radio" value="continue" /><b>이어받기</b><small>같은 변형을 그대로 넘겨요. 보유자만 바뀌어요 · 기본</small></label>
          <label :class="{ on: mode === 'fork' }"><input v-model="mode" type="radio" value="fork" /><b>갈래 만들기</b><small>지금 시점에서 새 변형을 만들어 넘겨요. 내 변형은 그대로 둬요</small></label>
        </div>

        <div class="sec">지금까지 한 일</div>
        <input v-model="done" class="fld" />
        <div class="sec">다음에 할 일</div>
        <textarea v-model="next" class="fld ta" placeholder="예: 안내문 문구를 법무 검토 의견에 맞춰 고쳐 주세요" />
        <p class="fine">인계 기록(받는 방·할 일·인계 이벤트)에 이 변형이 실려요. 받는 쪽이 에이전트면 그 변형 위에서 바로 일을 시작하고, 끝나면 결과가 같은 변형에 커밋돼요.</p>
        <p v-if="err" class="bad">{{ err }}</p>
      </div>
      <footer class="ft">
        <button class="pill-btn" @click="emit('close')">취소</button>
        <button class="dark-btn" :disabled="!ok" @click="submit">{{ busy ? '넘기는 중…' : '인계할게요' }}</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.veil { position: fixed; inset: 0; z-index: 45; background: rgba(20, 24, 32, .3); display: grid; place-items: center; padding: 24px; animation: fade-in .2s both; }
.box { width: min(660px, 100%); max-height: calc(100vh - 48px); border-radius: 24px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 18px 60px rgba(0, 0, 0, .3); animation: pop-in .4s var(--spring) both; --regular-bg: var(--regular-solid-bg); }
.hd { display: flex; align-items: center; gap: 10px; height: 58px; padding: 0 14px 0 20px; border-bottom: 1px solid var(--hairline); font-size: 16px; flex: none; }
.sp { flex: 1; }
.ic { width: 32px; height: 32px; border-radius: 16px; display: grid; place-items: center; background: var(--button-bg); }
.body { flex: 1; min-height: 0; overflow-y: auto; padding: 6px 20px 18px; }
.sec { font-size: 12.5px; color: var(--text-tertiary); margin: 16px 0 8px; letter-spacing: .04em; }
.who { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; max-height: 210px; overflow-y: auto; }
.cand { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 14px; background: var(--cell-bg); border: 1.5px solid transparent; text-align: left; }
.cand.on { border-color: var(--color-info); }
.cand span { display: flex; flex-direction: column; min-width: 0; } .cand b { font-weight: 500; font-size: 13.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .cand small { font-size: 11.5px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.warn { display: flex; gap: 8px; align-items: center; margin-top: 10px; font-size: 13px; color: #e08a2c; }
.modes { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.modes label { display: flex; flex-direction: column; gap: 3px; padding: 12px; border-radius: 14px; background: var(--cell-bg); border: 1.5px solid transparent; cursor: pointer; }
.modes label.on { border-color: var(--color-info); }
.modes input { display: none; } .modes b { font-weight: 500; font-size: 14.5px; } .modes small { font-size: 12.5px; color: var(--text-secondary); line-height: 1.5; }
.fld { width: 100%; height: 42px; border-radius: 12px; border: 1px solid var(--hairline); background: var(--field-bg); padding: 0 12px; font-size: 14px; outline: 0; }
.ta { height: 72px; padding: 10px 12px; resize: none; }
.fine { font-size: 12.5px; color: var(--text-secondary); line-height: 1.6; margin: 12px 0 0; }
.bad { font-size: 13px; color: var(--color-error); }
.ft { display: flex; justify-content: flex-end; gap: 10px; padding: 12px 16px; border-top: 1px solid var(--hairline); flex: none; }
.ft > * { height: 42px; }
.dark-btn { background: var(--ink); color: var(--ink-inverse); }
</style>
