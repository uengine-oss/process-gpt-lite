<script setup>
// A work item of mine on Home: opens its instance page, where its form is. Home is notifications —
// the card is put away with its ✕ or a sideways swipe, and the work item stays mine: 루틴 lists it under
// 「내 입력이 필요해요」 (2026-11-23: 「bpm todolist 는, 다른 곳에서 목록을 볼 수 있을것이므로 … 삭제 가능해야 한다」).
import { useApp } from '../stores/app.js'
import { useSwipeAway } from '../swipeAway.js'

const props = defineProps({ todo: Object })
const emit = defineEmits(['open'])
const app = useApp()
const sw = useSwipeAway(() => app.dismissTodo(props.todo))
const card = sw.el
const { down, move, up } = sw
// a step whose name asks for a decision reads as Review, the rest as Submit
const verb = (name) => (/결정|승인|검토|심사|판단/.test(name || '') ? 'Review' : 'Submit')
function open() { if (!sw.swiped()) emit('open', props.todo) }
</script>

<template>
  <button ref="card" class="act glass press" :class="{ swiping: sw.swiping.value }" :style="sw.style.value" data-test="todo-card"
    @click="open" @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up">
    <span class="verb">{{ verb(todo.activity_name) }}</span>
    <span class="txt">{{ todo.activity_name }}</span>
    <span class="due">{{ todo.proc_inst_name || todo.def_name }}</span>
    <span class="x" role="button" aria-label="닫기" title="홈에서 닫기 — 루틴에는 남아요" data-test="todo-close" @click.stop="app.dismissTodo(todo)">×</span>
  </button>
</template>

<style scoped>
.act { position: relative; display: block; width: 100%; text-align: left; overflow-wrap: anywhere; border-radius: 24px; padding: 17px 40px 19px 22px; font-size: 16px; line-height: 34px; color: var(--text-primary); touch-action: pan-y; }
.act.swiping { user-select: none; }
.verb { display: inline-block; height: 34px; line-height: 34px; padding: 0 8px; border-radius: 8px; background: var(--color-attention); color: #fff; margin-right: 8px; font-weight: 450; vertical-align: top; }
.txt { line-height: 1.75; }
.due { display: block; color: var(--text-secondary); line-height: 1.6; }
.x { position: absolute; top: 8px; right: 12px; width: 24px; height: 24px; border-radius: 9999px; display: grid; place-items: center; color: var(--text-tertiary); opacity: 0; transition: opacity .2s; font-size: 18px; line-height: 1; }
.act:hover .x { opacity: 1; }
@media (hover: none) { .x { opacity: 1; } }
</style>
