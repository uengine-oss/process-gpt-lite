<script setup>
import { reactive, ref, computed } from 'vue'
import { marked } from 'marked'
import Icon from './Icon.vue'
import { api } from '../api.js'

// Renders a process-gpt form (form_def.fields_json) as a glass card.
// fields: [{key, text, type, items?: [{value: label}], readonly?}]
const props = defineProps({
  title: String,
  subtitle: String,
  fields: { type: Array, default: () => [] },
  values: { type: Object, default: () => ({}) },
  readonly: Boolean,
  submitLabel: { type: String, default: '제출' },
  busy: Boolean,
})
const emit = defineEmits(['submit', 'cancel'])
const model = reactive(Object.fromEntries(props.fields.map((f) => [f.key, props.values?.[f.key] ?? (f.type === 'multiselect' || f.type === 'checkbox' && f.items ? [] : '')])))
const uploading = ref({})
const kind = (t) => String(t || 'text').replace(/-field$/, '')
const opts = (f) => (f.items || []).map((o) => (typeof o === 'object' ? Object.entries(o)[0] : [o, o])).map(([v, l]) => ({ v, l }))
const ro = (f) => props.readonly || f.readonly === 'true' || f.readonly === true || f.disabled === 'true'
const md = (t) => marked.parse(String(t || '').replace(/</g, '&lt;'), { breaks: true })
const filled = computed(() => props.fields.some((f) => model[f.key] !== '' && model[f.key] != null))

function toggleMulti(f, v) {
  const a = Array.isArray(model[f.key]) ? model[f.key] : []
  model[f.key] = a.includes(v) ? a.filter((x) => x !== v) : [...a, v]
}
async function upload(f, e) {
  const file = e.target.files?.[0]
  if (!file) return
  uploading.value[f.key] = true
  try {
    const data = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(file) })
    model[f.key] = await api('/files', { method: 'POST', body: { name: file.name, type: file.type, data } })
  } finally { uploading.value[f.key] = false }
}
</script>

<template>
  <form class="form glass" @submit.prevent="emit('submit', { ...model })">
    <div v-if="title" class="h">
      <span class="t serif">{{ title }}</span>
      <span v-if="subtitle" class="s">{{ subtitle }}</span>
    </div>
    <div v-for="f in fields" :key="f.key" class="field" :class="`t-${kind(f.type)}`">
      <label>{{ f.text || f.key }}</label>

      <div v-if="kind(f.type) === 'report'" class="report md" :class="{ edit: !ro(f) }">
        <div v-if="ro(f)" v-html="md(model[f.key])" />
        <textarea v-else v-model="model[f.key]" rows="5" placeholder="마크다운으로 작성" />
      </div>
      <textarea v-else-if="kind(f.type) === 'textarea'" v-model="model[f.key]" class="in area" rows="3" :readonly="ro(f)" />
      <div v-else-if="kind(f.type) === 'select' || kind(f.type) === 'radio'" class="choices">
        <button v-for="o in opts(f)" :key="o.v" type="button" class="choice press" :class="{ on: model[f.key] === o.v }" :disabled="ro(f)" @click="model[f.key] = o.v">{{ o.l }}</button>
      </div>
      <div v-else-if="kind(f.type) === 'multiselect' || (kind(f.type) === 'checkbox' && f.items)" class="choices">
        <button v-for="o in opts(f)" :key="o.v" type="button" class="choice press" :class="{ on: (model[f.key] || []).includes(o.v) }" :disabled="ro(f)" @click="toggleMulti(f, o.v)">{{ o.l }}</button>
      </div>
      <button v-else-if="kind(f.type) === 'boolean' || kind(f.type) === 'checkbox'" type="button" class="toggle" :class="{ on: model[f.key] === true || model[f.key] === 'true' }" :disabled="ro(f)"
        @click="model[f.key] = !(model[f.key] === true || model[f.key] === 'true')"><span /></button>
      <div v-else-if="kind(f.type) === 'file'" class="file">
        <a v-if="model[f.key]?.url" :href="model[f.key].url" target="_blank" class="chip"><Icon name="doc" :size="16" /> {{ model[f.key].name }}</a>
        <label v-if="!ro(f)" class="pick press"><input type="file" hidden @change="upload(f, $event)" />{{ uploading[f.key] ? '올리는 중…' : model[f.key]?.url ? '바꾸기' : '파일 선택' }}</label>
      </div>
      <input v-else v-model="model[f.key]" class="in" :readonly="ro(f)"
        :type="{ number: 'number', date: 'date', 'datetime-local': 'datetime-local' }[kind(f.type)] || 'text'"
        :placeholder="kind(f.type) === 'user-select' ? '이메일' : ''" />
    </div>
    <div v-if="!readonly" class="foot">
      <button v-if="$attrs.onCancel" type="button" class="ghost press" @click="emit('cancel')">취소</button>
      <button class="dark-btn" :disabled="busy || !filled">{{ busy ? '보내는 중…' : submitLabel }}</button>
    </div>
  </form>
