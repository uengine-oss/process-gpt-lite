// first: picks the screen language and tags every /api call with it (X-PGL-Lang)
import { isEnglish } from './i18n/lang.js'
import { createApp, watch } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
import './styles/base.css'
// the desktop app's title bar (desktop/): only under html.pgl-desktop, nothing in a browser
import './styles/desktop.css'
// **굵게** right before a Korean particle (src/markdownCjk.js): every marked.parse in the app
import { installCjkMarkdown } from './markdownCjk.js'
import { watchUaTransitions } from './uaTransition.js'
import { api, auth, adoptHostSession } from './api.js'
import { registerWorker, setBadge } from './browserNotify.js'
import { watchInstall } from './install.js'
import { useApp } from './stores/app.js'

const routes = [
  { path: '/login', component: () => import('./views/LoginView.vue'), meta: { public: true } },
  { path: '/auth/done', component: () => import('./views/AuthDone.vue'), meta: { public: true } },
  // invite-only (2026-11-25): someone who is not an approved member of this company — no session is kept (src/api.js leaveRefused)
  { path: '/invite-only', component: () => import('./views/InviteOnly.vue'), meta: { public: true } },
  // (noTeam: a page without the top bar — the team messenger is not shown over it: App.vue)
  { path: '/welcome/age', component: () => import('./views/OnboardAge.vue'), meta: { noTeam: true } },
  { path: '/welcome/intro', component: () => import('./views/OnboardIntro.vue'), meta: { noTeam: true } },
  { path: '/chat', component: () => import('./views/MainView.vue'), meta: { mode: 'chat' } },
  // one conversation the context router told apart, inside the main chat
  { path: '/chat/c/:cid', component: () => import('./views/MainView.vue'), meta: { mode: 'chat' } },
  // 루틴: a process instance (2026-11-18: "프로세스 인스턴스는 프로젝트가 아니다") — the list, and one
  // instance's page (InstanceHeader + its conversation). The old /projects/p/<instId> links (Home cards,
  // chat cards, notifications already sent) land on the same page.
  { path: '/routines/:instId?', name: 'routine', component: () => import('./views/MainView.vue'), meta: { mode: 'routine' } },
  { path: '/projects/p/:instId', redirect: (to) => ({ name: 'routine', params: { instId: to.params.instId } }) },
  // one sub-topic of a project (2026-11-25: 「하나의 프로젝트 내에서도 서브 레벨로 주제들이 자동 분류」 — src/projectTopics.js)
  { path: '/projects/:id/t/:tid', component: () => import('./views/MainView.vue'), meta: { mode: 'project' } },
  { path: '/projects/:id?', component: () => import('./views/MainView.vue'), meta: { mode: 'project' } },
  { path: '/settings/:page?/:sub?', component: () => import('./views/MainView.vue'), meta: { mode: 'chat', settings: true } },
  { path: '/workroom/:kind/:id', component: () => import('./views/WorkroomView.vue'), meta: { noTeam: true } },
  // 공유 폴더 (UI 프로토타입, 가짜 데이터)
  { path: '/folders', component: () => import('./views/FoldersView.vue') },
  { path: '/folders/:slug', component: () => import('./views/FoldersView.vue') },
  { path: '/folders/:slug/v/:variation', component: () => import('./views/FoldersView.vue') },
  // 프로세스 마이닝 추천 (관리자): 반복되는 흐름 → 정식 등록
  { path: '/mining/:id?', component: () => import('./views/MiningView.vue') },
  // 프로세스 개선: 병목 · 가치 흐름 · 제약 · 크리티컬 패스 · 개선 실행(what-if → 새 버전) — 지도에 없는 정의 프로세스만(아래 넘기기)
  { path: '/improve/:defId?', component: () => import('./views/ImproveView.vue') },
  { path: '/process-map', component: () => import('./views/ProcessMapView.vue') },
  // 전략맵: 목표·우선순위·위험 허용·제약, 단계·기능·정책의 기여 (Agentic BPM)
  { path: '/strategy', component: () => import('./views/StrategyView.vue') },
  // Agentic BPM 리포트 (관리자): 원장에서 배우는 것 — 판단·승인 대기·막은 일·최적화, 정책 조정 제안
  { path: '/agentic', component: () => import('./views/AgenticReportView.vue') },
  // 빌링 백오피스 (운영자): 회사마다 요금제 · 이번 달 사용 · 청구서 · 충전 크레딧
  { path: '/backoffice/:tenant?', component: () => import('./views/BackofficeView.vue') },
  // 팀 활동 (팀 맥락 공유): 공유된 작업만, 보는 사람의 깊이로 — 사람마다 지금 하는 일·주로 하는 일·프롬프트 유형, 장·관리자는 조직도로
  { path: '/team-activity', component: () => import('./views/TeamActivityView.vue') },
  // 다른 사람(또는 내) 대화 맥락 하나를 보는 사람의 깊이로 — 볼 수 없는 깊이는 「요청하기」
  { path: '/context/:conv', component: () => import('./views/ContextView.vue') },
  { path: '/', redirect: '/chat' },
]

