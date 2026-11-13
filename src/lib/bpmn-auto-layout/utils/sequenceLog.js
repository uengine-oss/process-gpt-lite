// Ported from Process GPT vue3 frontend — process-gpt/services/frontend/src/utils/sequenceLog.js @ 0e85995b.
// Copied as is for Lite's BPMN views (src/lib/bpmn-auto-layout/index.js); changes here are marked "Lite:".
/**
 * 시퀀스 플로우 라우팅 디버그 로그 버퍼.
 *
 * `sequence-flow-final-layouter.js` 등 자동 레이아웃 모듈이 라우팅 과정의
 * 장애물/도킹 정보를 남기는 데 사용한다. 콘솔을 직접 호출하지 않고 링 버퍼에
 * 모아두어, 필요할 때 {@link readSequenceLog} 로 한 번에 조회할 수 있다.
 *
 * 호출부 시그니처: `pushSequenceLog(level, tag, message)`
 *   - level: 'info' | 'warn' | 'error' | string
 *   - tag:   로그 분류 태그 (예: 'obstacle-bounds')
 *   - message: 문자열 메시지
 */

/** 링 버퍼 최대 길이 (초과분은 앞에서 제거). */
var MAX_SEQUENCE_LOG_ENTRIES = 2000;

/** true 면 push 시 콘솔에도 함께 출력한다. */
var SEQUENCE_LOG_ECHO_TO_CONSOLE = false;

var sequenceLogEntries = [];

/**
 * 로그 한 줄을 버퍼에 추가한다.
 * @param {string} level
 * @param {string} tag
 * @param {string} message
 */
export function pushSequenceLog(level, tag, message) {
    var entry = {
        level: level || 'info',
        tag: tag || '',
        message: message == null ? '' : String(message)
    };
    sequenceLogEntries.push(entry);
    if (sequenceLogEntries.length > MAX_SEQUENCE_LOG_ENTRIES) {
        sequenceLogEntries.splice(0, sequenceLogEntries.length - MAX_SEQUENCE_LOG_ENTRIES);
    }
    if (SEQUENCE_LOG_ECHO_TO_CONSOLE && typeof console !== 'undefined') {
        var fn =
            entry.level === 'error' && console.error ? console.error : entry.level === 'warn' && console.warn ? console.warn : console.log;
        if (fn) {
            fn.call(console, '[' + entry.tag + ']', entry.message);
        }
    }
    return entry;
}

/**
 * 현재까지 쌓인 로그 사본을 반환한다.
 * @returns {Array<{level:string, tag:string, message:string}>}
 */
export function readSequenceLog() {
    return sequenceLogEntries.map(function (e) {
        return { level: e.level, tag: e.tag, message: e.message };
    });
}

/** 버퍼를 비운다. */
export function clearSequenceLog() {
    sequenceLogEntries.length = 0;
}

/**
 * push 시 콘솔 echo 여부를 토글한다(디버깅 편의).
 * @param {boolean} v
 */
export function setSequenceLogConsoleEcho(v) {
    SEQUENCE_LOG_ECHO_TO_CONSOLE = !!v;
}
