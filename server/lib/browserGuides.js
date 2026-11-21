// What the browser agent should know about a site before it starts: where the controls are and how long things take.
// A guide is a hint, not a script: the agent still reads the page, so a renamed button only costs it a look around.
export const NOTEBOOK_URL = 'https://notebook.google.com/'
const NOTEBOOK_WORDS = /노트북\s*(엘엠|lm)|notebook\s*lm|(구글|제미나이|gemini)\s*노트북|gemini\s*notebook|notebook\.google|notebooklm\.google/i
export const isNotebookJob = (text) => NOTEBOOK_WORDS.test(String(text || ''))
const NOTEBOOK_HOST = /^(notebook|notebooklm)\.google(\.com)?$/

const NOTEBOOK_GUIDE = `This site is Google NotebookLM (also shown as Gemini Notebook) at ${NOTEBOOK_URL}.
Signing in is the person's: when the page is the sign-in screen (the front page with only 「로그인」 / 「Gemini Notebook에 로그인」, or accounts.google.com), the server stops and asks them to sign in themselves: never type a Google password yourself, and do not press those sign-in buttons. The sign-in stays for next time.
- Home: 「새 노트북」 (New notebook) creates one. A new notebook opens with an add-source dialog, or use 「소스 추가」 / 「출처 추가」.
- A link or YouTube video: in that dialog choose 「웹사이트」 (it also takes YouTube links), put the address in its box, press 「삽입」. A file: choose 「파일 업로드」 and use attach_file.
- Wait until the source shows up in the left panel, with wait_for_page, before going on.
- Slides and podcast are made from the 스튜디오 panel on the right: 「슬라이드 자료」 and 「AI 오디오 오버뷰」. Pressing one may open a settings panel: keep its defaults, choose Korean if a language is asked, and press its 「생성」 (Generate). Start one, then the other.
- They take several minutes each. Tell the person with tell_user what has started and that it takes a while, then call wait_for_page, more than once if needed. Do not leave before both are ready, and do not start one over because it is slow.
- When one is ready it is listed in the 스튜디오 panel. Open its menu (⋮) and choose 「다운로드」; downloaded files reach the person by themselves.`

const GUIDES = [[isNotebookJob, NOTEBOOK_GUIDE]]
export const guideFor = (goal, url) => GUIDES.filter(([is]) => is(goal) || is(url)).map(([, g]) => g).join('\n')

// The name a person knows the site by, for what the card says.
export function siteName(host, goal = '') {
  const h = String(host || '').replace(/^www\./, '')
  return NOTEBOOK_HOST.test(h) || (/(^|\.)google\.com$/.test(h) && isNotebookJob(goal)) ? 'NotebookLM' : h
}

// ---- walls: pages the agent cannot get past by itself, told apart by rules (no model turn) ----
// Google turning the sign-in down in this browser ("Couldn't sign you in")
const GOOGLE_REFUSED = /이 브라우저 또는 앱은 안전하지 않을 수 있습니다|안전하지 않은 브라우저|로그인할 수 없음|couldn.t sign you in|this browser or app may not be secure|try using a different browser/i
const GOOGLE_REFUSED_PATH = /rejected|deniedsignin/i
// the NotebookLM front page for people not signed in: sign-in buttons, none of the app's own
const SIGN_IN = /^(로그인|로그인하기|sign in|log in|signin)$|에 로그인$|^(sign|log) in to /i
const NOTEBOOK_APP = /새 노트북|노트북 만들기|새로 만들기|new notebook|create new|소스 추가|출처 추가|add source/i
// a bot check (Google's "unusual traffic", "I'm not a robot", Cloudflare's check)
const BOT_CHECK = /unusual traffic from your computer|비정상적인 트래픽|로봇이 아닙니다|i.m not a robot|verify you are human|사람인지 확인하(고|는|세요)|checking if the site connection is secure|자동화된 요청/i
// any site saying it needs a sign-in before going on
const SIGN_IN_ASKED = /로그인이 필요(해|합|한)|로그인 후 (이용|사용)|로그인해야|로그인해 주세요|로그인하세요|sign in to continue|log in to continue|please (sign|log) in|you need to (sign|log) in|you must (sign|log) in/i

// snapshot {url, title, text, els} → { need: 'blocked' | 'login' | 'captcha', site, google?, generic? } or null
export function wallOf(snap) {
  let u
  try { u = new URL(snap?.url || '') } catch { return null }
  if (!/^https?:$/.test(u.protocol)) return null
  const site = u.hostname.replace(/^www\./, '')
  const text = `${snap.title || ''}\n${snap.text || ''}`
  const els = snap.els || []
  const google = /(^|\.)google\.com$/.test(site) || NOTEBOOK_HOST.test(site)
  if (site === 'accounts.google.com') return { need: GOOGLE_REFUSED.test(text) || GOOGLE_REFUSED_PATH.test(u.pathname) ? 'blocked' : 'login', site, google: true }
  if (BOT_CHECK.test(text) || (google && u.pathname.startsWith('/sorry'))) return { need: 'captcha', site }
  if (NOTEBOOK_HOST.test(site)) {
    const signIn = els.some((e) => SIGN_IN.test(String(e.text || '').trim()))
    const app = els.some((e) => NOTEBOOK_APP.test(String(e.text || '')))
    if (/^\/(trynow|login)\b/.test(u.pathname) || (signIn && !app)) return { need: 'login', site, google: true }
    return null
  }
  // only when the sign-in is in the way: a sign-in form on the page, or next to nothing else to read
  if (SIGN_IN_ASKED.test(text) && (els.some((e) => e.secret || e.type === 'password') || String(snap.text || '').length < 400)) return { need: 'login', site, generic: true }
  return null
}
