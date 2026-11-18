// first: picks the screen language and tags every /api call with it (X-PGL-Lang)
import { isEnglish } from './i18n/lang.js'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
import './styles/base.css'
import { auth, adoptHostSession } from './api.js'
import { registerWorker } from './browserNotify.js'

const routes = [
  { path: '/login', component: () => import('./views/LoginView.vue'), meta: { public: true } },
  { path: '/auth/done', component: () => import('./views/AuthDone.vue'), meta: { public: true } },
  { path: '/welcome/age', component: () => import('./views/OnboardAge.vue') },
  { path: '/welcome/intro', component: () => import('./views/OnboardIntro.vue') },
  { path: '/chat', component: () => import('./views/MainView.vue'), meta: { mode: 'chat' } },
  // one conversation the context router told apart, inside the main chat
  { path: '/chat/c/:cid', component: () => import('./views/MainView.vue'), meta: { mode: 'chat' } },
  // 루틴: a process instance (2026-11-18: "프로세스 인스턴스는 프로젝트가 아니다") — the list, and one
  // instance's page (InstanceHeader + its conversation). The old /projects/p/<instId> links (Home cards,
  // chat cards, notifications already sent) land on the same page.
  { path: '/routines/:instId?', name: 'routine', component: () => import('./views/MainView.vue'), meta: { mode: 'routine' } },
  { path: '/projects/p/:instId', redirect: (to) => ({ name: 'routine', params: { instId: to.params.instId } }) },
  { path: '/projects/:id?', component: () => import('./views/MainView.vue'), meta: { mode: 'project' } },
  { path: '/settings/:page?/:sub?', component: () => import('./views/MainView.vue'), meta: { mode: 'chat', settings: true } },
  { path: '/workroom/:kind/:id', component: () => import('./views/WorkroomView.vue') },
  // 공유 폴더 (UI 프로토타입, 가짜 데이터)
  { path: '/folders', component: () => import('./views/FoldersView.vue') },
  { path: '/folders/:slug', component: () => import('./views/FoldersView.vue') },
  { path: '/folders/:slug/v/:variation', component: () => import('./views/FoldersView.vue') },
  // 프로세스 마이닝 추천 (관리자): 반복되는 흐름 → 정식 등록
  { path: '/mining/:id?', component: () => import('./views/MiningView.vue') },
  // 프로세스 개선: 병목 · 가치 흐름 · 제약 · 크리티컬 패스 · 개선 실행(what-if → 새 버전)
  { path: '/improve/:defId?', component: () => import('./views/ImproveView.vue') },
  { path: '/', redirect: '/chat' },
]

const router = createRouter({ history: createWebHistory(import.meta.env.BASE_URL), routes })
adoptHostSession()
router.beforeEach((to) => {
  if (!to.meta.public && !auth.get()?.session) return '/login'
})

// English: the dictionary and the runtime translator go in before the first render
const ready = isEnglish ? import('./i18n/english.js').then((m) => m.installEnglish()).catch((e) => console.error('english mode', e)) : Promise.resolve()
ready.then(() => createApp(App).use(createPinia()).use(router).mount('#app'))
// push notifications and the installed app's badge (public/sw.js)
registerWorker()
