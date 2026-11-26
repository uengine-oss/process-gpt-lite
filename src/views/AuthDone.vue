<script setup>
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { auth, leaveRefused } from '../api.js'
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
    // not an approved member of this address's company (invite-only — server lib/membership.js): the session is not kept, the sign-in
    // becomes a request an administrator can approve, and the refusal screen says so (src/api.js leaveRefused)
    if (r.status === 403) {
      const j = await r.json().catch(() => null)
      if (j?.code === 'invite_only' && await leaveRefused(j)) return
      if (j?.code !== 'invite_only') return fail('이 회사의 ProcessGPT 계정이 아니에요. 회사 관리자에게 초대를 요청하거나 그 회사 주소에서 로그인해 주세요.')
      // (a member after all — approved meanwhile)
      return router.replace('/chat')
    }
    if (!r.ok) return fail('로그인에 실패했어요')
    const me = await r.json()
    router.replace(me.profile?.onboarded_at || me.profile?.birth ? '/chat' : '/welcome/age')
  } catch {
    fail('로그인에 실패했어요')
  }
})
</script>

<template><div /></template>
