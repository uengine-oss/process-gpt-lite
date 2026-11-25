// Voice dictation for the chat composer (Composer.vue) — the browser's own speech recognition (Web Speech API; Chrome's
// webkitSpeechRecognition), kept on until the person turns it off.
// 2026-11-24 사용자: 「채팅 입력 부분의 음성입력 부분이 누른상태면 계속 입력 받는걸로 해.. 목소리 끊겼다고 자동 발송하지말고..」
//   - Before: one recognition without `continuous` ended at the first pause, and the mic sat where the send button appears — the
//     first words turned it into ↑, so the next tap (to keep talking or to stop) sent the message.
//   - on: the person wants it on (a tap, or holding the mic down). Chrome ends a session after a pause (no-speech), after about a
//     minute, or on a network hiccup; while on, the next session starts by itself. Only the person turns it off — the mic again,
//     letting go of a held mic, sending, leaving the page — or an error that will not go away (no microphone permission, no speech
//     service: the desktop app's Chromium has none).
//   - Text: what was in the box when it started, then each final phrase appended (a space between them), then the phrase still being
//     heard. What the person types meanwhile is kept, and the next phrase goes after it.
//   - It never sends. Sending is the send button or Enter, and that cancels dictation first (nothing heard later comes back).
// Where the browser has no speech service (the desktop app, Firefox) the recognizer is the server's transcription
// (src/serverDictation.js, 2026-11-25): same events, final results only, and a longer wait after stop (its graceMs).
// No Vue here: server/test/dictation.test.js runs it in node with a fake recognizer and fake timers; Composer.vue keeps `state` in a
// reactive object through onChange.

// longer than this is a hold (push to talk: letting go stops); shorter is a tap (toggles)
export const HOLD_MS = 350
// a session that ends this soon without a word, this many times in a row: the service is not there — stop and say so
export const QUICK_END_MS = 1500
export const MAX_QUICK_ENDS = 3
// network errors tolerated in a row (a hiccup) before giving up
export const MAX_NETWORK = 2
// the desktop app: no 'start' this long after start() means its speech service does not answer (the app grants the mic itself, so
// this is not a permission prompt — in a browser it could be, and there is no such limit)
export const DESKTOP_START_MS = 8000
// after stop(), the recognizer gets this long to hand over its last phrase and end
export const STOP_GRACE_MS = 3000
export const ERROR_SHOW_MS = 8000

export const MESSAGES = {
  unsupported: '이 브라우저는 받아쓰기를 지원하지 않아요.',
  permission: '마이크를 쓸 수 없어요. 브라우저에서 이 사이트의 마이크 사용을 허용한 뒤 다시 눌러 주세요.',
  noMic: '마이크를 찾지 못했어요. 마이크가 연결되어 있는지 확인해 주세요.',
  network: '음성 인식 서비스에 닿지 못했어요. 인터넷 연결을 확인하고 다시 눌러 주세요.',
  service: '이 브라우저의 음성 인식 서비스를 쓸 수 없어요.',
  language: '이 브라우저는 한국어 받아쓰기를 지원하지 않아요.',
  stuck: '받아쓰기가 자꾸 끊겨요. 잠시 뒤 다시 눌러 주세요.',
  server: '받아쓰기 서버가 응답하지 않아요. 잠시 뒤 다시 눌러 주세요.',
  desktop: '데스크톱 앱에서는 음성 인식 서비스에 닿지 못했어요. 브라우저에서 열거나 운영체제의 받아쓰기를 써 주세요.',
  other: '받아쓰기가 멈췄어요. 다시 눌러 주세요.',
}

export const recognizerOf = (w) => (w && (w.SpeechRecognition || w.webkitSpeechRecognition)) || null

// a space between what is there and the next phrase, unless one side already has one (Chrome starts later phrases with a space)
export function joinSpeech(a, b) {
  const x = a || '', y = b || ''
  if (!x || !y) return x + y
  return /\s$/.test(x) || /^\s/.test(y) ? x + y : `${x} ${y}`
}

