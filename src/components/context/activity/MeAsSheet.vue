<script setup>
// 다른 사람 눈으로 내 카드 보기(GET /team-activity/me/as): 같은 팀·다른 팀·장·관리자가 내 카드를 어떻게 보는지(허락 없이 등급과 역할만으로)
// + 이번 주 내 카드를 본 사람과 내 원문을 연 기록.
import { ref, onMounted, onBeforeUnmount } from 'vue'
import Icon from '../../Icon.vue'
import PersonCard from './PersonCard.vue'
import { api } from '../../../api.js'
import { DEPTH, stamp } from './fmt.js'

const props = defineProps({ initial: { type: String, default: 'team' } })
const emit = defineEmits(['close'])
const as = ref(props.initial), d = ref(null), err = ref('')
const CHOICES = [{ id: 'team', label: '같은 팀' }, { id: 'other', label: '다른 팀' }, { id: 'lead', label: '장' }, { id: 'admin', label: '관리자' }]
async function load() {
  err.value = ''
  try { d.value = await api(`/team-activity/me/as?as=${as.value}`) } catch (e) { err.value = e.message }
}
const pick = (id) => { as.value = id; load() }
const onKey = (e) => { if (e.key === 'Escape') emit('close') }
onMounted(() => { load(); window.addEventListener('keydown', onKey) })
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <div class="veil" @click.self="emit('close')">
      <div class="sheet glass blur-in" role="dialog" aria-label="다른 사람 눈으로 내 카드 보기">
        <header>
          <h2>다른 사람 눈으로 내 카드 보기</h2>
          <button class="x press" aria-label="닫기" @click="emit('close')"><Icon name="close" :size="18" /></button>
        </header>
        <div class="seg">
          <button v-for="c in CHOICES" :key="c.id" :class="{ on: as === c.id }" @click="pick(c.id)">{{ c.label }} 눈으로 보기</button>
        </div>
        <p class="hint">허락 없이 공개 등급과 역할만으로 보이는 모양이에요. 허락을 받은 사람에게는 그만큼 더 보입니다.</p>
        <div v-if="d" class="cols">
          <PersonCard :card="d.card" :interactive="false" />
          <div class="views">
            <p class="ct">이번 주 내 활동을 본 사람</p>
            <div v-for="(v, i) in d.views" :key="i" class="v">
              <b>{{ v.viewer_name }}</b>
              <i class="dp" :class="v.depth">{{ DEPTH[v.depth] }}</i>
              <span class="tt">{{ v.title }}</span>
              <small>{{ v.basis }}<template v-if="v.count > 1"> · {{ v.count }}회</template> · {{ stamp(v.at) }}</small>
            </div>
            <p v-if="!d.views.length" class="none">이번 주에는 아직 아무도 보지 않았어요</p>
          </div>
        </div>
        <p v-else-if="err" class="none">{{ err }}</p>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.veil { position: fixed; inset: 0; z-index: 200; background: rgba(0, 0, 0, .28); display: grid; place-items: center; padding: 16px; }
.sheet { width: min(980px, 100%); max-height: min(92vh, 900px); box-sizing: border-box; border-radius: 28px; padding: 18px 22px; display: flex; flex-direction: column; gap: 10px; background: var(--regular-solid-bg); box-shadow: var(--shadow-card); overflow-y: auto; }
header { display: flex; justify-content: space-between; align-items: center; }
h2 { margin: 0; font-size: 20px; font-weight: 600; }
.x { width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; background: var(--button-bg); }
.seg { display: inline-flex; align-self: flex-start; padding: 3px; border-radius: 9999px; background: var(--field-bg); gap: 2px; }
.seg button { height: 32px; padding: 0 14px; border-radius: 9999px; font-size: 13.5px; color: var(--text-secondary); }
.seg button.on { background: var(--ink); color: var(--ink-inverse); }
.hint { margin: 0; font-size: 13px; color: var(--text-secondary); }
.cols { display: grid; grid-template-columns: 1.25fr 1fr; gap: 14px; align-items: start; }
.views { display: flex; flex-direction: column; gap: 6px; }
.ct { margin: 0; font-weight: 600; font-size: 14.5px; }
.v { display: grid; grid-template-columns: auto auto 1fr; gap: 2px 8px; align-items: center; padding: 8px 10px; border-radius: 12px; background: var(--cell-bg); font-size: 13.5px; }
.v b { font-weight: 600; }
.v .tt { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.v small { grid-column: 1 / -1; color: var(--text-tertiary); font-size: 12px; }
.dp { font-style: normal; font-size: 11px; padding: 1px 7px; border-radius: 8px; background: var(--field-bg); color: var(--text-secondary); }
.dp.summary { background: rgba(76, 141, 246, .16); color: var(--color-info); }
.dp.content { background: rgba(59, 185, 138, .16); color: var(--color-success); }
.none { margin: 0; font-size: 13px; color: var(--text-tertiary); }
@media (max-width: 760px) { .cols { grid-template-columns: 1fr; } }
</style>
