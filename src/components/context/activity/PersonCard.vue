<script setup>
// 팀 활동 카드 한 장(server lib/context/activity.js assembleCard): 서버가 보는 사람의 깊이로 이미 자른 것을 그대로 그린다.
// 지금 하는 일을 누르면 그 맥락의 시간순 보기(open), 깊이가 모자란 칸은 「제목만」「요약까지」로 표시한다.
import { computed } from 'vue'
import { DEPTH, kindColor, ago, stamp, credits } from './fmt.js'

const props = defineProps({ card: Object, interactive: { type: Boolean, default: true } })
const emit = defineEmits(['open'])
const total = computed(() => props.card.kinds.reduce((n, k) => n + k.count, 0) || 1)
const initial = computed(() => (props.card.name || '?').slice(0, 1))
const open = (x) => { if (props.interactive && x.conversationId) emit('open', { user: props.card.user, conversationId: x.conversationId, title: x.title || x.context }) }
</script>

<template>
  <article class="pc glass">
    <header>
      <span class="av">{{ initial }}</span>
      <div class="who">
        <b>{{ card.name }}</b>
        <small>{{ card.team || '조직도 밖' }} · <span class="rel" :class="{ me: card.relation === '본인' }">{{ card.relation }}</span></small>
      </div>
      <span class="sp" />
      <div class="amt">
        <span>턴 <b>{{ card.amount.turns }}</b></span>
        <span v-if="card.amount.cost">비용 <b>{{ credits(card.amount.cost) }}</b></span>
      </div>
    </header>

    <section>
      <p class="cap">지금 하는 일</p>
      <button v-for="x in card.now" :key="x.conversationId" class="now press" :class="{ off: !interactive }" @click="open(x)">
        <span class="t"><b>{{ x.title }}</b><i class="dp" :class="x.depth">{{ DEPTH[x.depth] }}</i><small>{{ ago(x.at) }}</small></span>
        <span v-if="x.line" class="ln">{{ x.line }}</span>
        <span v-else-if="x.purpose" class="ln dim">{{ x.purpose }}</span>
      </button>
      <p v-if="!card.now.length" class="none">최근 7일 동안 보이는 작업이 없어요</p>
    </section>

    <section v-if="card.kinds.length">
      <p class="cap">주로 하는 일 <small>30일</small></p>
      <div class="bar"><i v-for="k in card.kinds" :key="k.name" :style="{ flex: k.count, background: kindColor(k.name) }" :title="`${k.name} ${k.count}`" /></div>
      <div class="legend"><span v-for="k in card.kinds" :key="k.name"><i :style="{ background: kindColor(k.name) }" />{{ k.name }} {{ Math.round(k.count / total * 100) }}%</span></div>
    </section>

    <section v-if="card.prompt_types.length || card.prompt_types_unnamed">
      <p class="cap">자주 쓰는 프롬프트 유형</p>
      <div class="types">
        <span v-for="t in card.prompt_types" :key="t.name" class="ty" :title="t.examples?.length ? t.examples.join('\n') : ''">{{ t.name }} <b>{{ t.count }}회</b></span>
      </div>
      <p v-for="t in card.prompt_types.filter((x) => x.examples?.length).slice(0, 1)" :key="t.name" class="ex">예: 「{{ t.examples[0] }}」</p>
      <p v-if="card.prompt_types_unnamed" class="none">제목만 보이는 일 {{ card.prompt_types_unnamed }}회는 유형 이름 없이 셉니다</p>
    </section>

    <section v-if="card.running.count">
      <p class="cap">진행 중인 AI 작업</p>
      <div v-for="(r, i) in card.running.items" :key="i" class="run" :class="{ link: r.conversationId && interactive }" @click="open(r)">
        <i class="pulse" :class="r.status" />
        <span><b>{{ r.kind_label }}</b> · {{ r.private ? '비공개 맥락' : r.title }}<small v-if="r.detail"> — {{ r.detail }}</small></span>
        <small class="st">{{ r.status_label }} · {{ ago(r.started_at) }}</small>
      </div>
      <p v-if="card.running.hidden" class="none">{{ card.running.items.length ? '그 밖에 ' : '' }}AI 작업 {{ card.running.hidden }}건 진행 중 — 내용은 맥락을 볼 수 있는 사람에게만 보여요</p>
    </section>

    <section v-if="card.artifacts.length">
      <p class="cap">최근 산출물</p>
      <div class="arts">
        <component :is="a.url ? 'a' : 'span'" v-for="(a, i) in card.artifacts" :key="i" class="art" :href="a.url" target="_blank" rel="noopener" :title="a.context ? `「${a.context}」에서` : ''">
          <i>{{ (a.ext || 'doc').toUpperCase().slice(0, 4) }}</i>{{ a.name }}
        </component>
      </div>
    </section>

    <p v-if="card.private" class="priv">비공개 작업 {{ card.private.count }}건 <small>내용 없이 건수만</small></p>
    <footer>
      <small v-if="card.stale">요약을 다시 만드는 중 — 지금은 {{ stamp(card.built_at) }} 기준</small>
      <small v-else-if="card.built_at">요약 기준 {{ stamp(card.built_at) }}</small>
    </footer>
  </article>
