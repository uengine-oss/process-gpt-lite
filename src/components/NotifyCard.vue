<script setup>
// Notifications on this device (src/browserNotify.js), two places:
//   place 'home'  — a Home card: 「브라우저 알림 켜기」 until the browser is asked; then 「알림이 켜졌어요」 with 「시험 알림 보내기」 (until
//                   closed); on an iPhone outside a Home Screen web app, how it works there (until closed)
//   place 'settings' — a row in 설정 › 계정 › 연결: the state and the same two buttons, always there
// 2026-11-26 (「퀵하게 대화방에서 온 내용 혹은 ai의 후먼인더루프 등을 모바일에서 보게할 수 있나?」): the person sees it working in seconds.
import { computed, ref } from 'vue'
import Icon from './Icon.vue'
import { permission, ask, sendTest, supported, iosNeedsHomeScreen } from '../browserNotify.js'

const props = defineProps({ place: { type: String, default: 'home' }, mode: { type: String, default: '' } })
const emit = defineEmits(['close', 'changed'])

const perm = ref(permission())
const ios = iosNeedsHomeScreen()
// what the card shows: ios · ask · on · denied · unsupported
const state = computed(() => props.mode || (ios && perm.value !== 'granted' ? 'ios' : perm.value === 'default' ? 'ask' : perm.value === 'granted' ? 'on' : supported() ? 'denied' : 'unsupported'))
const busy = ref(false)
const said = ref('')

async function turnOn() {
  busy.value = true
  try { perm.value = await ask() } finally { busy.value = false }
  emit('changed', perm.value)
}
async function test() {
  busy.value = true
  said.value = ''
  try {
    const r = await sendTest()
    said.value = !r.local ? (r.devices > 0 ? `보냈어요 · 기기 ${r.devices}대. 몇 초 안에 알림이 와요.` : '알림이 꺼져 있어 보내지 못했어요')
      : r.devices > 0 ? `기기 ${r.devices}대에 보냈어요. 이 브라우저는 푸시를 받지 못해 직접 띄웠어요.`
        : '이 브라우저는 푸시를 받지 못해 직접 띄웠어요. 앱을 닫으면 알림이 오지 않아요.'
  } finally { busy.value = false }
}
const TEXT = {
  ask: ['브라우저 알림 켜기', '앱을 닫아도 팀 메시지 · AI 질문 · 내 할 일을 알려 드려요'],
  on: ['알림이 켜져 있어요', '메시지는 방별로 묶고, AI 질문은 알림에서 바로 답할 수 있어요'],
  ios: ['iPhone에서 알림 받기', 'iOS 16.4 이상에서 Safari 공유 › 「홈 화면에 추가」로 설치한 앱을 열고 알림을 켜 주세요. Safari 탭에서는 알림을 받을 수 없어요.'],
  denied: ['알림이 차단돼 있어요', '브라우저 사이트 설정에서 알림을 허용해 주세요'],
  unsupported: ['이 브라우저는 알림을 지원하지 않아요', 'Chrome · Edge · Safari(설치한 앱)에서 켤 수 있어요'],
}
// 설정's row: named like the rows beside it (「메일 · 연결 안 됨」)
const SETTINGS_TITLE = { ask: '이 기기의 알림 · 꺼짐', on: '이 기기의 알림 · 켜짐', ios: '이 기기의 알림 · iPhone', denied: '이 기기의 알림 · 차단됨', unsupported: '이 기기의 알림 · 지원 안 됨' }
const title = computed(() => (props.place === 'settings' ? SETTINGS_TITLE[state.value] : TEXT[state.value][0]))
</script>

<template>
  <!-- (classes of its own: the page's scoped .settings / .on reach a child's root) -->
  <div class="ncard" :class="[`p-${place}`, `s-${state}`, { glass: place === 'home' }]" data-test="notify-card" :data-state="state">
    <div class="head">
      <span class="ic" aria-hidden="true"><Icon name="bell" :size="16" /></span>
      <div class="main">
        <b>{{ title }}</b>
        <small>{{ TEXT[state][1] }}</small>
      </div>
      <button v-if="place === 'home' && state !== 'ask'" class="x press" aria-label="닫기" title="닫기" data-test="notify-close" @click="emit('close')">×</button>
    </div>
    <div v-if="state === 'ask' || state === 'on'" class="row">
      <button v-if="state === 'ask'" class="dark-btn sm press" :disabled="busy" data-test="notify-on" @click="turnOn">알림 켜기</button>
      <button v-else class="pill-btn sm press" :disabled="busy" data-test="notify-test" @click="test">{{ busy ? '보내는 중…' : '시험 알림 보내기' }}</button>
    </div>
    <small v-if="said" class="said" role="status" data-test="notify-said">{{ said }}</small>
  </div>
</template>

<style scoped>
.ncard { display: flex; flex-direction: column; gap: 10px; min-width: 0; color: var(--text-primary); }
.ncard.p-home { border-radius: 22px; padding: 14px 16px 14px 18px; }
.ncard.p-settings { padding: 18px 0; border-top: 1px solid var(--hairline); }
.head { display: flex; align-items: flex-start; gap: 12px; min-width: 0; }
.ic { flex: none; width: 24px; height: 24px; margin-top: 1px; border-radius: 9999px; display: grid; place-items: center; background: var(--color-attention); color: #fff; }
.s-on .ic { background: var(--color-success); }
.s-denied .ic, .s-unsupported .ic { background: var(--text-tertiary); }
.main { flex: 1; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.main b { font-weight: 500; font-size: 15.5px; overflow-wrap: anywhere; }
.main small { color: var(--text-secondary); font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
.x { flex: none; width: 28px; height: 28px; border-radius: 14px; color: var(--text-tertiary); font-size: 20px; line-height: 26px; }
.row { display: flex; gap: 8px; flex-wrap: wrap; padding-left: 36px; }
.pill-btn.sm { height: 36px; padding: 0 16px; font-size: 14px; }
.dark-btn.sm { height: 36px; padding: 0 18px; font-size: 14px; }
.said { padding-left: 36px; color: var(--text-secondary); font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
</style>
