<script setup>
import { ref, shallowRef, markRaw, onMounted, onBeforeUnmount, watch } from 'vue'

// A step's input screen the agent made (A2UI v1.0 createSurface — server lib/stepUi), drawn by the official Lit renderer
// (<a2ui-surface>, loaded on first use — runtime.js). Pressing its send button emits submit({values: the data model's /form, a2ui:
// {version, action}}); the server reads both again against the screen it stored. readonly: a handed-in screen with its values,
// buttons left out, nothing can be changed. The words inside are the agent's, already in the person's language (data-no-i18n).
const props = defineProps({
  message: { type: Object, required: true },
  values: { type: Object, default: null },
  readonly: Boolean,
  busy: Boolean,
  title: String,
  subtitle: String,
})
const emit = defineEmits(['submit', 'failed'])
const surface = shallowRef(null)
const ready = ref(false)
// a field's check messages show once the person has been in that field, or tried to send with fields left (a fresh screen is not red)
const tried = ref(false)
let processor = null
// (the renderer's tag names: a2ui-basic-textfield, but a2ui-choicepicker · a2ui-checkbox · a2ui-datetimeinput · a2ui-slider)
const FIELDS = new Set(['A2UI-BASIC-TEXTFIELD', 'A2UI-CHOICEPICKER', 'A2UI-CHECKBOX', 'A2UI-DATETIMEINPUT', 'A2UI-SLIDER'])
function touch(e) {
  for (let n = e.target; n && n !== e.currentTarget; n = n.parentElement) if (FIELDS.has(n.tagName)) { n.setAttribute('data-touched', ''); return }
}
function press(e) {
  const b = e.target?.closest?.('a2ui-basic-button')
  if (b && b.querySelector('button:disabled')) tried.value = true
}

function onAction(a) {
  if (props.readonly || props.busy || !surface.value) return
  const form = surface.value.dataModel.get('/form') || {}
  // the action as the protocol has it (renderer → agent); the values are the data model's /form, copied
  const action = { name: a.name, surfaceId: a.surfaceId, sourceComponentId: a.sourceComponentId, timestamp: a.timestamp || new Date().toISOString(), context: a.context || {} }
  emit('submit', { values: JSON.parse(JSON.stringify(form)), a2ui: { version: '1.0', action } })
}

async function open() {
  close()
  try {
    const R = await import('./runtime.js')
    const msg = props.readonly ? R.readonlyMessage(props.message, props.values || {}) : props.message
    const s = R.openSurface(msg, onAction)
    processor = markRaw(s.processor)
    surface.value = markRaw(s.surface)
    ready.value = true
  } catch (e) {
    console.warn('[a2ui]', e)
    emit('failed', e)
  }
}
function close() {
  try { processor?.dispose?.() } catch { /* gone */ }
  processor = null
  surface.value = null
  ready.value = false
  tried.value = false
}
onMounted(open)
watch(() => [props.message, props.readonly, props.values], open)
onBeforeUnmount(close)
</script>

<template>
  <div class="a2 glass" :class="{ ro: readonly, busy, tried }" data-test="a2ui-step" :data-state="readonly ? 'readonly' : busy ? 'busy' : ready ? 'ready' : 'loading'"
    @focusout="touch" @change="touch" @click="touch" @pointerdown.capture="press">
    <div v-if="title" class="h">
      <span class="t serif">{{ title }}</span>
      <span v-if="subtitle" class="s">{{ subtitle }}</span>
    </div>
    <slot name="top" />
    <div v-if="!ready" class="loading shimmer-text">불러오는 중</div>
    <div class="body" data-no-i18n :inert="readonly || busy ? '' : null">
      <a2ui-surface v-if="surface" :surface.prop="surface" />
    </div>
    <slot />
  </div>
</template>