</template>

<style scoped>
.pc { border-radius: 22px; padding: 14px 16px 10px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
header { display: flex; align-items: center; gap: 10px; }
.av { width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; background: var(--ink); color: var(--ink-inverse); font-weight: 600; font-size: 15px; flex: none; }
.who { display: flex; flex-direction: column; min-width: 0; }
.who b { font-size: 16px; font-weight: 600; }
.who small { color: var(--text-secondary); font-size: 12.5px; }
.rel { color: var(--text-primary); }
.rel.me { color: var(--color-info); }
.sp { flex: 1; }
.amt { display: flex; gap: 10px; font-size: 12.5px; color: var(--text-secondary); }
.amt b { color: var(--text-primary); font-weight: 600; }
section { display: flex; flex-direction: column; gap: 5px; }
.cap { margin: 0; font-size: 12px; color: var(--text-secondary); letter-spacing: .02em; }
.cap small { color: var(--text-tertiary); margin-left: 4px; }
.now { text-align: left; display: flex; flex-direction: column; gap: 2px; padding: 7px 10px; border-radius: 12px; background: var(--cell-bg); }
.now:hover:not(.off) { background: var(--button-bg); }
.now.off { cursor: default; }
.now .t { display: flex; align-items: center; gap: 6px; min-width: 0; }
.now .t b { font-weight: 500; font-size: 14.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.now .t small { margin-left: auto; color: var(--text-tertiary); font-size: 12px; flex: none; }
.ln { font-size: 13px; color: var(--text-secondary); line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.ln.dim { color: var(--text-tertiary); }
.dp { font-style: normal; font-size: 11px; padding: 1px 7px; border-radius: 8px; flex: none; background: var(--field-bg); color: var(--text-secondary); }
.dp.summary { background: rgba(76, 141, 246, .16); color: var(--color-info); }
.dp.content { background: rgba(59, 185, 138, .16); color: var(--color-success); }
.bar { display: flex; height: 8px; border-radius: 4px; overflow: hidden; gap: 2px; }
.bar i { display: block; height: 100%; }
.legend { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 12px; color: var(--text-secondary); }
.legend span { display: inline-flex; align-items: center; gap: 4px; }
.legend i { width: 8px; height: 8px; border-radius: 2px; }
.types { display: flex; flex-wrap: wrap; gap: 5px; }
.ty { font-size: 12.5px; padding: 3px 9px; border-radius: 10px; background: var(--field-bg); }
.ty b { font-weight: 600; margin-left: 2px; }
.ex { margin: 0; font-size: 12.5px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.none { margin: 0; font-size: 12.5px; color: var(--text-tertiary); }
.run { display: flex; align-items: center; gap: 8px; font-size: 13px; padding: 4px 2px; min-width: 0; }
.run.link { cursor: pointer; }
.run > span { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.run small { color: var(--text-secondary); }
.run .st { margin-left: auto; flex: none; color: var(--text-tertiary); font-size: 12px; }
.pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--color-success); flex: none; animation: pulse 1.6s ease-in-out infinite; }
.pulse.needs_input, .pulse.queued { background: #F2A33A; }
@keyframes pulse { 50% { opacity: .35; } }
.arts { display: flex; flex-wrap: wrap; gap: 6px; }
.art { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; padding: 3px 9px 3px 4px; border-radius: 10px; background: var(--field-bg); color: var(--text-primary); text-decoration: none; max-width: 100%; }
.art i { font-style: normal; font-size: 10px; font-weight: 700; padding: 2px 5px; border-radius: 6px; background: var(--ink); color: var(--ink-inverse); }
.priv { margin: 0; font-size: 13px; padding: 6px 10px; border-radius: 10px; background: var(--field-bg); }
.priv small { color: var(--text-tertiary); margin-left: 4px; }
footer small { color: var(--text-tertiary); font-size: 11.5px; }
</style>
