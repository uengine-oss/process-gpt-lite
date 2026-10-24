<script setup>
// Top of the main chat: the conversations the context router told apart (hark keeps each piece
// of work in its own thread). Closed, a pill; open, the list; inside one, its title and the way
// back. The view is /chat/c/:cid, so a conversation can be linked and reopened.
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import Icon from './Icon.vue'
import { useApp } from '../stores/app.js'

const app = useApp()
const router = useRouter()
const open = ref(false)
const list = computed(() => app.convList)
const cur = computed(() => list.value.find((c) => c.id === app.convFilter) || (app.convFilter ? { id: app.convFilter, title: '대화', count: 0 } : null))
const when = (t) => {
  const d = new Date(t)
  const mins = Math.round((Date.now() - d) / 60000)
  return mins < 60 ? `${Math.max(1, mins)}분 전` : mins < 1440 ? `${Math.round(mins / 60)}시간 전` : d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })
}
const firstLine = (s) => String(s || '').replace(/^최근 요청:\s*/, '').split('\n')[0]
function go(c) { open.value = false; router.push(c ? `/chat/c/${encodeURIComponent(c.id)}` : '/chat') }
</script>

<template>
  <div class="cbar" :class="{ inside: !!cur }">
    <template v-if="cur">
      <button class="back press" @click="go(null)"><Icon name="back" :size="16" /> 전체 대화</button>
      <div class="cur">
        <b>{{ cur.title }}</b>
        <small>이 대화의 메시지 {{ cur.count }}개 · 여기서 물으면 이 대화에 이어져요</small>
      </div>
      <button class="pill press" @click="open = !open">다른 대화 ▾</button>
    </template>
    <button v-else-if="list.length" class="pill press" @click="open = !open">
      <Icon name="plan" :size="15" /> 대화 {{ list.length }}개 · 맥락별로 보기
    </button>

    <Transition name="fade">
      <div v-if="open" class="panel glass" @click.stop>
        <p class="cap">판단 모델이 나눈 대화</p>
        <button v-for="c in list" :key="c.id" class="row press" :class="{ on: c.id === app.convFilter }" @click="go(c)">
          <div class="t"><b>{{ c.title }}</b><small>{{ when(c.updated_at) }} · {{ c.count }}개</small></div>
          <p v-if="c.gist || c.summary" class="s">{{ c.gist ? c.gist + ' · ' : '' }}{{ firstLine(c.summary) }}</p>
        </button>
        <button v-if="app.convFilter" class="row all press" @click="go(null)">전체 대화 보기</button>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/* in the flow above the messages (sticky inside the bottom-anchored list overlapped the first one) */
.cbar { position: relative; z-index: 6; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 0 0 14px; }
/* inside one conversation the bar is a frosted strip, so messages scrolling under it do not show through */
.cbar.inside { padding: 6px; border-radius: 22px; background: var(--composer-bg); -webkit-backdrop-filter: blur(40px) saturate(1.4); backdrop-filter: blur(40px) saturate(1.4); box-shadow: 0 6px 24px rgba(0, 0, 0, .10); }
.cbar.inside .cur { background: transparent; -webkit-backdrop-filter: none; backdrop-filter: none; padding: 2px 6px; }
.pill { display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 14px; border-radius: 17px; font-size: 13.5px; color: var(--text-primary); background: var(--composer-bg); -webkit-backdrop-filter: blur(30px); backdrop-filter: blur(30px); box-shadow: 0 2px 10px rgba(0, 0, 0, .06); }
.back { display: inline-flex; align-items: center; gap: 4px; height: 34px; padding: 0 12px; border-radius: 17px; font-size: 13.5px; background: #1d1d1f; color: #fff; }
.cur { display: flex; flex-direction: column; min-width: 0; flex: 1; padding: 6px 12px; border-radius: 14px; background: var(--composer-bg); -webkit-backdrop-filter: blur(30px); backdrop-filter: blur(30px); }
.cur b { font-size: 14.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cur small { color: var(--text-secondary); font-size: 12px; }
.panel { position: absolute; top: 42px; left: 0; width: min(520px, 100%); max-height: 60vh; overflow: auto; border-radius: 20px; padding: 8px; box-shadow: 0 16px 48px rgba(0, 0, 0, .18); }
.cap { margin: 6px 10px 6px; font-size: 12.5px; color: var(--text-secondary); }
.row { display: block; width: 100%; text-align: left; padding: 10px 12px; border-radius: 14px; color: var(--text-primary); }
.row:hover { background: rgba(0, 0, 0, .05); } .row.on { background: rgba(42, 120, 214, .12); }
.row .t { display: flex; align-items: baseline; gap: 8px; }
.row .t b { flex: 1; font-size: 14.5px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row .t small { flex: none; color: var(--text-tertiary); font-size: 12px; }
.row .s { margin: 4px 0 0; font-size: 12.5px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row.all { text-align: center; font-size: 13px; color: var(--text-secondary); }
</style>