// letting go of the mic: wasOn — it was listening before this press; heldMs — how long it was down.
// A tap on an idle mic leaves it on; a hold (push to talk) and any press on a listening mic turn it off.
export const pressOutcome = (wasOn, heldMs, holdMs = HOLD_MS) => (wasOn || heldMs >= holdMs ? 'stop' : 'keep')

/**
 * @param {object} o
 * @param {Function} o.Recognition  SpeechRecognition constructor
 * @param {() => string} o.read      the box's text now
 * @param {(v: string) => void} o.write  put text in the box
 * @param {(s: {on: boolean, phase: 'off'|'starting'|'listening', error: string}) => void} [o.onChange]
 * @param {boolean|(() => boolean)} [o.desktop]  the desktop app (html.pgl-desktop)
 */
export function createDictation({ Recognition, read, write, onChange = () => {}, lang = 'ko-KR', desktop = false, timers = globalThis, now = () => Date.now() }) {
  const state = { on: false, phase: 'off', error: '' }
  const isDesktop = () => (typeof desktop === 'function' ? !!desktop() : !!desktop)
  let rec = null            // the recognizer of the session now
  let started = false       // it said 'start'
  let startedAt = 0
  let heard = false         // it gave a result
  let committed = ''        // the box's text before the phrase being heard
  let written = ''          // what this last put in the box (anything else there was typed by the person)
  let used = 0              // results of this session already in `committed`
  let seen = 0              // results the last event of this session had
  let quick = 0             // sessions in a row that ended quickly without a word
  let net = 0               // network errors in a row
  let pressAt = 0, pressWasOn = false, pressing = false
  const timer = { start: null, restart: null, grace: null, error: null }

  const emit = (patch) => { Object.assign(state, patch); onChange({ ...state }) }
  const clear = (k) => { if (timer[k]) { timers.clearTimeout(timer[k]); timer[k] = null } }
  const clearAll = () => { for (const k of ['start', 'restart', 'grace']) clear(k) }
  const put = (v) => { written = v; write(v) }

  // stop listening to a recognizer: its later events are not ours (rec !== r)
  function drop(abort) {
    const r = rec
    rec = null
    if (!r) return
    for (const h of ['onstart', 'onaudiostart', 'onresult', 'onerror', 'onend']) r[h] = null
    if (abort) { try { r.abort() } catch { /* already ended */ } }
  }

  function begin() {
    clear('restart')
    if (!state.on) return
    let r
    try { r = new Recognition() } catch { return fail(MESSAGES.service) }
    r.lang = lang
    r.continuous = true
    r.interimResults = true
    r.maxAlternatives = 1
    rec = r
    started = false
    heard = false
    used = 0
    seen = 0
    startedAt = now()
    const mine = (fn) => (e) => { if (rec === r) fn(e || {}) }
    r.onstart = r.onaudiostart = mine(() => {
      started = true
      clear('start')
      if (state.on && state.phase !== 'listening') emit({ phase: 'listening' })
    })
    r.onresult = mine(onResult)
    r.onerror = mine(onError)
    r.onend = mine(onEnd)
    if (isDesktop()) timer.start = timers.setTimeout(() => { if (rec === r && !started) fail(MESSAGES.desktop) }, DESKTOP_START_MS)
    try { r.start() } catch { fail(isDesktop() ? MESSAGES.desktop : MESSAGES.service) }
  }

  function onResult(e) {
    const results = e.results || []
    // the person typed since this last wrote: keep their text, with what was shown of this session in it
    const inBox = read()
    if (inBox !== written) { committed = inBox; used = Math.max(used, seen) }
    while (used < results.length && results[used]?.isFinal) { committed = joinSpeech(committed, results[used][0]?.transcript || ''); used++ }
    let hearing = ''
    for (let i = used; i < results.length; i++) hearing = joinSpeech(hearing, results[i]?.[0]?.transcript || '')
    seen = results.length
    if (results.length) { heard = true; net = 0; quick = 0 }
    put(joinSpeech(committed, hearing))
  }

  function onError(e) {
    switch (e.error) {
      case 'no-speech': return              // a pause: the session ends and the next one starts
      case 'aborted': return                // something else took the mic: the next session tries again (quick ends stop a loop)
      case 'network':
        if (isDesktop()) return fail(MESSAGES.desktop)
        if (++net > MAX_NETWORK) return fail(MESSAGES.network)
        return                              // a hiccup: the next session tries again
      case 'not-allowed': return fail(MESSAGES.permission)
      case 'service-not-allowed': return fail(isDesktop() ? MESSAGES.desktop : MESSAGES.service)
      case 'audio-capture': return fail(MESSAGES.noMic)
      case 'language-not-supported': return fail(MESSAGES.language)
      // the server's transcription (serverDictation.js) could not write a piece down: its reason
      case 'server': return fail(e.message || MESSAGES.server)
      default: return fail(MESSAGES.other)
    }
  }

  function onEnd() {
    clear('start')
    clear('grace')
    // what was shown stays — the phrase still being heard too (Chrome usually makes it final first, not always)
    committed = read()
    written = committed
    const quickEnd = !heard && now() - startedAt < QUICK_END_MS
    rec = null
    if (!state.on) { if (state.phase !== 'off') emit({ phase: 'off' }); return }
    quick = quickEnd ? quick + 1 : 0
    if (quick >= MAX_QUICK_ENDS) return fail(isDesktop() ? MESSAGES.desktop : MESSAGES.stuck)
    // on: the next session — at once after a pause, a little later after a quick end (not a hot loop)
    timer.restart = timers.setTimeout(begin, quick ? 250 * quick : 0)
  }

  function fail(msg) {
    clearAll()
    drop(true)
    clear('error')
    emit({ on: false, phase: 'off', error: msg })
    timer.error = timers.setTimeout(() => { timer.error = null; if (state.error === msg) emit({ error: '' }) }, ERROR_SHOW_MS)
  }

  function start() {
    if (state.on) return
    clear('error')
    quick = 0
    net = 0
    committed = read()
    written = committed
    // a recognizer still handing over its last phrase after stop(): its words are not lost, it just is not listened to any longer
    if (rec) drop(true)
    emit({ on: true, phase: 'starting', error: '' })
    begin()
  }

  // the person turned it off: the last phrase may still come (it is kept), then it ends
  function stop() {
    if (!state.on && !rec) return
    clear('restart')
    clear('start')
    emit({ on: false })
    const r = rec
    if (!r) { emit({ phase: 'off' }); return }
    try { r.stop() } catch { drop(true); emit({ phase: 'off' }); return }
    // (the server's recognizer sends the last piece only now: it waits longer — its graceMs)
    timer.grace = timers.setTimeout(() => { if (rec === r) { drop(true); emit({ phase: 'off' }) } }, r.graceMs || STOP_GRACE_MS)
  }

  // sending (or leaving the page): off at once, and nothing heard later is written
  function cancel() {
    pressing = false
    clearAll()
    drop(true)
    if (state.on || state.phase !== 'off') emit({ on: false, phase: 'off' })
  }

  const toggle = () => (state.on ? stop() : start())
  // the mic button: pointer down starts at once (push to talk hears the first word), letting go decides (pressOutcome)
  function press() {
    pressing = true
    pressAt = now()
    pressWasOn = state.on
    if (!state.on) start()
  }
  function release() {
    if (!pressing) return
    pressing = false
    if (pressOutcome(pressWasOn, now() - pressAt) === 'stop') stop()
  }

  return { state, start, stop, cancel, toggle, press, release, get on() { return state.on } }
}
