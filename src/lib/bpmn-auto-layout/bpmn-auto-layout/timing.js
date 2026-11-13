// Ported from Process GPT vue3 frontend — process-gpt/services/frontend/src/components/autoLayout/bpmn-auto-layout/timing.js @ 0e85995b.
// Copied as is for Lite's BPMN views (src/lib/bpmn-auto-layout/index.js); changes here are marked "Lite:".
/**
 * 자동 레이아웃 타이밍 헬퍼.
 * 측정값은 window.__BPMN_LAYOUT_TIMINGS__ 에 누적되며 최대 200개까지만 보관한다.
 */

const globalRef = typeof window !== 'undefined' ? window : globalThis;

export function nowMs() {
    if (globalRef.performance && typeof globalRef.performance.now === 'function') {
        return globalRef.performance.now();
    }
    return Date.now();
}

export function pushLayoutTiming(kind, startMs, extra = {}) {
    const endMs = nowMs();
    const entry = {
        kind,
        startMs,
        endMs,
        durationMs: Math.round((endMs - startMs) * 100) / 100,
        timestamp: Date.now(),
        ...extra
    };
    if (!Array.isArray(globalRef.__BPMN_LAYOUT_TIMINGS__)) {
        globalRef.__BPMN_LAYOUT_TIMINGS__ = [];
    }
    globalRef.__BPMN_LAYOUT_TIMINGS__.push(entry);
    if (globalRef.__BPMN_LAYOUT_TIMINGS__.length > 200) {
        globalRef.__BPMN_LAYOUT_TIMINGS__.splice(0, globalRef.__BPMN_LAYOUT_TIMINGS__.length - 200);
    }
    return entry;
}
