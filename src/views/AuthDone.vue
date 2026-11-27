<script setup>
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { auth, sessionUser } from '../api.js'
import { BASE } from '../base.js'
import { sessionFromFragment } from '../authFragment.js'
import { takeSignIn, doneStep } from '../signInNonce.js'

const router = useRouter()
const fail = (why) => { auth.clear(); router.replace('/login?error=' + encodeURIComponent(why)) }
onMounted(async () => {
  // Lite's own Google sign-in (#<JSON>) or ProcessGPT's Supabase one behind the gateway (#access_token=…) — taken only when it is the
  // sign-in this tab started (?n=…), and never over the session of someone signed in here (src/signInNonce.js doneStep)
  const got = sessionFromFragment(location.hash)
  const mine = takeSignIn(location.search)
  history.replaceState(null, '', BASE + '/auth/done')
  const step = doneStep({ mine, got, here: auth.get()?.session || null, who: sessionUser() })
  if (step === 'stay') return router.replace('/chat')
  if (step === 'refuse') return router.replace('/login?error=' + encodeURIComponent('이 창에서 시작한 로그인만 완료할 수 있어요. 다시 로그인해 주세요.'))
  if (step === 'fail') return fail(got?.error ? `Google 로그인에 실패했어요: ${got.error}` : '로그인에 실패했어요')
  auth.set(got)
  try {
    const r = await fetch(BASE + '/api/me', { headers: { Authorization: `Bearer ${got.session.access_token}` } })
    // behind the gateway: a Google account that is not a member of this address's company
    if (r.status === 403) return fail('이 회사의 ProcessGPT 계정이 아니에요. 회사 관리자에게 초대를 요청하거나 그 회사 주소에서 로그인해 주세요.')
    if (!r.ok) return fail('로그인에 실패했어요')
    const me = await r.json()
    router.replace(me.profile?.onboarded_at || me.profile?.birth ? '/chat' : '/welcome/age')
  } catch {
    fail('로그인에 실패했어요')
  }
})
</script>

<template><div /></template>
