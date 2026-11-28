<script setup>
// 폴더에 정리 (server lib/folders/filing.js): under a document that came in — a file a teammate sent in the messenger, a mail's
// attachment — the judge's folder: 「‘견적서’에 정리할까요? (확신 87%)」, one press files it there; 「새 폴더 만들기: …」 when nothing
// fits; 「다른 폴더 고르기」 to pick by hand. Asked only once the line is on screen, and once per document (the server keeps the verdict
// on its card); a filed one says where: 「‘견적서’에 정리했어요 · 열기」. (A file card of the chat has no line: its menu — FileCardMenu.vue,
// held · right-clicked · its ⋯ — offers the same, the card a dot while a suggestion waits; both use useFiling.js.)
import { ref, computed } from 'vue'
import Icon from '../Icon.vue'
import { useFiling } from './useFiling.js'

// one of: messageId (my file card) · shareId (a file sent to me) · actionId + attachment (a mail's attachment)
// filing: what the card already knows (its content.filing) — no request when it has a verdict
// label: which file this line is about, where one message carries several
const props = defineProps({ messageId: String, shareId: String, actionId: String, attachment: String, filing: Object, compact: Boolean, label: String })
const el = ref(null)
const ref_ = computed(() => (props.messageId ? { messageId: props.messageId } : props.shareId ? { shareId: props.shareId } : { actionId: props.actionId, attachment: props.attachment }))
const f = useFiling(() => ref_.value, () => props.filing, () => el.value)
const picking = ref(false)

async function fileIt(to) { if (await f.fileIt(to)) picking.value = false }
async function openPicker() {
  picking.value = !picking.value
  if (picking.value) await f.loadList()
}
</script>

<template>
  <div ref="el" class="fsg" :class="{ compact }" data-test="folder-suggest" :data-state="f.filed ? 'filed' : f.state" @click.stop>
    <template v-if="f.filed">
      <span class="tx"><Icon name="check" :size="14" /><span v-if="label" class="lb" data-no-i18n>{{ label }} →</span><span data-test="filing-done">{{ f.filed.already ? `이미 ‘${f.filed.name}’에 있어요` : `‘${f.filed.name}’에 정리했어요` }}</span></span>
      <button class="lnk press" data-test="filing-open" @click="f.openFolder">열기</button>
    </template>
    <template v-else-if="f.state === 'loading'">
      <span class="tx muted"><Icon name="folder" :size="14" />폴더에 정리 · 알맞은 폴더를 찾는 중…</span>
    </template>
    <template v-else-if="f.sug?.folder">
      <span class="tx"><Icon name="folder" :size="14" /><span v-if="label" class="lb" data-no-i18n>{{ label }} →</span><span data-test="filing-say">‘{{ f.where }}’에 정리할까요? <small>(확신 {{ f.pct }}%)</small></span></span>
      <button class="go press" data-test="filing-go" :disabled="f.busy" @click="fileIt({ slug: f.sug.folder.slug, sub: f.sug.sub || '' })">{{ f.busy ? '정리하는 중…' : '정리' }}</button>
      <button class="lnk press" data-test="filing-other" @click="openPicker">다른 폴더 고르기</button>
    </template>
    <template v-else-if="f.sug?.newFolder">
      <span class="tx"><Icon name="folder" :size="14" /><span v-if="label" class="lb" data-no-i18n>{{ label }} →</span><span data-test="filing-say">새 폴더 만들기: <b>{{ f.sug.newFolder.name }}</b></span></span>
      <button class="go press" data-test="filing-new" :disabled="f.busy" @click="fileIt({ newFolder: f.sug.newFolder.name })">{{ f.busy ? '만드는 중…' : '만들고 정리' }}</button>
      <button class="lnk press" data-test="filing-other" @click="openPicker">다른 폴더 고르기</button>
    </template>
    <template v-else>
      <span class="tx muted"><Icon name="folder" :size="14" />폴더에 정리</span>
      <button v-if="f.state !== 'idle'" class="lnk press" data-test="filing-other" @click="openPicker">폴더 고르기</button>
    </template>
    <small v-if="f.err" class="err" data-test="filing-error">{{ f.err }}</small>
    <div v-if="picking && !f.filed" class="pick" data-test="filing-pick">
      <p v-if="f.list && !f.list.length" class="none">정리할 수 있는 폴더가 없어요(편집 권한이 있는 폴더만).</p>
      <button v-for="x in f.list || []" :key="x.slug" class="row press" :disabled="f.busy" @click="fileIt({ slug: x.slug })"><Icon name="folder" :size="14" /> {{ x.name }}</button>
      <form class="nf" @submit.prevent="f.newName.trim() && fileIt({ newFolder: f.newName.trim() })">
        <input v-model="f.newName" placeholder="새 폴더 이름" maxlength="40" data-test="filing-new-name" />
        <button class="go press" type="submit" :disabled="f.busy || !f.newName.trim()">새 폴더에 정리</button>
      </form>
    </div>
  </div>
</template>

<style scoped>
.fsg { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 6px; max-width: 560px; font-size: 12.5px; color: var(--text-secondary); }
.tx { min-width: 0; color: var(--text-primary); overflow-wrap: anywhere; }
.tx > :deep(svg) { display: inline-block; vertical-align: -2px; margin-right: 5px; opacity: .8; }
.tx.muted { color: var(--text-secondary); }
.tx small { color: var(--text-secondary); }
.tx .lb { margin-right: 5px; color: var(--text-secondary); }
.go { height: 26px; padding: 0 11px; border-radius: 13px; font-size: 12.5px; font-weight: 500; background: #2a78d6; color: #fff; }
.go:disabled { opacity: .55; }
.lnk { height: 26px; padding: 0 6px; border-radius: 8px; font-size: 12.5px; color: #2a78d6; background: transparent; }
.err { flex-basis: 100%; color: #c62828; }
.pick { flex-basis: 100%; display: flex; flex-direction: column; gap: 4px; margin-top: 4px; padding: 8px; border-radius: 14px; background: var(--field-bg, rgba(127, 127, 127, .1)); }
.pick .row { display: flex; align-items: center; gap: 6px; width: 100%; text-align: left; padding: 7px 8px; border-radius: 10px; font-size: 13px; color: var(--text-primary); }
.pick .row:hover { background: rgba(127, 127, 127, .12); }
.pick .none { margin: 2px 4px; }
.nf { display: flex; gap: 6px; margin-top: 2px; }
.nf input { flex: 1; min-width: 0; height: 30px; padding: 0 10px; border-radius: 10px; border: 1px solid rgba(127, 127, 127, .3); background: transparent; color: var(--text-primary); font-size: 13px; }
.compact { font-size: 12px; }
</style>
