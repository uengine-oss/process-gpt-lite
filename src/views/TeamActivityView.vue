<script setup>
// 팀 활동 (팀 맥락 공유, server routes/teamActivity.js): 공유된 AI 작업만, 보는 사람의 깊이로.
//   범위 팀·부서·회사 → 사람마다 카드(지금 하는 일·주로 하는 일·자주 쓰는 프롬프트 유형·진행 중인 AI 작업·최근 산출물·양)
//   맥락을 누르면 시간순 보기(「원문 보기」 = 참고 요청), 장·관리자는 「조직도 보기」, 오른쪽에 「비슷한 주제를 하는 사람」,
//   「다른 사람 눈으로 내 카드 보기」. /team-activity?scope=department&view=org 로 바로 열 수 있다.
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import TopBar from '../components/TopBar.vue'
import PersonCard from '../components/context/activity/PersonCard.vue'
import TimelineDrawer from '../components/context/activity/TimelineDrawer.vue'
import OrgNode from '../components/context/activity/OrgNode.vue'
import OverlapPanel from '../components/context/activity/OverlapPanel.vue'
import MeAsSheet from '../components/context/activity/MeAsSheet.vue'
import { api } from '../api.js'
import { stamp } from '../components/context/activity/fmt.js'

const route = useRoute()
const router = useRouter()
const SCOPES = [{ id: 'team', label: '팀' }, { id: 'department', label: '부서' }, { id: 'company', label: '회사' }]
const scope = ref(SCOPES.some((s) => s.id === route.query.scope) ? route.query.scope : 'team')
const view = ref(route.query.view === 'org' ? 'org' : 'cards')
const d = ref(null), org = ref(null), err = ref(''), loading = ref(false), canOrg = ref(true)
const target = ref(null), meAs = ref(false), overlaps = ref(null)

async function load() {
  err.value = ''; loading.value = true
  try { d.value = await api(`/team-activity?scope=${scope.value}`); canOrg.value = d.value.viewer.can_org } catch (e) { err.value = e.message } finally { loading.value = false }
}
async function loadOrg() {
  err.value = ''
  try { org.value = await api('/team-activity/org') } catch (e) {
    if (e.status === 403) { canOrg.value = false; view.value = 'cards' } else err.value = e.message
  }
}
function setScope(s) { scope.value = s; view.value = 'cards'; sync(); load() }
function showOrg() { view.value = view.value === 'org' ? 'cards' : 'org'; sync(); if (view.value === 'org') loadOrg() }
const sync = () => router.replace({ query: { ...(scope.value !== 'team' ? { scope: scope.value } : {}), ...(view.value === 'org' ? { view: 'org' } : {}) } })
function reloadAll() { load(); if (view.value === 'org') loadOrg() }
onMounted(() => { load(); if (view.value === 'org') loadOrg() })
watch(() => route.query.scope, (s) => { if (s && s !== scope.value && SCOPES.some((x) => x.id === s)) { scope.value = s; load() } })
const counts = computed(() => (d.value ? `${d.value.cards.length}명` : ''))
</script>