<style scoped>
.a2 {
  width: 100%; max-width: 424px; border-radius: 24px; padding: 18px; display: flex; flex-direction: column; gap: 12px; box-shadow: var(--shadow-card);
  --regular-bg: var(--bubble-agent-bg);
  color-scheme: dark;
  /* our tokens → the renderer's variables (light · dark follow <html data-theme>) */
  --a2ui-color-background: transparent;
  --a2ui-color-on-background: var(--text-primary);
  --a2ui-color-surface: transparent;
  --a2ui-color-on-surface: var(--text-primary);
  --a2ui-color-primary: var(--ink);
  --a2ui-color-primary-hover: color-mix(in srgb, var(--ink) 82%, transparent);
  --a2ui-color-on-primary: var(--ink-inverse);
  --a2ui-color-secondary: var(--button-bg);
  --a2ui-color-secondary-hover: var(--field-bg);
  --a2ui-color-on-secondary: var(--text-primary);
  --a2ui-color-border: var(--hairline);
  --a2ui-border: 1px solid var(--hairline);
  --a2ui-color-input: var(--field-bg);
  --a2ui-color-on-input: var(--text-primary);
  --a2ui-font-family-title: var(--font-serif);
  --a2ui-font-size: 15px;
  --a2ui-border-radius: 16px;
  --a2ui-label-font-size: 13px;
  --a2ui-label-font-weight: 400;
  --a2ui-text-caption-color: var(--text-secondary);
  --a2ui-text-color-text: var(--text-primary);
  --a2ui-card-background: transparent;
  --a2ui-card-border: 0;
  --a2ui-card-padding: 0;
  --a2ui-card-margin: 0;
  --a2ui-card-box-shadow: none;
  --a2ui-column-gap: 14px;
  --a2ui-row-gap: 8px;
  --a2ui-textfield-border: 1px solid transparent;
  --a2ui-textfield-border-radius: 16px;
  --a2ui-textfield-padding: 11px 16px;
  --a2ui-textfield-color-border-focus: var(--text-primary);
  --a2ui-textfield-color-error: var(--color-error);
  --a2ui-datetimeinput-border: 1px solid transparent;
  --a2ui-datetimeinput-border-radius: 16px;
  --a2ui-datetimeinput-padding: 10px 14px;
  --a2ui-datetimeinput-color-error: var(--color-error);
  --a2ui-datetimeinput-label-font-weight: 400;
  --a2ui-checkbox-label-font-weight: 400;
  --a2ui-checkbox-label-font-size: 14px;
  --a2ui-choicepicker-label-font-weight: 400;
  --a2ui-choicepicker-chip-font-size: 14px;
  --a2ui-slider-label-font-weight: 400;
  accent-color: var(--ink);
  --a2ui-checkbox-color-error: var(--color-error);
  --a2ui-choicepicker-color-error: var(--color-error);
  --a2ui-choicepicker-label-color: var(--text-secondary);
  --a2ui-choicepicker-chip-background: var(--field-bg);
  --a2ui-choicepicker-chip-background-selected: var(--ink);
  --a2ui-choicepicker-chip-border: 0;
  --a2ui-choicepicker-chip-border-radius: 9999px;
  --a2ui-choicepicker-chip-padding: 8px 14px;
  --a2ui-slider-color-error: var(--color-error);
  --a2ui-slider-track-color: var(--field-bg);
  --a2ui-slider-thumb-color: var(--ink);
  --a2ui-button-border-radius: 9999px;
  --a2ui-button-padding: 12px 20px;
  --a2ui-button-font-weight: 500;
  --a2ui-divider-border: 1px solid var(--hairline);
}
:root[data-theme="light"] .a2 { color-scheme: light; }
.h { display: flex; flex-direction: column; gap: 2px; margin: 2px 4px 2px; }
.t { font-size: 22px; letter-spacing: .01em; }
.s { font-size: 13px; color: var(--text-secondary); }
.loading { font-size: 14px; padding: 6px; }
.body { min-width: 0; }
/* phones: a row of buttons wraps instead of running off the side; nothing is wider than the card */
.body :deep(a2ui-basic-row) { flex-wrap: wrap; }
.body :deep(a2ui-basic-row > *) { min-width: 0; }
.body :deep(input), .body :deep(textarea), .body :deep(select) { max-width: 100%; font-size: 15px; }
.body :deep(textarea) { min-height: 88px; resize: vertical; line-height: 1.5; }
.body :deep(label) { color: var(--text-secondary); margin-left: 6px; }
.body :deep(a2ui-checkbox label) { color: var(--text-primary); }
.body :deep(.a2ui-text-caption em) { font-style: normal; }
.body :deep(.a2ui-text-caption) { line-height: 1.5; }
/* check messages and red outlines wait until the field was used (or sending was tried) */
.a2:not(.tried) .body :deep(:is(a2ui-basic-textfield, a2ui-choicepicker, a2ui-checkbox, a2ui-datetimeinput, a2ui-slider):not([data-touched]) .a2ui-validation-errors) { display: none; }
.a2:not(.tried) .body :deep(:is(a2ui-basic-textfield, a2ui-choicepicker, a2ui-checkbox, a2ui-datetimeinput, a2ui-slider):not([data-touched]) .a2ui-invalid) { border-color: transparent; outline-color: transparent; color: inherit; }
.body :deep(.a2ui-error-message) { margin: 2px 0 0 6px; }
.ro .body { opacity: .92; }
.ro .body :deep(input), .ro .body :deep(textarea) { background: transparent; }
.busy .body { opacity: .6; pointer-events: none; }
</style>

<style>
/* the renderer's default sheet makes the whole page follow the system's light/dark (:where(:root) { color-scheme: light dark }): the
   page keeps its own — the screen sets its own color-scheme above */
html:root { color-scheme: normal; }
</style>