</template>

<style scoped>
.form { width: 100%; max-width: 424px; border-radius: 24px; padding: 18px; display: flex; flex-direction: column; gap: 14px; box-shadow: var(--shadow-card); --regular-bg: var(--bubble-agent-bg); }
.h { display: flex; flex-direction: column; gap: 2px; margin: 2px 4px 2px; }
.t { font-size: 22px; letter-spacing: .01em; }
.s { font-size: 13px; color: var(--text-secondary); }
.field { display: flex; flex-direction: column; gap: 6px; }
label { font-size: 13px; color: var(--text-secondary); margin-left: 6px; }
.in { height: 44px; border-radius: 9999px; border: 0; outline: 0; padding: 0 16px; background: var(--field-bg); font-size: 15px; transition: box-shadow .2s; }
.in:focus, .area:focus, .report textarea:focus { box-shadow: 0 0 0 1.5px var(--text-primary) inset; }
.in[readonly] { background: transparent; padding-left: 6px; height: auto; }
.area { height: auto; border-radius: 18px; padding: 12px 16px; resize: vertical; line-height: 1.5; }
.choices { display: flex; flex-wrap: wrap; gap: 6px; }
.choice { height: 36px; padding: 0 14px; border-radius: 9999px; background: var(--field-bg); font-size: 14px; transition: background-color .2s, color .2s; }
.choice.on { background: var(--ink); color: var(--ink-inverse); }
.toggle { width: 48px; height: 28px; border-radius: 9999px; background: var(--field-bg); position: relative; transition: background-color .25s; margin-left: 4px; }
.toggle span { position: absolute; top: 3px; left: 3px; width: 22px; height: 22px; border-radius: 9999px; background: #fff; box-shadow: 0 1px 4px rgba(0 0 0 / .2); transition: translate .3s var(--spring); }
.toggle.on { background: #34c759; }
.toggle.on span { translate: 20px 0; }
.file { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.chip { display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 14px; border-radius: 9999px; background: #1d1d1f; color: #f5f5f7; font-size: 14px; text-decoration: none; }
.pick { height: 36px; padding: 0 14px; border-radius: 9999px; background: var(--field-bg); font-size: 14px; display: inline-flex; align-items: center; cursor: pointer; color: var(--text-primary); margin: 0; }
.report { background: var(--field-bg); border-radius: 16px; padding: 12px 14px; font-size: 14px; line-height: 1.55; max-height: 260px; overflow: auto; }
.report textarea { width: 100%; border: 0; outline: 0; background: transparent; resize: vertical; font-size: 14px; line-height: 1.5; }
.md :deep(p) { margin: 0 0 .5em; } .md :deep(table) { border-collapse: collapse; font-size: 13px; } .md :deep(td), .md :deep(th) { padding: 3px 6px; border-bottom: 1px solid var(--hairline); }
.foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 2px; }
.ghost { height: 44px; padding: 0 18px; border-radius: 9999px; color: var(--text-secondary); }
.dark-btn { height: 44px; }
:root[data-theme="dark"] .dark-btn { background: #f5f5f7; color: #1d1d1f; }
</style>
