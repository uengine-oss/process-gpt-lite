<script setup>
import { computed } from 'vue'
import { marked } from 'marked'
import Icon from './Icon.vue'

// The whole skill, opened on demand: SKILL.md rendered, the files that travel with it, and
// (for a fresh draft) the skill-creator's own notes, folded.
const props = defineProps({ skill: Object })
defineEmits(['close'])
const body = computed(() => String(props.skill?.markdown || '').replace(/^---\n[\s\S]*?\n---\n?/, ''))
const html = computed(() => marked.parse(body.value.replace(/</g, '&lt;'), { breaks: false }))
const noteHtml = computed(() => marked.parse(String(props.skill?.note || '').replace(/</g, '&lt;'), { breaks: true }))
</script>

<template>
  <Teleport to="body">
    <div class="veil" @click.self="$emit('close')">
      <div class="sheet glass blur-in" role="dialog" :aria-label="skill.name">
        <header>
          <div>
            <span class="badge">스킬</span>
            <h2 class="serif">{{ skill.name }}</h2>
          </div>
          <button class="x press" aria-label="닫기" @click="$emit('close')"><Icon name="close" :size="18" /></button>
        </header>
        <p v-if="skill.description" class="desc">{{ skill.description }}</p>
        <div v-if="skill.tools?.length" class="tools"><span v-for="t in skill.tools" :key="t">{{ t }}</span></div>
        <div class="md scroll" v-html="html" />
        <div v-if="skill.files?.length > 1" class="files">
          <p class="cap">함께 들어 있는 파일</p>
          <span v-for="f in skill.files" :key="f">{{ f }}</span>
        </div>
        <details v-if="skill.note" class="note">
          <summary>skill-creator 작업 메모</summary>
          <div class="md" v-html="noteHtml" />
        </details>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.veil { position: fixed; inset: 0; z-index: 200; background: rgba(0, 0, 0, .28); display: grid; place-items: center; padding: 16px; }
.sheet { width: min(720px, 100%); min-width: 0; box-sizing: border-box; max-height: min(86vh, 900px); border-radius: 28px; padding: 22px 24px; display: flex; flex-direction: column; gap: 10px; background: var(--bubble-agent-bg); box-shadow: var(--shadow-card); }
header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.badge { font-size: 12px; color: var(--text-secondary); letter-spacing: .04em; }
header > div { min-width: 0; }
h2 { margin: 2px 0 0; font-size: 26px; font-weight: 400; overflow-wrap: anywhere; }
.x { width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; background: var(--field-bg); flex: none; }
.desc { margin: 0; color: var(--text-secondary); font-size: 14.5px; line-height: 1.55; }
.tools, .files { display: flex; flex-wrap: wrap; gap: 5px; }
.tools span, .files span { font: 11.5px ui-monospace, Menlo, monospace; padding: 3px 8px; border-radius: 9999px; background: var(--field-bg); color: var(--text-secondary); }
.md { overflow: auto; overflow-wrap: anywhere; font-size: 14.5px; line-height: 1.6; border-top: 1px solid var(--hairline); padding-top: 10px; min-height: 0; }
.md :deep(h1), .md :deep(h2) { font-size: 18px; margin: 1em 0 .4em; } .md :deep(h3) { font-size: 15.5px; margin: .9em 0 .3em; }
.md :deep(p) { margin: 0 0 .6em; } .md :deep(ol), .md :deep(ul) { padding-left: 1.3em; margin: 0 0 .6em; }
.md :deep(pre) { background: var(--field-bg); border-radius: 12px; padding: 10px 12px; overflow: auto; font-size: 12.5px; }
.md :deep(code) { font-size: 12.5px; } .md :deep(table) { border-collapse: collapse; font-size: 13px; } .md :deep(td), .md :deep(th) { padding: 4px 8px; border-bottom: 1px solid var(--hairline); }
.cap { width: 100%; margin: 0 0 2px; font-size: 12.5px; color: var(--text-secondary); }
.note summary { cursor: pointer; font-size: 13px; color: var(--text-secondary); }
.note .md { max-height: 240px; border-top: 0; }
@media (max-width: 760px) {
  .veil { place-items: end stretch; padding: 0; }
  .sheet { width: 100%; max-height: 88vh; border-radius: 28px 28px 0 0; padding: 20px 18px 28px; }
  h2 { font-size: 22px; }
}
</style>