const router = createRouter({ history: createWebHistory(import.meta.env.BASE_URL), routes })
adoptHostSession()
installCjkMarkdown()
watchUaTransitions()
// 앱 설치 안내: the browser's install offer can come right after load (src/install.js)
watchInstall()
router.beforeEach((to) => {
  if (!to.meta.public && !auth.get()?.session) return '/login'
})
// signed out — logout, a session that ran out, a sign-in that failed: every way ends on a page with no session. The badge
// (src/browserNotify.js setBadge: the installed app's icon, the desktop app's Dock · taskbar · tray) counted the last person's cards.
router.afterEach(() => { if (!auth.get()?.session) setBadge(0) })
// 개선 분석은 회사 프로세스 지도로 합쳤어요(pgpt-pro/docs/auto-ax-onboarding/design-improve-on-map.md §7, 결정 4): /improve(목록)는 지도의
// 병목 보기로, 지도 프로세스의 스냅샷 정의(/improve/:defId)는 그 프로세스의 병목 보기로 넘기고(server routes/improve.js GET /improve/:defId/map),
// 지도에 없는 정의(손으로 그린 · 생성한 프로세스)는 옛 개선 화면 그대로 — 알림의 /improve/… 주소, 인스턴스 머리글의 링크도 이 규칙을 따른다
// The classic screen opens only when asked (?classic=1 — the routine list's 「클래식 개선 분석」, 2026-11-19), and stays classic while
// one moves inside it; a company without the map (no Ontological DB, /api/me ontology false) has only the classic one.
const IMPROVE = (r) => r.matched.some((m) => m.path === '/improve/:defId?')
router.beforeEach(async (to, from) => {
  if (!IMPROVE(to)) return
  if (to.query.classic) return
  if (IMPROVE(from) && from.query.classic) return { path: to.path, query: { ...to.query, classic: '1' }, hash: to.hash, replace: true }
  if (useApp().me?.ontology === false) return
  if (!to.params.defId) return { path: '/process-map', query: { view: 'flow' }, replace: true }
  // (the old screen's own tab · version changes stay on the same definition)
  if (IMPROVE(from) && from.params.defId === to.params.defId) return
  const r = await api(`/improve/${encodeURIComponent(to.params.defId)}/map`).catch(() => null)
  if (r?.proc) return { path: '/process-map', query: { proc: r.proc, view: 'flow' }, replace: true }
})

// English: the dictionary and the runtime translator go in before the first render
const ready = isEnglish ? import('./i18n/english.js').then((m) => m.installEnglish()).catch((e) => console.error('english mode', e)) : Promise.resolve()
ready.then(() => {
  const pinia = createPinia()
  createApp(App).use(pinia).use(router).mount('#app')
  const app = useApp(pinia)
  // the badge follows the Home cards as they go too: a card put away here (✕, a swipe) gets no new list from the server
  watch(() => app.notifications.length, (n) => setBadge(n))
  // the desktop app's tray 「알림 N개 — 열기」 (desktop/src/tray.js): Home — the chat with its dock open
  window.pglDesktop?.onOpenHome?.(() => {
    const r = router.currentRoute.value
    if (r.meta.mode !== 'chat' || r.meta.settings) router.push('/chat').catch(() => {})
    app.dockOpen = true
  })
})
// push notifications and the installed app's badge (public/sw.js)
registerWorker()
