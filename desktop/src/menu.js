'use strict'
// The app menu, in the web app's language (Korean, or English when the page is in English).
const T = {
  ko: {
    about: 'Process GPT Lite 정보', server: '서버 바꾸기…', services: '서비스', hide: 'Process GPT Lite 가리기', hideOthers: '기타 가리기',
    unhide: '모두 보기', quit: 'Process GPT Lite 종료', file: '파일', close: '창 닫기',
    edit: '편집', undo: '실행 취소', redo: '실행 복귀', cut: '오려두기', copy: '복사하기', paste: '붙여넣기', selectAll: '모두 선택',
    view: '보기', reload: '새로 고침', forceReload: '강제로 새로 고침', actualSize: '실제 크기', zoomIn: '확대', zoomOut: '축소',
    fullscreen: '전체 화면', devtools: '개발자 도구',
    go: '이동', back: '뒤로', forward: '앞으로', chat: '채팅으로',
    window: '윈도우', minimize: '최소화', zoom: '확대/축소', front: '모두 앞으로 가져오기',
    help: '도움말', openInBrowser: '이 화면을 브라우저에서 열기', serverIs: (s) => `서버: ${s}`,
  },
  en: {
    about: 'About Process GPT Lite', server: 'Change Server…', services: 'Services', hide: 'Hide Process GPT Lite', hideOthers: 'Hide Others',
    unhide: 'Show All', quit: 'Quit Process GPT Lite', file: 'File', close: 'Close Window',
    edit: 'Edit', undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select All',
    view: 'View', reload: 'Reload', forceReload: 'Force Reload', actualSize: 'Actual Size', zoomIn: 'Zoom In', zoomOut: 'Zoom Out',
    fullscreen: 'Toggle Full Screen', devtools: 'Developer Tools',
    go: 'Go', back: 'Back', forward: 'Forward', chat: 'Go to Chat',
    window: 'Window', minimize: 'Minimize', zoom: 'Zoom', front: 'Bring All to Front',
    help: 'Help', openInBrowser: 'Open This Page in Browser', serverIs: (s) => `Server: ${s}`,
  },
}
const strings = (lang) => T[lang === 'en' ? 'en' : 'ko']

/**
 * h: { changeServer, reload, forceReload, back, forward, open(path), openInBrowser }
 * open(path): a page of the web app, under the server (/chat)
 */
function template({ lang, mac, dev, server, h }) {
  const t = strings(lang)
  const appMenu = {
    label: 'Process GPT Lite',
    submenu: [
      { label: t.about, role: 'about' },
      { type: 'separator' },
      { label: t.server, click: h.changeServer },
      { type: 'separator' },
      { label: t.services, role: 'services' },
      { type: 'separator' },
      { label: t.hide, role: 'hide' }, { label: t.hideOthers, role: 'hideOthers' }, { label: t.unhide, role: 'unhide' },
      { type: 'separator' },
      { label: t.quit, role: 'quit' },
    ],
  }
  const fileMenu = { label: t.file, submenu: [{ label: t.server, click: h.changeServer }, { type: 'separator' }, { label: t.quit, role: 'quit' }] }
  return [
    ...(mac ? [appMenu] : [fileMenu]),
    {
      label: t.edit,
      submenu: [
        { label: t.undo, role: 'undo' }, { label: t.redo, role: 'redo' }, { type: 'separator' },
        { label: t.cut, role: 'cut' }, { label: t.copy, role: 'copy' }, { label: t.paste, role: 'paste' }, { label: t.selectAll, role: 'selectAll' },
      ],
    },
    {
      label: t.view,
      submenu: [
        { label: t.reload, accelerator: 'CmdOrCtrl+R', click: h.reload },
        { label: t.forceReload, accelerator: 'Shift+CmdOrCtrl+R', click: h.forceReload },
        { type: 'separator' },
        { label: t.actualSize, role: 'resetZoom' }, { label: t.zoomIn, role: 'zoomIn' }, { label: t.zoomOut, role: 'zoomOut' },
        { type: 'separator' },
        { label: t.fullscreen, role: 'togglefullscreen' },
        ...(dev ? [{ type: 'separator' }, { label: t.devtools, role: 'toggleDevTools' }] : []),
      ],
    },
    {
      label: t.go,
      submenu: [
        { label: t.back, accelerator: mac ? 'Cmd+[' : 'Alt+Left', click: h.back },
        { label: t.forward, accelerator: mac ? 'Cmd+]' : 'Alt+Right', click: h.forward },
        { type: 'separator' },
        { label: t.chat, accelerator: 'CmdOrCtrl+1', click: () => h.open('/chat') },
      ],
    },
    {
      label: t.window,
      submenu: [
        { label: t.minimize, role: 'minimize' }, { label: t.zoom, role: 'zoom' },
        ...(mac ? [{ type: 'separator' }, { label: t.front, role: 'front' }] : [{ label: t.close, role: 'close' }]),
      ],
    },
    {
      label: t.help,
      role: 'help',
      submenu: [
        { label: t.openInBrowser, click: h.openInBrowser },
        ...(server ? [{ type: 'separator' }, { label: t.serverIs(server), enabled: false }] : []),
      ],
    },
  ]
}

module.exports = { template, strings }
