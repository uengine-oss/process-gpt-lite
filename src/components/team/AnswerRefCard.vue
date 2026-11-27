<script setup>
// An AI answer a teammate shared from their chat (server lib/answerShare.js → a room message of kind 'answer'): its title and its words, as
// the sender saw them — folded to a few lines, 「더 보기」 opens the rest. Written by a model, so it is shown as safe Markdown only
// (src/safeMarkdown.js), workspace paths as file names (src/paths.js).
import { computed, ref } from 'vue'
import { safeMarkdown } from '../../safeMarkdown.js'
import { hidePaths } from '../../paths.js'

const props = defineProps({ answer: Object })
const open = ref(false)
const body = computed(() => {
  const t = hidePaths(String(props.answer?.text || ''))
  // a document answer's first line is its title, shown above
  return safeMarkdown(props.answer?.kind === 'doc' ? t.split('\n').slice(1).join('\n') : t, { html: 'text' })
})
const long = computed(() => String(props.answer?.text || '').length > 280)
</script>

<template>
  <div class="ans" data-test="msg-answer" :class="{ open }">
    <p class="ah"><span class="spark">✦</span><b data-no-i18n>{{ answer.title }}</b></p>
    <div class="ab md" data-no-i18n data-test="msg-answer-body" v-html="body" />
    <p v-if="answer.truncated && (open || !long)" class="cut" data-test="msg-answer-truncated">글이 길어서 잘렸어요 · 앞부분만 왔어요</p>
    <button v-if="long" class="more press" data-test="msg-answer-more" @click="open = !open">{{ open ? '접기' : '더 보기' }}</button>
  </div>
</template>

<style scoped>
.ans { margin: 4px 0 2px; padding: 10px 12px; border-radius: 14px; background: var(--cell-bg, rgba(127, 127, 127, .08)); border: 1px solid var(--hairline); min-width: 0; max-width: 100%; box-sizing: border-box; }
.ah { margin: 0 0 4px; display: flex; align-items: baseline; gap: 6px; font-size: 13.5px; }
.ah b { font-weight: 600; overflow-wrap: anywhere; }
.spark { color: var(--text-tertiary); flex: none; }
.ab { font-size: 13px; line-height: 1.5; color: var(--text-primary); max-height: 7.5em; overflow: hidden; overflow-wrap: anywhere; -webkit-mask-image: linear-gradient(#000 70%, transparent); mask-image: linear-gradient(#000 70%, transparent); }
.open .ab { max-height: none; -webkit-mask-image: none; mask-image: none; }
.ab :deep(p), .ab :deep(ul), .ab :deep(ol) { margin: 0 0 6px; }
.ab :deep(h1), .ab :deep(h2), .ab :deep(h3), .ab :deep(h4) { font-size: 13.5px; margin: 6px 0 4px; }
.ab :deep(table) { border-collapse: collapse; font-size: 12px; display: block; overflow-x: auto; max-width: 100%; }
.ab :deep(td), .ab :deep(th) { border: 1px solid var(--hairline); padding: 2px 6px; }
.cut { margin: 4px 0 0; font-size: 12px; color: var(--text-secondary); }
.more { margin-top: 4px; font-size: 12px; font-weight: 600; color: var(--text-secondary); }
</style>
