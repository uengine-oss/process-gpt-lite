import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
import './styles/base.css'
import { auth } from './api.js'

const routes = [
  { path: '/login', component: () => import('./views/LoginView.vue'), meta: { public: true } },
  { path: '/auth/done', component: () => import('./views/AuthDone.vue'), meta: { public: true } },
  { path: '/welcome/age', component: () => import('./views/OnboardAge.vue') },
  { path: '/welcome/intro', component: () => import('./views/OnboardIntro.vue') },
  { path: '/chat', component: () => import('./views/MainView.vue'), meta: { mode: 'chat' } },
  // one conversation the context router told apart, inside the main chat
  { path: '/chat/c/:cid', component: () => import('./views/MainView.vue'), meta: { mode: 'chat' } },
  { path: '/projects/p/:instId', component: () => import('./views/MainView.vue'), meta: { mode: 'project' } },
  { path: '/projects/:id?', component: () => import('./views/MainView.vue'), meta: { mode: 'project' } },
  { path: '/settings/:page?/:sub?', component: () => import('./views/MainView.vue'), meta: { mode: 'chat', settings: true } },
  { path: '/workroom/:kind/:id', component: () => import('./views/WorkroomView.vue') },
  // 공유 폴더 (UI 프로토타입, 가짜 데이터)
  { path: '/folders', component: () => import('./views/FoldersView.vue') },
  { path: '/folders/:slug', component: () => import('./views/FoldersView.vue') },
  { path: '/folders/:slug/v/:variation', component: () => import('./views/FoldersView.vue') },
  { path: '/', redirect: '/chat' },
]

const router = createRouter({ history: createWebHistory(), routes })
router.beforeEach((to) => {
  if (!to.meta.public && !auth.get()?.session) return '/login'
})

createApp(App).use(createPinia()).use(router).mount('#app')
