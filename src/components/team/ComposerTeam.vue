<script setup>
// The composer's teammate part: person chips (who the next message goes to) and the "@" list that
// rises from the caret. Document-object chips (@표 2) stay in Composer's own row; these are round,
// with an initial, so the two read differently.
defineProps({ tm: Object })
const initial = (s) => String(s || '?').slice(0, 1)
</script>

<template>
  <div class="ct">
    <div v-if="tm.chips.value.length" class="people">
      <span class="to">받는 사람</span>
      <span v-for="(c, i) in tm.chips.value" :key="i + c.label" class="person" :class="c.type" :title="c.type === 'role' ? `${c.role} 담당 ${c.holder || ''}` : ''">
        <i>{{ c.type === 'role' ? '#' : initial(c.label) }}</i>{{ c.label }}<small v-if="c.type === 'role' && c.holder"> · {{ c.holder }}</small>
        <button class="x" aria-label="빼기" @click="tm.remove(i)">×</button>
      </span>
      <span class="hint">보내면 에이전트가 아니라 이분께 가요 · 이 대화 요지와 최근 산출물이 함께 가요</span>
    </div>
    <Transition name="rise">
      <div v-if="tm.open.value" class="sug glass" role="listbox" :style="{ left: `${tm.x.value}px` }" @mousedown.prevent>
        <template v-for="s in tm.sections.value" :key="s.key">
          <p class="sec" :class="s.key">{{ s.label }}</p>
          <p v-if="s.pending && !s.items.length" class="wait"><span class="shimmer-text">판단 모델이 이 일과 관계된 팀원을 고르는 중…</span></p>
          <button v-for="it in s.items" :key="s.key + (it.id || it.role)" class="it press" role="option"
            :class="{ on: tm.flat.value[tm.active.value] === it }" @click="tm.pick(it)" @mouseenter="tm.active.value = tm.flat.value.indexOf(it)">
            <span class="av" :class="it.type">{{ it.type === 'role' ? '#' : initial(it.name) }}</span>
            <span class="nm">
              <b>{{ it.type === 'role' ? it.role : it.name }}</b>
              <small>{{ it.type === 'role' ? `담당 ${it.holder?.name || ''}` : [it.roles?.join(', '), it.email].filter(Boolean).join(' · ') }}</small>
            </span>
            <em v-if="it.why === 'frequent'" class="tag f">{{ it.n }}번 전달</em>
            <em v-else-if="it.why === 'related'" class="tag r" :title="`판단 모델 확률 ${Math.round(it.p * 100)}%`">관련 {{ Math.round(it.p * 100) }}%</em>
          </button>
        </template>
        <p v-if="!tm.sections.value.length" class="none">맞는 팀원이 없어요. 설정 → 팀·역할에서 추가할 수 있어요.</p>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.ct { position: relative; }
.people { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 0 0 8px; }
.to { font-size: 12px; color: var(--text-secondary); margin-right: 2px; }
.person { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 4px 0 4px; border-radius: 15px; font-size: 13.5px; font-weight: 500;
  background: rgba(42, 120, 214, .14); color: var(--text-primary); border: 1px solid rgba(42, 120, 214, .45); animation: pop-in .3s var(--spring); }
.person i { width: 22px; height: 22px; border-radius: 11px; display: grid; place-items: center; font-style: normal; font-size: 12px; color: #fff; background: #2a78d6; }
.person.role i { background: #0f8a5f; }
.person.role { background: rgba(15, 138, 95, .12); border-color: rgba(15, 138, 95, .45); }
.person small { font-weight: 400; color: var(--text-secondary); }
.person .x { width: 20px; height: 20px; border-radius: 10px; color: var(--text-secondary); font-size: 15px; line-height: 18px; }
.hint { flex-basis: 100%; font-size: 11.5px; color: var(--text-tertiary); margin: 2px 2px 0; }
.sug { position: absolute; bottom: calc(100% + 6px); z-index: 30; width: 300px; max-height: 340px; overflow: auto; border-radius: 18px; padding: 6px; box-shadow: 0 14px 44px rgba(0, 0, 0, .2); }
.sec { margin: 8px 10px 4px; font-size: 11.5px; font-weight: 600; color: var(--text-secondary); letter-spacing: .02em; }
.sec.related { color: #7a5af5; }
.wait { margin: 2px 10px 8px; font-size: 12.5px; color: var(--text-tertiary); }
.it { width: 100%; display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 12px; text-align: left; color: var(--text-primary); }
.it.on { background: rgba(127, 127, 127, .14); }
.av { flex: none; width: 30px; height: 30px; border-radius: 15px; display: grid; place-items: center; font-size: 13px; font-weight: 600; color: #fff; background: linear-gradient(135deg, #8aa6d8, #4a5f9a); }
.av.role { background: #0f8a5f; border-radius: 9px; }
.nm { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.nm b { font-size: 14px; font-weight: 500; }
.nm small { font-size: 11.5px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tag { flex: none; font-style: normal; font-size: 11px; padding: 2px 7px; border-radius: 8px; }
.tag.f { background: rgba(42, 120, 214, .14); color: #2a78d6; }
.tag.r { background: rgba(122, 90, 245, .14); color: #7a5af5; }
.none { margin: 10px; font-size: 13px; color: var(--text-secondary); }
.rise-enter-from, .rise-leave-to { opacity: 0; transform: translateY(6px); }
.rise-enter-active, .rise-leave-active { transition: opacity .15s, transform .2s var(--spring); }
</style>
