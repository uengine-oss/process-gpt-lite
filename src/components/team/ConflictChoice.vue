<script setup>
// Branches that changed the same file differently (lib/team/worktree.js gather → 409): the sender
// picks one side per file before the share or the gathered work goes on. Nothing is picked for them.
import { ref, computed } from 'vue'

const props = defineProps({ conflicts: { type: Array, required: true }, busy: Boolean })
const emit = defineEmits(['pick', 'cancel'])
const picks = ref({})
const done = computed(() => props.conflicts.every((c) => picks.value[c.path]))
const size = (n) => (n == null ? '' : n < 1024 ? `${n}B` : `${Math.round(n / 1024)}KB`)
</script>

<template>
  <div class="cc" role="group" aria-label="충돌한 파일 고르기">
    <p class="cap">같은 파일을 서로 다르게 고쳤어요</p>
    <div v-for="c in conflicts" :key="c.path" class="row">
      <b class="nm">{{ c.path }}</b>
      <div class="sides">
        <button v-for="s in c.sides" :key="s.key" class="side press" :class="{ on: picks[c.path] === s.key }" :aria-pressed="picks[c.path] === s.key"
          @click="picks = { ...picks, [c.path]: s.key }">{{ s.label }}<small>{{ s.removed ? '지움' : size(s.size) }}</small></button>
      </div>
    </div>
    <div class="btns">
      <button class="ghost press" @click="emit('cancel')">취소</button>
      <button class="main press" :disabled="!done || busy" @click="emit('pick', picks)">고른 쪽으로</button>
    </div>
  </div>
</template>

<style scoped>
.cc { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: 12px; background: rgba(255, 196, 0, .12); }
.cap { margin: 0; font-size: 13px; font-weight: 600; }
.row { display: flex; flex-direction: column; gap: 4px; }
.nm { font-size: 13px; word-break: break-all; }
.sides { display: flex; flex-wrap: wrap; gap: 6px; }
.side { display: inline-flex; align-items: baseline; gap: 6px; padding: 5px 10px; border-radius: 999px; border: 1px solid rgba(0, 0, 0, .14); background: rgba(255, 255, 255, .7); font-size: 13px; cursor: pointer; }
.side small { opacity: .6; font-size: 11px; }
.side.on { background: #1d1d1f; color: #fff; border-color: #1d1d1f; }
.btns { display: flex; justify-content: flex-end; gap: 6px; }
.btns button { padding: 6px 12px; border-radius: 10px; border: 0; font-size: 13px; cursor: pointer; }
.btns .ghost { background: transparent; }
.btns .main { background: #1d1d1f; color: #fff; }
.btns .main:disabled { opacity: .4; cursor: default; }
</style>
