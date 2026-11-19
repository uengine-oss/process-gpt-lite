<script setup>
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { auth } from '../api.js'
import { BASE } from '../base.js'
import { sessionFromFragment } from '../authFragment.js'

const router = useRouter()
const fail = (why) => { auth.clear(); router.replace('/login?error=' + encodeURIComponent(why)) }
onMounted(async () => {
  // Lite's own Google sign-in (#<JSON>) or ProcessGPT's Supabase one behind the gateway (#access_token=…)
  const got = sessionFromFragment(location.hash)
  history.replaceState(null, '', BASE + '/auth/done')
  if (!got?.session) return fail(got?.error ? `Google 로그인에 실패했어요: ${got.error}` : '로그인에 실패했어요')
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
