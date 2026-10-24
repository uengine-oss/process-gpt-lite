<script setup>
import { computed, ref } from 'vue'
import { useApp } from '../stores/app.js'

const props = defineProps({ action: Object })
const app = useApp()
const verbs = { Reply: '답장', Pay: '납부', Release: '처리', Remind: '알림', Add: '추가', Review: '검토', Call: '전화', Book: '예약', Sign: '서명' }
const icon = computed(() => (props.action.icon ? `https://www.google.com/s2/favicons?domain=${props.action.icon}&sz=64` : null))
const iconFailed = ref(false)
const letter = computed(() => (props.action.icon || props.action.source?.from || '?').replace(/^www\./, '').charAt(0).toUpperCase())
// the model may return ISO timestamps or free text; show dates the way people say them
const due = computed(() => {
  const d = props.action.due
  if (!d) return ''
  const t = new Date(d)
  return isNaN(t) ? d : t.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' })
})
</script>

<template>
  <button class="act glass press" :class="{ running: action.status === 'running' }" @click="action.status === 'open' && app.runAction(action)">
    <span class="verb" :title="verbs[action.verb] || ''">{{ action.verb }}</span>
    <img v-if="icon && !iconFailed" :src="icon" class="ico" alt="" @error="iconFailed = true" />
    <span v-else-if="icon" class="ico letter">{{ letter }}</span>
    <span class="txt" :class="{ 'shimmer-text': action.status === 'running' }">{{ action.text }}</span>
    <span v-if="due" class="due">{{ due }}</span>
    <span class="x" role="button" aria-label="닫기" @click.stop="app.dismissAction(action)">×</span>
  </button>
</template>

<style scoped>
.act { position: relative; display: block; width: 100%; text-align: left; border-radius: 24px; padding: 17px 16px 19px 22px; font-size: 16px; line-height: 34px; color: var(--text-primary); }
.verb { display: inline-block; height: 34px; line-height: 34px; padding: 0 8px; border-radius: 8px; background: var(--chip-bg); margin-right: 8px; font-weight: 450; vertical-align: top; }
.ico { width: 24px; height: 24px; border-radius: 9999px; vertical-align: -6px; margin-right: 8px; background: #fff; }
.letter { display: inline-grid; place-items: center; font-size: 12px; font-weight: 600; color: #fff; background: linear-gradient(135deg, #7d8fb8, #4b5d8c); }
.txt { line-height: 1.75; }
.due { display: block; color: var(--text-secondary); line-height: 1.6; }
.x { position: absolute; top: 8px; right: 12px; width: 24px; height: 24px; border-radius: 9999px; display: grid; place-items: center; color: var(--text-tertiary); opacity: 0; transition: opacity .2s; font-size: 18px; line-height: 1; }
.act:hover .x { opacity: 1; }
.running { cursor: default; }
</style>
