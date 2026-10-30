<script setup>
// placeholder: filled by its scenario (pgpt-pro/docs/agentic-bpm/plan.md)
defineProps({ msg: Object })
</script>

<template>
  <div class="glass" style="border-radius: 18px; padding: 12px 14px">{{ msg.kind }}</div>
</template>
