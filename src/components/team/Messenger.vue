<script setup>
// The team messenger sheet: 받은 편지함 (what teammates shared or mentioned me in, "like email") and
// 대화 (1:1 and small group threads). Shares and mentions sit in the same thread with that teammate.
// From an item: open the artifact in the editor (my copy), "이어서 작업" (my agent picks it up), or reply.
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '../Icon.vue'
import { useApp } from '../../stores/app.js'
import { useTeam, shareable } from '../../stores/team.js'
import { kindOf, kindLabel } from '../../artifacts.js'
import AssistSuggestion from './AssistSuggestion.vue'

const app = useApp()
const team = useTeam()
const router = useRouter()
const draft = ref('')
const attach = ref([])         // my file cards to send along
const attachOpen = ref(false)
const picking = ref(false)     // new thread: choose teammates
const people = ref(null)
const chosen = ref([])
const scroller = ref(null)
const busy = ref('')
const err = ref('')

const thread = computed(() => team.threads.find((t) => t.id === team.active) || null)
const list = computed(() => team.msgs[team.active] || [])
const myFiles = computed(() => (app.messages[app.mainThread?.id] || []).filter(shareable).slice(-12).reverse())
const inboxUnread = computed(() => team.inbox.filter((x) => x.unread).length)
const initial = (s) => String(s || '?').slice(0, 1)
const when = (d) => {
  const t = new Date(d), mins = Math.round((Date.now() - t) / 60000)
  return mins < 1 ? '방금' : mins < 60 ? `${mins}분 전` : t.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
const kindWord = { share: '공유', mention: '멘션', text: '메시지', agent: '에이전트 결과' }
// team assist: the suggestion cards under the message that prompted them (lib/team/assist.js)
const sugOf = (id) => (team.suggestions[team.active] || []).filter((x) => x.messageId === id)

async function toBottom() {
  await nextTick()
  const el = scroller.value
  if (!el) return
  const f = team.focus && el.querySelector(`[data-id="${team.focus}"]`)
  if (f) { f.scrollIntoView({ block: 'center' }); f.classList.add('flash'); team.focus = null } else el.scrollTop = el.scrollHeight
}
watch(() => [team.active, list.value.length, (team.suggestions[team.active] || []).length], toBottom)

async function run(key, fn) {
  busy.value = key; err.value = ''
  try { await fn() } catch (e) { err.value = e.message || '처리하지 못했어요.' } finally { busy.value = '' }
}
const openFile = (a) => run(`f${a.shareId}`, () => team.openShared(a.shareId, router))
const cont = (m) => run(`c${m.id}`, () => team.continueWork(m.id, router))
const reply = (m) => { team.tab = 'threads'; team.openThread(m.threadId, m.id) }
async function send() {
  const text = draft.value.trim()
  if ((!text && !attach.value.length) || !team.active) return
  await run('send', async () => {
    await team.send(team.active, text, attach.value.map((m) => m.id))
    draft.value = ''; attach.value = []
  })
}
function onKey(e) { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send() } }
const toggleAttach = (m) => { attach.value = attach.value.some((x) => x.id === m.id) ? attach.value.filter((x) => x.id !== m.id) : [...attach.value, m].slice(0, 5) }

async function newThread() {
  picking.value = true; chosen.value = []
  const d = await team.suggest('fast').catch(() => null)
  people.value = d ? [...d.frequent, ...d.rest] : []
}
const choose = (p) => { chosen.value = chosen.value.includes(p.id) ? chosen.value.filter((x) => x !== p.id) : [...chosen.value, p.id] }
const start = () => run('start', async () => { await team.startThread(chosen.value); picking.value = false })

const onEsc = (e) => { if (e.key === 'Escape') team.open = false }
onMounted(() => { window.addEventListener('keydown', onEsc); team.loadThreads(); team.loadInbox() })
onBeforeUnmount(() => window.removeEventListener('keydown', onEsc))
</script>

