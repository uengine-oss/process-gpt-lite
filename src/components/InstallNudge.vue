<script setup>
// 「앱 설치」 안내 (2026-11-24, 「lite 로 직접 들어갔을때도 앱설치가 안된상태면 앱설치유도」): one card, three places —
//   place 'login' : the sign-in screen (phones; a link opened from a chat lands here first)
//   place 'home'  : Home's cards after signing in (a computer gets only this small one)
//   place 'sheet' : settings › 앱 설치, any time — always shown, with the browser-menu way too
// The card shows by itself only where installing is possible here and this device has not answered
// 「나중에」 (7 days) or 「다시 보지 않기」; never inside the installed app, the Android wrapper or the desktop
// app. What the browser can do: src/installEnv.js; the browser's offer and the answers: src/install.js.
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { install, currentEnv, kindNow, nudgeHere, linkOut, dismiss, promptInstall } from '../install.js'

const props = defineProps({ place: { type: String, default: 'home' } })
const emit = defineEmits(['close'])

const env = ref(currentEnv())
// installed from this very tab (a computer's Chrome moves the page into the app window), or the desktop
// app's preload marked the page after this read: read again
let mq
const reread = () => { env.value = currentEnv() }
onMounted(() => {
  reread()
  try { mq = window.matchMedia('(display-mode: standalone)'); mq.addEventListener?.('change', reread) } catch { /* old browser */ }
})
onBeforeUnmount(() => { try { mq?.removeEventListener?.('change', reread) } catch { /* gone */ } })

const sheet = computed(() => props.place === 'sheet')
const kind = computed(() => kindNow(env.value))
const installed = computed(() => !!install.memo.installedAt || install.related)
// (settings › 앱 설치 on a device that installed it before: how to open it first, the way to install again below)
const already = computed(() => installed.value && (kind.value === 'menu' || kind.value === 'ios'))
const shown = computed(() => !env.value.appMode && (sheet.value ? kind.value !== 'none' : nudgeHere(props.place, env.value)))
const phone = computed(() => env.value.os !== 'desktop')
const out = computed(() => (kind.value === 'inapp' ? linkOut(env.value) : null))

const title = computed(() => ({
  prompt: '앱으로 설치하기',
  ios: '홈 화면에 추가하기',
  inapp: '브라우저에서 열어야 설치할 수 있어요',
  menu: '앱으로 설치하기',
  unsupported: '앱으로 설치하기',
  ...(already.value ? { [kind.value]: '이미 설치했어요' } : {}),
}[kind.value] || ''))
const lead = computed(() => {
  if (kind.value === 'inapp') return env.value.inapp?.name ? `${env.value.inapp.name} 안의 브라우저에서는 앱을 설치할 수 없어요.` : '앱 안의 브라우저에서는 앱을 설치할 수 없어요.'
  if (already.value) return '홈 화면이나 앱 목록의 Process GPT 아이콘을 누르세요.'
  if (kind.value === 'unsupported') return '이 브라우저에서는 앱을 설치할 수 없어요.'
  return phone.value ? '홈 화면에서 바로 열고, 알림도 받을 수 있어요.' : '브라우저 탭 없이 별도 창으로 열려요.'
})
// the way through the browser's own menu (and the in-app browsers no link can leave)
const how = computed(() => {
  if (kind.value === 'inapp' && !out.value) {
    return env.value.os === 'ios'
      ? '오른쪽 위나 아래의 ⋯ 메뉴에서 「Safari로 열기」나 「외부 브라우저로 열기」를 누르세요.'
      : '주소를 복사해 Chrome이나 Edge에서 열어 주세요.'
  }
  if (kind.value === 'menu') {
    if (env.value.os === 'android') return '브라우저 메뉴(⋮)에서 「앱 설치」나 「홈 화면에 추가」를 누르세요.'
    if (env.value.browser === 'safari') return '메뉴 막대의 「파일 › Dock에 추가」를 누르세요.'
    return '주소창 오른쪽의 설치 아이콘이나 브라우저 메뉴에서 「앱 설치」를 누르세요.'
  }
  if (kind.value === 'unsupported') return 'Chrome이나 Edge에서 열면 설치할 수 있어요.'
  return ''
})

