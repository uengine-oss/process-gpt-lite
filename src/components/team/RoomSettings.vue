<script setup>
// A room's settings (2026-11-26 사용자 「대화방 설정으로 대화방 명칭 바꿀 수 있게」, 스펙 messenger-dock 「단체방의 이름을 바꾼다」): the name
// everyone in a group room sees — any of its people may set it, as in Process GPT's own room settings; empty → called by its people again.
// A 1:1 conversation is called by the other person: it says so (one shared name would replace each side's own).
//   group: a group room · name: its own name ('' when it is called by its people) · auto: what it is called without one · busy
import { ref, computed, onMounted, nextTick } from 'vue'

const props = defineProps({ group: Boolean, name: { type: String, default: '' }, auto: { type: String, default: '' }, busy: Boolean })
const emit = defineEmits(['save', 'cancel'])
const MAX = 50
const draft = ref(props.name)
const input = ref(null)
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim()
const changed = computed(() => clean(draft.value) !== clean(props.name))
const over = computed(() => [...clean(draft.value)].length > MAX)
onMounted(async () => { await nextTick(); input.value?.focus(); input.value?.select() })
const save = () => { if (changed.value && !over.value && !props.busy) emit('save', clean(draft.value)) }
function key(e) {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); save() }
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); emit('cancel') }
}
</script>

<template>
  <div class="rs" data-test="room-settings">
    <p class="cap">대화방 설정</p>
    <template v-if="group">
      <label class="lb" for="room-name">대화방 이름</label>
      <input id="room-name" ref="input" v-model="draft" class="field" :maxlength="MAX" :placeholder="auto" data-test="room-name" autocomplete="off" @keydown="key" />
      <p class="hint" :class="{ over }"><span>모두에게 같은 이름으로 보여요. 비워 두면 사람들 이름으로 보여요.</span><b>{{ [...clean(draft)].length }}/{{ MAX }}</b></p>
      <div class="btns">
        <button v-if="name" class="reset press" data-test="room-name-reset" :disabled="busy" @click="emit('save', '')">기본 이름으로</button>
        <span class="sp" />
        <button class="ghost press" data-test="room-settings-cancel" @click="emit('cancel')">취소</button>
        <button class="main press" data-test="room-name-save" :disabled="!changed || over || busy" @click="save">저장</button>
      </div>
    </template>
    <template v-else>
      <p class="note" data-test="room-settings-direct">1:1 대화는 상대의 이름으로 보여요. 이름은 단체방에서 붙일 수 있어요.</p>
      <div class="btns"><span class="sp" /><button class="ghost press" data-test="room-settings-cancel" @click="emit('cancel')">닫기</button></div>
    </template>
  </div>
</template>

<style scoped>
.rs { display: flex; flex-direction: column; min-height: 0; }
.cap { margin: 4px 6px 10px; font-size: 13px; font-weight: 600; color: var(--text-primary); }
.lb { margin: 0 6px 6px; font-size: 12px; color: var(--text-secondary); }
.field { margin: 0 2px; border: 1px solid rgba(127, 127, 127, .3); background: rgba(127, 127, 127, .06); border-radius: 12px; padding: 9px 12px; font-size: 14.5px;
  color: var(--text-primary); outline: 0; font-family: inherit; min-width: 0; }
.field:focus { border-color: #2a78d6; box-shadow: 0 0 0 3px rgba(42, 120, 214, .18); }
.hint { display: flex; gap: 8px; align-items: baseline; margin: 6px 6px 0; font-size: 12px; color: var(--text-secondary); line-height: 1.45; }
.hint span { flex: 1; min-width: 0; }
.hint b { flex: none; font-weight: 500; font-variant-numeric: tabular-nums; }
.hint.over b { color: #c62828; }
.note { margin: 0 6px; font-size: 13.5px; line-height: 1.5; color: var(--text-secondary); }
.btns { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
.sp { flex: 1; }
.btns button { height: 34px; padding: 0 14px; border-radius: 17px; font-size: 14px; }
.btns .ghost { background: transparent; color: var(--text-secondary); }
.btns .reset { background: rgba(127, 127, 127, .12); color: var(--text-primary); }
.btns .main { background: #1d1d1f; color: #fff; } .btns .main:disabled { opacity: .45; }
:root:not([data-theme="light"]) .btns .main { background: #f5f5f7; color: #1d1d1f; }
</style>