<template>
  <div class="veil" @click.self="team.open = false">
    <section class="ms glass" :class="{ inthread: !!team.active && team.tab === 'threads' }" role="dialog" aria-label="팀 메시지">
      <aside class="side">
        <header class="hd">
          <b>메시지</b>
          <button class="tb press" title="새 대화" @click="newThread"><Icon name="plus" :size="16" /> 새 대화</button>
          <button class="x press" aria-label="닫기" @click="team.open = false"><Icon name="close" :size="16" /></button>
        </header>
        <nav class="tabs">
          <button :class="{ on: team.tab === 'inbox' }" @click="team.tab = 'inbox'">받은 편지함<i v-if="inboxUnread">{{ inboxUnread }}</i></button>
          <button :class="{ on: team.tab === 'threads' }" @click="team.tab = 'threads'">대화<i v-if="team.unread.total">{{ team.unread.total }}</i></button>
        </nav>

        <div v-if="picking" class="pick">
          <p class="cap">대화할 팀원 (여럿 고르면 그룹 대화)</p>
          <button v-for="p in people || []" :key="p.id" class="row press" :class="{ on: chosen.includes(p.id) }" @click="choose(p)">
            <span class="av">{{ initial(p.name) }}</span><span class="nm"><b>{{ p.name }}</b><small>{{ (p.roles || []).join(', ') || p.email }}</small></span>
            <span class="ck">{{ chosen.includes(p.id) ? '✓' : '' }}</span>
          </button>
          <p v-if="people && !people.length" class="empty">대화할 팀원이 없어요.</p>
          <div class="pickbtns"><button class="ghost press" @click="picking = false">취소</button><button class="main press" :disabled="!chosen.length || busy === 'start'" @click="start">대화 시작</button></div>
        </div>

        <div v-else-if="team.tab === 'inbox'" class="items scroll">
          <article v-for="m in team.inbox" :key="m.id" class="mail" :class="{ unread: m.unread }">
            <div class="mh"><span class="av">{{ initial(m.sender.name) }}</span>
              <span class="who"><span><b>{{ m.sender.name }}</b> · {{ kindWord[m.kind] }}</span><small>{{ when(m.at) }}</small></span></div>
            <p v-if="m.context?.title" class="ctitle">{{ m.context.title }}</p>
            <p v-if="m.body" class="body">{{ m.body }}</p>
            <div v-if="m.artifacts.length" class="arts">
              <button v-for="a in m.artifacts" :key="a.shareId" class="art press" :disabled="!a.shareId || busy === `f${a.shareId}`" @click="openFile(a)">
                <span class="fic" :class="kindOf(a.name)">{{ kindLabel[kindOf(a.name)] || 'FILE' }}</span>{{ a.name }}
              </button>
            </div>
            <div class="acts">
              <button v-if="m.artifacts[0]?.shareId" class="b press" :disabled="!!busy" @click="openFile(m.artifacts[0])">편집기에서 열기</button>
              <button class="b main press" :disabled="!!busy" @click="cont(m)">{{ busy === `c${m.id}` ? '넘기는 중…' : '이어서 작업' }}</button>
              <button class="b ghost press" @click="reply(m)">답장</button>
            </div>
          </article>
          <p v-if="!team.inbox.length" class="empty">아직 받은 공유나 멘션이 없어요.</p>
        </div>

        <div v-else class="items scroll">
          <button v-for="t in team.threads" :key="t.id" class="th press" :class="{ on: t.id === team.active }" @click="team.openThread(t.id)">
            <span class="av" :class="{ grp: t.kind === 'group' }">{{ t.kind === 'group' ? t.members.length : initial(t.title) }}</span>
            <span class="nm"><b>{{ t.title }}</b>
              <small>{{ t.last ? `${t.last.mine ? '나: ' : ''}${t.last.kind === 'share' ? `산출물 ${t.last.files}개 공유${t.last.body ? ' · ' + t.last.body : ''}` : t.last.body}` : '새 대화' }}</small></span>
            <i v-if="team.unread.byThread[t.id]" class="badge">{{ team.unread.byThread[t.id] }}</i>
          </button>
          <p v-if="!team.threads.length" class="empty">팀원과 나눈 대화가 여기에 모여요.</p>
        </div>
      </aside>

      <main class="pane">
        <template v-if="thread && team.tab === 'threads'">
          <header class="thd">
            <button class="back press" aria-label="목록" @click="team.active = null"><Icon name="back" :size="18" /></button>
            <b>{{ thread.title }}</b><small>{{ thread.members.map((m) => m.name).join(', ') }}</small>
            <button class="aitog press" :class="{ on: team.assistOn[thread.id] }" :title="team.assistOn[thread.id] ? '대화 중 에이전트가 도울 일을 찾으면 제안해요 (끄기)' : 'AI 제안이 꺼져 있어요 (켜기)'" @click="team.toggleAssist(thread.id)">AI 제안 {{ team.assistOn[thread.id] ? '켬' : '끔' }}</button>
          </header>
          <div ref="scroller" class="msgs scroll">
            <template v-for="m in list" :key="m.id">
            <div :data-id="m.id" class="msg" :class="{ mine: m.mine, card: m.kind !== 'text', agent: m.kind === 'agent' }">
              <span v-if="!m.mine" class="av sm">{{ initial(m.sender.name) }}</span>
              <div class="bub">
                <p v-if="m.kind === 'text' && !m.mine && thread.kind === 'group'" class="kind">{{ m.sender.name }}</p>
                <p v-if="m.kind === 'agent'" class="kind">✦ {{ m.sender.name }}<template v-if="m.context?.title"> · {{ m.context.title }}</template></p>
                <p v-else-if="m.kind !== 'text'" class="kind">{{ m.mine ? '보냄' : m.sender.name }} · {{ kindWord[m.kind] }}<template v-if="m.context?.title"> · {{ m.context.title }}</template></p>
                <p v-if="m.body" class="txt">{{ m.body }}</p>
                <details v-if="m.context?.excerpt?.length" class="ex"><summary>대화 발췌</summary><p v-for="(l, i) in m.context.excerpt" :key="i">{{ l }}</p></details>
                <div v-if="m.artifacts.length" class="arts">
                  <button v-for="a in m.artifacts" :key="a.name + a.shareId" class="art press" :disabled="!a.shareId" @click="openFile(a)">
                    <span class="fic" :class="kindOf(a.name)">{{ kindLabel[kindOf(a.name)] || 'FILE' }}</span>{{ a.name }}
                  </button>
                </div>
                <button v-if="!m.mine && (m.kind === 'share' || m.kind === 'mention')" class="b main press cont" :disabled="!!busy" @click="cont(m)">{{ busy === `c${m.id}` ? '넘기는 중…' : '이어서 작업' }}</button>
                <small class="t">{{ when(m.at) }}</small>
              </div>
            </div>
            <AssistSuggestion v-for="sg in sugOf(m.id)" :key="sg.id" :s="sg" />
            </template>
          </div>
          <footer class="cmp">
            <div v-if="attach.length" class="chips"><span v-for="m in attach" :key="m.id" class="chip">{{ m.content.name }}<button @click="toggleAttach(m)">×</button></span></div>
            <div v-if="attachOpen" class="amenu glass">
              <p class="cap">내 산출물에서 첨부</p>
              <button v-for="m in myFiles" :key="m.id" class="row press" :class="{ on: attach.some((x) => x.id === m.id) }" @click="toggleAttach(m)">
                <span class="fic" :class="kindOf(m.content.name)">{{ kindLabel[kindOf(m.content.name)] || 'FILE' }}</span><span class="nm"><b>{{ m.content.name }}</b></span>
              </button>
              <p v-if="!myFiles.length" class="empty">첨부할 산출물이 없어요.</p>
            </div>
            <div class="box">
              <button class="ic press" title="산출물 첨부" aria-label="산출물 첨부" @click="attachOpen = !attachOpen"><Icon name="clip" :size="18" /></button>
              <textarea v-model="draft" rows="1" placeholder="메시지 보내기" @keydown="onKey" @focus="attachOpen = false" />
              <button class="send press" aria-label="보내기" :disabled="busy === 'send' || (!draft.trim() && !attach.length)" @click="send"><Icon name="up" :size="18" /></button>
            </div>
          </footer>
        </template>
        <div v-else class="blank">
          <Icon name="team" :size="36" />
          <p>{{ team.tab === 'inbox' ? '받은 공유와 멘션에서 바로 열거나 이어서 작업할 수 있어요.' : '대화를 고르거나 새 대화를 시작해 주세요.' }}</p>
        </div>
        <p v-if="err" class="err">{{ err }}</p>
      </main>
    </section>
  </div>
