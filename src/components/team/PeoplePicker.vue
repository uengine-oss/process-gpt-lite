<script setup>
// Pick teammates — the messenger's one picker: a new conversation, inviting into a group room, a group made from a 1:1
// (2026-11-25 「기존 단체 메신저 대화창에서 신규인원 초대가 가능해야.」). Each with their face (PersonAvatar.vue) and the name every
// screen uses (src/people.js) — two of the same name told apart by their address (src/sameNames.js); found by name, address or role;
// several at once, then confirmed.
//   people: [{id, name, email, roles}] (null while loading) · exclude: ids not offered (already in the room) · title · confirm (label)
import { ref, computed } from 'vue'
import PersonAvatar from '../PersonAvatar.vue'
import { nameOf, tagsFor, labelOf } from '../../people.js'

const props = defineProps({
  people: { type: Array, default: null },
  exclude: { type: Array, default: () => [] },
  title: { type: String, default: '' },
  confirm: { type: String, default: '확인' },
  empty: { type: String, default: '' },
  busy: Boolean,
})
const emit = defineEmits(['confirm', 'cancel'])
const find = ref('')
const picked = ref([])
const nm = (p) => nameOf(p.id, p.name)
const offered = computed(() => (props.people || []).filter((p) => !props.exclude.map(String).includes(String(p.id))))
const tags = computed(() => tagsFor(offered.value))
const shown = computed(() => {
  const s = find.value.trim().toLowerCase()
  return offered.value.filter((p) => !s || [nm(p), p.name, p.email, ...(p.roles || [])].some((v) => v && String(v).toLowerCase().includes(s)))
})
const toggle = (p) => { picked.value = picked.value.includes(p.id) ? picked.value.filter((x) => x !== p.id) : [...picked.value, p.id] }
</script>

<template>
  <div class="pp" data-test="people-picker">
    <p v-if="title" class="cap">{{ title }}</p>
    <input v-model="find" class="find" placeholder="이름·이메일·역할로 찾기" data-test="people-find" />
    <div class="rows">
      <button v-for="p in shown" :key="p.id" class="row press" :class="{ on: picked.includes(p.id) }" :data-person="p.id" data-test="people-row" @click="toggle(p)">
        <PersonAvatar :id="p.id" :name="nm(p)" /><span class="nm"><b>{{ labelOf(tags, p) }}</b><small>{{ (p.roles || []).join(', ') || p.email }}</small></span>
        <span class="ck">{{ picked.includes(p.id) ? '✓' : '' }}</span>
      </button>
      <p v-if="!people" class="empty">불러오는 중…</p>
      <p v-else-if="!shown.length" class="empty">{{ find.trim() ? '맞는 팀원이 없어요.' : empty }}</p>
    </div>
    <div class="btns">
      <button class="ghost press" data-test="people-cancel" @click="emit('cancel')">취소</button>
      <button class="main press" data-test="people-confirm" :disabled="!picked.length || busy" @click="emit('confirm', picked)">{{ confirm }}<template v-if="picked.length > 1"> · {{ picked.length }}</template></button>
    </div>
  </div>
</template>

<style scoped>
.pp { display: flex; flex-direction: column; min-height: 0; }
.cap { margin: 6px 6px 6px; font-size: 12px; color: var(--text-secondary); }
.find { margin: 0 2px 6px; border: 1px solid rgba(127, 127, 127, .3); background: rgba(127, 127, 127, .06); border-radius: 12px; padding: 8px 12px; font-size: 14px;
  color: var(--text-primary); outline: 0; font-family: inherit; }
.rows { flex: 1; min-height: 0; overflow: auto; }
.row { width: 100%; display: flex; align-items: center; gap: 10px; padding: 8px; border-radius: 12px; text-align: left; color: var(--text-primary); }
.row.on { background: rgba(42, 120, 214, .14); }
.nm { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.nm b { font-size: 14.5px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nm small { font-size: 12.5px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ck { flex: none; width: 22px; height: 22px; border-radius: 11px; display: grid; place-items: center; font-size: 13px; color: #fff; background: rgba(127, 127, 127, .2); }
.row.on .ck { background: #2a78d6; }
.empty { font-size: 13px; color: var(--text-secondary); text-align: center; margin: 24px 8px; }
.btns { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
.btns button { height: 34px; padding: 0 14px; border-radius: 17px; font-size: 14px; }
.btns .ghost { background: transparent; color: var(--text-secondary); }
.btns .main { background: #1d1d1f; color: #fff; } .btns .main:disabled { opacity: .45; }
:root[data-theme="dark"] .btns .main { background: #f5f5f7; color: #1d1d1f; }
</style>
