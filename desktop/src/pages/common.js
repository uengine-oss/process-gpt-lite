'use strict'
// Shared by the local pages: theme and language from the address (main.js pageQuery), the strings, the logo.
const Q = new URLSearchParams(location.search)
document.documentElement.dataset.theme = Q.get('theme') === 'light' ? 'light' : 'dark'
const LANG = Q.get('lang') === 'en' ? 'en' : 'ko'
document.documentElement.lang = LANG
const STR = {
  ko: {
    setupTitle: 'Process GPT Lite 서버 고르기',
    setupLead: '사용할 Lite 서버 주소를 넣어 주세요. 한 번 고르면 주소가 저장되고, 메뉴의 「서버 바꾸기…」로 언제든 바꿀 수 있어요.',
    company: '회사 주소', companyHint: 'https://<회사>.process-gpt.io/lite',
    local: '이 컴퓨터에 설치한 Lite', placeholder: '서버 주소', companyPh: '회사 이름만 넣어도 돼요 — 예: uengine',
    recent: '최근', gate: '공개 주소에 접근 암호가 걸려 있으면 (선택)', user: '아이디', pass: '암호', passKept: '저장된 암호 유지',
    connect: '연결', cancel: '취소', checking: '연결 확인 중…',
    empty: '주소를 넣어 주세요.', unreachable: '서버에 연결하지 못했어요. 주소를 확인해 주세요.',
    auth: '접근 암호가 필요하거나 맞지 않아요.', notLite: '해당 주소에서 Process GPT Lite를 찾지 못했어요. 회사 주소라면 끝에 /lite가 붙어요.',
    foot: '서버에 연결한 뒤 해당 서버의 화면에서 로그인해요(이메일 코드 · Google).',
    offTitle: '서버에 연결하지 못했어요', offHttp: (c) => `서버가 응답하지 못했어요(${c}).`, offAuth: '접근 암호가 필요해요. 「서버 바꾸기」에서 아이디와 암호를 넣어 주세요.',
    retry: '다시 시도', change: '서버 바꾸기', auto: '연결되면 자동으로 다시 열려요.',
  },
  en: {
    setupTitle: 'Choose your Process GPT Lite server',
    setupLead: 'Enter the address of the Lite server to use. The app remembers it; change it any time from the menu (Change Server…).',
    company: 'Company address', companyHint: 'https://<company>.process-gpt.io/lite',
    local: 'Lite installed on this computer', placeholder: 'Server address', companyPh: 'The company name is enough — e.g. acme',
    recent: 'Recent', gate: 'If the public address has an access password (optional)', user: 'User', pass: 'Password', passKept: 'Keep saved password',
    connect: 'Connect', cancel: 'Cancel', checking: 'Checking the connection…',
    empty: 'Enter an address.', unreachable: "Couldn't reach the server. Check the address.",
    auth: 'An access password is needed, or it is wrong.', notLite: "Process GPT Lite isn't at that address. A company address ends with /lite.",
    foot: 'You sign in on the server’s own screen after connecting (email code · Google).',
    offTitle: "Can't reach the server", offHttp: (c) => `The server didn't answer (${c}).`, offAuth: 'An access password is needed. Enter it under Change Server.',
    retry: 'Try Again', change: 'Change Server', auto: 'It reopens by itself once the server answers.',
  },
}[LANG]
const LOGO = '<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#1d1d1f"/><path d="M7 16 25 8 20 25 16 18z" fill="#f5f5f7"/></svg>'
const $ = (s) => document.querySelector(s)