</template>

<style scoped>
.veil { position: fixed; inset: 0; z-index: 45; background: rgba(20, 24, 32, .16); display: flex; justify-content: flex-end; padding: 76px 16px 16px; }
.ms { width: min(860px, 100%); display: flex; border-radius: 24px; overflow: hidden; box-shadow: 0 18px 60px rgba(0, 0, 0, .22); color: var(--text-primary); animation: pop-in .3s var(--spring); }
.side { width: 330px; flex: none; display: flex; flex-direction: column; border-right: 1px solid rgba(127, 127, 127, .18); min-height: 0; }
.hd { display: flex; align-items: center; gap: 6px; padding: 14px 12px 6px 18px; }
.hd b { flex: 1; font-size: 18px; font-weight: 600; }
.tb { display: inline-flex; align-items: center; gap: 4px; height: 30px; padding: 0 10px; border-radius: 15px; font-size: 13px; background: rgba(127, 127, 127, .12); color: var(--text-primary); }
.x { width: 30px; height: 30px; border-radius: 15px; display: grid; place-items: center; color: var(--text-secondary); }
.tabs { display: flex; gap: 4px; padding: 6px 12px 8px; }
.tabs button { flex: 1; height: 34px; border-radius: 17px; font-size: 14px; color: var(--text-secondary); }
.tabs button.on { background: var(--ink, #1d1d1f); color: var(--text-primary-on, #fff); }
.tabs i, .badge { font-style: normal; display: inline-block; min-width: 18px; height: 18px; line-height: 18px; padding: 0 5px; margin-left: 6px; border-radius: 9px; background: #e5484d; color: #fff; font-size: 11px; text-align: center; }
.items { flex: 1; overflow: auto; padding: 0 10px 12px; }
.empty { font-size: 13px; color: var(--text-secondary); text-align: center; margin: 24px 8px; }
.av { flex: none; width: 34px; height: 34px; border-radius: 17px; display: grid; place-items: center; font-weight: 600; font-size: 14px; color: #fff; background: linear-gradient(135deg, #8aa6d8, #4a5f9a); }
.av.grp { background: #0f8a5f; } .av.sm { width: 28px; height: 28px; font-size: 12px; }
.mail { padding: 12px; border-radius: 16px; margin-bottom: 8px; background: rgba(127, 127, 127, .07); }
.mail.unread { background: rgba(42, 120, 214, .1); box-shadow: inset 3px 0 0 #2a78d6; }
.mh { display: flex; align-items: center; gap: 10px; }
.who { flex: 1; font-size: 14px; display: flex; flex-direction: column; }
.who small { font-size: 11.5px; color: var(--text-tertiary); }
.ctitle { margin: 8px 0 0; font-size: 12.5px; color: var(--text-secondary); }
.body { margin: 6px 0 0; font-size: 14px; line-height: 1.5; white-space: pre-wrap; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
.arts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.art { display: inline-flex; align-items: center; gap: 8px; max-width: 100%; height: 36px; padding: 0 12px 0 4px; border-radius: 12px; background: #1d1d1f; color: #f5f5f7; font-size: 13px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.fic { flex: none; width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; font-size: 9.5px; font-weight: 700; color: #fff; background: #6b6b66; }
.fic.hwp { background: #1f6fd1; } .fic.doc { background: #2b579a; } .fic.xls { background: #217346; } .fic.ppt { background: #c43e1c; } .fic.pdf { background: #d93025; } .fic.cad { background: #0b6f88; } .fic.vec { background: #c2570c; } .fic.img { background: #7b3fbf; } .fic.snd { background: #0f8a5f; } .fic.vid { background: #b0223c; }
.acts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.b { height: 32px; padding: 0 13px; border-radius: 16px; font-size: 13.5px; background: rgba(127, 127, 127, .14); color: var(--text-primary); }
.b.main { background: #2a78d6; color: #fff; }
.b.ghost { background: transparent; color: var(--text-secondary); }
.b:disabled { opacity: .55; }
.th { width: 100%; display: flex; align-items: center; gap: 10px; padding: 10px; border-radius: 14px; text-align: left; color: var(--text-primary); }
.th.on { background: rgba(127, 127, 127, .14); }
.nm { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.nm b { font-size: 14.5px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nm small { font-size: 12.5px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pick { flex: 1; overflow: auto; padding: 0 10px 12px; }
.cap { margin: 6px 6px 6px; font-size: 12px; color: var(--text-secondary); }
.row { width: 100%; display: flex; align-items: center; gap: 10px; padding: 8px; border-radius: 12px; text-align: left; color: var(--text-primary); }
.row.on { background: rgba(42, 120, 214, .14); }
.ck { width: 22px; height: 22px; border-radius: 11px; display: grid; place-items: center; font-size: 13px; color: #fff; background: rgba(127, 127, 127, .2); }
.row.on .ck { background: #2a78d6; }
.pickbtns { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
.pickbtns button { height: 34px; padding: 0 14px; border-radius: 17px; font-size: 14px; }
.pickbtns .main { background: #1d1d1f; color: #fff; } .pickbtns .main:disabled { opacity: .45; }
.pane { flex: 1; min-width: 0; display: flex; flex-direction: column; position: relative; }
.thd { display: flex; align-items: baseline; gap: 8px; padding: 18px 18px 10px; border-bottom: 1px solid rgba(127, 127, 127, .14); }
.thd b { font-size: 16px; font-weight: 600; } .thd small { font-size: 12px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.back { display: none; }
.msgs { flex: 1; overflow: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.msg { display: flex; align-items: flex-end; gap: 8px; max-width: 86%; }
.msg.mine { align-self: flex-end; flex-direction: row-reverse; }
.bub { border-radius: 18px; padding: 9px 13px; background: rgba(127, 127, 127, .12); font-size: 14.5px; line-height: 1.5; min-width: 0; }
.mine .bub { background: #2a78d6; color: #fff; }
.card .bub { background: var(--bubble-agent-bg, rgba(255, 255, 255, .7)); color: var(--text-primary); border: 1px solid rgba(127, 127, 127, .2); }
.msg.flash .bub { animation: flash 1.6s; }
@keyframes flash { 0%, 60% { box-shadow: 0 0 0 3px rgba(42, 120, 214, .55); } 100% { box-shadow: none; } }
.aitog { margin-left: auto; flex: none; align-self: center; height: 26px; padding: 0 10px; border-radius: 13px; font-size: 12px; color: var(--text-secondary); background: rgba(127, 127, 127, .12); }
.aitog.on { color: #7a5af5; background: rgba(122, 90, 245, .14); }
.msg.agent .bub { border-color: rgba(122, 90, 245, .45); }
.kind { margin: 0 0 4px; font-size: 12px; color: var(--text-secondary); }
.txt { margin: 0; white-space: pre-wrap; word-break: break-word; }
.ex { margin-top: 6px; font-size: 12.5px; color: var(--text-secondary); }
.ex summary { cursor: pointer; } .ex p { margin: 4px 0 0; }
.cont { margin-top: 8px; }
.t { display: block; margin-top: 4px; font-size: 11px; opacity: .6; }
.cmp { position: relative; padding: 10px 12px 12px; border-top: 1px solid rgba(127, 127, 127, .14); }
.box { display: flex; align-items: flex-end; gap: 6px; border-radius: 22px; background: rgba(127, 127, 127, .1); padding: 4px; }
.box textarea { flex: 1; resize: none; border: 0; outline: 0; background: transparent; padding: 9px 6px; font-size: 14.5px; line-height: 19px; color: var(--text-primary); font-family: inherit; max-height: 120px; }
.ic { width: 36px; height: 36px; border-radius: 18px; display: grid; place-items: center; color: var(--text-secondary); }
.send { width: 36px; height: 36px; border-radius: 18px; display: grid; place-items: center; background: #1d1d1f; color: #fff; }
.send:disabled { opacity: .35; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.chip { display: inline-flex; align-items: center; gap: 4px; height: 26px; padding: 0 4px 0 10px; border-radius: 13px; font-size: 12.5px; background: rgba(42, 120, 214, .14); }
.chip button { width: 20px; height: 20px; border-radius: 10px; color: var(--text-secondary); }
.amenu { position: absolute; left: 12px; bottom: calc(100% + 4px); width: 300px; max-height: 300px; overflow: auto; border-radius: 16px; padding: 6px; box-shadow: 0 12px 40px rgba(0, 0, 0, .2); }
.blank { flex: 1; display: grid; place-content: center; justify-items: center; gap: 10px; color: var(--text-tertiary); text-align: center; padding: 30px; font-size: 14px; }
.err { position: absolute; left: 16px; right: 16px; bottom: 70px; margin: 0; padding: 8px 12px; border-radius: 10px; background: rgba(198, 40, 40, .12); color: #c62828; font-size: 13px; }
@media (max-width: 760px) {
  .veil { padding: 70px 8px 8px; }
  .side { width: 100%; border-right: 0; }
  .pane { display: none; }
  .ms.inthread .side { display: none; }
  .ms.inthread .pane { display: flex; }
  .back { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 15px; align-self: center; }
  .blank { display: none; }
}
</style>
