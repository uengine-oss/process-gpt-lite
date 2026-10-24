<script setup>
// 폴더 목록(드라이브): 이름·구성원·최근 활동·변형 수·색인 상태, 그리고 색인 검색.
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import Icon from '../Icon.vue'
import FIcon from './FIcon.vue'
import Avatar from './Avatar.vue'
import { folders as F, whoOf, indexLabel, ago } from '../../foldersApi.js'
import { kindOf, kindLabel, baseName, dirName } from './fileKind.js'

const emit = defineEmits(['preview'])
const router = useRouter()
const route = useRoute()
// 폴더 | 스킬: skills are folders too (variations, 반영 요청, review), listed on their own
const tab = computed(() => (route.query.tab === 'skills' ? 'skills' : 'folders'))
const skills = ref(null)
const skillFilter = ref('all')
async function loadSkills() { try { skills.value = await F.skills() } catch (e) { err.value = e.message } }
watch(tab, (t) => { if (t === 'skills' && !skills.value) loadSkills() }, { immediate: true })
const shownSkills = computed(() => (skills.value || []).filter((k) => skillFilter.value === 'all' || (skillFilter.value === 'mine' ? k.mine : k.visibility === 'tenant')))
async function openSkill(k) {
  try { router.push(`/folders/${k.folder?.slug || await F.openSkill(k.name)}`) } catch (e) { err.value = e.message }
}
const list = ref(null)
const err = ref('')
const q = ref('')
const hits = ref([])
const searching = ref(false)
const sheet = ref(null)        // 'new' | 'link'
const form = ref({ name: '', description: '', path: '' })
const busy = ref(false)
const formErr = ref('')

async function load() {
  try { list.value = await F.list() } catch (e) { err.value = e.message }
}
onMounted(load)

let t
watch(q, (v) => {
  clearTimeout(t)
  if (!v.trim()) { hits.value = []; return }
  t = setTimeout(async () => {
    searching.value = true
    try { hits.value = await F.search(v.trim()) } catch { hits.value = [] } finally { searching.value = false }
  }, 250)
})

function mark(text) {
  const k = q.value.trim()
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  if (!k) return esc(text)
  const i = String(text || '').toLowerCase().indexOf(k.toLowerCase())
  if (i < 0) return esc(text)
  return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + k.length)) + '</mark>' + esc(text.slice(i + k.length))
}
function open(kind) { sheet.value = kind; form.value = { name: '', description: '', path: '' }; formErr.value = '' }
async function submit() {
  busy.value = true; formErr.value = ''
  try {
    const f = sheet.value === 'new'
      ? await F.create({ name: form.value.name, description: form.value.description })
      : await F.link({ path: form.value.path, name: form.value.name || undefined, description: form.value.description || undefined })
    sheet.value = null
    router.push(`/folders/${f.slug}`)
  } catch (e) { formErr.value = e.message } finally { busy.value = false }
}
const idx = (f) => f.index_state || {}
</script>

