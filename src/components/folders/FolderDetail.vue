<script setup>
// 폴더 하나: 왼쪽은 기준본(main) 파일 트리·이력·색인, 오른쪽은 변형 목록과 일괄 반영.
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '../Icon.vue'
import FIcon from './FIcon.vue'
import Avatar from './Avatar.vue'
import MergeSheet from './MergeSheet.vue'
import ShareSheet from './ShareSheet.vue'
import { folders as F, whoOf, roleLabel, statusLabel, sourceLabel, indexLabel, ago, prLabel } from '../../foldersApi.js'
import { kindOf, kindLabel, baseName, fmtSize } from './fileKind.js'

const props = defineProps({ slug: String })
const emit = defineEmits(['preview'])
const router = useRouter()
const folder = ref(null)
const files = ref([])
const err = ref('')
const tab = ref('files')
const showPast = ref(false)
const picked = ref([])
const merging = ref(null)       // {ids} or {integration}
const sharing = ref(false)
const toast = ref('')
const closed = ref(new Set())
const uploading = ref('')
const dragging = ref(false)
const cand = ref(null)
const skill = ref(null)        // skill folders: author, visibility, agents & bosses, contributions, merge right
const sharing2 = ref(false)
const fileInput = ref(null)
const say = (t) => { toast.value = t; setTimeout(() => { if (toast.value === t) toast.value = '' }, 2800) }

const can = (need) => ({ viewer: 1, runner: 2, editor: 3, owner: 4 })[folder.value?.role] >= ({ viewer: 1, runner: 2, editor: 3, owner: 4 })[need]
async function load() {
  try {
    const [f, t] = await Promise.all([F.get(props.slug), F.tree(props.slug)])
    folder.value = f; files.value = t
    if (f.kind === 'skill') skill.value = await F.skillInfo(props.slug).catch(() => null)
    picked.value = picked.value.filter((id) => f.variations.some((v) => v.id === id && v.status === 'ready'))
    if (f.kind === 'linked' && !cand.value) cand.value = await F.candidates(props.slug).catch(() => null)
  } catch (e) { err.value = e.message }
}
onMounted(load)
watch(() => props.slug, () => { folder.value = null; cand.value = null; load() })
// agents finish runs and cards get made in the background: keep the view fresh meanwhile
const busy = computed(() => folder.value && (folder.value.variations.some((v) => v.status === 'open') || folder.value.index_state?.state === 'indexing'))
let poll = setInterval(() => { if (busy.value && !merging.value) load() }, 4000)
onBeforeUnmount(() => clearInterval(poll))

const tree = computed(() => {
  const dirs = new Map(), top = []
  for (const f of files.value) {
    const i = f.path.lastIndexOf('/')
    if (i < 0) { top.push(f); continue }
    const d = f.path.slice(0, i)
    if (!dirs.has(d)) dirs.set(d, [])
    dirs.get(d).push(f)
  }
  return { dirs: [...dirs.entries()].sort((a, b) => a[0].localeCompare(b[0])), top }
})
function toggle(d) { const s = new Set(closed.value); s.has(d) ? s.delete(d) : s.add(d); closed.value = s }
const live = computed(() => (folder.value?.variations || []).filter((v) => ['open', 'ready', 'conflicted'].includes(v.status)))
const past = computed(() => (folder.value?.variations || []).filter((v) => ['merged', 'discarded'].includes(v.status)))
function pick(v) {
  if (v.status !== 'ready') return
  const s = new Set(picked.value)
  s.has(v.id) ? s.delete(v.id) : s.add(v.id)
  picked.value = folder.value.variations.filter((x) => s.has(x.id)).map((x) => x.id)
}
function preview(f) { emit('preview', { folder: folder.value, file: f, ref: 'main' }) }

