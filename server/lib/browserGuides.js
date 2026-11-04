// What the browser agent should know about a site before it starts: where the controls are and how long things take.
// A guide is a hint, not a script: the agent still reads the page, so a renamed button only costs it a look around.
export const NOTEBOOK_URL = 'https://notebook.google.com/'
const NOTEBOOK_WORDS = /노트북\s*(엘엠|lm)|notebook\s*lm|(구글|제미나이|gemini)\s*노트북|gemini\s*notebook|notebook\.google|notebooklm\.google/i
export const isNotebookJob = (text) => NOTEBOOK_WORDS.test(String(text || ''))

const NOTEBOOK_GUIDE = `This site is Google NotebookLM (also shown as Gemini Notebook) at ${NOTEBOOK_URL}.
If it asks to sign in, call need_user and ask the person to sign in with takeover: never type a Google password yourself. The sign-in stays for next time.
- Home: 「새 노트북」 (New notebook) creates one. A new notebook opens with an add-source dialog, or use 「소스 추가」 / 「출처 추가」.
- A link or YouTube video: in that dialog choose 「웹사이트」 (it also takes YouTube links), put the address in its box, press 「삽입」. A file: choose 「파일 업로드」 and use attach_file.
- Wait until the source shows up in the left panel, with wait_for_page, before going on.
- Slides and podcast are made from the 스튜디오 panel on the right: 「슬라이드 자료」 and 「AI 오디오 오버뷰」. Pressing one may open a settings panel: keep its defaults, choose Korean if a language is asked, and press its 「생성」 (Generate). Start one, then the other.
- They take several minutes each. Tell the person with tell_user what has started and that it takes a while, then call wait_for_page, more than once if needed. Do not leave before both are ready, and do not start one over because it is slow.
- When one is ready it is listed in the 스튜디오 panel. Open its menu (⋮) and choose 「다운로드」; downloaded files reach the person by themselves.`

const GUIDES = [[isNotebookJob, NOTEBOOK_GUIDE]]
export const guideFor = (goal, url) => GUIDES.filter(([is]) => is(goal) || is(url)).map(([, g]) => g).join('\n')