const busy = ref(false)
async function go() {
  busy.value = true
  try { await promptInstall() } finally { busy.value = false }
  if (sheet.value) emit('close')
}
const copied = ref(false)
async function copy() {
  const url = location.href
  let ok = false
  try { await navigator.clipboard.writeText(url); ok = true } catch { /* an app's web view may refuse */ }
  if (!ok) {
    try {
      const t = Object.assign(document.createElement('textarea'), { value: url })
      t.setAttribute('readonly', '')
      t.style.cssText = 'position:fixed;opacity:0;top:0;left:0'
      document.body.appendChild(t)
      t.select()
      ok = document.execCommand('copy')
      t.remove()
    } catch { /* nothing more to try: the address is still in the app's own menu */ }
  }
  copied.value = ok
  if (ok) setTimeout(() => { copied.value = false }, 2500)
}
const later = (how) => { dismiss(how) }
</script>

<template>
  <div v-if="shown" :class="sheet ? 'veil' : 'wrap'" @click.self="sheet && emit('close')">
    <section class="install" :class="[place, kind, { glass: !sheet }]" role="region" aria-label="앱 설치" data-test="install-nudge" :data-kind="kind">
      <div class="head">
        <span class="appicon" aria-hidden="true">
          <svg viewBox="0 0 32 32" width="40" height="40"><rect width="32" height="32" rx="8" fill="#1d1d1f" /><path d="M7 16 25 8 20 25 16 18z" fill="#f5f5f7" /></svg>
        </span>
        <div class="titles">
          <strong>{{ title }}</strong>
          <small>{{ lead }}</small>
        </div>
        <button v-if="sheet" class="x press" aria-label="닫기" data-test="install-close" @click="emit('close')">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </div>

      <!-- iPhone · iPad: no install API — Share › 홈 화면에 추가 › 추가. The sign-in screen has the short way
           (one line, it sits under the sign-in buttons); Home and the sheet number the steps. -->
      <template v-if="kind === 'ios' && place === 'login'">
        <div class="path" data-test="install-ios-path">
          <span class="chip"><span class="g" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v11.5M8 6.8 12 3l4 3.8M7.5 10H6a1.5 1.5 0 0 0-1.5 1.5v8A1.5 1.5 0 0 0 6 21h12a1.5 1.5 0 0 0 1.5-1.5v-8A1.5 1.5 0 0 0 18 10h-1.5" /></svg></span>공유</span><span class="sep" aria-hidden="true">›</span>
          <span class="chip"><span class="g" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="4" y="4" width="16" height="16" rx="4" /><path d="M12 8.5v7M8.5 12h7" /></svg></span>홈 화면에 추가</span><span class="sep" aria-hidden="true">›</span>
          <span class="chip">추가</span>
        </div>
        <p class="note">공유 버튼이 보이지 않으면 ⋯ 버튼을 먼저 누르세요.</p>
      </template>
      <ol v-else-if="kind === 'ios'" class="steps" data-test="install-ios-steps">
        <li>
          <span class="glyph" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v11.5M8 6.8 12 3l4 3.8M7.5 10H6a1.5 1.5 0 0 0-1.5 1.5v8A1.5 1.5 0 0 0 6 21h12a1.5 1.5 0 0 0 1.5-1.5v-8A1.5 1.5 0 0 0 18 10h-1.5" /></svg></span>
          <span class="t"><span>공유 버튼을 누르세요.</span> <small>보이지 않으면 ⋯ 버튼을 먼저 누르세요.</small></span>
        </li>
        <li>
          <span class="glyph" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="4" y="4" width="16" height="16" rx="4" /><path d="M12 8.5v7M8.5 12h7" /></svg></span>
          <span class="t"><span>「홈 화면에 추가」를 누르세요.</span></span>
        </li>
        <li>
          <span class="glyph" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg></span>
          <span class="t"><span>「추가」를 누르면 끝이에요.</span></span>
        </li>
      </ol>

      <p v-if="how" class="how">{{ how }}</p>

      <div class="row">
        <button v-if="kind === 'prompt'" class="go press" :disabled="busy" data-test="install-go" @click="go">앱 설치</button>
        <a v-if="out" class="go press" :href="out.href" data-test="install-open">{{ out.via === 'chrome' ? 'Chrome에서 열기' : 'Safari에서 열기' }}</a>
        <button v-if="kind === 'inapp' && !out" class="go press" data-test="install-copy" @click="copy">{{ copied ? '복사했어요' : '주소 복사' }}</button>
        <template v-if="!sheet">
          <button class="soft press" data-test="install-later" @click="later('later')">나중에</button>
          <button class="soft press" data-test="install-never" @click="later('never')">다시 보지 않기</button>
        </template>
        <button v-else-if="kind !== 'prompt'" class="soft press" @click="emit('close')">닫기</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.install { border-radius: 22px; padding: 14px 16px; color: var(--text-primary); display: flex; flex-direction: column; gap: 12px; text-align: left; }