async function uploadFiles(list, dir = '') {
  if (!can('editor')) return say('올리려면 편집 권한이 필요해요.')
  for (const file of list) {
    const rel = (file.webkitRelativePath || '').trim() || (dir ? `${dir}/${file.name}` : file.name)
    uploading.value = rel
    try { await F.upload(props.slug, rel, file) } catch (e) { say(`${file.name}: ${e.message}`) }
  }
  uploading.value = ''
  await load()
  say('올렸어요 — 문서 카드는 잠시 뒤 생겨요')
}
function onDrop(e) { dragging.value = false; if (e.dataTransfer?.files?.length) uploadFiles([...e.dataTransfer.files]) }
async function removeFile(f) {
  if (!confirm(`'${f.path}' 을(를) main 에서 지울까요? 이력에는 남아요.`)) return
  try { await F.removeFile(props.slug, f.path); await load() } catch (e) { say(e.message) }
}
async function newVariation() {
  const title = prompt('새 변형 이름', '내 수정안')
  if (!title) return
  try { const v = await F.newVariation(props.slug, { title }); router.push(`/folders/${props.slug}/v/${v.id}`) } catch (e) { say(e.message) }
}
async function importAll() {
  const names = cand.value.branches.filter((b) => !b.imported).map((b) => b.name)
  try { const out = await F.importBranches(props.slug, names); say(`변형 ${out.length}개를 가져왔어요 (저장소는 그대로예요)`); cand.value = await F.candidates(props.slug); load() } catch (e) { say(e.message) }
}
function merged(r) {
  merging.value = null
  picked.value = []
  load()
  if (r?.status === 'done') say('main 에 반영했어요')
}
const isSkill = computed(() => folder.value?.kind === 'skill')
const canMerge = computed(() => (isSkill.value ? !!skill.value?.canMerge : can('editor')))
async function shareSkill() {
  sharing2.value = true
  try { await F.share(props.slug); say('전사에 공유했어요 — 이제 누구나 이 스킬을 쓰고 고칠 점을 제안할 수 있어요'); await load() } catch (e) { say(e.message) } finally { sharing2.value = false }
}
async function keepPrivate() { await F.keepPrivate(props.slug).catch(() => {}); skill.value = { ...skill.value, askShare: false } }
async function beBoss(a) { try { await F.setBoss(a.id); await load(); say(`${a.name} 의 담당자가 됐어요`) } catch (e) { say(e.message) } }
const CTYPE = { CREATED: '만듦', MODIFIED: '고침', PROPOSAL_APPROVED: '제안 반영' }
const cardOf = (f) => f.card?.abstract
const indexLines = computed(() => files.value.map((f) => `${f.path}  ·  ${fmtSize(Number(f.size))}${cardOf(f) ? '\n    └ ' + cardOf(f) : ''}`).join('\n'))
const ix = computed(() => folder.value?.index_state || {})
</script>

