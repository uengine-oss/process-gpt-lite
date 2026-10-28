<script setup>
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { auth } from '../api.js'
import { BASE } from '../base.js'

const router = useRouter()
onMounted(async () => {
  try {
    auth.set(JSON.parse(decodeURIComponent(location.hash.slice(1))))
    history.replaceState(null, '', BASE + '/auth/done')
    const me = await (await fetch(BASE + '/api/me', { headers: { Authorization: `Bearer ${auth.get().session.access_token}` } })).json()
    router.replace(me.profile?.onboarded_at ? '/chat' : '/welcome/age')
  } catch {
    router.replace('/login?error=로그인에 실패했어요')
  }
})
</script>

<template><div /></template>