<template>
  <div class="ta">
    <TopBar />
    <div class="page scroll">
      <div class="mv">
        <div class="head">
          <h1>팀 활동</h1>
          <span class="sub">공유된 작업만, 내가 볼 수 있는 깊이로 모았어요</span>
          <span class="sp" />
          <nav v-if="view === 'cards'" class="seg" aria-label="범위">
            <button v-for="s in SCOPES" :key="s.id" :class="{ on: scope === s.id }" @click="setScope(s.id)">{{ s.label }}</button>
          </nav>
          <button v-if="canOrg && d?.viewer.can_org" class="hbtn press" :class="{ on: view === 'org' }" @click="showOrg">{{ view === 'org' ? '카드로 보기' : '조직도 보기' }}</button>
          <button v-if="d?.viewer.in_org" class="hbtn press" @click="meAs = true">다른 사람 눈으로 내 카드 보기</button>
        </div>

        <p v-if="d && !d.viewer.in_org" class="note glass">조직도에 내 자리가 없어서 팀 활동을 볼 수 없어요. 관리자에게 조직도에 넣어 달라고 하세요.</p>

        <div class="body">
          <main>
            <template v-if="view === 'org'">
              <p class="cap">조직도 <small v-if="org?.built_at">요약 기준 {{ stamp(org.built_at) }} · 비공개 작업은 건수·비용에만 들어가요</small></p>
              <div v-if="org" class="tree">
                <OrgNode v-for="n in org.roots" :key="n.id" :node="n" @open="target = $event" />
              </div>
              <p v-else-if="!err" class="cap">불러오는 중…</p>
            </template>
            <template v-else>
              <p class="cap">{{ SCOPES.find((s) => s.id === scope).label }} 범위 {{ counts }}<small v-if="loading"> · 새로 고치는 중</small></p>
              <div v-if="d" class="cards">
                <PersonCard v-for="c in d.cards" :key="c.user" :card="c" @open="target = $event" />
              </div>
              <p v-if="d && !d.cards.length && d.viewer.in_org" class="cap">이 범위에는 아직 사람이 없어요</p>
            </template>
          </main>
          <aside>
            <OverlapPanel ref="overlaps" @open="target = $event" />
            <div class="legend glass">
              <p class="ct">깊이</p>
              <p><i class="dp">제목</i> 제목·한 줄 목적·작업 유형 횟수</p>
              <p><i class="dp summary">요약</i> 요약 한 줄·프롬프트 유형 이름</p>
              <p><i class="dp content">원문</i> 프롬프트 문장과 답</p>
              <small>비공개 맥락은 보이지 않아요. 관리자에게만 건수로 보여요.</small>
            </div>
          </aside>
        </div>
        <p v-if="err" class="err glass">{{ err }}</p>
      </div>
    </div>
    <TimelineDrawer v-if="target" :target="target" @close="target = null" @granted="reloadAll" />
    <MeAsSheet v-if="meAs" @close="meAs = false" />
  </div>
</template>

<style scoped>
.ta { position: absolute; inset: 0; }
.page { position: absolute; top: 84px; left: 0; right: 0; bottom: 0; }
.page.scroll { overflow-y: auto; }
.mv { max-width: 1200px; margin: 0 auto; padding: 0 24px 60px; }
.head { display: flex; align-items: center; gap: 12px; margin: 4px 0 14px; flex-wrap: wrap; }
h1 { margin: 0; font-size: 28px; font-weight: 500; letter-spacing: -0.02em; }
.sub { color: var(--text-secondary); font-size: 14px; }
.sp { flex: 1; }
.seg { display: inline-flex; padding: 3px; border-radius: 9999px; background: var(--field-bg); gap: 2px; }
.seg button { height: 32px; padding: 0 16px; border-radius: 9999px; font-size: 14px; color: var(--text-secondary); }
.seg button.on { background: var(--ink); color: var(--ink-inverse); }
.hbtn { height: 36px; padding: 0 14px; border-radius: 18px; font-size: 14px; background: var(--button-bg); }
.hbtn.on { background: var(--ink); color: var(--ink-inverse); }
.body { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 14px; align-items: start; }
main { min-width: 0; }
.cap { margin: 0 4px 8px; color: var(--text-secondary); font-size: 13.5px; }
.cap small { color: var(--text-tertiary); margin-left: 6px; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 12px; align-items: start; }
.tree { display: flex; flex-direction: column; gap: 10px; }
aside { display: flex; flex-direction: column; gap: 12px; position: sticky; top: 0; }
.legend { border-radius: 18px; padding: 12px 14px; display: flex; flex-direction: column; gap: 5px; }
.legend .ct { margin: 0 0 2px; font-weight: 600; font-size: 14px; }
.legend p { margin: 0; font-size: 12.5px; color: var(--text-secondary); display: flex; gap: 6px; align-items: center; }
.legend small { color: var(--text-tertiary); font-size: 12px; margin-top: 2px; }
.dp { font-style: normal; font-size: 11px; padding: 1px 7px; border-radius: 8px; background: var(--field-bg); color: var(--text-secondary); flex: none; }
.dp.summary { background: rgba(76, 141, 246, .16); color: var(--color-info); }
.dp.content { background: rgba(59, 185, 138, .16); color: var(--color-success); }
.note { padding: 12px 16px; border-radius: 14px; font-size: 14px; }
.err { margin-top: 14px; padding: 12px 16px; border-radius: 14px; color: var(--color-error); font-size: 14px; }
@media (max-width: 900px) { .body { grid-template-columns: 1fr; } aside { position: static; } }
</style>