<template>
  <div class="fd" @dragover.prevent="dragging = can('editor')" @dragleave.self="dragging = false" @drop.prevent="onDrop">
    <p v-if="err" class="missing">{{ err }}</p>
    <template v-else-if="folder">
      <div class="head">
        <button class="back press" title="폴더 목록" @click="router.push('/folders')"><Icon name="back" :size="18" /></button>
        <span class="fic folder" :class="{ linked: folder.kind === 'linked', skill: isSkill }"><FIcon :name="folder.kind === 'linked' ? 'link' : isSkill ? 'agent' : 'folder'" :size="22" /></span>
        <div class="ttl">
          <h1>{{ folder.name }} <span v-if="isSkill" class="kb" :class="skill?.visibility">{{ skill?.visibility === 'private' ? '내 스킬' : '전사 공유 스킬' }}</span></h1>
          <small v-if="isSkill">작성자 {{ skill?.author?.name || '—' }} · {{ canMerge ? '반영할 수 있어요' : '고칠 점은 변형으로 제안해요' }}</small>
          <small v-else>{{ folder.description }} · 내 권한 {{ roleLabel[folder.role] }}</small>
        </div>
        <span class="sp" />
        <button class="mem press" :title="folder.members.map((m) => `${m.name}(${roleLabel[m.role]})`).join(', ')" @click="sharing = true">
          <Avatar v-for="m in folder.members.slice(0, 6)" :key="m.type + m.id" :who="whoOf(m)" :size="30" />
        </button>
 <button v-if="!isSkill" class="pill-btn hbtn" @click="sharing = true"><FIcon name="people" :size="16" /> 공유</button>
        <button v-if="can('editor') && folder.kind === 'managed'" class="pill-btn hbtn" title="main 을 작업실(파일·셸)에서 열기" @click="router.push(`/workroom/folder/${folder.slug}`)"><FIcon name="terminal" :size="16" /> 작업실</button>
      </div>

      <div v-if="isSkill && skill?.visibility === 'private' && skill?.mine" class="banner ask glass">
        <FIcon name="people" :size="18" />
        <span><b>이 스킬을 전사에 공유하시겠어요?</b> 지금은 나와 내 에이전트만 써요. 공유하면 누구나 쓰고 고칠 점을 변형으로 제안할 수 있고, 반영은 나(작성자)와 이 스킬을 쓰는 에이전트의 담당자만 해요.</span>
        <span class="sp" />
        <button class="dark-btn sm2" :disabled="sharing2" @click="shareSkill">{{ sharing2 ? '공유하는 중…' : '전사에 공유' }}</button>
        <button v-if="skill.askShare" class="tb press" @click="keepPrivate">나만 쓰기</button>
      </div>
      <div v-if="folder.kind === 'linked' && cand" class="banner glass">
        <FIcon name="branch" :size="18" />
        <span>이 저장소에 에이전트 브랜치 <b>{{ cand.branches.length }}개</b>와 작업 사본 <b>{{ cand.worktrees }}개</b>(디렉터리가 사라진 것 {{ cand.staleWorktrees }}개)가 있어요. 저장소는 건드리지 않고 목록만 보여 드려요.</span>
        <span class="sp" />
        <button v-if="cand.branches.some((b) => !b.imported) && can('editor')" class="tb press" @click="importAll">변형으로 가져오기</button>
      </div>

      <div class="cols">
        <section class="pane glass">
          <div class="ph">
            <div class="seg">
              <button :class="{ on: tab === 'files' }" @click="tab = 'files'">파일</button>
              <button :class="{ on: tab === 'history' }" @click="tab = 'history'">이력</button>
              <button :class="{ on: tab === 'index' }" @click="tab = 'index'">색인</button>
              <button v-if="isSkill" :class="{ on: tab === 'skill' }" @click="tab = 'skill'">스킬</button>
            </div>
            <span class="ref"><FIcon name="branch" :size="14" /> {{ folder.default_branch }} · <code>{{ folder.history[0]?.short }}</code></span>
            <span class="sp" />
            <span v-if="uploading" class="up"><span class="spin" /> {{ uploading }}</span>
            <template v-if="tab === 'files' && can('editor') && folder.kind === 'managed'">
              <input ref="fileInput" type="file" multiple hidden @change="uploadFiles([...$event.target.files]); $event.target.value = ''" />
              <button class="tb press" @click="fileInput.click()"><FIcon name="upload" :size="15" /> 올리기</button>
            </template>
          </div>

          <div v-if="tab === 'files'" class="files scroll" :class="{ drag: dragging }">
            <div class="fr th"><span>이름</span><span>마지막 수정</span><span>크기</span></div>
            <template v-for="[d, list] in tree.dirs" :key="d">
              <button class="fr dir" @click="toggle(d)">
                <span class="fn"><span class="tw">{{ closed.has(d) ? '▸' : '▾' }}</span><FIcon name="folder" :size="17" /> {{ d }}</span><span /><span class="sz">{{ list.length }}개</span>
              </button>
              <template v-if="!closed.has(d)">
                <div v-for="f in list" :key="f.path" class="fr file">
                  <button class="fn in press" @click="preview(f)"><span class="fic sm" :class="kindOf(f.path)">{{ kindLabel[kindOf(f.path)] }}</span><span class="nm">{{ baseName(f.path) }}</span><span v-if="f.has_card" class="cd" :title="cardOf(f)">카드</span></button>
                  <span class="by"><Avatar v-if="f.author" :who="whoOf({ name: f.author, id: f.author })" :size="20" /> {{ f.author }} · {{ ago(f.mtime) }}</span>
                  <span class="sz">{{ fmtSize(Number(f.size)) }}<button v-if="can('editor') && folder.kind === 'managed'" class="del" title="지우기" @click="removeFile(f)"><Icon name="trash" :size="14" /></button></span>
                </div>
              </template>
            </template>
            <div v-for="f in tree.top" :key="f.path" class="fr file">
              <button class="fn press" @click="preview(f)"><span class="fic sm" :class="kindOf(f.path)">{{ kindLabel[kindOf(f.path)] }}</span><span class="nm">{{ baseName(f.path) }}</span><span v-if="f.has_card" class="cd" :title="cardOf(f)">카드</span></button>
              <span class="by"><Avatar v-if="f.author" :who="whoOf({ name: f.author, id: f.author })" :size="20" /> {{ f.author }} · {{ ago(f.mtime) }}</span>
              <span class="sz">{{ fmtSize(Number(f.size)) }}<button v-if="can('editor') && folder.kind === 'managed'" class="del" title="지우기" @click="removeFile(f)"><Icon name="trash" :size="14" /></button></span>
            </div>
            <p v-if="!files.length" class="none">아직 파일이 없어요.</p>
            <p v-if="can('editor') && folder.kind === 'managed'" class="drop">파일을 여기로 끌어다 놓으면 main 에 올라가요 · 올린 사람과 시각이 이력에 남아요</p>
          </div>

          <div v-else-if="tab === 'history'" class="hist scroll">
            <div v-for="h in folder.history" :key="h.sha" class="hr">
              <code>{{ h.short }}</code><span class="hm">{{ h.msg }}</span><span class="by"><Avatar :who="whoOf({ name: h.name, id: h.name })" :size="20" /> {{ h.name }} · {{ ago(h.at) }}</span>
            </div>
          </div>

          <div v-else-if="tab === 'skill'" class="idx scroll">
            <dl class="sk">
              <dt>작성자</dt><dd>{{ skill?.author?.name || '—' }}</dd>
              <dt>공개 범위</dt><dd>{{ skill?.visibility === 'private' ? '내 스킬 — 작성자와 작성자의 에이전트만 써요' : '전사 공유 — 누구나 쓰고 변형으로 제안해요' }}</dd>
              <dt>반영</dt><dd>작성자, 그리고 이 스킬을 쓰는 에이전트의 담당자만 할 수 있어요{{ skill?.canMerge ? ' · 나도 할 수 있어요' : '' }}</dd>
              <dt>저장소</dt><dd>{{ skill?.mode === 'provider' ? 'process-gpt git 공급자' : '이 폴더의 git (git 공급자 미연결)' }}</dd>
            </dl>
            <div class="sec">이 스킬을 쓰는 에이전트와 담당자</div>
            <div v-for="a in skill?.agents || []" :key="a.id" class="ar">
              <Avatar :who="whoOf({ id: a.id, name: a.name, type: 'agent', agent_type: a.agent_type })" :size="24" /><b>{{ a.name }}</b>
              <span class="sp" /><span class="bn">{{ a.boss_name ? `담당 ${a.boss_name}` : '담당자 없음' }}</span>
              <button v-if="!a.boss_id" class="tb press" @click="beBoss(a)">내가 담당할게요</button>
            </div>
            <p v-if="!skill?.agents?.length" class="none">이 스킬을 쓰도록 지정된 에이전트가 없어요.</p>
            <div class="sec">기여 기록</div>
            <div v-for="(c, i) in skill?.contributions || []" :key="i" class="ar">
              <Avatar :who="whoOf({ id: c.id, name: c.name })" :size="22" /><b>{{ c.name }}</b><span class="bn">{{ CTYPE[c.type] || c.type }} · {{ ago(c.created_at) }}</span>
            </div>
            <p v-if="!skill?.contributions?.length" class="none">아직 반영된 제안이 없어요.</p>
          </div>

          <div v-else class="idx scroll">
            <div class="ist">
              <span class="badge" :class="ix.state">{{ indexLabel[ix.state] || '색인 전' }}</span>
              <span>파일 {{ (ix.files || 0).toLocaleString() }}개 · 카드 {{ ix.cards || 0 }}개 · {{ fmtSize(ix.size || 0) }} · {{ ago(ix.at) }}{{ ix.fulltext ? ' · 본문 색인 켜짐' : '' }}</span>
            </div>
            <p v-if="ix.state === 'list'" class="exp">파일이 많고 코드가 대부분이라 <b>파일 목록만</b> 색인해요. 에이전트는 경로와 이름으로 찾고, 필요한 파일만 열어 읽어요.</p>
            <p v-else class="exp">문서마다 1~2문장 <b>문서 카드</b>를 만들어 두었어요. 에이전트는 아래 목록을 먼저 읽고 알맞은 파일을 골라 열어요. 문서가 200개를 넘거나 카드 목록이 길어지면(약 12k 토큰, 본문 5MB) <b>본문 색인</b>이 자동으로 켜져요.</p>
            <div class="sec">에이전트가 보는 목록</div>
            <pre class="cat">{{ indexLines }}</pre>
          </div>
        </section>

        <section class="vars glass">
          <div class="vh">
            <b>변형</b><span class="cnt">{{ live.length }}</span>
            <span class="sp" />
            <button v-if="can('runner') && folder.kind === 'managed'" class="tb press" @click="newVariation"><FIcon name="branch" :size="15" /> 새 변형</button>
          </div>
          <div class="vl scroll">
            <div v-for="v in live" :key="v.id" class="vc" :class="{ sel: picked.includes(v.id) }">
              <button class="chk" :class="{ on: picked.includes(v.id) }" :disabled="v.status !== 'ready' || !canMerge || folder.kind === 'linked'" :title="v.status === 'ready' ? '반영할 변형으로 고르기' : '실행이 끝나야 고를 수 있어요'" @click="pick(v)">
                <Icon v-if="picked.includes(v.id)" name="check" :size="14" />
              </button>
              <button class="vb press" @click="router.push(`/folders/${folder.slug}/v/${v.id}`)">
                <span class="vt"><b>{{ v.title }}</b><span class="st" :class="v.status"><span v-if="v.status === 'open' && v.worktree_path" class="spin" />{{ statusLabel[v.status] }}</span></span>
                <code class="br">{{ v.branch }}</code>
                <span class="vmeta">
                  <Avatar :who="whoOf({ id: v.holder_id, name: v.holder_name, type: v.holder_type })" :size="20" /> {{ v.holder_name }}
                  <span class="src" :class="v.kind">{{ sourceLabel[v.kind] }}</span>
                  <span class="ab" title="main 보다 앞선 커밋 / 뒤처진 커밋">↑{{ v.ahead }} ↓{{ v.behind }}</span>
                  <span class="when">{{ ago(v.updated_at) }}</span>
                </span>
                <span v-if="v.source?.pr_id" class="prb">반영 요청됨</span>
                <span v-if="v.change_card?.summary" class="from">{{ v.change_card.summary }}</span>
                <span v-else class="from">{{ v.source?.label }}</span>
              </button>
            </div>
            <p v-if="!live.length" class="none">진행 중인 변형이 없어요. 채팅에서 "{{ isSkill ? `${folder.name} 스킬을 … 고쳐줘` : `${folder.name} 폴더의 … 고쳐줘` }}" 라고 하면 에이전트가 변형을 만들어 일해요.</p>
            <button v-if="past.length" class="past" @click="showPast = !showPast">{{ showPast ? '지난 변형 접기' : `지난 변형 ${past.length}개 (반영됨·버림)` }}</button>
            <template v-if="showPast">
              <div v-for="v in past" :key="v.id" class="vc past-c">
                <span class="chk ghost" />
                <button class="vb press" @click="router.push(`/folders/${folder.slug}/v/${v.id}`)">
                  <span class="vt"><b>{{ v.title }}</b><span class="st" :class="v.status">{{ statusLabel[v.status] }}</span></span>
                  <code class="br">{{ v.branch }}</code>
                </button>
              </div>
            </template>
          </div>
          <div v-if="folder.integration" class="vf on">
            <span>반영이 멈춰 있어요<small>충돌을 풀거나 그만둘 수 있어요</small></span>
            <button class="dark-btn" @click="merging = { integration: folder.integration }"><FIcon name="merge" :size="17" /> 이어서 하기</button>
          </div>
          <div v-else-if="isSkill && !canMerge" class="vf">
            <span>반영은 작성자·에이전트 담당자가 해요<small>변형을 열어 "반영 요청" 을 보내면 알림이 가요</small></span>
          </div>
          <div v-else class="vf" :class="{ on: picked.length }">
            <span>{{ picked.length ? `${picked.length}개 골랐어요` : '반영할 변형을 골라 주세요' }}<small>충돌이 나면 멈추고 알려 줘요</small></span>
            <button class="dark-btn" :disabled="!picked.length" @click="merging = { ids: picked }"><FIcon name="merge" :size="17" /> 일괄 반영</button>
          </div>
        </section>
      </div>

      <MergeSheet v-if="merging" :folder="folder" :ids="merging.ids" :integration="merging.integration" @close="merging = null; load()" @done="merged" />
      <ShareSheet v-if="sharing" :folder="folder" @close="sharing = false; load()" />
    </template>
    <Transition name="fade"><div v-if="toast" class="toast">{{ toast }}</div></Transition>
  </div>
