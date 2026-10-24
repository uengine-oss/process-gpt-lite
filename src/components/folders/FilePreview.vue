<script setup>
// 파일을 누르면 그 자리에서 열리는 미리보기 시트. 본문은 작업실과 같은 FileView(같은 방식으로 보임),
// 오른쪽은 색인의 문서 카드와 파일 정보. 이음오피스·ArtCraft 는 스토리지에 올린 사본으로 연다.
import { ref, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '../Icon.vue'
import FIcon from './FIcon.vue'
import Avatar from './Avatar.vue'
import FileView from '../files/FileView.vue'
import { folders as F, rawUrl, whoOf, ago } from '../../foldersApi.js'
import { useApp } from '../../stores/app.js'
import { viewOf, kindOf, kindLabel, baseName, fmtSize } from './fileKind.js'

const props = defineProps({
  file: Object,          // { path, card?, change? }
  folder: Object,        // { slug, name }
  ref_: { type: String, default: 'main' }, // 'main' or a variation id
  refLabel: String,
})
const emit = defineEmits(['close'])
const router = useRouter()
const app = useApp()
const maximized = ref(false)
const text = ref(null)
const info = ref(null)       // index row of main: card, size, author, mtime
const err = ref('')

const view = computed(() => viewOf(props.file?.path))
const isText = computed(() => ['markdown', 'code', 'text', 'csv'].includes(view.value) || view.value === 'none')
const url = computed(() => rawUrl(props.folder.slug, props.file.path, props.ref_))
const card = computed(() => info.value?.card || props.file.card || null)

watch(() => [props.file?.path, props.ref_], async () => {
  text.value = null; info.value = null; err.value = ''
  if (props.ref_ === 'main') info.value = await F.file(props.folder.slug, props.file.path).catch(() => null)
  if (isText.value) {
    try { text.value = await F.text(props.folder.slug, props.file.path, props.ref_) } catch (e) { err.value = e.message }
  }
}, { immediate: true })
const editorUrl = () => F.publish(props.folder.slug, props.file.path, props.ref_)
const where = computed(() => (props.ref_ === 'main' ? '기준본(main)' : `변형 ${props.refLabel || ''}`))
// the chat composer gets the question started; the folder name makes the agent work in this folder
function ask() {
  const draft = `${props.folder.name} 폴더의 ${props.file.path} `
  emit('close')
  router.push('/chat').then(() => setTimeout(() => { app.prefill = draft }, 700))
}
</script>

<template>
  <div class="veil" :class="{ max: maximized }" @click.self="emit('close')">
    <div class="sheet glass" :class="{ max: maximized }">
      <section class="main">
        <header class="hd">
          <span class="fic" :class="kindOf(file.path)">{{ kindLabel[kindOf(file.path)] }}</span>
          <div class="ttl">
            <b>{{ baseName(file.path) }}</b>
            <small><FIcon :name="ref_ === 'main' ? 'folder' : 'branch'" :size="13" /> {{ folder.name }} · {{ ref_ === 'main' ? 'main' : refLabel }} · {{ file.path }}</small>
          </div>
          <a class="tb press" :href="rawUrl(folder.slug, file.path, ref_, true)" target="_blank" rel="noopener">원본 받기</a>
          <button class="tb ic press" :title="maximized ? '원래 크기' : '크게 보기'" @click="maximized = !maximized"><Icon :name="maximized ? 'shrink' : 'expand'" :size="15" /></button>
          <button class="tb ic press" title="닫기" @click="emit('close')"><Icon name="close" :size="16" /></button>
        </header>
        <div class="body">
          <p v-if="err" class="none">{{ err }}</p>
          <p v-else-if="isText && text === null" class="none">여는 중…</p>
          <FileView v-else :path="file.path" :text="text" :url="url" :editor-url="editorUrl" mode="preview" />
        </div>
      </section>

      <aside v-if="!maximized" class="side scroll">
        <template v-if="file.change">
          <div class="sec">이 변형에서 바뀐 점</div>
          <p class="abs">{{ file.change }}</p>
        </template>
        <div class="sec">문서 카드</div>
        <template v-if="card?.abstract">
          <p class="abs">{{ card.abstract }}</p>
          <div v-if="card.keywords?.length" class="kws"><span v-for="k in card.keywords" :key="k">{{ k }}</span></div>
        </template>
        <p v-else-if="ref_ !== 'main'" class="muted">문서 카드는 main 에 반영된 파일에 만들어요.</p>
        <p v-else-if="info?.card_error" class="muted">카드를 만들지 못했어요({{ info.card_error }}). 파일은 이름과 위치로 찾아져요.</p>
        <p v-else-if="info && /\.(md|txt|csv|docx|xlsx|pptx|hwpx|pdf)$/i.test(file.path)" class="muted">카드를 만드는 중이에요. 잠시 뒤 다시 열어 보세요.</p>
        <p v-else class="muted">카드가 없는 파일이에요. 이미지·소리·영상·도면은 이름과 위치로만 찾아져요.</p>

        <dl class="meta">
          <template v-if="card?.n_pages"><dt>쪽</dt><dd>{{ card.n_pages }}쪽</dd></template>
          <template v-if="info?.size"><dt>크기</dt><dd>{{ fmtSize(Number(info.size)) }}</dd></template>
          <template v-if="info?.author"><dt>마지막 수정</dt><dd class="who"><Avatar :who="whoOf({ name: info.author, id: info.author })" :size="20" /> {{ info.author }} · {{ ago(info.mtime) }}</dd></template>
          <dt>위치</dt><dd>{{ where }}</dd>
          <dt>색인</dt><dd>{{ card?.abstract ? '문서 카드' : '파일 목록' }}</dd>
        </dl>

        <div class="acts">
          <button class="act press" @click="ask"><FIcon name="chat" :size="16" /> 에이전트에게 이 파일로 묻기</button>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.veil { position: fixed; inset: 0; z-index: 40; background: rgba(20, 24, 32, .22); display: flex; justify-content: flex-end; align-items: stretch; padding: 76px 16px 16px; animation: fade-in .2s both; }
.veil.max { padding: 0; }
.sheet { width: min(1180px, 92vw); border-radius: 22px; overflow: hidden; display: flex; box-shadow: 0 18px 60px rgba(0, 0, 0, .25); animation: blur-in .35s var(--spring) both; --regular-bg: var(--regular-solid-bg); }
.sheet.max { width: 100%; border-radius: 0; }
.main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.hd { display: flex; align-items: center; gap: 8px; height: 60px; padding: 0 12px 0 16px; border-bottom: 1px solid var(--hairline); flex: none; }
.ttl { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.ttl b { font-size: 15.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ttl small { display: flex; align-items: center; gap: 4px; color: var(--text-secondary); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fic { flex: none; width: 36px; height: 36px; border-radius: 10px; display: grid; place-items: center; font-size: 10.5px; font-weight: 700; color: #fff; background: #6b6b66; }
.fic.hwp { background: #1f6fd1; } .fic.doc { background: #2b579a; } .fic.xls { background: #217346; } .fic.ppt { background: #c43e1c; } .fic.pdf { background: #d93025; } .fic.cad { background: #0b6f88; } .fic.vec { background: #c2570c; } .fic.img { background: #7b3fbf; } .fic.snd { background: #0f8a5f; } .fic.vid { background: #b0223c; } .fic.md { background: #3d4f6b; } .fic.code { background: #2d333b; }
.tb { height: 32px; padding: 0 13px; border-radius: 16px; font-size: 13px; font-weight: 500; background: var(--button-bg); color: var(--text-primary); display: inline-flex; align-items: center; gap: 6px; text-decoration: none; white-space: nowrap; }
.tb.ic { width: 32px; padding: 0; justify-content: center; }
.body { flex: 1; min-height: 0; display: flex; flex-direction: column; background: var(--surface-secondary); }
.body > :deep(*) { flex: 1; min-height: 0; }
.none { margin: auto; color: var(--text-secondary); flex: none !important; }
.side { width: 300px; flex: none; border-left: 1px solid var(--hairline); padding: 18px 18px 24px; display: flex; flex-direction: column; gap: 12px; }
.sec { font-size: 12.5px; color: var(--text-tertiary); letter-spacing: .04em; }
.abs { margin: 0; font-size: 14.5px; line-height: 1.65; }
.muted { margin: 0; font-size: 13.5px; color: var(--text-secondary); line-height: 1.6; }
.kws { display: flex; flex-wrap: wrap; gap: 6px; }
.kws span { height: 26px; padding: 0 10px; border-radius: 13px; background: var(--button-bg); font-size: 12.5px; display: inline-flex; align-items: center; }
.meta { display: grid; grid-template-columns: 76px 1fr; gap: 8px 10px; margin: 6px 0 0; font-size: 13px; }
.meta dt { color: var(--text-secondary); } .meta dd { margin: 0; min-width: 0; }
.who { display: flex; align-items: center; gap: 6px; }
.acts { display: flex; flex-direction: column; gap: 8px; margin-top: 6px; }
.act { height: 40px; border-radius: 12px; background: var(--button-bg); display: flex; align-items: center; gap: 8px; padding: 0 12px; font-size: 13.5px; font-weight: 500; }
@media (max-width: 900px) { .side { display: none; } .sheet { width: 100%; } }
</style>