<template>
  <div class="fl">
    <div class="head">
      <h1>폴더</h1>
      <span class="sub">여럿이 함께 쓰고, 에이전트가 변형을 만들어 일하는 파일 공간이에요</span>
      <span class="sp" />
      <button class="pill-btn hbtn" @click="open('link')"><FIcon name="link" :size="16" /> 저장소 연결</button>
      <button class="dark-btn hbtn" @click="open('new')">새 폴더</button>
    </div>

    <div class="tabs">
      <div class="seg glass-thin">
        <button :class="{ on: tab === 'folders' }" @click="router.replace({ query: {} })">폴더</button>
        <button :class="{ on: tab === 'skills' }" @click="router.replace({ query: { tab: 'skills' } })">스킬</button>
      </div>
      <div v-if="tab === 'skills'" class="seg sm glass-thin">
        <button :class="{ on: skillFilter === 'all' }" @click="skillFilter = 'all'">전체</button>
        <button :class="{ on: skillFilter === 'mine' }" @click="skillFilter = 'mine'">내 스킬</button>
        <button :class="{ on: skillFilter === 'tenant' }" @click="skillFilter = 'tenant'">전사 공유</button>
      </div>
    </div>

    <label v-if="tab === 'folders'" class="search glass">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM15.5 15.5 20 20" /></svg>
      <input v-model="q" placeholder="폴더와 문서 찾기 — 파일 이름과 문서 카드 요약까지 찾아요" />
      <button v-if="q" class="clr" @click="q = ''">지우기</button>
    </label>

    <div v-if="tab === 'folders' && q.trim()" class="hits glass">
      <div class="hh">{{ searching ? '찾는 중…' : `색인에서 ${hits.length}건 · 에이전트도 같은 색인으로 폴더를 골라요` }}</div>
      <template v-for="(h, i) in hits" :key="i">
        <button v-if="h.type === 'folder'" class="hit press" @click="router.push(`/folders/${h.folder.slug}`)">
          <span class="fic folder" :class="{ linked: h.folder.kind === 'linked' }"><FIcon :name="h.folder.kind === 'linked' ? 'link' : 'folder'" :size="18" /></span>
          <span class="hm"><b v-html="mark(h.folder.name)" /><small>폴더 · {{ h.folder.description }}</small></span>
        </button>
        <button v-else class="hit press" @click="emit('preview', { folder: h.folder, file: h.file, ref: 'main' })">
          <span class="fic" :class="kindOf(h.file.path)">{{ kindLabel[kindOf(h.file.path)] }}</span>
          <span class="hm">
            <b v-html="mark(baseName(h.file.path))" />
            <small>{{ h.folder.name }}{{ dirName(h.file.path) ? ' / ' + dirName(h.file.path) : '' }} · {{ { card: '문서 카드에서 찾음', name: '파일 이름', text: '본문에서 찾음' }[h.by] }}</small>
            <span v-if="h.by === 'text' && h.snippet" class="snip" v-html="mark(h.snippet)" />
            <span v-else-if="h.file.card?.abstract" class="snip" v-html="mark(h.file.card.abstract)" />
          </span>
        </button>
      </template>
      <p v-if="!searching && !hits.length" class="empty">찾는 내용이 색인에 없어요. 다른 낱말로 찾아 보세요.</p>
    </div>

    <p v-if="err" class="empty">{{ err }}</p>
    <div v-else-if="tab === 'skills'" class="grid">
      <div class="row sk th"><span>스킬</span><span>공개</span><span>작성자</span><span>변형</span></div>
      <button v-for="k in shownSkills" :key="k.name" class="row sk glass press" @click="openSkill(k)">
        <span class="name">
          <span class="fic folder skill"><FIcon name="agent" :size="20" /></span>
          <span class="nm"><b>{{ k.name }}</b><small>{{ k.folder?.description || '처음 열면 스킬 파일로 폴더를 만들어요' }}</small></span>
        </span>
        <span><span class="badge" :class="k.visibility === 'private' ? 'private' : 'cards'">{{ k.visibility === 'private' ? '내 스킬' : '전사 공유' }}</span></span>
        <span class="act">{{ k.author?.name || '—' }}{{ k.mine ? ' (나)' : '' }}</span>
        <span class="var"><b>{{ k.folder?.live || 0 }}</b><small>{{ k.folder?.live ? '진행 중인 변형' : '변형 없음' }}</small></span>
      </button>
      <p v-if="skills && !shownSkills.length" class="empty">보여 줄 스킬이 없어요.</p>
    </div>
    <div v-else-if="list && !list.length" class="first glass">
      <FIcon name="folder" :size="30" />
      <b>아직 폴더가 없어요</b>
      <span>폴더를 만들어 파일을 올리고 팀원과 에이전트를 초대해 보세요.</span>
      <button class="dark-btn hbtn" @click="open('new')">새 폴더</button>
    </div>
    <div v-else-if="list && tab === 'folders'" class="grid">
      <div class="row th">
        <span>이름</span><span>구성원</span><span>최근 활동</span><span>변형</span><span>색인</span>
      </div>
      <button v-for="f in list" :key="f.slug" class="row glass press" @click="router.push(`/folders/${f.slug}`)">
        <span class="name">
          <span class="fic folder" :class="{ linked: f.kind === 'linked' }"><FIcon :name="f.kind === 'linked' ? 'link' : 'folder'" :size="20" /></span>
          <span class="nm"><b>{{ f.name }}</b><small>{{ f.description }}</small></span>
        </span>
        <span class="mem">
          <span class="stack"><Avatar v-for="m in f.members.slice(0, 4)" :key="m.type + m.id" :who="whoOf(m)" :size="28" /></span>
          <small v-if="f.members.length > 4">+{{ f.members.length - 4 }}</small>
        </span>
        <span class="act">{{ f.activity ? `${ago(f.activity.at)} · ${f.activity.text}` : '활동 없음' }}</span>
        <span class="var">
          <b>{{ f.live }}</b>
          <small v-if="f.live">{{ [f.open && `작업 중 ${f.open}`, f.ready && `반영 대기 ${f.ready}`].filter(Boolean).join(' · ') }}</small>
          <small v-else>변형 없음</small>
        </span>
        <span class="idx">
          <span class="badge" :class="idx(f).state"><span v-if="idx(f).state === 'indexing'" class="spin" />{{ indexLabel[idx(f).state] || '색인 전' }}</span>
          <small>{{ idx(f).state === 'list' ? `${(idx(f).files || 0).toLocaleString()}개 파일` : `${idx(f).cards || 0}/${idx(f).files || 0} 카드${idx(f).fulltext ? ' · 본문' : ''}` }}</small>
        </span>
      </button>
    </div>

    <div v-if="sheet" class="veil" @click.self="sheet = null">
      <form class="box glass" @submit.prevent="submit">
        <header class="bh"><b>{{ sheet === 'new' ? '새 폴더' : '저장소 연결' }}</b><span class="sp" /><button type="button" class="ic press" @click="sheet = null"><Icon name="close" :size="16" /></button></header>
        <div class="bb">
          <template v-if="sheet === 'link'">
            <label class="lbl">저장소 경로(이 컴퓨터)</label>
            <input v-model="form.path" class="fld" placeholder="/Users/…/my-repo" />
            <p class="fine">저장소 안의 내용은 바꾸지 않아요. 현재 브랜치가 main 이 되고, 쌓여 있는 에이전트 브랜치는 목록으로만 보여 드려요.</p>
          </template>
          <label class="lbl">이름{{ sheet === 'link' ? ' (비우면 폴더 이름)' : '' }}</label>
          <input v-model="form.name" class="fld" :placeholder="sheet === 'new' ? '예: 11월 고객 세미나' : ''" :required="sheet === 'new'" />
          <label class="lbl">설명</label>
          <input v-model="form.description" class="fld" placeholder="예: 고객경험팀 · 안내문·발표·예산" />
          <p v-if="formErr" class="bad">{{ formErr }}</p>
        </div>
        <footer class="bf"><button type="button" class="pill-btn" @click="sheet = null">취소</button><button class="dark-btn" :disabled="busy">{{ busy ? '만드는 중…' : sheet === 'new' ? '만들기' : '연결하기' }}</button></footer>
      </form>
    </div>
  </div>
