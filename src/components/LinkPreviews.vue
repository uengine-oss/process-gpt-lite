<script setup>
// 메시지 아래 링크 미리보기 카드들(채팅의 내 말 · 에이전트 답, 루틴 대화, 팀 메시지): 처음 세 링크마다 하나(src/linkPreview.js).
// 회사가 끈 서버(GET /api/me features.linkPreview === false)에서는 아무것도 그리지 않는다.
import { computed } from 'vue'
import { linksIn } from '../linkPreview.js'
import { useApp } from '../stores/app.js'
import LinkCard from './LinkCard.vue'

const props = defineProps({ text: { type: String, default: '' } })
const app = useApp()
const urls = computed(() => (app.me?.features?.linkPreview === false ? [] : linksIn(props.text)))
</script>

<template>
  <div v-if="urls.length" class="lps" role="group" aria-label="링크 미리보기" data-test="link-previews">
    <LinkCard v-for="u in urls" :key="u" :url="u" />
  </div>
</template>

<style scoped>
.lps { display: flex; flex-direction: column; gap: 6px; width: min(424px, 100%); max-width: 100%; margin-top: 6px; }
</style>
