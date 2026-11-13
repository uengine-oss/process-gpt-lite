// Ported from Process GPT vue3 frontend — process-gpt/services/frontend/src/components/autoLayout/sequence-flow/obstacle-spatial-index.js @ 0e85995b.
// Copied as is for Lite's BPMN views (src/lib/bpmn-auto-layout/index.js); changes here are marked "Lite:".
/**
 * 자동 레이아웃 1 패스 동안 사용할 도형(장애물) 공간 인덱스.
 *
 * 알고리즘: Grid bucketing.
 * - 캔버스를 CELL_SIZE 픽셀 셀로 나눔.
 * - 각 도형(rect)이 차지하는 셀에 해당 element 를 등록.
 * - segment / rect 쿼리 시 대상 영역과 겹치는 셀의 element 만 회수.
 *
 * yFiles 의 R-tree 를 단순화한 구조이며 BPMN 캔버스 규모(보통 수십~수백 도형)에서
 * obstacle 검사 비용을 O(N×M) → O(N×k) 로 낮춘다 (k = segment 가 걸친 셀의 element 평균 수).
 *
 * 인덱스는 한 자동 레이아웃 호출 동안만 유효하며 BpmnAutoLayout.applyAutoLayout 시작 시 build,
 * 끝에 dispose 한다. 인덱스가 없으면 호출자는 기존 fallback 경로 (전체 elementRegistry 순회) 로 동작.
 */

const CELL_SIZE = 120;

function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
}

export class ObstacleSpatialIndex {
    constructor() {
        this._buckets = new Map();
        this._allElements = [];
        this._size = 0;
        // perf B: ancestor (Participant / Lane) 결과 캐시.
        // BPMN tree 구조는 한 layout pass 동안 변하지 않으므로 안전.
        this.ancestorCache = new WeakMap();
    }

    _key(cx, cy) {
        return cx + ',' + cy;
    }

    _addToCell(cx, cy, el) {
        const k = this._key(cx, cy);
        let bucket = this._buckets.get(k);
        if (!bucket) {
            bucket = [];
            this._buckets.set(k, bucket);
        }
        bucket.push(el);
    }

    /**
     * 노드 이동 후 cell 위치를 fresh 좌표로 다시 계산.
     * ancestorCache 는 parent 관계가 변하지 않으므로 보존한다.
     */
    rebuild(elements) {
        this._buckets.clear();
        this._size = 0;
        this._allElements = [];
        // ancestorCache 그대로 유지
        this.build(elements);
    }

    /**
     * @param {Array} elements 등록할 도형 배열 (el.x/y/width/height 필요)
     */
    build(elements) {
        if (!Array.isArray(elements)) return;
        this._allElements = elements;
        this._size = elements.length;
        for (let i = 0; i < elements.length; i++) {
            const el = elements[i];
            if (!el) continue;
            const x = el.x;
            const y = el.y;
            const w = el.width;
            const h = el.height;
            if (typeof x !== 'number' || typeof y !== 'number' || typeof w !== 'number' || typeof h !== 'number') {
                continue;
            }
            const cx0 = Math.floor(x / CELL_SIZE);
            const cy0 = Math.floor(y / CELL_SIZE);
            const cx1 = Math.floor((x + w) / CELL_SIZE);
            const cy1 = Math.floor((y + h) / CELL_SIZE);
            for (let cx = cx0; cx <= cx1; cx++) {
                for (let cy = cy0; cy <= cy1; cy++) {
                    this._addToCell(cx, cy, el);
                }
            }
        }
    }

    /** 주어진 직사각형(검색 영역) 과 겹치는 도형들 (중복 제거 후) */
    queryRect(x, y, w, h) {
        if (this._size === 0) return [];
        const cx0 = Math.floor(x / CELL_SIZE);
        const cy0 = Math.floor(y / CELL_SIZE);
        const cx1 = Math.floor((x + w) / CELL_SIZE);
        const cy1 = Math.floor((y + h) / CELL_SIZE);
        const seen = new Set();
        const result = [];
        for (let cx = cx0; cx <= cx1; cx++) {
            for (let cy = cy0; cy <= cy1; cy++) {
                const bucket = this._buckets.get(this._key(cx, cy));
                if (!bucket) continue;
                for (let i = 0; i < bucket.length; i++) {
                    const el = bucket[i];
                    if (seen.has(el)) continue;
                    seen.add(el);
                    result.push(el);
                }
            }
        }
        return result;
    }

    /** segment(ax,ay → bx,by) 의 bbox 와 겹치는 도형들 + 추가 padding */
    querySegment(ax, ay, bx, by, padPx) {
        const pad = Math.max(0, padPx || 0);
        const minX = Math.min(ax, bx) - pad;
        const minY = Math.min(ay, by) - pad;
        const maxX = Math.max(ax, bx) + pad;
        const maxY = Math.max(ay, by) + pad;
        return this.queryRect(minX, minY, maxX - minX, maxY - minY);
    }

    size() {
        return this._size;
    }

    /** 등록된 모든 element (필터되지 않은 원본 리스트) */
    allElements() {
        return this._allElements;
    }
}

// ─── 모듈-레벨 active 인덱스 ─────────────────────────────────────────────────

let activeIndex = null;

export function setActiveObstacleSpatialIndex(index) {
    activeIndex = index || null;
}

export function getActiveObstacleSpatialIndex() {
    return activeIndex;
}

export function clearActiveObstacleSpatialIndex() {
    activeIndex = null;
}