</template>

<style scoped>
.fl { max-width: 1180px; margin: 0 auto; padding: 0 24px 40px; }
.head { display: flex; align-items: baseline; gap: 14px; margin: 6px 0 18px; flex-wrap: wrap; }
h1 { margin: 0; font-size: 30px; font-weight: 500; letter-spacing: -0.02em; }
.sub { color: var(--text-secondary); font-size: 14.5px; }
.sp { flex: 1; }
.hbtn { height: 40px; font-size: 14px; display: inline-flex; align-items: center; gap: 6px; align-self: center; }
.search { display: flex; align-items: center; gap: 12px; height: 56px; padding: 0 18px 0 20px; border-radius: 28px; color: var(--text-secondary); }
.search input { flex: 1; border: 0; outline: 0; background: none; font-size: 16px; color: var(--text-primary); }
.search input::placeholder { color: var(--text-tertiary); }
.clr { font-size: 13px; color: var(--text-secondary); }
.hits { margin-top: 10px; border-radius: 22px; padding: 8px; display: flex; flex-direction: column; animation: blur-in .35s var(--spring) both; }
.hh { font-size: 12.5px; color: var(--text-tertiary); padding: 8px 12px 6px; }
.hit { display: flex; gap: 12px; text-align: left; padding: 10px 12px; border-radius: 16px; align-items: flex-start; }
.hit:hover { background: var(--cell-bg); }
.hm { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.hm b { font-weight: 500; font-size: 15px; }
.hm small { color: var(--text-secondary); font-size: 12.5px; }
.snip { font-size: 13.5px; color: var(--text-primary); opacity: .82; line-height: 1.5; margin-top: 2px; }
:deep(mark) { background: rgba(255 214 102 / .55); color: inherit; border-radius: 3px; padding: 0 1px; }
.empty { color: var(--text-secondary); font-size: 14px; padding: 8px 12px; margin: 0; }
.first { margin-top: 22px; border-radius: 22px; padding: 40px; display: flex; flex-direction: column; align-items: center; gap: 10px; color: var(--text-secondary); text-align: center; }
.first b { color: var(--text-primary); font-size: 18px; font-weight: 500; }
.grid { margin-top: 22px; display: flex; flex-direction: column; gap: 8px; }
.row { display: grid; grid-template-columns: minmax(0, 2.3fr) 150px minmax(0, 1.6fr) 130px 130px; align-items: center; gap: 16px; padding: 12px 18px; border-radius: 20px; text-align: left; }
.row.th { padding: 0 18px; font-size: 12.5px; color: var(--text-tertiary); }
button.row:hover { background: var(--regular-solid-bg); }
.name { display: flex; align-items: center; gap: 12px; min-width: 0; }
.nm { display: flex; flex-direction: column; min-width: 0; }
.nm b { font-weight: 500; font-size: 16.5px; }
.nm small, .var small, .idx small { color: var(--text-secondary); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.act { font-size: 13.5px; color: var(--text-secondary); line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.fic { flex: none; width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center; font-size: 10.5px; font-weight: 700; color: #fff; background: #6b6b66; }
.fic.folder { background: #e2a93b; } .fic.folder.linked { background: #4a5f9a; }
.fic.hwp { background: #1f6fd1; } .fic.doc { background: #2b579a; } .fic.xls { background: #217346; } .fic.ppt { background: #c43e1c; } .fic.pdf { background: #d93025; } .fic.cad { background: #0b6f88; } .fic.vec { background: #c2570c; } .fic.img { background: #7b3fbf; } .fic.snd { background: #0f8a5f; } .fic.vid { background: #b0223c; } .fic.md { background: #3d4f6b; } .fic.code { background: #2d333b; }
.mem { display: flex; align-items: center; gap: 6px; }
.stack { display: flex; } .stack > * + * { margin-left: -7px; }
.mem small { color: var(--text-secondary); font-size: 12.5px; }
.var, .idx { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.var b { font-weight: 600; font-size: 17px; }
.badge { align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; border-radius: 12px; font-size: 12px; font-weight: 500; background: var(--button-bg); }
.badge.cards { background: rgba(150 240 176 / .2); color: var(--color-success); }
.badge.indexing { color: var(--color-info); }
.spin { width: 10px; height: 10px; border-radius: 9999px; border: 2px solid currentColor; border-right-color: transparent; animation: spin .8s linear infinite; }
.veil { position: fixed; inset: 0; z-index: 45; background: rgba(20, 24, 32, .3); display: grid; place-items: center; padding: 24px; animation: fade-in .2s both; }
.box { width: min(520px, 100%); border-radius: 24px; overflow: hidden; box-shadow: 0 18px 60px rgba(0, 0, 0, .3); animation: pop-in .4s var(--spring) both; --regular-bg: var(--regular-solid-bg); }
.bh { display: flex; align-items: center; height: 56px; padding: 0 14px 0 20px; border-bottom: 1px solid var(--hairline); font-size: 16px; }
.ic { width: 32px; height: 32px; border-radius: 16px; display: grid; place-items: center; background: var(--button-bg); }
.bb { padding: 10px 20px 16px; display: flex; flex-direction: column; }
.lbl { font-size: 12.5px; color: var(--text-tertiary); margin: 12px 0 6px; }
.fld { height: 42px; border-radius: 12px; border: 1px solid var(--hairline); background: var(--field-bg); padding: 0 12px; font-size: 14px; outline: 0; }
.fine { font-size: 12.5px; color: var(--text-secondary); line-height: 1.6; margin: 8px 0 0; }
.bad { font-size: 13px; color: var(--color-error); margin: 10px 0 0; }
.bf { display: flex; justify-content: flex-end; gap: 10px; padding: 12px 16px; border-top: 1px solid var(--hairline); }
.bf > * { height: 42px; }
.dark-btn { background: var(--ink); color: var(--ink-inverse); }
@media (max-width: 900px) { .row { grid-template-columns: 1fr auto; } .row > :nth-child(2), .row > :nth-child(3), .row > :nth-child(4) { display: none; } }
.tabs { display: flex; gap: 10px; align-items: center; margin-bottom: 14px; }
.seg { display: flex; padding: 3px; border-radius: 9999px; }
.seg button { height: 38px; padding: 0 18px; border-radius: 9999px; font-size: 14.5px; font-weight: 500; color: var(--text-secondary); }
.seg.sm button { height: 32px; padding: 0 14px; font-size: 13.5px; }
.seg button.on { background: var(--ink); color: var(--ink-inverse); }
.row.sk { grid-template-columns: minmax(0, 2.6fr) 120px minmax(0, 1fr) 130px; }
.fic.folder.skill { background: #7b5cd6; }
.badge.private { background: rgba(255 160 60 / .18); color: #e08a2c; }
</style>