.head { display: flex; align-items: flex-start; gap: 12px; }
.appicon { flex: none; width: 40px; height: 40px; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 10px rgba(0 0 0 / .18), 0 0 0 1px rgba(255 255 255 / .14); }
.appicon svg { display: block; }
.titles { flex: 1; min-width: 0; }
.titles strong { display: block; font-size: 15.5px; font-weight: 600; line-height: 1.3; letter-spacing: -0.01em; }
.titles small { display: block; margin-top: 3px; font-size: 13px; line-height: 1.45; color: var(--text-secondary); word-break: keep-all; }
.x { flex: none; width: 32px; height: 32px; border-radius: 16px; display: grid; place-items: center; color: var(--text-secondary); background: var(--button-bg); }
.steps { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px; }
.steps li { display: flex; align-items: center; gap: 10px; font-size: 14px; line-height: 1.4; }
.steps .glyph { flex: none; width: 32px; height: 32px; border-radius: 10px; display: grid; place-items: center; background: var(--button-bg); color: var(--color-info); }
.steps .t { min-width: 0; word-break: keep-all; }
.steps small { display: block; font-size: 12.5px; color: var(--text-secondary); }
.path { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; }
.path .chip { display: inline-flex; align-items: center; gap: 5px; height: 30px; padding: 0 10px; border-radius: 15px; font-size: 13.5px; background: var(--button-bg); }
.path .g { display: grid; place-items: center; color: var(--color-info); }
.path .sep { color: var(--text-tertiary); font-size: 14px; }
.note { margin: -4px 0 0; font-size: 12.5px; line-height: 1.45; color: var(--text-secondary); word-break: keep-all; }
.how { margin: 0; font-size: 13.5px; line-height: 1.5; color: var(--text-primary); word-break: keep-all; }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.go { height: 36px; padding: 0 16px; border-radius: 18px; background: var(--ink); color: var(--ink-inverse); font-size: 14px; font-weight: 600;
  display: inline-flex; align-items: center; text-decoration: none; }
.go:disabled { opacity: .5; }
.soft { height: 36px; padding: 0 10px; border-radius: 18px; font-size: 13.5px; color: var(--text-secondary); }
.soft:hover { color: var(--text-primary); }
.wrap { width: 100%; }
/* the sign-in screen: under the sign-in buttons, as wide as they are */
.install.login { margin-top: 24px; }
/* settings › 앱 설치: a sheet over the page */
.veil { position: fixed; inset: 0; z-index: 80; display: grid; place-items: end center; background: rgba(0 0 0 / .32);
  padding: 16px 16px calc(16px + env(safe-area-inset-bottom, 0px)); animation: fade-in .2s both; }
.install.sheet { width: min(420px, 100%); padding: 18px; border-radius: 26px; background: var(--regular-solid-bg); box-shadow: var(--shadow-card);
  -webkit-backdrop-filter: blur(40px); backdrop-filter: blur(40px);
  animation: pop-in .35s var(--spring) both; }
@media (min-width: 761px) { .veil { place-items: center; } }
</style>