</template>

<style scoped>
.fd { position: absolute; inset: 0; display: flex; flex-direction: column; padding: 0 24px 16px; max-width: 1400px; margin: 0 auto; }
.missing { text-align: center; color: var(--text-secondary); margin-top: 80px; }
.head { display: flex; align-items: center; gap: 12px; margin: 0 0 14px; }
.back { width: 40px; height: 40px; border-radius: 20px; display: grid; place-items: center; background: var(--button-bg); }
.ttl { display: flex; flex-direction: column; min-width: 0; }
h1 { margin: 0; font-size: 24px; font-weight: 500; letter-spacing: -0.02em; }
.ttl small { color: var(--text-secondary); font-size: 13px; }
.sp { flex: 1; }
.mem { display: flex; } .mem > * + * { margin-left: -8px; }
.hbtn { height: 40px; font-size: 14px; display: inline-flex; align-items: center; gap: 6px; }
.fic { flex: none; width: 44px; height: 44px; border-radius: 13px; display: grid; place-items: center; font-size: 10.5px; font-weight: 700; color: #fff; background: #6b6b66; }
.fic.sm { width: 28px; height: 28px; border-radius: 8px; font-size: 9px; }
.fic.folder { background: #e2a93b; } .fic.folder.linked { background: #4a5f9a; }
.fic.hwp { background: #1f6fd1; } .fic.doc { background: #2b579a; } .fic.xls { background: #217346; } .fic.ppt { background: #c43e1c; } .fic.pdf { background: #d93025; } .fic.cad { background: #0b6f88; } .fic.vec { background: #c2570c; } .fic.img { background: #7b3fbf; } .fic.snd { background: #0f8a5f; } .fic.vid { background: #b0223c; } .fic.md { background: #3d4f6b; } .fic.code { background: #2d333b; }
.banner.ask { border: 1px solid rgba(123 92 214 / .45); }
.sm2 { height: 36px; padding: 0 16px; font-size: 13.5px; }
.kb { display: inline-flex; vertical-align: middle; height: 24px; padding: 0 10px; border-radius: 12px; font-size: 12px; font-weight: 500; background: rgba(150 240 176 / .2); color: var(--color-success); letter-spacing: 0; }
.kb.private { background: rgba(255 160 60 / .18); color: #e08a2c; }
.fic.folder.skill { background: #7b5cd6; }
dl.sk { display: grid; grid-template-columns: 90px 1fr; gap: 8px 12px; margin: 8px 6px; font-size: 13.5px; } dl.sk dt { color: var(--text-secondary); } dl.sk dd { margin: 0; }
.ar { display: flex; align-items: center; gap: 8px; padding: 8px 6px; border-bottom: 1px solid var(--hairline); font-size: 14px; } .ar b { font-weight: 500; }
.bn { font-size: 12.5px; color: var(--text-secondary); }
.prb { align-self: flex-start; height: 20px; padding: 0 8px; border-radius: 10px; font-size: 11px; display: inline-flex; align-items: center; background: rgba(123 92 214 / .2); color: #9b7cf0; }
.banner { display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-radius: 16px; font-size: 13.5px; margin-bottom: 12px; }
.cols { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 440px; gap: 14px; }
.pane, .vars { border-radius: 22px; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.ph, .vh { display: flex; align-items: center; gap: 10px; height: 56px; padding: 0 12px 0 14px; border-bottom: 1px solid var(--hairline); flex: none; }
.seg { display: flex; background: var(--button-bg); border-radius: 18px; padding: 3px; }
.seg button { height: 30px; padding: 0 14px; border-radius: 15px; font-size: 13.5px; color: var(--text-secondary); }
.seg button.on { background: var(--ink); color: var(--ink-inverse); }
.ref { display: inline-flex; align-items: center; gap: 4px; font-size: 12.5px; color: var(--text-secondary); }
.up { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--color-info); max-width: 220px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
code { font-family: "SF Mono", Menlo, monospace; font-size: 12px; }
.tb { height: 32px; padding: 0 12px; border-radius: 16px; font-size: 13px; font-weight: 500; background: var(--button-bg); display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.files, .hist, .idx { flex: 1; min-height: 0; overflow-y: auto; padding: 6px 8px 14px; }
.files.drag { outline: 2px dashed var(--color-info); outline-offset: -8px; border-radius: 18px; }
.fr { width: 100%; display: grid; grid-template-columns: minmax(0, 1fr) 190px 92px; align-items: center; gap: 10px; min-height: 42px; padding: 4px 10px; border-radius: 12px; text-align: left; font-size: 14px; }
.fr.th { min-height: 30px; font-size: 12px; color: var(--text-tertiary); }
.fr.file:hover, .fr.dir:hover { background: var(--cell-bg); }
.fn { display: flex; align-items: center; gap: 10px; min-width: 0; text-align: left; font-size: 14px; }
.fn.in { padding-left: 26px; }
.dir .fn { gap: 6px; font-weight: 500; color: var(--text-primary); }
.tw { width: 14px; color: var(--text-tertiary); font-size: 12px; }
.nm { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cd { flex: none; height: 20px; padding: 0 7px; border-radius: 10px; font-size: 11px; background: rgba(150 240 176 / .18); color: var(--color-success); display: inline-flex; align-items: center; }
.by { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; }
.sz { font-size: 12.5px; color: var(--text-secondary); text-align: right; display: flex; align-items: center; justify-content: flex-end; gap: 6px; }
.del { width: 24px; height: 24px; border-radius: 12px; display: grid; place-items: center; opacity: 0; color: var(--text-secondary); }
.fr.file:hover .del { opacity: 1; } .del:hover { background: var(--button-bg); color: var(--color-error); }
.none { font-size: 13.5px; color: var(--text-secondary); padding: 10px; margin: 0; line-height: 1.6; }
.drop { margin: 14px 10px 0; padding: 14px; border-radius: 14px; border: 1.5px dashed var(--hairline); font-size: 13px; color: var(--text-tertiary); text-align: center; }
.hr { display: grid; grid-template-columns: 76px 1fr auto; gap: 10px; align-items: center; padding: 10px; border-bottom: 1px solid var(--hairline); font-size: 14px; }
.hr code { color: var(--text-secondary); }
.ist { display: flex; align-items: center; gap: 10px; font-size: 13.5px; padding: 8px 6px; }
.badge { display: inline-flex; align-items: center; height: 24px; padding: 0 10px; border-radius: 12px; font-size: 12px; font-weight: 500; background: var(--button-bg); }
.badge.cards { background: rgba(150 240 176 / .2); color: var(--color-success); } .badge.indexing { color: var(--color-info); }
.exp { font-size: 14px; line-height: 1.65; margin: 4px 6px 4px; }
.sec { font-size: 12.5px; color: var(--text-tertiary); margin: 16px 6px 8px; letter-spacing: .04em; }
.cat { margin: 0 6px; padding: 14px; border-radius: 14px; background: var(--cell-bg); font: 12px/1.7 "SF Mono", Menlo, monospace; white-space: pre-wrap; color: var(--text-primary); }
.vh b { font-size: 15px; font-weight: 600; }
.cnt { height: 22px; min-width: 22px; padding: 0 7px; border-radius: 11px; background: var(--button-bg); font-size: 12px; display: grid; place-items: center; }
.vl { flex: 1; min-height: 0; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.vc { display: flex; gap: 8px; align-items: flex-start; padding: 10px 10px 10px 8px; border-radius: 16px; border: 1px solid transparent; }
.vc:hover { background: var(--cell-bg); }
.vc.sel { background: var(--cell-bg); border-color: var(--color-info); }
.chk { flex: none; width: 22px; height: 22px; margin-top: 2px; border-radius: 7px; border: 1.5px solid var(--text-tertiary); display: grid; place-items: center; }
.chk.on { background: var(--color-info); border-color: var(--color-info); color: #fff; }
.chk:disabled { opacity: .3; cursor: not-allowed; }
.chk.ghost { border-color: transparent; }
.vb { flex: 1; min-width: 0; text-align: left; display: flex; flex-direction: column; gap: 4px; }
.vt { display: flex; align-items: center; gap: 8px; }
.vt b { font-weight: 500; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.st { flex: none; display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 9px; border-radius: 11px; font-size: 11.5px; font-weight: 500; background: var(--button-bg); }
.st.ready { background: rgba(161 208 255 / .2); color: var(--color-info); }
.st.open { background: rgba(255 160 60 / .18); color: #e08a2c; }
.st.conflicted { background: #e0613f; color: #fff; }
.st.merged { background: rgba(150 240 176 / .18); color: var(--color-success); }
.br { color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vmeta { display: flex; align-items: center; gap: 6px; font-size: 12.5px; flex-wrap: wrap; }
.src { height: 20px; padding: 0 8px; border-radius: 10px; font-size: 11px; display: inline-flex; align-items: center; background: var(--button-bg); }
.src.run, .src.chat { color: #9b7cf0; } .src.instance { color: #e2a93b; } .src.person, .src.handover { color: var(--color-info); } .src.imported { color: #d97757; }
.ab { font-family: "SF Mono", Menlo, monospace; font-size: 11.5px; color: var(--text-secondary); }
.when { color: var(--text-tertiary); margin-left: auto; }
.from { font-size: 12.5px; color: var(--text-secondary); line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.spin { width: 9px; height: 9px; border-radius: 9999px; border: 2px solid currentColor; border-right-color: transparent; animation: spin .8s linear infinite; }
.past { font-size: 13px; color: var(--text-secondary); padding: 8px 10px; text-align: left; }
.past-c { opacity: .6; }
.vf { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-top: 1px solid var(--hairline); flex: none; }
.vf span { flex: 1; display: flex; flex-direction: column; font-size: 14px; font-weight: 500; }
.vf small { font-size: 12px; color: var(--text-secondary); font-weight: 400; }
.vf .dark-btn { height: 44px; }
.dark-btn { background: var(--ink); color: var(--ink-inverse); }
.toast { position: fixed; left: 50%; bottom: 28px; translate: -50% 0; padding: 12px 18px; border-radius: 14px; background: #1d1d1f; color: #f5f5f7; font-size: 14px; z-index: 50; max-width: 90vw; }
@media (max-width: 1000px) { .cols { grid-template-columns: 1fr; overflow-y: auto; } .fd { overflow-y: auto; } }
</style>
