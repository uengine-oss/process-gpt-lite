// Ported from Process GPT vue3 frontend — process-gpt/services/frontend/src/components/autoLayout/sequence-flow-final-layouter.js @ 0e85995b.
// Copied as is for Lite's BPMN views (src/lib/bpmn-auto-layout/index.js); changes here are marked "Lite:".
/**
 * 시퀀스 플로우 계산의 단일 호스트.
 *
 * 설계: yFiles **문서 개념만** 참고(직교 라우터·스테이지·최소간격 등). yWorks 라이브러리는 사용하지 않음.
 * 스펙: `docs/superpowers/specs/2026-04-13-sequence-flow-routing-design.md` — **§ 후보 풀 + 2단계 점수**에 목표 아키텍처(P1 facing / P2 path)가 정리됨.
 *
 * 파이프라인 요약 (현 구현 — S-* 연쇄):
 * - S-In: 입력 웨이포인트
 * - S-FacingSnap / S-ObstacleReroute: `computeFinalSequenceFlowWaypoints` 옵션으로 선택
 * - S-OrthoManhattan: `applyOrthogonalManhattanSequenceFlow` (직교·nudge·participant 클램프·계단 제거)
 * - S-Loop: 직교(C-Ortho)·장애물(C-NoRun과 연계)·도킹(C-Dock) 만족까지 반복 (`MAX_ORTHO_OBSTACLE_OUTER_PASSES`)
 * - S-Parallel: `applyParallelSequenceFlowSeparation` (별도 호출, 보조·약화)
 *
 * 목표 구조 (스펙과 동일 용어; 리팩터링 시 이 타입으로 수렴):
 * - **P1** `ConnectionRoutingFacingCandidate`: 소스/타깃 **면(facing) 조합** `(sourceExitSide, targetEntrySide)` + `phase1Score`.
 *   후보는 `l|t|r|b` 유한 집합. 점수: 기하(예: 타깃이 소스 왼쪽 위면 좌·상 출발 선호), 흐름 방향, near-column·multi-incoming 정렬 등.
 * - **P2** `ConnectionRoutingPathCandidate`: P1에서 고른 조합(또는 상위 k개)마다 **직교 웨이포인트 배열** + `phase2Score`.
 *   비용: `scoreDetourCandidatePath`, 장애물 교차, participant, 백트래킹 스파이크(`collapseOrthogonalBacktrackSpikes`), 필요 시 평행 분리와 합성.
 * - **선택**: `totalScore = phase2Score` 위주, 동점 시 `phase1Score` 타이브레이크; P2 infeasible이면 해당 조합 탈락.
 *
 * **P1**은 `applyOrthogonalManhattanSequenceFlow` 초기 단계에서(`!shortLink`일 때) `pickBestFacingCandidate`로 **도킹 쪽(sourceExitSide / targetEntrySide)** 을 정한다. **P2**(경로 후보·2차 점수)는 아직 미연동.
 *
 * @typedef {{ sourceExitSide: 'l'|'r'|'t'|'b', targetEntrySide: 'l'|'r'|'t'|'b', phase1Score: number, meta?: Record<string, unknown> }} ConnectionRoutingFacingCandidate
 * @typedef {{ facing: ConnectionRoutingFacingCandidate, waypoints: Array<{x:number,y:number}>, phase2Score: number, feasible: boolean }} ConnectionRoutingPathCandidate
 *
 * 다른 파일은 가능하면 이 모듈의 export 만 사용한다.
 */
import inherits from 'inherits-browser';

import BaseLayouter from 'diagram-js/lib/layout/BaseLayouter';
import BpmnLayouter from 'bpmn-js/lib/features/modeling/BpmnLayouter';

import { withoutRedundantPoints } from 'diagram-js/lib/layout/ManhattanLayout';
import { getMid } from 'diagram-js/lib/layout/LayoutUtil';

import { is } from 'bpmn-js/lib/util/ModelUtil';
import { isDirectionHorizontal } from 'bpmn-js/lib/features/modeling/util/ModelingUtil';

import { pushSequenceLog } from './utils/sequenceLog.js'; // Lite: was '../../utils/sequenceLog' (vue3 src/utils/sequenceLog.js)
import { getActiveObstacleSpatialIndex } from './sequence-flow/obstacle-spatial-index.js';

/** obstacle-bounds / obstacle-bounds-gfx 스냅샷 (전역 플래그 대신 이 상수만 수정) */
var LOG_SEQUENCE_FLOW_OBSTACLE_ELEMENT_BOUNDS = true;
/** true면 매 연결마다 스냅샷, false면 세션당 1회 */
var LOG_SEQUENCE_FLOW_OBSTACLE_ELEMENT_BOUNDS_REPEAT = false;

var OBSTACLE_ROUTER_ORTHO_EPS = 1e-4;
var TWO_BEND_DIAGONAL_MIN_PX = 28;
var FACING_DOMINANT_AXIS_RATIO = 1.35;
export var SEQUENCE_FLOW_OBSTACLE_SEGMENT_CLEARANCE_PX = 12;
var OBSTACLE_SEGMENT_CLEARANCE_PX = SEQUENCE_FLOW_OBSTACLE_SEGMENT_CLEARANCE_PX;
export var SEQUENCE_FLOW_OBSTACLE_HIT_CLEARANCE_PX = 2;
export var SEQUENCE_FLOW_OBSTACLE_DETOUR_CLEARANCE_PX = 6;
export var SEQUENCE_FLOW_OBSTACLE_DETOUR_EXTRA_PX = 4;
var MAX_OBSTACLE_REROUTE_LENGTH_RATIO = 4;
var OBSTACLE_ROUTER_LOCAL_PAD_PX = 120;

/**
 * BpmnLayouter.repairConnection·크롭 입력 waypoint 수 상한. 초과 시 맨해튼이 비정상·폭주할 수 있음.
 * 끝 두 점만 넘기면 연결 polyline이 직선이 되어 도킹/교차·직교 재계산이 무너져 대각선이 나올 수 있어,
 * {@link decimateWaypointsToMax}로 균등 샘플링한다.
 */
export var MAX_BPMN_DELEGATE_WAYPOINT_HINT = 40;

/**
 * waypoint 개수만 상한으로 줄이고, 시작·끝은 원본 그대로 유지한다(인덱스 균등 샘플).
 * @param {Array<{x:number,y:number}>} waypoints
 * @param {number} max
 * @returns {Array<{x:number,y:number}>}
 */
export function decimateWaypointsToMax(waypoints, max) {
    if (!Array.isArray(waypoints) || waypoints.length <= max) {
        return waypoints.slice();
    }
    var n = waypoints.length;
    var m = Math.max(2, Math.min(max, n));
    var out = [];
    var denom = m - 1;
    for (var k = 0; k < m; k++) {
        var idx = Math.round((k / denom) * (n - 1));
        out.push(waypoints[idx]);
    }
    var deduped = [out[0]];
    for (var i = 1; i < out.length; i++) {
        var prev = deduped[deduped.length - 1];
        var cur = out[i];
        if (prev.x !== cur.x || prev.y !== cur.y) {
            deduped.push(cur);
        }
    }
    if (deduped.length < 2) {
        return [waypoints[0], waypoints[n - 1]];
    }
    return deduped;
}

var sequenceFlowImportLayoutActive = false;

export function setSequenceFlowImportLayoutActive(v) {
    sequenceFlowImportLayoutActive = !!v;
}

export function isSequenceFlowImportLayoutActive() {
    return sequenceFlowImportLayoutActive;
}

function axisRange1D(lo, hi) {
    return { lo: lo, hi: hi };
}

function bbox1DOverlap(a, b) {
    return !(a.hi < b.lo || b.hi < a.lo);
}

var SOURCE_TO_TARGET_OPPOSITE_SIDE = { l: 'r', r: 'l', t: 'b', b: 't' };
var FACING_HEMISPHERE_EPS = 1e-3;

export function clampSequenceFacingSidesTowardTarget(source, target, sourceSide, targetSide) {
    var sm = getMid(source);
    var tm = getMid(target);
    var dx = tm.x - sm.x;
    var dy = tm.y - sm.y;
    var sw = source.width || 0;
    var sh = source.height || 0;
    var tw = target.width || 0;
    var th = target.height || 0;
    var EPS = FACING_HEMISPHERE_EPS;

    var sL = source.x;
    var sR = source.x + sw;
    var tL = target.x;
    var tR = target.x + tw;
    var sT = source.y;
    var sB = source.y + sh;
    var tT = target.y;
    var tB = target.y + th;

    var bboxTargetEntirelyLeft = tR <= sL + EPS;
    var bboxTargetEntirelyRight = tL >= sR - EPS;
    var bboxTargetEntirelyAbove = tB <= sT + EPS;
    var bboxTargetEntirelyBelow = tT >= sB - EPS;

    var centerLeft = dx < -EPS;
    var centerRight = dx > EPS;
    if (Math.abs(dx) <= EPS) {
        if (bboxTargetEntirelyLeft) {
            centerLeft = true;
            centerRight = false;
        } else if (bboxTargetEntirelyRight) {
            centerLeft = false;
            centerRight = true;
        } else {
            centerLeft = tR < sm.x - EPS;
            centerRight = tL > sm.x + EPS;
        }
    }

    if (centerLeft || bboxTargetEntirelyLeft) {
        if (sourceSide === 'r') {
            sourceSide = 'l';
        }
    }
    if (centerRight || bboxTargetEntirelyRight) {
        if (sourceSide === 'l') {
            sourceSide = 'r';
        }
    }

    var centerAbove = dy < -EPS;
    var centerBelow = dy > EPS;
    if (Math.abs(dy) <= EPS) {
        if (bboxTargetEntirelyAbove) {
            centerAbove = true;
            centerBelow = false;
        } else if (bboxTargetEntirelyBelow) {
            centerAbove = false;
            centerBelow = true;
        } else {
            centerAbove = tB < sm.y - EPS;
            centerBelow = tT > sm.y + EPS;
        }
    }

    if (centerAbove || bboxTargetEntirelyAbove) {
        if (sourceSide === 'b') {
            sourceSide = 't';
        }
    }
    if (centerBelow || bboxTargetEntirelyBelow) {
        if (sourceSide === 't') {
            sourceSide = 'b';
        }
    }

    var pair = SOURCE_TO_TARGET_OPPOSITE_SIDE[sourceSide];
    if (pair) {
        targetSide = pair;
    }

    return { sourceSide: sourceSide, targetSide: targetSide };
}

function computeSequenceFacingSides(source, target, layoutHorizontal) {
    var sm = getMid(source);
    var tm = getMid(target);
    var dx = tm.x - sm.x;
    var dy = tm.y - sm.y;
    var adx = Math.abs(dx);
    var ady = Math.abs(dy);
    var sourceSide;
    var targetSide;

    var sw = source.width || 0;
    var sh = source.height || 0;
    var tw = target.width || 0;
    var th = target.height || 0;
    var yOv = bbox1DOverlap(axisRange1D(source.y, source.y + sh), axisRange1D(target.y, target.y + th));
    var xOv = bbox1DOverlap(axisRange1D(source.x, source.x + sw), axisRange1D(target.x, target.x + tw));

    var diagonal = adx >= TWO_BEND_DIAGONAL_MIN_PX && ady >= TWO_BEND_DIAGONAL_MIN_PX;

    if (diagonal) {
        if (layoutHorizontal) {
            sourceSide = dx >= 0 ? 'r' : 'l';
            targetSide = dx >= 0 ? 'l' : 'r';
        } else {
            sourceSide = dy >= 0 ? 'b' : 't';
            targetSide = dy >= 0 ? 't' : 'b';
        }
    } else if (yOv && adx > 1e-3) {
        if (adx >= ady) {
            sourceSide = dx >= 0 ? 'r' : 'l';
            targetSide = dx >= 0 ? 'l' : 'r';
        } else if (ady > adx * FACING_DOMINANT_AXIS_RATIO) {
            sourceSide = dy >= 0 ? 'b' : 't';
            targetSide = dy >= 0 ? 't' : 'b';
        } else {
            sourceSide = dx >= 0 ? 'r' : 'l';
            targetSide = dx >= 0 ? 'l' : 'r';
        }
    } else if (xOv && ady > 1e-3) {
        if (ady >= adx) {
            sourceSide = dy >= 0 ? 'b' : 't';
            targetSide = dy >= 0 ? 't' : 'b';
        } else if (adx > ady * FACING_DOMINANT_AXIS_RATIO) {
            sourceSide = dx >= 0 ? 'r' : 'l';
            targetSide = dx >= 0 ? 'l' : 'r';
        } else {
            sourceSide = dy >= 0 ? 'b' : 't';
            targetSide = dy >= 0 ? 't' : 'b';
        }
    } else if (layoutHorizontal && adx * 1.2 >= ady) {
        if (adx >= ady) {
            sourceSide = dx >= 0 ? 'r' : 'l';
            targetSide = dx >= 0 ? 'l' : 'r';
        } else if (ady > adx * FACING_DOMINANT_AXIS_RATIO) {
            sourceSide = dy >= 0 ? 'b' : 't';
            targetSide = dy >= 0 ? 't' : 'b';
        } else {
            sourceSide = dx >= 0 ? 'r' : 'l';
            targetSide = dx >= 0 ? 'l' : 'r';
        }
    } else if (!layoutHorizontal && ady * 1.2 >= adx) {
        if (ady >= adx) {
            sourceSide = dy >= 0 ? 'b' : 't';
            targetSide = dy >= 0 ? 't' : 'b';
        } else if (adx > ady * FACING_DOMINANT_AXIS_RATIO) {
            sourceSide = dx >= 0 ? 'r' : 'l';
            targetSide = dx >= 0 ? 'l' : 'r';
        } else {
            sourceSide = dy >= 0 ? 'b' : 't';
            targetSide = dy >= 0 ? 't' : 'b';
        }
    } else if (adx >= ady) {
        sourceSide = dx >= 0 ? 'r' : 'l';
        targetSide = dx >= 0 ? 'l' : 'r';
    } else {
        sourceSide = dy >= 0 ? 'b' : 't';
        targetSide = dy >= 0 ? 't' : 'b';
    }

    return clampSequenceFacingSidesTowardTarget(source, target, sourceSide, targetSide);
}

function getShapeType(shape) {
    if (!shape) {
        return '';
    }
    return String(shape.type || (shape.businessObject && shape.businessObject.$type) || '');
}

function isBoundaryAwareGateway(shape) {
    return getShapeType(shape).indexOf('Gateway') !== -1;
}

function isBoundaryAwareEvent(shape) {
    return getShapeType(shape).indexOf('Event') !== -1;
}

function makeDockingPoint(x, y) {
    return { x: x, y: y, original: { x: x, y: y } };
}

/**
 * Dock 위치가 도형 꼭지점에 붙지 않도록 sideOffset 을 가장자리 안쪽으로 클램프.
 *
 * - 가장자리 길이의 절반(halfDim) 에서 코너 마진만큼 안쪽까지만 허용.
 * - 노드 변이 너무 짧으면 (마진의 2배보다 작음) 마진을 자동 축소해서 최소 1px 여유 보장.
 *
 * 사용자 요청: "연결 위치가 박스 꼭지점에 붙는 건 금지".
 */
// 코너 클램프 마진 (10 → 14 강화). 노드 변이 짧으면 자동 축소.
var DOCK_CORNER_MARGIN_PX = 14;

function clampDockOffsetAwayFromCorners(offset, halfDim) {
    var margin = DOCK_CORNER_MARGIN_PX;
    if (halfDim <= margin) {
        margin = Math.max(1, halfDim * 0.3);
    }
    var maxAbs = halfDim - margin;
    if (maxAbs <= 0) return offset;
    if (offset > maxAbs) return maxAbs;
    if (offset < -maxAbs) return -maxAbs;
    return offset;
}

export function dockingPointOnShapeBoundary(shape, side, sideOffset) {
    if (!shape || !side) {
        return null;
    }
    var x1 = shape.x || 0;
    var y1 = shape.y || 0;
    var w = shape.width || 0;
    var h = shape.height || 0;
    var m = getMid(shape);
    var cx = m.x;
    var cy = m.y;
    var hw = w / 2;
    var hh = h / 2;
    var offset = typeof sideOffset === 'number' ? sideOffset : 0;

    if (isBoundaryAwareGateway(shape)) {
        if (side === 'l' || side === 'r') {
            var dy = clampDockOffsetAwayFromCorners(clamp(offset, -hh, hh), hh);
            var gatewayX = cx + (side === 'r' ? 1 : -1) * hw * (1 - Math.abs(dy) / Math.max(hh, 1));
            return makeDockingPoint(gatewayX, cy + dy);
        }
        var dx = clampDockOffsetAwayFromCorners(clamp(offset, -hw, hw), hw);
        var gatewayY = cy + (side === 'b' ? 1 : -1) * hh * (1 - Math.abs(dx) / Math.max(hw, 1));
        return makeDockingPoint(cx + dx, gatewayY);
    }

    if (isBoundaryAwareEvent(shape)) {
        if (side === 'l' || side === 'r') {
            var eventDy = clampDockOffsetAwayFromCorners(clamp(offset, -hh, hh), hh);
            var eventRxFactor = hh > 0 ? Math.max(0, 1 - (eventDy * eventDy) / (hh * hh)) : 0;
            var eventX = cx + (side === 'r' ? 1 : -1) * hw * Math.sqrt(eventRxFactor);
            return makeDockingPoint(eventX, cy + eventDy);
        }
        var eventDx = clampDockOffsetAwayFromCorners(clamp(offset, -hw, hw), hw);
        var eventRyFactor = hw > 0 ? Math.max(0, 1 - (eventDx * eventDx) / (hw * hw)) : 0;
        var eventY = cy + (side === 'b' ? 1 : -1) * hh * Math.sqrt(eventRyFactor);
        return makeDockingPoint(cx + eventDx, eventY);
    }

    if (side === 'r') {
        var rOffset = clampDockOffsetAwayFromCorners(offset, hh);
        return makeDockingPoint(x1 + w, cy + rOffset);
    }
    if (side === 'l') {
        var lOffset = clampDockOffsetAwayFromCorners(offset, hh);
        return makeDockingPoint(x1, cy + lOffset);
    }
    if (side === 'b') {
        var bOffset = clampDockOffsetAwayFromCorners(offset, hw);
        return makeDockingPoint(cx + bOffset, y1 + h);
    }
    var tOffset = clampDockOffsetAwayFromCorners(offset, hw);
    return makeDockingPoint(cx + tOffset, y1);
}

function dockingPointOnSideMid(shape, side) {
    return dockingPointOnShapeBoundary(shape, side, 0);
}

var FACING_AXIS_SIDES = ['l', 'r', 't', 'b'];
var P1_FACING_TOP_K = 3;
var ROUTE_ENGINE_REDUCED_OUTER_PASSES = 3;
var ROUTE_ENGINE_DEBUG_KEY = '__BPMN_ROUTE_ENGINE_DEBUG_METRICS__';

function getRouteEngineDebugStore() {
    var g = typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : {};
    if (!Array.isArray(g[ROUTE_ENGINE_DEBUG_KEY])) {
        g[ROUTE_ENGINE_DEBUG_KEY] = [];
    }
    return g[ROUTE_ENGINE_DEBUG_KEY];
}

export function resetRouteEngineDebugMetrics() {
    var store = getRouteEngineDebugStore();
    store.length = 0;
}

export function readRouteEngineDebugMetrics() {
    return getRouteEngineDebugStore().map(function (entry) {
        return Object.assign({}, entry);
    });
}

function pushRouteEngineDebugMetric(entry) {
    var store = getRouteEngineDebugStore();
    store.push(Object.assign({}, entry));
    if (store.length > 200) {
        store.splice(0, store.length - 200);
    }
}

/**
 * P1 1차 점수: 기존 `computeSequenceFacingSides`와 동일한 조합은 0(최우선), 그 외는 변 중점 간 맨해튼 거리(낮을수록 유리).
 *
 * @param {'l'|'r'|'t'|'b'} sourceExitSide
 * @param {'l'|'r'|'t'|'b'} targetEntrySide
 * @param {{ sourceSide: string, targetSide: string }|null} primaryPair — `computeSequenceFacingSides` 결과; 없으면 거리만 사용
 * @returns {number}
 */
export function scoreFacingCandidatePhase1(sourceExitSide, targetEntrySide, source, target, primaryPair) {
    if (primaryPair && sourceExitSide === primaryPair.sourceSide && targetEntrySide === primaryPair.targetSide) {
        return 0;
    }
    var a = dockingPointOnSideMid(source, sourceExitSide);
    var b = dockingPointOnSideMid(target, targetEntrySide);
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/**
 * P1: 소스 출발 변 × 타깃 진입 변 후보(유한) + 1차 점수.
 * - 1순위: `computeSequenceFacingSides`(레이아웃 방향 반영)와 일치하는 조합 → phase1Score 0
 * - 추가: 축 l/r/t/b 각각에 대해 `clampSequenceFacingSidesTowardTarget` 로 기하 보정한 조합을 합친 뒤 중복 제거·점수순 정렬
 *
 * 주의: 아직 `applyOrthogonalManhattanSequenceFlow` 입력으로 연결되지 않음(다음 단계 P2·배선 선택).
 *
 * @param {{ horizontalLayout?: boolean }} [options]
 * @returns {Array<ConnectionRoutingFacingCandidate & { meta?: { kind: string, from?: string } }}>}
 */
export function enumerateSequenceFlowFacingCandidates(source, target, elementRegistry, options) {
    options = options || {};
    var layoutHorizontal =
        typeof options.horizontalLayout === 'boolean'
            ? options.horizontalLayout
            : !!(target && elementRegistry && isDirectionHorizontal(target, elementRegistry));

    var primary = computeSequenceFacingSides(source, target, layoutHorizontal);
    var seen = Object.create(null);
    var out = [];

    function pushCandidate(ss, ts, meta) {
        var k = ss + '|' + ts;
        if (seen[k]) {
            return;
        }
        seen[k] = true;
        out.push({
            sourceExitSide: ss,
            targetEntrySide: ts,
            phase1Score: scoreFacingCandidatePhase1(ss, ts, source, target, primary),
            meta: meta
        });
    }

    pushCandidate(primary.sourceSide, primary.targetSide, { kind: 'primary' });

    for (var i = 0; i < FACING_AXIS_SIDES.length; i++) {
        var s0 = FACING_AXIS_SIDES[i];
        var opp = SOURCE_TO_TARGET_OPPOSITE_SIDE[s0];
        var cl = clampSequenceFacingSidesTowardTarget(source, target, s0, opp);
        pushCandidate(cl.sourceSide, cl.targetSide, { kind: 'axisProbe', from: s0 });
    }

    out.sort(function (a, b) {
        var d = a.phase1Score - b.phase1Score;
        if (d !== 0) {
            return d;
        }
        var ka = String(a.sourceExitSide) + String(a.targetEntrySide);
        var kb = String(b.sourceExitSide) + String(b.targetEntrySide);
        return ka.localeCompare(kb);
    });

    return out;
}

/**
 * P1 결과에서 1차 점수가 가장 낮은 면 조합 하나(동점 시 정렬 안정).
 *
 * @returns {ConnectionRoutingFacingCandidate|null}
 */
export function pickBestFacingCandidate(source, target, elementRegistry, options) {
    var list = enumerateSequenceFlowFacingCandidates(source, target, elementRegistry, options);
    return list.length ? list[0] : null;
}

function getTopFacingCandidates(source, target, elementRegistry, options, limit) {
    var list = enumerateSequenceFlowFacingCandidates(source, target, elementRegistry, options);
    if (typeof limit === 'number' && limit > 0 && list.length > limit) {
        return list.slice(0, limit);
    }
    return list;
}

function projectPointFromDockSide(point, side, distance) {
    var d = typeof distance === 'number' ? distance : EDGE_CLEARANCE_PX;
    if (!point || typeof point.x !== 'number' || typeof point.y !== 'number') {
        return point;
    }
    if (side === 'l') return makePt(point.x - d, point.y);
    if (side === 'r') return makePt(point.x + d, point.y);
    if (side === 't') return makePt(point.x, point.y - d);
    if (side === 'b') return makePt(point.x, point.y + d);
    return makePt(point.x, point.y);
}

function buildOrthogonalPathTemplate(start, end, kind) {
    if (!start || !end) {
        return null;
    }
    if (Math.abs(start.x - end.x) < ORTHO_EPS || Math.abs(start.y - end.y) < ORTHO_EPS) {
        return [snapshotWaypoint(start), snapshotWaypoint(end)];
    }
    if (kind === 'hv') {
        return [snapshotWaypoint(start), makePt(end.x, start.y), snapshotWaypoint(end)];
    }
    if (kind === 'vh') {
        return [snapshotWaypoint(start), makePt(start.x, end.y), snapshotWaypoint(end)];
    }
    if (kind === 'hvh') {
        var midX = (start.x + end.x) / 2;
        return [snapshotWaypoint(start), makePt(midX, start.y), makePt(midX, end.y), snapshotWaypoint(end)];
    }
    if (kind === 'vhv') {
        var midY = (start.y + end.y) / 2;
        return [snapshotWaypoint(start), makePt(start.x, midY), makePt(end.x, midY), snapshotWaypoint(end)];
    }
    return null;
}

function buildP2TemplateCandidatesForFacing(source, target, connection, facing) {
    if (!source || !target || !facing) {
        return [];
    }
    var startDock = connection
        ? dockingPointOnSharedSide(source, facing.sourceExitSide, connection)
        : dockingPointOnSideMid(source, facing.sourceExitSide);
    var endDock = connection
        ? dockingPointOnSharedSide(target, facing.targetEntrySide, connection)
        : dockingPointOnSideMid(target, facing.targetEntrySide);
    var exitPoint = projectPointFromDockSide(startDock, facing.sourceExitSide, EDGE_CLEARANCE_PX);
    var approachPoint = projectPointFromDockSide(endDock, facing.targetEntrySide, EDGE_CLEARANCE_PX);
    var kinds = ['hv', 'vh', 'hvh', 'vhv'];
    var out = [];
    for (var i = 0; i < kinds.length; i++) {
        var bridge = buildOrthogonalPathTemplate(exitPoint, approachPoint, kinds[i]);
        if (!bridge || !bridge.length) {
            continue;
        }
        var points = [snapshotWaypoint(startDock)]
            .concat(bridge.slice(0, bridge.length - 1))
            .concat([snapshotWaypoint(approachPoint), snapshotWaypoint(endDock)]);
        points = ensureStrictlyOrthogonalWaypoints(withoutRedundantPoints(points));
        points = withoutRedundantPoints(points);
        out.push({
            kind: kinds[i],
            facing: facing,
            points: points
        });
    }
    return out;
}

function createSequenceFlowObstacleContext(connection, elementRegistry) {
    var empty = { all: [], betweenEndpoints: [], flowNodes: [] };
    if (!connection || !elementRegistry || !connection.source || !connection.target) {
        return empty;
    }
    var all = collectSequenceFlowObstacleElements(connection, elementRegistry);
    var betweenEndpoints = filterObstacleElementsBetweenEndpoints(
        connection.source,
        connection.target,
        all,
        WAYPOINT_OBSTACLE_ENDPOINT_PAD_PX
    );
    return {
        all: all,
        betweenEndpoints: betweenEndpoints,
        flowNodes: betweenEndpoints.filter(function (el) {
            return !el.labelTarget;
        })
    };
}

function selectBestP2TemplateCandidate(source, target, connection, p1Candidates, obstacleContext) {
    if (!connection || !Array.isArray(p1Candidates) || !p1Candidates.length) {
        return null;
    }
    var obstacles = obstacleContext && Array.isArray(obstacleContext.flowNodes) ? obstacleContext.flowNodes : [];
    var best = null;
    var candidateCount = 0;
    for (var i = 0; i < p1Candidates.length; i++) {
        var facing = p1Candidates[i];
        var templates = buildP2TemplateCandidatesForFacing(source, target, connection, facing);
        for (var j = 0; j < templates.length; j++) {
            var template = templates[j];
            candidateCount++;
            if (waypointsIntersectFlowObstacles(template.points, obstacles, SEQUENCE_FLOW_OBSTACLE_SEGMENT_CLEARANCE_PX)) {
                continue;
            }
            var score = scoreDetourCandidatePath(template.points, connection, source, target, obstacles);
            if (!isFinite(score)) {
                continue;
            }
            score += facing.phase1Score;
            score += i * 5;
            score += template.points.length;
            if (!best || score < best.score) {
                best = {
                    facing: facing,
                    points: template.points,
                    score: score,
                    candidateCount: candidateCount,
                    templateKind: template.kind
                };
            }
        }
    }
    if (best) {
        best.candidateCount = candidateCount;
    }
    return best;
}

function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
}

function getSequenceFlowsAttachedToShape(shape) {
    var seen = Object.create(null);
    var out = [];

    function push(flow) {
        if (!flow || seen[flow.id]) {
            return;
        }
        var bo = flow.businessObject;
        if (!bo || bo.$type !== 'bpmn:SequenceFlow') {
            return;
        }
        seen[flow.id] = true;
        out.push(flow);
    }

    (shape && shape.incoming ? shape.incoming : []).forEach(push);
    (shape && shape.outgoing ? shape.outgoing : []).forEach(push);
    return out;
}

function getFlowDockPointOnShape(flow, shape) {
    if (!flow || !shape || !Array.isArray(flow.waypoints) || !flow.waypoints.length) {
        return null;
    }
    if (flow.source === shape) {
        return getWpXY(flow.waypoints[0]);
    }
    if (flow.target === shape) {
        return getWpXY(flow.waypoints[flow.waypoints.length - 1]);
    }
    return null;
}

function centeredDockOffsets(count, step) {
    var out = [];
    var start = -((count - 1) * step) / 2;
    for (var i = 0; i < count; i++) {
        out.push(start + i * step);
    }
    return out;
}

function getOppositeMidpointAxis(flow, shape, side) {
    var other = flow.source === shape ? flow.target : flow.source;
    var mid = other ? getMid(other) : null;
    if (!mid) {
        return 0;
    }
    return side === 't' || side === 'b' ? mid.x : mid.y;
}

function inferDockSideFromSegmentDirection(shape, endpoint, adjacent) {
    if (!shape || !endpoint || !adjacent) {
        return null;
    }
    var dx = adjacent.x - endpoint.x;
    var dy = adjacent.y - endpoint.y;
    if (Math.abs(dx) < ORTHO_EPS && Math.abs(dy) > ORTHO_EPS) {
        return dy > 0 ? 'b' : 't';
    }
    if (Math.abs(dy) < ORTHO_EPS && Math.abs(dx) > ORTHO_EPS) {
        return dx > 0 ? 'r' : 'l';
    }
    return inferDockSideFromPointOnShape(shape, endpoint);
}

function preferNearColumnDockSide(shape, otherShape, currentSide) {
    if (!shape || !otherShape || !currentSide) {
        return currentSide;
    }
    var sm = getMid(shape);
    var om = getMid(otherShape);
    var dx = om.x - sm.x;
    var dy = om.y - sm.y;
    var adx = Math.abs(dx);
    var ady = Math.abs(dy);
    if (adx > NEAR_COLUMN_DOCK_MAX_DX_PX || ady <= adx * NEAR_COLUMN_DOCK_DOMINANCE_RATIO) {
        return currentSide;
    }
    return dy >= 0 ? 'b' : 't';
}

function dockSideFacesOther(shape, otherShape, side) {
    if (!shape || !otherShape || !side) {
        return false;
    }
    var sm = getMid(shape);
    var om = getMid(otherShape);
    var dx = om.x - sm.x;
    var dy = om.y - sm.y;
    var eps = FACING_HEMISPHERE_EPS;
    if (side === 'l') return dx < -eps;
    if (side === 'r') return dx > eps;
    if (side === 't') return dy < -eps;
    if (side === 'b') return dy > eps;
    return false;
}

function dockingPointOnSharedSide(shape, side, connection) {
    var base = dockingPointOnSideMid(shape, side);
    if (!shape || !connection || !side) {
        return base;
    }
    if (/Gateway/.test(getShapeType(shape))) {
        return base;
    }

    var attached = getSequenceFlowsAttachedToShape(shape);
    var sameSide = attached.filter(function (flow) {
        var pt = getFlowDockPointOnShape(flow, shape);
        return inferDockSideFromPointOnShape(shape, pt) === side;
    });

    if (sameSide.length < 2) {
        return base;
    }

    var hasIncoming = sameSide.some(function (flow) {
        return flow.target === shape;
    });
    var hasOutgoing = sameSide.some(function (flow) {
        return flow.source === shape;
    });
    if (!hasIncoming || !hasOutgoing) {
        return base;
    }

    sameSide.sort(function (a, b) {
        var da = getOppositeMidpointAxis(a, shape, side);
        var db = getOppositeMidpointAxis(b, shape, side);
        if (da !== db) {
            return da - db;
        }
        return String(a.id || '').localeCompare(String(b.id || ''));
    });

    var idx = sameSide.indexOf(connection);
    if (idx === -1) {
        return base;
    }

    var offsets = centeredDockOffsets(sameSide.length, SAME_SIDE_DOCK_SPREAD_STEP_PX);
    if (side === 't' || side === 'b') {
        var nextX = clamp(
            base.x + offsets[idx],
            shape.x + SAME_SIDE_DOCK_SPREAD_MARGIN_PX,
            shape.x + (shape.width || 0) - SAME_SIDE_DOCK_SPREAD_MARGIN_PX
        );
        return dockingPointOnShapeBoundary(shape, side, nextX - getMid(shape).x);
    }
    var nextY = clamp(
        base.y + offsets[idx],
        shape.y + SAME_SIDE_DOCK_SPREAD_MARGIN_PX,
        shape.y + (shape.height || 0) - SAME_SIDE_DOCK_SPREAD_MARGIN_PX
    );
    return dockingPointOnShapeBoundary(shape, side, nextY - getMid(shape).y);
}

function isDiagramAncestor(ancestor, node) {
    if (!ancestor || !node) {
        return false;
    }
    var p = node;
    while (p) {
        if (p === ancestor) {
            return true;
        }
        p = p.parent;
    }
    return false;
}

/**
 * perf B: source / target 의 Participant + Lane 조상을 한 번의 parent chain traverse 로 동시 계산.
 * active spatial index 가 ancestor cache 를 제공하면 결과를 메모이즈 → trial loop 안에서 반복 호출 비용 0.
 */
function _computeAncestorInfo(node) {
    var participant = null;
    var lane = null;
    var cur = node;
    while (cur) {
        if (!participant && is(cur, 'bpmn:Participant')) {
            participant = cur;
        }
        if (!lane && is(cur, 'bpmn:Lane')) {
            lane = cur;
        }
        if (participant && lane) break;
        cur = cur.parent;
    }
    return { participant: participant, lane: lane };
}

function _getAncestorInfo(node) {
    if (!node) return { participant: null, lane: null };
    var idx = getActiveObstacleSpatialIndex();
    var cache = idx && idx.ancestorCache;
    if (cache) {
        var hit = cache.get(node);
        if (hit) return hit;
        var info = _computeAncestorInfo(node);
        cache.set(node, info);
        return info;
    }
    return _computeAncestorInfo(node);
}

function findAncestorParticipant(node) {
    return _getAncestorInfo(node).participant;
}

function clampSequenceFlowToSharedParticipant(points, source, target) {
    if (!Array.isArray(points) || points.length < 2) {
        return points;
    }

    var sourceParticipant = findAncestorParticipant(source);
    var targetParticipant = findAncestorParticipant(target);
    if (!sourceParticipant || sourceParticipant !== targetParticipant) {
        return points;
    }

    var left = sourceParticipant.x;
    var top = sourceParticipant.y;
    var right = sourceParticipant.x + (sourceParticipant.width || 0);
    var bottom = sourceParticipant.y + (sourceParticipant.height || 0);
    if (!(right > left) || !(bottom > top)) {
        return points;
    }

    var next = cloneWaypoints(points);
    for (var i = 1; i < next.length - 1; i++) {
        next[i].x = clamp(next[i].x, left, right);
        next[i].y = clamp(next[i].y, top, bottom);
    }
    return next;
}

function flowEndpointContainedIn(ancestor, source, target) {
    if (isDiagramAncestor(ancestor, source) || isDiagramAncestor(ancestor, target)) {
        return true;
    }
    if (source && source.host && isDiagramAncestor(ancestor, source.host)) {
        return true;
    }
    if (target && target.host && isDiagramAncestor(ancestor, target.host)) {
        return true;
    }
    return false;
}

export function isSequenceFlowLayoutObstacle(el, connection, source, target) {
    if (!el || !el.businessObject) {
        return false;
    }
    if (el === source || el === target || el === connection) {
        return false;
    }
    if (el.labelTarget) {
        if (el.labelTarget === connection) {
            return false;
        }
        return true;
    }
    if (!is(el, 'bpmn:FlowNode')) {
        return false;
    }
    if (is(el, 'bpmn:SubProcess')) {
        return !flowEndpointContainedIn(el, source, target);
    }
    return true;
}

function getDefaultElementSize(el) {
    var t = (el && el.businessObject && el.businessObject.$type) || '';
    if (/Event/.test(t)) return { width: 36, height: 36 };
    if (/Gateway/.test(t)) return { width: 50, height: 50 };
    return { width: 100, height: 80 };
}

/**
 * Element 타입별 추가 clearance.
 * task (100x80) 기준 12px 가 적당하지만 event (36x36) / gateway (50x50) 는 절대 크기가 작아
 * 같은 12px 만으로는 인접 segment 가 도형 가장자리를 스칠 가능성이 큼 → 더 큰 padding 추가.
 *
 * task pad +4 까지 시도했으나 routing 이 너무 멀리 우회하는 회귀 → 0 으로 복귀.
 * event/gateway 는 작은 크기 보정 효과가 명확해서 +8/+6 유지.
 */
function elementClearancePadPx(el) {
    var t = (el && el.businessObject && el.businessObject.$type) || '';
    if (/Event$/.test(t)) return 8;
    if (/Gateway$/.test(t)) return 6;
    return 0;
}

export function obstacleRectForSegmentHitTest(el, clearancePx) {
    var c = Math.max(0, clearancePx || 0) + elementClearancePadPx(el);
    var w = el.width;
    var h = el.height;
    if (typeof w !== 'number' || w <= 0 || typeof h !== 'number' || h <= 0) {
        var def = getDefaultElementSize(el);
        w = def.width;
        h = def.height;
    }
    return { x: el.x - c, y: el.y - c, width: w + 2 * c, height: h + 2 * c };
}

var obstacleBoundsDebugLoggedOnce = false;

export function tryLogElementBoundsBeforeObstacleCheck(elementRegistry, connection, contextTag) {
    if (sequenceFlowImportLayoutActive) {
        return;
    }
    if (!LOG_SEQUENCE_FLOW_OBSTACLE_ELEMENT_BOUNDS) {
        return;
    }
    if (!LOG_SEQUENCE_FLOW_OBSTACLE_ELEMENT_BOUNDS_REPEAT && obstacleBoundsDebugLoggedOnce) {
        return;
    }
    try {
        var fid = (connection && connection.id) || '?';
        var ctx = contextTag || '';
        if (!elementRegistry || typeof elementRegistry.getAll !== 'function') {
            pushSequenceLog('warn', 'obstacle-bounds', 'debug skip: no registry | ctx=' + ctx + ' flow=' + fid);
            return;
        }
        var all = elementRegistry.getAll();
        if (!Array.isArray(all)) {
            pushSequenceLog('warn', 'obstacle-bounds', 'debug getAll not array | ctx=' + ctx + ' flow=' + fid);
            return;
        }
        var head =
            'obstacle-bounds-debug (model=el.x/y/w/h; gfx=SVG getBBox on render group, 로컬 좌표) | ctx=' +
            ctx +
            ' flow=' +
            fid +
            ' total=' +
            all.length;
        pushSequenceLog('info', 'obstacle-bounds', head);
        if (typeof console !== 'undefined' && console.info) {
            console.info('[obstacle-bounds]', head);
        }
        var sorted = all.slice();
        sorted.sort(function (a, b) {
            return String((a && a.id) || '').localeCompare(String((b && b.id) || ''));
        });

        function displayNameForBoundsLog(el) {
            if (!el) {
                return '-';
            }
            var bo = el.businessObject;
            var n = bo && bo.name;
            if (n != null && String(n).trim() !== '') {
                var s = String(n).trim();
                return s.length > 48 ? s.slice(0, 47) + '…' : s;
            }
            return '-';
        }

        function emitGfxLine(registry, el, nm) {
            var bo = el.businessObject;
            var typ = (bo && bo.$type) || el.type || '?';
            var base = 'el id=' + (el.id || '?') + ' type=' + typ + ' name=' + JSON.stringify(nm) + ' ';
            try {
                if (!registry || typeof registry.getGraphics !== 'function') {
                    pushSequenceLog('info', 'obstacle-bounds-gfx', base + 'gfx=noRegistry');
                    return;
                }
                var gfx = registry.getGraphics(el);
                if (!gfx || typeof gfx.getBBox !== 'function') {
                    gfx = registry.getGraphics(el, true);
                }
                if (!gfx || typeof gfx.getBBox !== 'function') {
                    pushSequenceLog('info', 'obstacle-bounds-gfx', base + 'gfx=noGfx');
                    return;
                }
                var bb = gfx.getBBox();
                if (!bb || typeof bb.x !== 'number' || typeof bb.y !== 'number') {
                    pushSequenceLog('info', 'obstacle-bounds-gfx', base + 'gfx=bboxNull');
                    return;
                }
                var gw = bb.width;
                var gh = bb.height;
                var rx = Math.round(bb.x * 10) / 10;
                var ry = Math.round(bb.y * 10) / 10;
                var rw = typeof gw === 'number' && isFinite(gw) ? Math.round(gw * 10) / 10 : null;
                var rh = typeof gh === 'number' && isFinite(gh) ? Math.round(gh * 10) / 10 : null;
                var line = base + 'gfx_local=(' + rx + ',' + ry + ')+' + (rw != null ? rw : 'na') + 'x' + (rh != null ? rh : 'na') + ' | ';
                if (typeof el.x === 'number' && typeof el.y === 'number' && rw != null && rh != null) {
                    var wx = Math.round((el.x + bb.x) * 10) / 10;
                    var wy = Math.round((el.y + bb.y) * 10) / 10;
                    var wr = Math.round((el.x + bb.x + gw) * 10) / 10;
                    var wb = Math.round((el.y + bb.y + gh) * 10) / 10;
                    line +=
                        'world_AABB=(' +
                        wx +
                        ',' +
                        wy +
                        ')-(' +
                        wr +
                        ',' +
                        wb +
                        ') [다이어그램 축: 모델(el.x,el.y)+로컬 getBBox; Task는 테두리·커스텀 렌더로 model 박스보다 약간 큼]';
                } else {
                    line += 'world_AABB=n/a (연결선·루트 등 el.x/y 없음 — gfx_local 은 그룹 내부 좌표)';
                }
                pushSequenceLog('info', 'obstacle-bounds-gfx', line);
                if (typeof console !== 'undefined' && console.info) {
                    console.info('[obstacle-bounds-gfx]', line);
                }
            } catch (e) {
                var err = base + 'gfx=err:' + (e && e.message ? String(e.message) : String(e));
                try {
                    pushSequenceLog('warn', 'obstacle-bounds-gfx', err);
                } catch (e2) {
                    /* ignore */
                }
                try {
                    if (typeof console !== 'undefined' && console.warn) {
                        console.warn('[obstacle-bounds-gfx]', err);
                    }
                } catch (e3) {
                    /* ignore */
                }
            }
        }

        for (var iObstacle = 0; iObstacle < sorted.length; iObstacle++) {
            var el = sorted[iObstacle];
            if (!el) {
                continue;
            }
            var bo = el.businessObject;
            var nm = displayNameForBoundsLog(el);
            var line =
                'model | el id=' +
                (el.id || '?') +
                ' type=' +
                ((bo && bo.$type) || el.type || '?') +
                ' name=' +
                JSON.stringify(nm) +
                ' x=' +
                (typeof el.x === 'number' ? String(el.x) : 'na') +
                ' y=' +
                (typeof el.y === 'number' ? String(el.y) : 'na') +
                ' w=' +
                (typeof el.width === 'number' ? String(el.width) : 'na') +
                ' h=' +
                (typeof el.height === 'number' ? String(el.height) : 'na');
            pushSequenceLog('info', 'obstacle-bounds', line);
            if (typeof console !== 'undefined' && console.info) {
                console.info('[obstacle-bounds]', line);
            }
            emitGfxLine(elementRegistry, el, nm);
        }
        if (!LOG_SEQUENCE_FLOW_OBSTACLE_ELEMENT_BOUNDS_REPEAT) {
            obstacleBoundsDebugLoggedOnce = true;
        }
    } catch (e) {
        var msg = 'obstacle-bounds-debug error: ' + (e && e.message ? e.message : String(e));
        try {
            pushSequenceLog('warn', 'obstacle-bounds', msg);
        } catch (e2) {
            /* ignore */
        }
        try {
            if (typeof console !== 'undefined' && console.warn) {
                console.warn('[obstacle-bounds]', msg, e);
            }
        } catch (e3) {
            /* ignore */
        }
    }
}

export function segmentIntersectsRect(ax, ay, bx, by, rect) {
    var eps = 1e-5;
    function pin(x, y) {
        return x >= rect.x - eps && y >= rect.y - eps && x <= rect.x + rect.width + eps && y <= rect.y + rect.height + eps;
    }
    if (pin(ax, ay) || pin(bx, by)) {
        return true;
    }

    var rx = rect.x;
    var ry = rect.y;
    var rx2 = rx + rect.width;
    var ry2 = ry + rect.height;
    var xmin = Math.min(ax, bx);
    var xmax = Math.max(ax, bx);
    var ymin = Math.min(ay, by);
    var ymax = Math.max(ay, by);

    if (Math.abs(ay - by) < 1e-3) {
        if (ay < ry || ay > ry2) return false;
        return xmax > rx && xmin < rx2;
    }
    if (Math.abs(ax - bx) < 1e-3) {
        if (ax < rx || ax > rx2) return false;
        return ymax > ry && ymin < ry2;
    }

    var steps = 32;
    for (var s = 1; s < steps; s++) {
        var t = s / steps;
        var px = ax + (bx - ax) * t;
        var py = ay + (by - ay) * t;
        if (pin(px, py)) return true;
    }
    return false;
}

export function segmentStripIntersectsRect(ax, ay, bx, by, halfThickness, rect) {
    if (halfThickness == null || halfThickness <= 0 || !rect) {
        return segmentIntersectsRect(ax, ay, bx, by, rect);
    }
    var eps = 1e-5;
    var rx = rect.x;
    var ry = rect.y;
    var rx2 = rx + rect.width;
    var ry2 = ry + rect.height;
    var xmin = Math.min(ax, bx);
    var xmax = Math.max(ax, bx);
    var ymin = Math.min(ay, by);
    var ymax = Math.max(ay, by);

    if (Math.abs(ay - by) < 1e-3) {
        var yLo = ay - halfThickness;
        var yHi = ay + halfThickness;
        return xmax > rx - eps && xmin < rx2 + eps && yHi > ry - eps && yLo < ry2 + eps;
    }
    if (Math.abs(ax - bx) < 1e-3) {
        var xLo = ax - halfThickness;
        var xHi = ax + halfThickness;
        return ymax > ry - eps && ymin < ry2 + eps && xHi > rx - eps && xLo < rx2 + eps;
    }
    return segmentIntersectsRect(ax, ay, bx, by, rect);
}

export function collectSequenceFlowObstacleElements(connection, elementRegistry) {
    var source = connection.source;
    var target = connection.target;
    if (!connection || !elementRegistry || !source || !target) {
        return [];
    }
    // perf A: active spatial index 가 있으면 그 도형 리스트만 filter (이미 좁혀진 후보).
    // 인덱스가 없으면 fallback: 전체 elementRegistry 순회.
    var spatialIndex = getActiveObstacleSpatialIndex();
    var pool = spatialIndex ? spatialIndex.allElements() : elementRegistry.getAll();
    return pool.filter(function (el) {
        return isSequenceFlowLayoutObstacle(el, connection, source, target);
    });
}

export function waypointsIntersectFlowObstacles(waypoints, obstacleElements, clearancePx) {
    if (!Array.isArray(waypoints) || waypoints.length < 2 || !obstacleElements.length) {
        return false;
    }
    var c = clearancePx == null ? OBSTACLE_SEGMENT_CLEARANCE_PX : clearancePx;

    // perf A 진짜 활용: spatial index 가 있으면 segment 별로 query 후 obstacleElements 와 교집합 검사.
    // 결과: segment 가 거치지 않는 영역의 obstacle 은 검사에서 제외 → 큰 다이어그램에서 큰 가속.
    var spatialIndex = getActiveObstacleSpatialIndex();
    if (spatialIndex && obstacleElements.length > 8) {
        var obstacleSet = new Set(obstacleElements);
        // rect 캐시 (obstacle 객체 → rect)
        var rectMap = new Map();
        for (var i = 0; i < waypoints.length - 1; i++) {
            var a = waypoints[i];
            var b = waypoints[i + 1];
            if (!a || !b) continue;
            var ax = a.x !== undefined ? a.x : a.original && a.original.x;
            var ay = a.y !== undefined ? a.y : a.original && a.original.y;
            var bx = b.x !== undefined ? b.x : b.original && b.original.x;
            var by = b.y !== undefined ? b.y : b.original && b.original.y;
            if (typeof ax !== 'number' || typeof ay !== 'number' || typeof bx !== 'number' || typeof by !== 'number') {
                continue;
            }
            // segment bbox + clearance 로 query
            var nearby = spatialIndex.querySegment(ax, ay, bx, by, c + 4);
            for (var n = 0; n < nearby.length; n++) {
                var el = nearby[n];
                if (!obstacleSet.has(el)) continue;
                var rect = rectMap.get(el);
                if (rect === undefined) {
                    var r0 = obstacleRectForSegmentHitTest(el, c);
                    rect = r0.width > 0 && r0.height > 0 ? r0 : null;
                    rectMap.set(el, rect);
                }
                if (rect && segmentIntersectsRect(ax, ay, bx, by, rect)) {
                    return true;
                }
            }
        }
        return false;
    }

    // fallback: 기존 경로 (rect 캐시 + 전체 obstacle 순회)
    var rects = new Array(obstacleElements.length);
    for (var ri = 0; ri < obstacleElements.length; ri++) {
        var r = obstacleRectForSegmentHitTest(obstacleElements[ri], c);
        rects[ri] = r.width > 0 && r.height > 0 ? r : null;
    }
    for (var i2 = 0; i2 < waypoints.length - 1; i2++) {
        var a2 = waypoints[i2];
        var b2 = waypoints[i2 + 1];
        if (!a2 || !b2) continue;
        var ax2 = a2.x !== undefined ? a2.x : a2.original && a2.original.x;
        var ay2 = a2.y !== undefined ? a2.y : a2.original && a2.original.y;
        var bx2 = b2.x !== undefined ? b2.x : b2.original && b2.original.x;
        var by2 = b2.y !== undefined ? b2.y : b2.original && b2.original.y;
        if (typeof ax2 !== 'number' || typeof ay2 !== 'number' || typeof bx2 !== 'number' || typeof by2 !== 'number') {
            continue;
        }
        for (var o = 0; o < rects.length; o++) {
            var rect2 = rects[o];
            if (!rect2) continue;
            if (segmentIntersectsRect(ax2, ay2, bx2, by2, rect2)) {
                return true;
            }
        }
    }
    return false;
}

function getEdgeRouterOrthogonal() {
    var g = typeof globalThis !== 'undefined' ? globalThis : {};
    return g.EdgeRouterOrthogonal && typeof g.EdgeRouterOrthogonal.computeWaypoints === 'function' ? g.EdgeRouterOrthogonal : null;
}

function toRouterCenterNode(el) {
    if (!el || typeof el.x !== 'number' || typeof el.y !== 'number') return null;
    var def = getDefaultElementSize(el);
    var w = el.width != null ? el.width : def.width;
    var h = el.height != null ? el.height : def.height;
    return {
        id: el.id,
        x: el.x + w / 2,
        y: el.y + h / 2,
        width: w,
        height: h
    };
}

function polylineManhattanLength(pts) {
    if (!Array.isArray(pts) || pts.length < 2) return 0;
    var sum = 0;
    for (var iLen = 1; iLen < pts.length; iLen++) {
        var a = pts[iLen - 1];
        var b = pts[iLen];
        if (typeof a.x !== 'number' || typeof a.y !== 'number' || typeof b.x !== 'number' || typeof b.y !== 'number') {
            continue;
        }
        sum += Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    }
    return sum;
}

function inferSourceDockSideFromFirstSegment(p0, p1) {
    var dx = p1.x - p0.x;
    var dy = p1.y - p0.y;
    if (Math.abs(dx) < OBSTACLE_ROUTER_ORTHO_EPS && Math.abs(dy) < OBSTACLE_ROUTER_ORTHO_EPS) {
        return null;
    }
    if (Math.abs(dx) < OBSTACLE_ROUTER_ORTHO_EPS) {
        return dy > 0 ? 'b' : 't';
    }
    if (Math.abs(dy) < OBSTACLE_ROUTER_ORTHO_EPS) {
        return dx > 0 ? 'r' : 'l';
    }
    return null;
}

function inferTargetDockSideFromLastApproachSegment(pPrev, pLast) {
    var dx = pLast.x - pPrev.x;
    var dy = pLast.y - pPrev.y;
    if (Math.abs(dx) < OBSTACLE_ROUTER_ORTHO_EPS && Math.abs(dy) < OBSTACLE_ROUTER_ORTHO_EPS) {
        return null;
    }
    if (Math.abs(dx) < OBSTACLE_ROUTER_ORTHO_EPS) {
        return dy > 0 ? 't' : 'b';
    }
    if (Math.abs(dy) < OBSTACLE_ROUTER_ORTHO_EPS) {
        return dx > 0 ? 'l' : 'r';
    }
    return null;
}

export function resolveObstacleRerouteSourceDockSide(source, target, facingSourceSide, srcFromPath) {
    if (facingSourceSide == null) {
        return srcFromPath;
    }
    if (srcFromPath == null) {
        return facingSourceSide;
    }
    var g = facingSourceSide;
    var p = srcFromPath;
    var oppH = (g === 'l' && p === 'r') || (g === 'r' && p === 'l');
    var oppV = (g === 't' && p === 'b') || (g === 'b' && p === 't');
    if (oppH || oppV) {
        return facingSourceSide;
    }
    return srcFromPath;
}

export function resolveObstacleRerouteTargetDockSide(facingTargetSide, tgtFromApproach) {
    if (facingTargetSide == null) {
        return tgtFromApproach;
    }
    if (tgtFromApproach == null) {
        return facingTargetSide;
    }
    var g = facingTargetSide;
    var p = tgtFromApproach;
    var oppH = (g === 'l' && p === 'r') || (g === 'r' && p === 'l');
    var oppV = (g === 't' && p === 'b') || (g === 'b' && p === 't');
    if (oppH || oppV) {
        return facingTargetSide;
    }
    return tgtFromApproach;
}

export function ensureOrthogonalStartSegment(merged, srcSide, orthoEps) {
    var eps = orthoEps == null ? OBSTACLE_ROUTER_ORTHO_EPS : orthoEps;
    if (!merged || merged.length < 2 || !srcSide) {
        return merged;
    }
    var p0 = merged[0];
    var p1 = merged[1];
    if (typeof p0.x !== 'number' || typeof p0.y !== 'number' || typeof p1.x !== 'number' || typeof p1.y !== 'number') {
        return merged;
    }
    var dx = p1.x - p0.x;
    var dy = p1.y - p0.y;
    if (Math.abs(dx) < eps || Math.abs(dy) < eps) {
        return merged;
    }
    var verticalSide = srcSide === 't' || srcSide === 'b';
    var elbow;
    if (verticalSide) {
        elbow = { x: p0.x, y: p1.y, original: { x: p0.x, y: p1.y } };
    } else {
        elbow = { x: p1.x, y: p0.y, original: { x: p1.x, y: p0.y } };
    }
    merged.splice(1, 0, elbow);
    return merged;
}

export function ensureOrthogonalEndSegment(merged, tgtSide, orthoEps) {
    var eps = orthoEps == null ? OBSTACLE_ROUTER_ORTHO_EPS : orthoEps;
    if (!merged || merged.length < 2 || !tgtSide) {
        return merged;
    }
    var pPrev = merged[merged.length - 2];
    var pLast = merged[merged.length - 1];
    if (typeof pPrev.x !== 'number' || typeof pPrev.y !== 'number' || typeof pLast.x !== 'number' || typeof pLast.y !== 'number') {
        return merged;
    }
    var dx = pLast.x - pPrev.x;
    var dy = pLast.y - pPrev.y;
    if (Math.abs(dx) < eps || Math.abs(dy) < eps) {
        return merged;
    }
    var verticalSide = tgtSide === 't' || tgtSide === 'b';
    var elbow;
    if (verticalSide) {
        elbow = { x: pLast.x, y: pPrev.y, original: { x: pLast.x, y: pPrev.y } };
    } else {
        elbow = { x: pPrev.x, y: pLast.y, original: { x: pPrev.x, y: pLast.y } };
    }
    merged.splice(merged.length - 1, 0, elbow);
    return merged;
}

function forceOrthogonalStartSegmentAxis(merged, srcSide, orthoEps) {
    var eps = orthoEps == null ? OBSTACLE_ROUTER_ORTHO_EPS : orthoEps;
    if (!merged || merged.length < 2 || !srcSide) {
        return merged;
    }
    var p0 = merged[0];
    var p1 = merged[1];
    if (!p0 || !p1) {
        return merged;
    }
    var dx = p1.x - p0.x;
    var dy = p1.y - p0.y;
    if ((srcSide === 't' || srcSide === 'b') && Math.abs(dx) >= eps) {
        var next = merged.length >= 3 ? merged[2] : null;
        var nextY = next && typeof next.y === 'number' ? next.y : p1.y;
        if (Math.abs(nextY - p0.y) < eps) {
            nextY = p0.y + (srcSide === 'b' ? EDGE_CLEARANCE_PX : -EDGE_CLEARANCE_PX);
        }
        merged[1] = { x: p0.x, y: nextY, original: { x: p0.x, y: nextY } };
    } else if ((srcSide === 'l' || srcSide === 'r') && Math.abs(dy) >= eps) {
        var next = merged.length >= 3 ? merged[2] : null;
        var nextX = next && typeof next.x === 'number' ? next.x : p1.x;
        if (Math.abs(nextX - p0.x) < eps) {
            nextX = p0.x + (srcSide === 'r' ? EDGE_CLEARANCE_PX : -EDGE_CLEARANCE_PX);
        }
        merged[1] = { x: nextX, y: p0.y, original: { x: nextX, y: p0.y } };
    }
    return merged;
}

function forceOrthogonalEndSegmentAxis(merged, tgtSide, orthoEps) {
    var eps = orthoEps == null ? OBSTACLE_ROUTER_ORTHO_EPS : orthoEps;
    if (!merged || merged.length < 2 || !tgtSide) {
        return merged;
    }
    var pPrev = merged[merged.length - 2];
    var pLast = merged[merged.length - 1];
    if (!pPrev || !pLast) {
        return merged;
    }
    var dx = pLast.x - pPrev.x;
    var dy = pLast.y - pPrev.y;
    if ((tgtSide === 't' || tgtSide === 'b') && Math.abs(dx) >= eps) {
        var prev2 = merged.length >= 3 ? merged[merged.length - 3] : null;
        var prevY = prev2 && typeof prev2.y === 'number' ? prev2.y : pPrev.y;
        if (Math.abs(prevY - pLast.y) < eps) {
            prevY = pLast.y + (tgtSide === 'b' ? EDGE_CLEARANCE_PX : -EDGE_CLEARANCE_PX);
        }
        merged[merged.length - 2] = { x: pLast.x, y: prevY, original: { x: pLast.x, y: prevY } };
    } else if ((tgtSide === 'l' || tgtSide === 'r') && Math.abs(dy) >= eps) {
        var prev2 = merged.length >= 3 ? merged[merged.length - 3] : null;
        var prevX = prev2 && typeof prev2.x === 'number' ? prev2.x : pPrev.x;
        if (Math.abs(prevX - pLast.x) < eps) {
            prevX = pLast.x + (tgtSide === 'r' ? EDGE_CLEARANCE_PX : -EDGE_CLEARANCE_PX);
        }
        merged[merged.length - 2] = { x: prevX, y: pLast.y, original: { x: prevX, y: pLast.y } };
    }
    return merged;
}

function snapshotWaypointForFacingSnap(p) {
    if (!p) {
        return { x: 0, y: 0 };
    }
    var x = typeof p.x === 'number' ? p.x : p.original && p.original.x;
    var y = typeof p.y === 'number' ? p.y : p.original && p.original.y;
    var o = { x: x, y: y };
    if (p.original && typeof p.original.x === 'number' && typeof p.original.y === 'number') {
        o.original = { x: p.original.x, y: p.original.y };
    }
    return o;
}

export function snapSequenceFlowWaypointsToFacingEndpoints(pts, source, target, layoutHorizontal, lockedFacingSides) {
    if (!pts || pts.length < 2 || !source || !target) {
        return pts;
    }
    var sides = lockedFacingSides
        ? {
              sourceSide: lockedFacingSides.sourceSide,
              targetSide: lockedFacingSides.targetSide
          }
        : computeSequenceFacingSides(source, target, layoutHorizontal === true);
    if (!lockedFacingSides && pts.length >= 2) {
        var sourceSideFromPath = inferDockSideFromSegmentDirection(source, pts[0], pts[1]);
        if (
            sourceSideFromPath &&
            (dockSideFacesOther(source, target, sourceSideFromPath) || !dockSideFacesOther(source, target, sides.sourceSide))
        ) {
            sides.sourceSide = sourceSideFromPath;
        }
    }
    if (!lockedFacingSides && pts.length >= 3) {
        var targetSideFromPath = inferDockSideFromSegmentDirection(target, pts[pts.length - 1], pts[pts.length - 2]);
        if (
            targetSideFromPath &&
            (dockSideFacesOther(target, source, targetSideFromPath) || !dockSideFacesOther(target, source, sides.targetSide))
        ) {
            sides.targetSide = targetSideFromPath;
        }
    }
    var ds = dockingPointOnSideMid(source, sides.sourceSide);
    var de = dockingPointOnSideMid(target, sides.targetSide);
    pts[0] = snapshotWaypointForFacingSnap(ds);
    pts[pts.length - 1] = snapshotWaypointForFacingSnap(de);
    ensureOrthogonalStartSegment(pts, sides.sourceSide, OBSTACLE_ROUTER_ORTHO_EPS);
    ensureOrthogonalEndSegment(pts, sides.targetSide, OBSTACLE_ROUTER_ORTHO_EPS);
    return withoutRedundantPoints(pts);
}

export function shouldSnapSequenceFlowFacingEndpoints(connection, source, target) {
    if (!connection || !is(connection, 'bpmn:SequenceFlow')) {
        return false;
    }
    if (!source || !target || source === target) {
        return false;
    }
    if (is(source, 'bpmn:BoundaryEvent')) {
        return false;
    }
    return true;
}

export function filterObstacleElementsBetweenEndpoints(source, target, obstacleElements, padPx) {
    var pad = padPx == null ? OBSTACLE_ROUTER_LOCAL_PAD_PX : padPx;
    var sw = source.width || 0;
    var sh = source.height || 0;
    var tw = target.width || 0;
    var th = target.height || 0;
    var sL = Math.min(source.x, target.x) - pad;
    var sR = Math.max(source.x + sw, target.x + tw) + pad;
    var sT = Math.min(source.y, target.y) - pad;
    var sB = Math.max(source.y + sh, target.y + th) + pad;
    return obstacleElements.filter(function (el) {
        var ew = el.width || 0;
        var eh = el.height || 0;
        var L = el.x;
        var R = el.x + ew;
        var T = el.y;
        var B = el.y + eh;
        return !(R < sL || L > sR || B < sT || T > sB);
    });
}

export function applySequenceFlowObstacleReroute(connection, waypoints, elementRegistry, horizontalLayout, lockedFacingSides) {
    if (!connection || !is(connection, 'bpmn:SequenceFlow')) {
        return waypoints;
    }
    if (sequenceFlowImportLayoutActive) {
        return waypoints;
    }
    var source = connection.source;
    var target = connection.target;
    if (!source || !target || !elementRegistry || !Array.isArray(waypoints) || waypoints.length < 2) {
        return waypoints;
    }

    var obstacles = collectSequenceFlowObstacleElements(connection, elementRegistry);
    tryLogElementBoundsBeforeObstacleCheck(elementRegistry, connection, 'obstacle-reroute');

    if (!waypointsIntersectFlowObstacles(waypoints, obstacles, OBSTACLE_SEGMENT_CLEARANCE_PX)) {
        return waypoints;
    }

    var router = getEdgeRouterOrthogonal();
    if (!router) {
        return waypoints;
    }

    var sourceNode = toRouterCenterNode(source);
    var targetNode = toRouterCenterNode(target);
    if (!sourceNode || !targetNode) {
        return waypoints;
    }

    var localObstacles = filterObstacleElementsBetweenEndpoints(source, target, obstacles, OBSTACLE_ROUTER_LOCAL_PAD_PX);
    var obstacleNodes = localObstacles.map(toRouterCenterNode).filter(Boolean);
    var lenBefore = polylineManhattanLength(waypoints);

    try {
        var routed = router.computeWaypoints(sourceNode, targetNode, obstacleNodes, {
            horizontal: horizontalLayout === true
        });
        if (Array.isArray(routed) && routed.length >= 2) {
            var merged = routed.map(function (p) {
                return { x: p.x, y: p.y };
            });
            var srcSide;
            var tgtSide;
            if (lockedFacingSides && lockedFacingSides.sourceSide && lockedFacingSides.targetSide) {
                srcSide = lockedFacingSides.sourceSide;
                tgtSide = lockedFacingSides.targetSide;
            } else {
                var facingSides = computeSequenceFacingSides(source, target, horizontalLayout === true);
                var srcFromPath = merged.length >= 2 ? inferSourceDockSideFromFirstSegment(merged[0], merged[1]) : null;
                srcSide = resolveObstacleRerouteSourceDockSide(source, target, facingSides.sourceSide, srcFromPath);
                var tgtFromApproach =
                    merged.length >= 2
                        ? inferTargetDockSideFromLastApproachSegment(merged[merged.length - 2], merged[merged.length - 1])
                        : null;
                tgtSide = resolveObstacleRerouteTargetDockSide(facingSides.targetSide, tgtFromApproach);
            }
            merged[0] = dockingPointOnSideMid(source, srcSide);
            merged[merged.length - 1] = dockingPointOnSideMid(target, tgtSide);
            ensureOrthogonalStartSegment(merged, srcSide, OBSTACLE_ROUTER_ORTHO_EPS);
            ensureOrthogonalEndSegment(merged, tgtSide, OBSTACLE_ROUTER_ORTHO_EPS);
            merged = withoutRedundantPoints(merged);
            var lenAfter = polylineManhattanLength(merged);
            if (lenBefore > 0 && lenAfter > lenBefore * MAX_OBSTACLE_REROUTE_LENGTH_RATIO) {
                return waypoints;
            }
            return merged;
        }
    } catch (e) {
        console.warn('[sequence-flow-obstacle-reroute] reroute failed:', connection.id, e);
    }
    return waypoints;
}

var ORTHO_EPS = 1e-3;
var EDGE_TOL_PX = 20;
var EDGE_CLEARANCE_PX = 14;
var MAX_ITERATIONS = 16;
var MAX_SAME_OBSTACLE_STRIKES = 3;
var WAYPOINT_OBSTACLE_ENDPOINT_PAD_PX = 80;
var SEGMENT_OBSTACLE_FILTER_PAD_PX = 40;
var FIRST_SEGMENT_STRIP_EXTRA_PAD_PX = 4;
var HIT_CLEARANCE_PX = SEQUENCE_FLOW_OBSTACLE_HIT_CLEARANCE_PX;
var OBSTACLE_CLEARANCE_PX = SEQUENCE_FLOW_OBSTACLE_DETOUR_CLEARANCE_PX;
var DETOUR_EXTRA_PX = SEQUENCE_FLOW_OBSTACLE_DETOUR_EXTRA_PX;
var DETOUR_SIDE_TIE_PX = 12;
var MICRO_JOG_MAX_PX = 14;
var STAIR_HIT_CLEARANCE_PX = SEQUENCE_FLOW_OBSTACLE_SEGMENT_CLEARANCE_PX;
var PARALLEL_Y_TOL = 1.5;
var PARALLEL_SEQUENCE_FLOW_SEPARATION_PX = 8;
/** 게이트웨이/태스크 바로 옆의 짧은 내부 수평 구간은 분리 시 작은 ㅁ자 지그재그가 생기기 쉬워 제외 */
var PARALLEL_INTERNAL_SEGMENT_MIN_LENGTH_PX = 48;
// 평행 segment 검사: 노드 외곽선에서 이 거리 안쪽에 평행하게 흐르는 segment 는 회피 페널티
// (16 → 18: 도형 접촉 케이스 보강. 24 까지 올렸더니 정상 직진까지 평행으로 잘못 판정 → 18 로 보수적)
var NODE_NO_RUN_CLEARANCE_PX = 18;
// 짧은 segment 검사: 24 까지 줄였더니 정상 직진 segment 까지 페널티 → 40 로 복귀
var NODE_NO_RUN_MIN_SEGMENT_PX = 40;
var TARGET_LOCAL_HOOK_MAX_PX = 40;
var TARGET_TINY_JOG_MAX_PX = 16;
var SAME_SIDE_DOCK_SPREAD_STEP_PX = 16;
// 같은 side 에 여러 flow dock 시 코너에서 떨어뜨리는 마진. 18 → 22 강화 (사용자 보고: 코너 접촉)
var SAME_SIDE_DOCK_SPREAD_MARGIN_PX = 22;
var NEAR_COLUMN_DOCK_MAX_DX_PX = 140;
var NEAR_COLUMN_DOCK_DOMINANCE_RATIO = 1.35;
var LOCAL_CLUSTER_MAX_DX_PX = 260;
var LOCAL_CLUSTER_MAX_DY_PX = 180;
var LEADING_LOCAL_JOG_MAX_PX = 48;
var LOG_SEQUENCE_FLOW_WAYPOINT_OBSTACLE = true;

function snapshotWaypoint(p) {
    if (!p) return { x: 0, y: 0 };
    var x = typeof p.x === 'number' ? p.x : p.original && p.original.x;
    var y = typeof p.y === 'number' ? p.y : p.original && p.original.y;
    var o = { x: x, y: y };
    if (p.original && typeof p.original.x === 'number' && typeof p.original.y === 'number') {
        o.original = { x: p.original.x, y: p.original.y };
    }
    return o;
}

function cloneWaypoints(pts) {
    if (!Array.isArray(pts)) {
        return [];
    }
    return pts.map(snapshotWaypoint);
}

function makePt(x, y) {
    return { x: x, y: y, original: { x: x, y: y } };
}

function pointsNearlyEqual(a, b, eps) {
    return Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps;
}

function pointsNearlyEqualOrtho(a, b) {
    if (!a || !b) return false;
    return Math.abs(a.x - b.x) < ORTHO_EPS && Math.abs(a.y - b.y) < ORTHO_EPS;
}

/**
 * 동일 수직선(같은 x) 또는 동일 수평선(같은 y) 위에서 A→B→A 처럼 나갔다 돌아오는 직교 스파이크를 제거한다.
 * {@link withoutRedundantPoints}는 공선 상의 중복만 지우므로, (x,ya)-(x,yb)-(x,ya) 톱니 패턴·폭주 DI waypoint가 남을 수 있다.
 *
 * @param {Array<{x:number,y:number}>} waypoints
 * @returns {Array<{x:number,y:number}>}
 */
function collapseOrthogonalBacktrackSpikes(waypoints) {
    if (!Array.isArray(waypoints) || waypoints.length < 3) {
        return Array.isArray(waypoints) ? cloneWaypoints(waypoints) : waypoints;
    }
    var pts = cloneWaypoints(waypoints);
    var eps = ORTHO_EPS;
    var guard = 0;
    var maxGuard = Math.max(pts.length * 8, 64);
    while (pts.length >= 3 && guard < maxGuard) {
        guard++;
        var removed = false;
        for (var i = 1; i < pts.length - 1; i++) {
            var a = pts[i - 1];
            var b = pts[i];
            var c = pts[i + 1];
            var vertSpike =
                Math.abs(a.x - b.x) < eps && Math.abs(b.x - c.x) < eps && Math.abs(a.y - c.y) < eps && Math.abs(a.y - b.y) > eps;
            var horizSpike =
                Math.abs(a.y - b.y) < eps && Math.abs(b.y - c.y) < eps && Math.abs(a.x - c.x) < eps && Math.abs(a.x - b.x) > eps;
            if (vertSpike || horizSpike) {
                pts.splice(i, 1);
                removed = true;
                break;
            }
        }
        if (!removed) {
            break;
        }
    }
    return pts;
}

function getShapeBounds(el) {
    if (!el || typeof el.x !== 'number' || typeof el.y !== 'number') return null;
    var w = el.width || 0;
    var h = el.height || 0;
    return { x: el.x, y: el.y, r: el.x + w, b: el.y + h };
}

function bpmnElementDisplayName(el) {
    if (!el) {
        return '?';
    }
    var bo = el.businessObject;
    var n = bo && bo.name;
    if (n != null && String(n).trim() !== '') {
        var s = String(n).trim();
        return s.length > 48 ? s.slice(0, 47) + '…' : s;
    }
    return el.id || '?';
}

function logObstacleHit(connection, segIndex, ax, ay, bx, by, obstacleEl) {
    if (!LOG_SEQUENCE_FLOW_WAYPOINT_OBSTACLE) {
        return;
    }
    var bo = obstacleEl && obstacleEl.businessObject;
    var type = (bo && bo.$type) || (obstacleEl && obstacleEl.type) || '?';
    var oid = (obstacleEl && obstacleEl.id) || '?';
    var oname = bpmnElementDisplayName(obstacleEl);
    var fid = (connection && connection.id) || '?';
    var srcName = bpmnElementDisplayName(connection && connection.source);
    var tgtName = bpmnElementDisplayName(connection && connection.target);
    var flowBo = connection && connection.businessObject;
    var flowName = flowBo && flowBo.name != null && String(flowBo.name).trim() !== '' ? String(flowBo.name).trim() : '';
    if (flowName.length > 40) {
        flowName = flowName.slice(0, 39) + '…';
    }
    var msg =
        'flow id=' +
        fid +
        ' path="' +
        srcName +
        '"→"' +
        tgtName +
        '"' +
        (flowName ? ' flowName="' + flowName + '"' : '') +
        ' | 세그먼트 pts[' +
        segIndex +
        ']→[' +
        (segIndex + 1) +
        '] (' +
        ax.toFixed(0) +
        ',' +
        ay.toFixed(0) +
        ')–(' +
        bx.toFixed(0) +
        ',' +
        by.toFixed(0) +
        ') | 장애물 name="' +
        oname +
        '" id=' +
        oid +
        ' type=' +
        type;
    pushSequenceLog('info', 'waypoint-obstacle', msg);
    if (typeof console !== 'undefined' && console.info) {
        console.info('[SequenceFlowWaypointObstacle]', msg);
    }
}

function filterObstaclesForSegment(obstacles, ax, ay, bx, by, padPx) {
    var p = padPx == null ? 0 : padPx;
    var minX = Math.min(ax, bx) - p;
    var maxX = Math.max(ax, bx) + p;
    var minY = Math.min(ay, by) - p;
    var maxY = Math.max(ay, by) + p;
    return obstacles.filter(function (el) {
        var ew = el.width || 0;
        var eh = el.height || 0;
        if (typeof el.x !== 'number' || typeof el.y !== 'number') {
            return false;
        }
        if (ew <= 0 || eh <= 0) {
            return true;
        }
        var L = el.x;
        var R = el.x + ew;
        var T = el.y;
        var B = el.y + eh;
        return !(R < minX || L > maxX || B < minY || T > maxY);
    });
}

function filterDuplicateInsertions(prev, next, insert) {
    var out = [];
    var k;
    for (k = 0; k < insert.length; k++) {
        var p = insert[k];
        if (out.length === 0 && pointsNearlyEqual(p, prev, ORTHO_EPS)) {
            continue;
        }
        out.push(p);
    }
    if (out.length && pointsNearlyEqual(out[out.length - 1], next, ORTHO_EPS)) {
        out.pop();
    }
    return out;
}

function sourceTargetBothAxesOverlap(s, t) {
    if (!s || !t || typeof s.x !== 'number' || typeof t.x !== 'number') {
        return false;
    }
    var sw = s.width || 0;
    var sh = s.height || 0;
    var tw = t.width || 0;
    var th = t.height || 0;
    var sL = s.x;
    var sR = s.x + sw;
    var sT = s.y;
    var sB = s.y + sh;
    var tL = t.x;
    var tR = t.x + tw;
    var tT = t.y;
    var tB = t.y + th;
    var xOv = !(sR < tL || tR < sL);
    var yOv = !(sB < tT || tB < sT);
    return xOv && yOv;
}

function preferCloserObstacleExit(source, target) {
    if (!source || !target) {
        return false;
    }
    return !sourceTargetBothAxesOverlap(source, target);
}

function getFirstSegmentStripHalfThickness(source) {
    if (!source || typeof source.width !== 'number' || typeof source.height !== 'number') {
        return 0;
    }
    var hw = source.width / 2;
    var hh = source.height / 2;
    var base = Math.max(hw, hh);
    return base + FIRST_SEGMENT_STRIP_EXTRA_PAD_PX;
}

function buildHorizontalDetour(ax, ay, bx, by, rect, extraPad, source, target, stripHalfForHitTest) {
    if (Math.abs(ay - by) > ORTHO_EPS) {
        return null;
    }
    var rx = rect.x;
    var ry = rect.y;
    var rw = rect.width;
    var rh = rect.height;
    var rx2 = rx + rw;
    var ry2 = ry + rh;
    var stripH = stripHalfForHitTest == null ? 0 : stripHalfForHitTest;
    var hitH = stripH > 0 ? segmentStripIntersectsRect(ax, ay, bx, by, stripH, rect) : segmentIntersectsRect(ax, ay, bx, by, rect);
    if (!hitH) {
        return null;
    }
    if (stripH <= 0 && (ay <= ry || ay >= ry2)) {
        return null;
    }

    var cy = ry + rh / 2;
    var useCloser = preferCloserObstacleExit(source, target);
    var yDet;
    if (useCloser && source && target) {
        var sm = getMid(source);
        var tm = getMid(target);
        var yUp = ry - extraPad;
        var yDown = ry2 + extraPad;
        var dUp = Math.min(Math.abs(sm.y - yUp), Math.abs(tm.y - yUp));
        var dDown = Math.min(Math.abs(sm.y - yDown), Math.abs(tm.y - yDown));
        if (Math.abs(dUp - dDown) < DETOUR_SIDE_TIE_PX) {
            yDet = Math.abs(tm.y - yUp) <= Math.abs(tm.y - yDown) ? yUp : yDown;
        } else {
            yDet = dUp <= dDown ? yUp : yDown;
        }
    } else {
        yDet = ay < cy ? ry - extraPad : ry2 + extraPad;
    }
    var dLeft = rx - extraPad;
    var dRight = rx2 + extraPad;
    var forward = bx >= ax;
    var distL = Math.abs(ax - dLeft);
    var distR = Math.abs(ax - dRight);
    var xExitCloser = distL <= distR ? dLeft : dRight;

    var pbInsideX = bx >= rx && bx <= rx2;
    if (pbInsideX) {
        var xExit = useCloser ? xExitCloser : forward ? dLeft : dRight;
        return [makePt(xExit, ay), makePt(xExit, yDet), makePt(bx, yDet), makePt(bx, by)];
    }

    if (forward) {
        if (useCloser) {
            return [makePt(xExitCloser, ay), makePt(xExitCloser, yDet)];
        }
        return [makePt(dLeft, ay), makePt(dLeft, yDet)];
    }
    if (useCloser) {
        return [makePt(xExitCloser, ay), makePt(xExitCloser, yDet)];
    }
    return [makePt(dRight, ay), makePt(dRight, yDet)];
}

function buildVerticalDetour(ax, ay, bx, by, rect, extraPad, source, target, stripHalfForHitTest) {
    if (Math.abs(ax - bx) > ORTHO_EPS) {
        return null;
    }
    var rx = rect.x;
    var ry = rect.y;
    var rw = rect.width;
    var rh = rect.height;
    var rx2 = rx + rw;
    var ry2 = ry + rh;
    var stripV = stripHalfForHitTest == null ? 0 : stripHalfForHitTest;
    var hitV = stripV > 0 ? segmentStripIntersectsRect(ax, ay, bx, by, stripV, rect) : segmentIntersectsRect(ax, ay, bx, by, rect);
    if (!hitV) {
        return null;
    }
    if (stripV <= 0 && (ax <= rx || ax >= rx2)) {
        return null;
    }

    var useCloser = preferCloserObstacleExit(source, target);

    if (by > ry && by < ry2) {
        var dLe2 = rx - extraPad;
        var dRi2 = rx2 + extraPad;
        var xExit2;
        if (useCloser && source && target) {
            var distLe = Math.abs(ax - dLe2);
            var distRi = Math.abs(ax - dRi2);
            if (Math.abs(distLe - distRi) < DETOUR_SIDE_TIE_PX) {
                var tmPt = getMid(target);
                xExit2 = Math.abs(tmPt.x - dLe2) <= Math.abs(tmPt.x - dRi2) ? dLe2 : dRi2;
            } else {
                xExit2 = distLe <= distRi ? dLe2 : dRi2;
            }
        } else {
            var cx2 = rx + rw / 2;
            xExit2 = ax < cx2 ? dLe2 : dRi2;
        }
        var yOut2;
        if (useCloser && source && target) {
            var sm = getMid(source);
            var tm = getMid(target);
            var yUp = ry - extraPad;
            var yDown = ry2 + extraPad;
            var dU = Math.min(Math.abs(sm.y - yUp), Math.abs(tm.y - yUp));
            var dD = Math.min(Math.abs(sm.y - yDown), Math.abs(tm.y - yDown));
            if (Math.abs(dU - dD) < DETOUR_SIDE_TIE_PX) {
                yOut2 = Math.abs(tm.y - yUp) <= Math.abs(tm.y - yDown) ? yUp : yDown;
            } else {
                yOut2 = dU <= dD ? yUp : yDown;
            }
        } else {
            var cy2 = ry + rh / 2;
            yOut2 = ay < cy2 ? ry - extraPad : ry2 + extraPad;
        }
        var out2 = [makePt(xExit2, ay), makePt(xExit2, yOut2), makePt(xExit2, by)];
        if (Math.abs(ax - xExit2) > ORTHO_EPS) {
            out2.push(makePt(ax, by));
        }
        return out2;
    }

    var xDet;
    if (useCloser && source && target) {
        var sm2 = getMid(source);
        var tm2 = getMid(target);
        var xl = rx - extraPad;
        var xr = rx2 + extraPad;
        var dxL = Math.min(Math.abs(sm2.x - xl), Math.abs(tm2.x - xl));
        var dxR = Math.min(Math.abs(sm2.x - xr), Math.abs(tm2.x - xr));
        if (Math.abs(dxL - dxR) < DETOUR_SIDE_TIE_PX) {
            xDet = Math.abs(tm2.x - xl) <= Math.abs(tm2.x - xr) ? xl : xr;
        } else {
            xDet = dxL <= dxR ? xl : xr;
        }
    } else {
        var cx = rx + rw / 2;
        xDet = ax < cx ? rx - extraPad : rx2 + extraPad;
    }
    var downward = by > ay;

    if (downward && ay < ry && by > ry) {
        var yTop = ry - extraPad;
        var outDown = [makePt(ax, yTop), makePt(xDet, yTop), makePt(xDet, by)];
        if (Math.abs(ax - xDet) > ORTHO_EPS) {
            outDown.push(makePt(ax, by));
        }
        return outDown;
    }

    if (!downward && ay > ry2 && by < ry2) {
        var yBot = ry2 + extraPad;
        var outUp = [makePt(ax, yBot), makePt(xDet, yBot), makePt(xDet, by)];
        if (Math.abs(ax - xDet) > ORTHO_EPS) {
            outUp.push(makePt(ax, by));
        }
        return outUp;
    }

    return null;
}

function buildDetourForSegment(ax, ay, bx, by, rect, extraPad, source, target, stripHalfForHitTest) {
    var strip = stripHalfForHitTest == null ? 0 : stripHalfForHitTest;
    var h = buildHorizontalDetour(ax, ay, bx, by, rect, extraPad, source, target, strip);
    if (h) {
        return h;
    }
    return buildVerticalDetour(ax, ay, bx, by, rect, extraPad, source, target, strip);
}

function firstHitTAlongSegment(ax, ay, bx, by, rect) {
    var rx = rect.x;
    var ry = rect.y;
    var rx2 = rx + rect.width;
    var ry2 = ry + rect.height;
    var dx = bx - ax;
    var dy = by - ay;

    if (Math.abs(dx) < ORTHO_EPS && Math.abs(dy) < ORTHO_EPS) {
        return 0;
    }

    if (Math.abs(dy) < ORTHO_EPS) {
        if (ay < ry || ay > ry2) {
            return Infinity;
        }
        var x0 = Math.min(ax, bx);
        var x1 = Math.max(ax, bx);
        if (x1 < rx || x0 > rx2) {
            return Infinity;
        }
        if (dx > 0) {
            if (ax < rx) {
                return (rx - ax) / dx;
            }
            if (ax >= rx && ax <= rx2) {
                return 0;
            }
            return Infinity;
        }
        if (dx < 0) {
            if (ax > rx2) {
                return (rx2 - ax) / dx;
            }
            if (ax >= rx && ax <= rx2) {
                return 0;
            }
            return Infinity;
        }
        return Infinity;
    }

    if (Math.abs(dx) < ORTHO_EPS) {
        if (ax < rx || ax > rx2) {
            return Infinity;
        }
        if (dy > 0) {
            if (ay < ry) {
                return (ry - ay) / dy;
            }
            if (ay >= ry && ay <= ry2) {
                return 0;
            }
            return Infinity;
        }
        if (dy < 0) {
            if (ay > ry2) {
                return (ry2 - ay) / dy;
            }
            if (ay >= ry && ay <= ry2) {
                return 0;
            }
            return Infinity;
        }
        return Infinity;
    }

    return Infinity;
}

function collapseMicroOrthogonalJogs(pts, connection, elementRegistry) {
    if (!Array.isArray(pts) || pts.length < 4 || !connection || !elementRegistry) {
        return pts;
    }
    var obstacles = collectSequenceFlowObstacleElements(connection, elementRegistry);
    var out = pts.slice();
    var changed = true;
    while (changed && out.length >= 4) {
        changed = false;
        var i;
        for (i = 1; i < out.length - 2; i++) {
            var p0 = out[i - 1];
            var p1 = out[i];
            var p2 = out[i + 1];
            var p3 = out[i + 2];
            if (!p0 || !p1 || !p2 || !p3) {
                continue;
            }
            var h01 = Math.abs(p0.y - p1.y) < ORTHO_EPS && Math.abs(p2.y - p3.y) < ORTHO_EPS && Math.abs(p1.x - p2.x) < ORTHO_EPS;
            if (h01) {
                var vLeg = Math.abs(p1.y - p2.y);
                if (vLeg <= 1e-6 || vLeg > MICRO_JOG_MAX_PX) {
                    continue;
                }
                if (Math.abs(p0.x - p1.x) < ORTHO_EPS || Math.abs(p2.x - p3.x) < ORTHO_EPS) {
                    continue;
                }
                var midH = makePt(p3.x, p0.y);
                if (pointsNearlyEqual(midH, p0, ORTHO_EPS) || pointsNearlyEqual(midH, p3, ORTHO_EPS)) {
                    continue;
                }
                var trialH = out.slice();
                trialH.splice(i, 2, midH);
                if (waypointsIntersectFlowObstacles(trialH, obstacles, STAIR_HIT_CLEARANCE_PX)) {
                    continue;
                }
                out.splice(i, 2, midH);
                changed = true;
                break;
            }
            var v01 = Math.abs(p0.x - p1.x) < ORTHO_EPS;
            var h12 = Math.abs(p1.y - p2.y) < ORTHO_EPS;
            var v23 = Math.abs(p2.x - p3.x) < ORTHO_EPS;
            if (v01 && h12 && v23) {
                var hLeg = Math.abs(p2.x - p1.x);
                if (hLeg <= 1e-6 || hLeg > MICRO_JOG_MAX_PX) {
                    continue;
                }
                if (Math.abs(p0.y - p1.y) < ORTHO_EPS || Math.abs(p2.y - p3.y) < ORTHO_EPS) {
                    continue;
                }
                var midV = makePt(p0.x, p3.y);
                if (pointsNearlyEqual(midV, p0, ORTHO_EPS) || pointsNearlyEqual(midV, p3, ORTHO_EPS)) {
                    continue;
                }
                var trialV = out.slice();
                trialV.splice(i, 2, midV);
                if (waypointsIntersectFlowObstacles(trialV, obstacles, STAIR_HIT_CLEARANCE_PX)) {
                    continue;
                }
                out.splice(i, 2, midV);
                changed = true;
                break;
            }
        }
    }
    return out;
}

function segmentRunsParallelNearRect(ax, ay, bx, by, rect, clearance, minRun) {
    var left = rect.x - clearance;
    var right = rect.x + rect.width + clearance;
    var top = rect.y - clearance;
    var bottom = rect.y + rect.height + clearance;

    if (Math.abs(ay - by) < ORTHO_EPS) {
        var run = Math.abs(ax - bx);
        if (run < minRun) {
            return false;
        }
        if (ay < top || ay > bottom) {
            return false;
        }
        return !(Math.max(ax, bx) < left || Math.min(ax, bx) > right);
    }

    if (Math.abs(ax - bx) < ORTHO_EPS) {
        var rise = Math.abs(ay - by);
        if (rise < minRun) {
            return false;
        }
        if (ax < left || ax > right) {
            return false;
        }
        return !(Math.max(ay, by) < top || Math.min(ay, by) > bottom);
    }

    return false;
}

function pathHasTinyHookNearTarget(points) {
    if (!Array.isArray(points) || points.length < 4) {
        return false;
    }
    var tail = points.slice(-4);
    for (var i = 0; i < tail.length - 2; i++) {
        var a = getWpXY(tail[i]);
        var b = getWpXY(tail[i + 1]);
        var c = getWpXY(tail[i + 2]);
        var ab = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
        var bc = Math.abs(b.x - c.x) + Math.abs(b.y - c.y);
        if (ab <= TARGET_LOCAL_HOOK_MAX_PX && bc <= TARGET_LOCAL_HOOK_MAX_PX) {
            return true;
        }
    }
    return false;
}

function scorePathAgainstNodeNoRunBands(points, source, target, obstacles) {
    if (!Array.isArray(points) || points.length < 2) {
        return 0;
    }
    var scoringObstacles = Array.isArray(obstacles) ? obstacles.slice() : [];
    if (target && scoringObstacles.indexOf(target) === -1) {
        scoringObstacles.push(target);
    }

    var score = 0;
    for (var i = 0; i < points.length - 1; i++) {
        var a = getWpXY(points[i]);
        var b = getWpXY(points[i + 1]);
        if (typeof a.x !== 'number' || typeof a.y !== 'number' || typeof b.x !== 'number' || typeof b.y !== 'number') {
            continue;
        }

        for (var j = 0; j < scoringObstacles.length; j++) {
            var obstacle = scoringObstacles[j];
            if (!obstacle || obstacle === source) {
                continue;
            }
            if (obstacle === target && i === points.length - 2) {
                continue;
            }
            var rect = obstacleRectForSegmentHitTest(obstacle, 0);
            if (!rect || rect.width <= 0 || rect.height <= 0) {
                continue;
            }
            if (segmentRunsParallelNearRect(a.x, a.y, b.x, b.y, rect, NODE_NO_RUN_CLEARANCE_PX, NODE_NO_RUN_MIN_SEGMENT_PX)) {
                // 평행 페널티: 500/300 → 700/450 으로 약간만 강화 (1200/800 은 회귀 발생)
                score += obstacle === target ? 700 : 450;
            }
        }
    }

    return score;
}

function findAncestorLane(node) {
    // perf B: _getAncestorInfo (메모이즈) 와 동일한 cache 공유
    return _getAncestorInfo(node).lane;
}

/**
 * source / target 의 가장 가까운 공통 레이아웃 컨테이너를 반환한다.
 * - 같은 Lane 안에 있으면 그 Lane (가장 좁은 박스). 결함 2번 (백워드 루프가 lane 헤더 strip 위로 빠져나감) 차단의 핵심.
 * - 그렇지 않고 같은 Participant 안이면 그 Participant.
 * - 둘 다 아니면 null (검사 생략).
 *
 * 이전 구현은 Participant 만 검사해서, 같은 lane 안의 backward loop 가
 * 다른 lane 영역을 가로질러 lane 헤더 strip 위로 빠져나가는 경로도 valid 로 판정했다.
 */
function findSharedLayoutContainer(source, target) {
    var sourceLane = findAncestorLane(source);
    var targetLane = findAncestorLane(target);
    if (sourceLane && sourceLane === targetLane) {
        return sourceLane;
    }
    var sourcePart = findAncestorParticipant(source);
    var targetPart = findAncestorParticipant(target);
    if (sourcePart && sourcePart === targetPart) {
        return sourcePart;
    }
    return null;
}

/**
 * C-Container: 공통 레이아웃 컨테이너(Lane 우선, 없으면 Participant) 박스 밖으로
 * 웨이포인트가 빠지면 우회 후보 탈락.
 */
function pathViolatesSharedParticipantBounds(points, source, target) {
    if (!Array.isArray(points) || points.length < 1 || !source || !target) {
        return false;
    }
    var container = findSharedLayoutContainer(source, target);
    if (!container) {
        return false;
    }
    var w = container.width || 0;
    var h = container.height || 0;
    if (!(w > 0) || !(h > 0)) {
        return false;
    }
    var left = container.x;
    var top = container.y;
    var right = container.x + w;
    var bottom = container.y + h;
    var tol = 0.5;
    var i;
    for (i = 0; i < points.length; i++) {
        var pt = getWpXY(points[i]);
        if (typeof pt.x !== 'number' || typeof pt.y !== 'number' || !isFinite(pt.x) || !isFinite(pt.y)) {
            return true;
        }
        if (pt.x < left - tol || pt.x > right + tol || pt.y < top - tol || pt.y > bottom + tol) {
            return true;
        }
    }
    return false;
}

/**
 * source 출발 방향 / target 도착 방향이 source→target 직선의 주축 방향과 반대(backtrack)이면
 * segment 길이에 비례한 페널티를 반환한다.
 *
 * 결함 3 (풀 가장자리 EndEvent 의 들어오는 엣지가 아래로 빠지며 다른 task 침범) 과
 * 결함 6 (Y 분기가 위로 backtrack 해서 인접 task 덮음) 둘 다 같은 메커니즘으로 잡힌다.
 *
 * 가중치 BACKTRACK_PENALTY_PER_PX 는 의도적 우회 (장애물 회피) 와의 균형을 위해 보수적으로 설정.
 */
var BACKTRACK_PENALTY_PER_PX = 4;
var BACKTRACK_MIN_DELTA_PX = 5;

function computeBacktrackPenalty(points, source, target) {
    if (!source || !target || !Array.isArray(points) || points.length < 2) {
        return 0;
    }
    var sCx = source.x + (source.width || 0) / 2;
    var sCy = source.y + (source.height || 0) / 2;
    var tCx = target.x + (target.width || 0) / 2;
    var tCy = target.y + (target.height || 0) / 2;
    var dirX = tCx - sCx;
    var dirY = tCy - sCy;

    var penalty = 0;

    // 첫 segment: source 에서 나가는 방향
    var p0 = points[0];
    var p1 = points[1];
    var fdx = p1.x - p0.x;
    var fdy = p1.y - p0.y;
    if (Math.abs(fdx) > Math.abs(fdy)) {
        if (Math.abs(dirX) > BACKTRACK_MIN_DELTA_PX && fdx * dirX < 0) {
            penalty += Math.abs(fdx) * BACKTRACK_PENALTY_PER_PX;
        }
    } else {
        if (Math.abs(dirY) > BACKTRACK_MIN_DELTA_PX && fdy * dirY < 0) {
            penalty += Math.abs(fdy) * BACKTRACK_PENALTY_PER_PX;
        }
    }

    // 마지막 segment: target 에 도착하는 방향
    var pLast = points[points.length - 1];
    var pPrev = points[points.length - 2];
    var ldx = pLast.x - pPrev.x;
    var ldy = pLast.y - pPrev.y;
    if (Math.abs(ldx) > Math.abs(ldy)) {
        if (Math.abs(dirX) > BACKTRACK_MIN_DELTA_PX && ldx * dirX < 0) {
            penalty += Math.abs(ldx) * BACKTRACK_PENALTY_PER_PX;
        }
    } else {
        if (Math.abs(dirY) > BACKTRACK_MIN_DELTA_PX && ldy * dirY < 0) {
            penalty += Math.abs(ldy) * BACKTRACK_PENALTY_PER_PX;
        }
    }

    return penalty;
}

function scoreDetourCandidatePath(points, connection, source, target, obstacles) {
    if (pathViolatesSharedParticipantBounds(points, source, target)) {
        return Number.POSITIVE_INFINITY;
    }
    var score = 0;
    if (pathHasTinyHookNearTarget(points)) {
        score += 1000;
    }
    score += scorePathAgainstNodeNoRunBands(points, source, target, obstacles);
    score += computeBacktrackPenalty(points, source, target);
    score += points.length * 10;
    return score;
}

function noRunBandScore(points, source, target, obstacles) {
    return scorePathAgainstNodeNoRunBands(points, source, target, obstacles);
}

function candidateWorsensNodeNoRunBands(candidate, current, source, target, obstacles) {
    return noRunBandScore(candidate, source, target, obstacles) > noRunBandScore(current, source, target, obstacles);
}

function pathHasInlineBackwardReturnRun(points, source, target, obstacles) {
    if (!Array.isArray(points) || points.length < 2 || !source || !target) {
        return false;
    }
    var sourceMid = getMid(source);
    var targetMid = getMid(target);
    if (!(targetMid.x < sourceMid.x - BACKTRACK_MIN_DELTA_PX)) {
        return false;
    }
    var corridorLeft = Math.min(target.x, source.x);
    var corridorRight = Math.max(target.x + (target.width || 0), source.x + (source.width || 0));
    var relevant = (Array.isArray(obstacles) ? obstacles : []).filter(function (el) {
        if (!el || el === source || el === target || el.labelTarget) {
            return false;
        }
        var rect = obstacleRectForSegmentHitTest(el, 0);
        if (!rect) return false;
        return rect.x + rect.width >= corridorLeft && rect.x <= corridorRight;
    });
    relevant.push(source, target);
    var top = Math.min.apply(
        null,
        relevant.map(function (el) {
            return el.y;
        })
    );
    var bottom = Math.max.apply(
        null,
        relevant.map(function (el) {
            return el.y + (el.height || 0);
        })
    );

    for (var i = 0; i < points.length - 1; i++) {
        var a = getWpXY(points[i]);
        var b = getWpXY(points[i + 1]);
        if (
            typeof a.x !== 'number' ||
            typeof a.y !== 'number' ||
            typeof b.x !== 'number' ||
            typeof b.y !== 'number' ||
            Math.abs(a.y - b.y) >= ORTHO_EPS
        ) {
            continue;
        }
        var y = a.y;
        var xMin = Math.min(a.x, b.x);
        var xMax = Math.max(a.x, b.x);
        if (
            y > top - ORTHO_EPS &&
            y < bottom + ORTHO_EPS &&
            xMax - xMin >= NODE_NO_RUN_MIN_SEGMENT_PX &&
            xMax >= corridorLeft &&
            xMin <= corridorRight
        ) {
            return true;
        }
    }
    return false;
}

function alignBackwardReturnRunNearTargetEntry(points, source, target) {
    if (!Array.isArray(points) || points.length < 4 || !source || !target) {
        return points;
    }
    var sourceMid = getMid(source);
    var targetMid = getMid(target);
    if (!(targetMid.x < sourceMid.x - BACKTRACK_MIN_DELTA_PX)) {
        return points;
    }

    var out = cloneWaypoints(points);
    var last = out.length - 1;
    var targetSide = inferTargetDockSideFromLastApproachSegment(out[last - 1], out[last]);
    var desiredY = null;
    if (targetSide === 'b') {
        desiredY = target.y + (target.height || 0) + EDGE_CLEARANCE_PX / 2;
    } else if (targetSide === 't') {
        desiredY = target.y - EDGE_CLEARANCE_PX / 2;
    }
    if (desiredY == null) {
        return out;
    }

    var bestIndex = -1;
    var bestLength = 0;
    for (var i = 1; i < out.length - 2; i++) {
        var a = getWpXY(out[i]);
        var b = getWpXY(out[i + 1]);
        if (
            typeof a.x !== 'number' ||
            typeof a.y !== 'number' ||
            typeof b.x !== 'number' ||
            typeof b.y !== 'number' ||
            Math.abs(a.y - b.y) >= ORTHO_EPS
        ) {
            continue;
        }
        var len = Math.abs(a.x - b.x);
        if (len > bestLength) {
            bestLength = len;
            bestIndex = i;
        }
    }
    if (bestIndex < 0 || bestLength < NODE_NO_RUN_MIN_SEGMENT_PX) {
        return out;
    }

    var trial = cloneWaypoints(out);
    trial[bestIndex].y = desiredY;
    trial[bestIndex + 1].y = desiredY;
    syncWaypointOriginal(trial[bestIndex]);
    syncWaypointOriginal(trial[bestIndex + 1]);
    trial = withoutRedundantPoints(ensureStrictlyOrthogonalWaypoints(trial));
    return trial;
}

function simplifyBackwardReturnOuterDogleg(points, source, target, connection, obstacleElements) {
    if (!Array.isArray(points) || points.length < 6 || !source || !target) {
        return points;
    }
    var sourceMid = getMid(source);
    var targetMid = getMid(target);
    if (!(targetMid.x < sourceMid.x - BACKTRACK_MIN_DELTA_PX)) {
        return points;
    }

    var out = withoutRedundantPoints(collapseOrthogonalBacktrackSpikes(cloneWaypoints(points)));
    if (out.length < 6) {
        return out;
    }

    var first = getWpXY(out[0]);
    var rail = getWpXY(out[1]);
    var last = getWpXY(out[out.length - 1]);
    if (
        typeof first.x !== 'number' ||
        typeof first.y !== 'number' ||
        typeof rail.x !== 'number' ||
        typeof rail.y !== 'number' ||
        typeof last.x !== 'number' ||
        typeof last.y !== 'number' ||
        Math.abs(first.y - rail.y) >= ORTHO_EPS ||
        Math.abs(rail.x - last.x) < NODE_NO_RUN_MIN_SEGMENT_PX
    ) {
        return out;
    }

    var obstacles = Array.isArray(obstacleElements) ? obstacleElements : [];
    var targetEntry = connection ? dockingPointOnSharedSide(target, 'r', connection) : dockingPointOnSideMid(target, 'r');
    var targetEntryLead = makePt(targetEntry.x + EDGE_CLEARANCE_PX, targetEntry.y);
    var candidateSpecs = [
        [snapshotWaypoint(out[0]), snapshotWaypoint(out[1]), makePt(rail.x, last.y), snapshotWaypoint(out[out.length - 1])]
    ];
    var outerY = targetMid.y < sourceMid.y ? target.y - EDGE_CLEARANCE_PX : target.y + (target.height || 0) + EDGE_CLEARANCE_PX;
    candidateSpecs.push([
        snapshotWaypoint(out[0]),
        snapshotWaypoint(out[1]),
        makePt(rail.x, outerY),
        makePt(targetEntryLead.x, outerY),
        targetEntryLead,
        snapshotWaypoint(targetEntry)
    ]);

    var currentLen = polylineManhattanLength(out);
    var best = out;
    var bestLen = currentLen;
    for (var ci = 0; ci < candidateSpecs.length; ci++) {
        var candidate = withoutRedundantPoints(ensureStrictlyOrthogonalWaypoints(candidateSpecs[ci]));
        var len = polylineManhattanLength(candidate);
        if (candidate.length >= out.length || len >= bestLen) {
            continue;
        }
        if (
            waypointsIntersectFlowObstacles(candidate, obstacles, SEQUENCE_FLOW_OBSTACLE_SEGMENT_CLEARANCE_PX) ||
            sequenceFlowWaypointsObstacleHitsExhaustive(candidate, obstacles, SEQUENCE_FLOW_OBSTACLE_SEGMENT_CLEARANCE_PX)
        ) {
            continue;
        }
        if (candidateWorsensNodeNoRunBands(candidate, out, source, target, obstacles)) {
            continue;
        }
        best = candidate;
        bestLen = len;
    }
    return best;
}

function simplifyBackwardGatewayReturnExit(points, source, target, connection, obstacleElements) {
    if (!Array.isArray(points) || points.length < 5 || !source || !target || !/Gateway/.test(getShapeType(source))) {
        return points;
    }
    var sourceMid = getMid(source);
    var targetMid = getMid(target);
    if (!(targetMid.x < sourceMid.x - BACKTRACK_MIN_DELTA_PX)) {
        return points;
    }

    var out = withoutRedundantPoints(collapseOrthogonalBacktrackSpikes(cloneWaypoints(points)));
    if (out.length < 5) {
        return out;
    }
    var p0 = getWpXY(out[0]);
    var p1 = getWpXY(out[1]);
    if (
        typeof p0.x !== 'number' ||
        typeof p0.y !== 'number' ||
        typeof p1.x !== 'number' ||
        typeof p1.y !== 'number' ||
        !(p1.x > p0.x + ORTHO_EPS)
    ) {
        return out;
    }

    var bestIndex = -1;
    var bestLength = 0;
    for (var i = 1; i < out.length - 1; i++) {
        var a = getWpXY(out[i]);
        var b = getWpXY(out[i + 1]);
        if (
            typeof a.x !== 'number' ||
            typeof a.y !== 'number' ||
            typeof b.x !== 'number' ||
            typeof b.y !== 'number' ||
            Math.abs(a.y - b.y) >= ORTHO_EPS
        ) {
            continue;
        }
        var xMin = Math.min(a.x, b.x);
        var xMax = Math.max(a.x, b.x);
        var len = xMax - xMin;
        if (len > bestLength && xMin < sourceMid.x && xMax <= source.x + (source.width || 0) + EDGE_CLEARANCE_PX * 2) {
            bestLength = len;
            bestIndex = i;
        }
    }
    if (bestIndex < 0 || bestLength < NODE_NO_RUN_MIN_SEGMENT_PX) {
        return out;
    }

    var rail = getWpXY(out[bestIndex]);
    var last = getWpXY(out[out.length - 1]);
    var railY = rail.y;
    if (Math.abs(last.y - (target.y + (target.height || 0))) < EDGE_CLEARANCE_PX) {
        railY = Math.max(railY, target.y + (target.height || 0) + EDGE_CLEARANCE_PX);
    } else if (Math.abs(last.y - target.y) < EDGE_CLEARANCE_PX) {
        railY = Math.min(railY, target.y - EDGE_CLEARANCE_PX);
    }
    var railEndBase = getWpXY(out[bestIndex + 1]);
    var railEnd = makePt(railEndBase.x, railY);
    var sourceSide = railY >= sourceMid.y ? 'b' : 't';
    var sourceDock = connection ? dockingPointOnSharedSide(source, sourceSide, connection) : dockingPointOnSideMid(source, sourceSide);
    var candidate = withoutRedundantPoints(
        ensureStrictlyOrthogonalWaypoints(
            [snapshotWaypoint(sourceDock), makePt(sourceDock.x, railY), railEnd].concat(out.slice(bestIndex + 2).map(snapshotWaypoint))
        )
    );

    if (candidate.length >= out.length || polylineManhattanLength(candidate) >= polylineManhattanLength(out)) {
        return out;
    }
    var obstacles = Array.isArray(obstacleElements) ? obstacleElements : [];
    var currentHits =
        waypointsIntersectFlowObstacles(out, obstacles, SEQUENCE_FLOW_OBSTACLE_SEGMENT_CLEARANCE_PX) ||
        sequenceFlowWaypointsObstacleHitsExhaustive(out, obstacles, SEQUENCE_FLOW_OBSTACLE_SEGMENT_CLEARANCE_PX);
    var candidateHits =
        waypointsIntersectFlowObstacles(candidate, obstacles, SEQUENCE_FLOW_OBSTACLE_SEGMENT_CLEARANCE_PX) ||
        sequenceFlowWaypointsObstacleHitsExhaustive(candidate, obstacles, SEQUENCE_FLOW_OBSTACLE_SEGMENT_CLEARANCE_PX);
    if (candidateHits && !currentHits) {
        return out;
    }
    if (candidateWorsensNodeNoRunBands(candidate, out, source, target, obstacles)) {
        return out;
    }
    return candidate;
}

function enforceFinalTargetApproachClearance(points, target) {
    if (!Array.isArray(points) || points.length < 2 || !target) {
        return points;
    }
    var out = cloneWaypoints(points);
    var lastIndex = out.length - 1;
    var side = inferTargetDockSideFromLastApproachSegment(out[lastIndex - 1], out[lastIndex]);
    if (!side) {
        return out;
    }
    ensureMinApproachLegLength(out[lastIndex - 1], out[lastIndex], side, EDGE_CLEARANCE_PX);
    return withoutRedundantPoints(ensureStrictlyOrthogonalWaypoints(out));
}

function repairSameLaneBackwardReturnNoRun(points, source, target, connection, obstacleElements) {
    if (!Array.isArray(points) || points.length < 2 || !source || !target || !connection) {
        return points;
    }
    var sourceLane = findAncestorLane(source);
    var targetLane = findAncestorLane(target);
    if (!sourceLane || sourceLane !== targetLane) {
        return points;
    }
    var sourceMid = getMid(source);
    var targetMid = getMid(target);
    if (!(targetMid.x < sourceMid.x - BACKTRACK_MIN_DELTA_PX)) {
        return points;
    }

    var obstacles = Array.isArray(obstacleElements) ? obstacleElements : [];
    var current = withoutRedundantPoints(ensureStrictlyOrthogonalWaypoints(cloneWaypoints(points)));
    var currentNoRun = noRunBandScore(current, source, target, obstacles);
    var hasInlineRun = pathHasInlineBackwardReturnRun(current, source, target, obstacles);
    if (currentNoRun <= 0 && !hasInlineRun) {
        return current;
    }

    var corridorLeft = Math.min(target.x, source.x) - EDGE_CLEARANCE_PX;
    var corridorRight = Math.max(target.x + (target.width || 0), source.x + (source.width || 0)) + EDGE_CLEARANCE_PX;
    var relevant = obstacles.filter(function (el) {
        if (!el || el === source || el === target || el.labelTarget || findAncestorLane(el) !== sourceLane) {
            return false;
        }
        var rect = obstacleRectForSegmentHitTest(el, 0);
        if (!rect) return false;
        return rect.x + rect.width >= corridorLeft && rect.x <= corridorRight;
    });
    relevant.push(source, target);

    var topLimit = sourceLane.y + EDGE_CLEARANCE_PX;
    var bottomLimit = sourceLane.y + (sourceLane.height || 0) - EDGE_CLEARANCE_PX;
    var minTop = Math.min.apply(
        null,
        relevant.map(function (el) {
            return el.y;
        })
    );
    var maxBottom = Math.max.apply(
        null,
        relevant.map(function (el) {
            return el.y + (el.height || 0);
        })
    );
    var railCandidates = [
        { side: 't', y: Math.max(topLimit, minTop - NODE_NO_RUN_CLEARANCE_PX - EDGE_CLEARANCE_PX) },
        { side: 'b', y: Math.min(bottomLimit, maxBottom + NODE_NO_RUN_CLEARANCE_PX + EDGE_CLEARANCE_PX) }
    ];

    var targetDock = dockingPointOnSharedSide(target, 'r', connection);
    var targetLead = makePt(targetDock.x + EDGE_CLEARANCE_PX, targetDock.y);
    var best = current;
    var bestNoRun = currentNoRun;
    var bestScore = scoreDetourCandidatePath(current, connection, source, target, obstacles);

    railCandidates.forEach(function (rail) {
        if (rail.y <= topLimit - ORTHO_EPS || rail.y >= bottomLimit + ORTHO_EPS) {
            return;
        }
        var sourceDock = dockingPointOnSharedSide(source, rail.side, connection);
        var candidate = withoutRedundantPoints(
            ensureStrictlyOrthogonalWaypoints([
                snapshotWaypoint(sourceDock),
                makePt(sourceDock.x, rail.y),
                makePt(targetLead.x, rail.y),
                targetLead,
                snapshotWaypoint(targetDock)
            ])
        );
        if (
            pathViolatesSharedParticipantBounds(candidate, source, target) ||
            waypointsIntersectFlowObstacles(candidate, obstacles, SEQUENCE_FLOW_OBSTACLE_SEGMENT_CLEARANCE_PX) ||
            sequenceFlowWaypointsObstacleHitsExhaustive(candidate, obstacles, SEQUENCE_FLOW_OBSTACLE_SEGMENT_CLEARANCE_PX)
        ) {
            return;
        }
        var candidateNoRun = noRunBandScore(candidate, source, target, obstacles);
        var candidateHasInlineRun = pathHasInlineBackwardReturnRun(candidate, source, target, obstacles);
        var candidateScore = scoreDetourCandidatePath(candidate, connection, source, target, obstacles);
        if (
            candidateNoRun < bestNoRun ||
            (candidateNoRun === bestNoRun && hasInlineRun && !candidateHasInlineRun) ||
            (candidateNoRun === bestNoRun && candidateHasInlineRun === hasInlineRun && candidateScore < bestScore)
        ) {
            best = candidate;
            bestNoRun = candidateNoRun;
            hasInlineRun = candidateHasInlineRun;
            bestScore = candidateScore;
        }
    });

    return best;
}

function buildLocalClusterOneBendCandidate(start, end, horizontalFirst) {
    if (!start || !end) {
        return null;
    }
    if (Math.abs(start.x - end.x) < ORTHO_EPS || Math.abs(start.y - end.y) < ORTHO_EPS) {
        return [snapshotWaypoint(start), snapshotWaypoint(end)];
    }
    return horizontalFirst
        ? [snapshotWaypoint(start), makePt(end.x, start.y), snapshotWaypoint(end)]
        : [snapshotWaypoint(start), makePt(start.x, end.y), snapshotWaypoint(end)];
}

function collapseLeadingLocalJog(points, connection, source, target, elementRegistry, obstacleElements) {
    if (!Array.isArray(points) || points.length < 4 || !connection || !source || !target || !elementRegistry) {
        return points;
    }

    var sourceParticipant = findAncestorParticipant(source);
    var targetParticipant = findAncestorParticipant(target);
    if (!sourceParticipant || sourceParticipant !== targetParticipant) {
        return points;
    }

    var out = withoutRedundantPoints(cloneWaypoints(points));
    if (out.length < 4) {
        return out;
    }

    var p0 = getWpXY(out[0]);
    var p1 = getWpXY(out[1]);
    var p2 = getWpXY(out[2]);
    var p3 = getWpXY(out[3]);
    var obstacles = Array.isArray(obstacleElements)
        ? obstacleElements
        : filterObstacleElementsBetweenEndpoints(
              source,
              target,
              collectSequenceFlowObstacleElements(connection, elementRegistry),
              WAYPOINT_OBSTACLE_ENDPOINT_PAD_PX
          ).filter(function (el) {
              return !el.labelTarget;
          });
    var currentScore = scoreDetourCandidatePath(out, connection, source, target, obstacles);

    var h01 = Math.abs(p0.y - p1.y) < ORTHO_EPS;
    var v12 = Math.abs(p1.x - p2.x) < ORTHO_EPS;
    var h23 = Math.abs(p2.y - p3.y) < ORTHO_EPS;
    if (h01 && v12 && h23) {
        var firstLeg = Math.abs(p1.x - p0.x);
        var midLeg = Math.abs(p2.y - p1.y);
        var runLeg = Math.abs(p3.x - p2.x);
        if (firstLeg <= LEADING_LOCAL_JOG_MAX_PX && midLeg > ORTHO_EPS && runLeg > ORTHO_EPS) {
            var collapsedHVH = ensureStrictlyOrthogonalWaypoints(withoutRedundantPoints([out[0], makePt(p0.x, p2.y)].concat(out.slice(3))));
            if (
                !waypointsIntersectFlowObstacles(collapsedHVH, obstacles, SEQUENCE_FLOW_OBSTACLE_SEGMENT_CLEARANCE_PX) &&
                scoreDetourCandidatePath(collapsedHVH, connection, source, target, obstacles) < currentScore
            ) {
                return collapsedHVH;
            }
        }
    }

    var v01 = Math.abs(p0.x - p1.x) < ORTHO_EPS;
    var h12 = Math.abs(p1.y - p2.y) < ORTHO_EPS;
    var v23 = Math.abs(p2.x - p3.x) < ORTHO_EPS;
    if (v01 && h12 && v23) {
        var firstLegY = Math.abs(p1.y - p0.y);
        var midLegX = Math.abs(p2.x - p1.x);
        var runLegY = Math.abs(p3.y - p2.y);
        if (firstLegY <= LEADING_LOCAL_JOG_MAX_PX && midLegX > ORTHO_EPS && runLegY > ORTHO_EPS) {
            var collapsedVHV = ensureStrictlyOrthogonalWaypoints(withoutRedundantPoints([out[0], makePt(p2.x, p0.y)].concat(out.slice(3))));
            if (
                !waypointsIntersectFlowObstacles(collapsedVHV, obstacles, SEQUENCE_FLOW_OBSTACLE_SEGMENT_CLEARANCE_PX) &&
                scoreDetourCandidatePath(collapsedVHV, connection, source, target, obstacles) < currentScore
            ) {
                return collapsedVHV;
            }
        }
    }

    return out;
}

function simplifyLocalClusterWaypoints(points, connection, source, target, elementRegistry, obstacleElements) {
    if (!Array.isArray(points) || points.length < 4 || !connection || !source || !target || !elementRegistry) {
        return points;
    }

    var sourceParticipant = findAncestorParticipant(source);
    var targetParticipant = findAncestorParticipant(target);
    if (!sourceParticipant || sourceParticipant !== targetParticipant) {
        return points;
    }

    var start = getWpXY(points[0]);
    var end = getWpXY(points[points.length - 1]);
    var dx = Math.abs(end.x - start.x);
    var dy = Math.abs(end.y - start.y);
    if (dx > LOCAL_CLUSTER_MAX_DX_PX || dy > LOCAL_CLUSTER_MAX_DY_PX) {
        return points;
    }

    var obstacles = Array.isArray(obstacleElements)
        ? obstacleElements
        : filterObstacleElementsBetweenEndpoints(
              source,
              target,
              collectSequenceFlowObstacleElements(connection, elementRegistry),
              WAYPOINT_OBSTACLE_ENDPOINT_PAD_PX
          ).filter(function (el) {
              return !el.labelTarget;
          });

    var current = withoutRedundantPoints(cloneWaypoints(points));
    var currentScore = scoreDetourCandidatePath(current, connection, source, target, obstacles);
    var candidates = [buildLocalClusterOneBendCandidate(start, end, true), buildLocalClusterOneBendCandidate(start, end, false)];

    var best = current;
    var bestScore = currentScore;
    for (var i = 0; i < candidates.length; i++) {
        var candidate = candidates[i];
        if (!candidate) {
            continue;
        }
        candidate = ensureStrictlyOrthogonalWaypoints(withoutRedundantPoints(candidate));
        if (candidate.length > current.length) {
            continue;
        }
        if (waypointsIntersectFlowObstacles(candidate, obstacles, SEQUENCE_FLOW_OBSTACLE_SEGMENT_CLEARANCE_PX)) {
            continue;
        }
        var candidateScore = scoreDetourCandidatePath(candidate, connection, source, target, obstacles);
        if (candidateScore < bestScore) {
            best = candidate;
            bestScore = candidateScore;
        }
    }

    return best;
}

function rerouteTailAwayFromTargetNoRunBand(points, target) {
    if (!Array.isArray(points) || points.length < 3 || !target) {
        return points;
    }

    var rect = obstacleRectForSegmentHitTest(target, 0);
    if (!rect || rect.width <= 0 || rect.height <= 0) {
        return points;
    }

    var lastSegIndex = points.length - 2;
    var offendingSeg = -1;
    for (var i = 0; i < lastSegIndex; i++) {
        var a = getWpXY(points[i]);
        var b = getWpXY(points[i + 1]);
        if (segmentRunsParallelNearRect(a.x, a.y, b.x, b.y, rect, NODE_NO_RUN_CLEARANCE_PX, NODE_NO_RUN_MIN_SEGMENT_PX)) {
            offendingSeg = i;
        }
    }

    if (offendingSeg === -1) {
        return points;
    }

    var last = snapshotWaypoint(points[points.length - 1]);
    var penultimate = snapshotWaypoint(points[points.length - 2]);
    var tailStart = snapshotWaypoint(points[offendingSeg]);
    var outsidePad = NODE_NO_RUN_CLEARANCE_PX + EDGE_CLEARANCE_PX;
    var rebuilt = cloneWaypoints(points.slice(0, offendingSeg + 1));

    if (Math.abs(penultimate.x - last.x) < ORTHO_EPS) {
        var outsideY = last.y >= rect.y + rect.height / 2 ? rect.y + rect.height + outsidePad : rect.y - outsidePad;
        if (Math.abs(tailStart.y - outsideY) > ORTHO_EPS) {
            rebuilt.push(makePt(tailStart.x, outsideY));
        }
        if (Math.abs(tailStart.x - last.x) > ORTHO_EPS || Math.abs(outsideY - (rebuilt[rebuilt.length - 1] || {}).y) > ORTHO_EPS) {
            rebuilt.push(makePt(last.x, outsideY));
        }
        rebuilt.push(last);
        return withoutRedundantPoints(rebuilt);
    }

    if (Math.abs(penultimate.y - last.y) < ORTHO_EPS) {
        var outsideX = last.x >= rect.x + rect.width / 2 ? rect.x + rect.width + outsidePad : rect.x - outsidePad;
        if (Math.abs(tailStart.x - outsideX) > ORTHO_EPS) {
            rebuilt.push(makePt(outsideX, tailStart.y));
        }
        rebuilt.push(makePt(outsideX, last.y));
        rebuilt.push(last);
        return withoutRedundantPoints(rebuilt);
    }

    return points;
}

/**
 * 타깃 직전이 아닌 수평 세그먼트가 target bbox(확장)에 평행 밀착(no-run)이면, 위·아래로 한 번 꺾어 세그먼트를 벗어나게 한다.
 * E2E `hasParallelRunNearNode`·스펙 C-NoRun 정합.
 */
function breakAxisSegmentsAlongTargetNoRunBand(pts, target, connection, elementRegistry) {
    if (isSequenceFlowImportLayoutActive() || !Array.isArray(pts) || pts.length < 3 || !target || !connection || !elementRegistry) {
        return pts;
    }
    var source = connection.source;
    if (!source) {
        return pts;
    }
    var rect = obstacleRectForSegmentHitTest(target, 0);
    if (!rect || rect.width <= 0 || rect.height <= 0) {
        return pts;
    }
    var obstacles = collectSequenceFlowObstacleElements(connection, elementRegistry).filter(function (el) {
        return !el.labelTarget;
    });
    var clear = SEQUENCE_FLOW_OBSTACLE_SEGMENT_CLEARANCE_PX;
    var pad = NODE_NO_RUN_CLEARANCE_PX + EDGE_CLEARANCE_PX;
    var out = cloneWaypoints(pts);
    var i;
    for (i = 0; i < out.length - 2; i++) {
        var a = getWpXY(out[i]);
        var b = getWpXY(out[i + 1]);
        if (!segmentRunsParallelNearRect(a.x, a.y, b.x, b.y, rect, NODE_NO_RUN_CLEARANCE_PX, NODE_NO_RUN_MIN_SEGMENT_PX)) {
            continue;
        }
        var horiz = Math.abs(a.y - b.y) < ORTHO_EPS && Math.abs(a.x - b.x) > ORTHO_EPS;
        var vert = Math.abs(a.x - b.x) < ORTHO_EPS && Math.abs(a.y - b.y) > ORTHO_EPS;
        if (!horiz && !vert) {
            continue;
        }
        var trialCandidates = [];
        if (horiz) {
            var yAbove = rect.y - pad;
            var yBelow = rect.y + rect.height + pad;
            /** 입력 미세 차이에 따라 분기하지 않도록 y 후보는 항상 오름차순으로만 시도한다. */
            var yOrder = yAbove <= yBelow ? [yAbove, yBelow] : [yBelow, yAbove];
            var yi;
            for (yi = 0; yi < yOrder.length; yi++) {
                var yOut = yOrder[yi];
                if (Math.abs(yOut - a.y) < ORTHO_EPS) {
                    continue;
                }
                var t = cloneWaypoints(out);
                t.splice(i + 1, 0, snapshotWaypoint(makePt(a.x, yOut)), snapshotWaypoint(makePt(b.x, yOut)));
                trialCandidates.push(withoutRedundantPoints(ensureStrictlyOrthogonalWaypoints(t)));
            }
        } else {
            var xLeft = rect.x - pad;
            var xRight = rect.x + rect.width + pad;
            var xOrder = xLeft <= xRight ? [xLeft, xRight] : [xRight, xLeft];
            var xi;
            for (xi = 0; xi < xOrder.length; xi++) {
                var xOut = xOrder[xi];
                if (Math.abs(xOut - a.x) < ORTHO_EPS) {
                    continue;
                }
                var t2 = cloneWaypoints(out);
                t2.splice(i + 1, 0, snapshotWaypoint(makePt(xOut, a.y)), snapshotWaypoint(makePt(xOut, b.y)));
                trialCandidates.push(withoutRedundantPoints(ensureStrictlyOrthogonalWaypoints(t2)));
            }
        }
        // perf: score 를 sort 전에 1회만 계산. 이전엔 sort comparator 가 N log N 번 호출하면서
        // 매번 scoreDetourCandidatePath (그 안에서 또 평행 검사 등) 를 반복.
        var validTrials = [];
        var ti;
        for (ti = 0; ti < trialCandidates.length; ti++) {
            var trial = trialCandidates[ti];
            if (waypointsIntersectFlowObstacles(trial, obstacles, clear)) {
                continue;
            }
            if (pathViolatesSharedParticipantBounds(trial, source, target)) {
                continue;
            }
            validTrials.push({
                trial: trial,
                score: scoreDetourCandidatePath(trial, connection, source, target, obstacles)
            });
        }
        if (!validTrials.length) {
            continue;
        }
        validTrials.sort(function (ea, eb) {
            var ta = ea.trial;
            var tb = eb.trial;
            if (ta.length !== tb.length) {
                return ta.length - tb.length;
            }
            if (ea.score !== eb.score) {
                return ea.score - eb.score;
            }
            var fa = getWpXY(ta[0]);
            var fb = getWpXY(tb[0]);
            if (fa.x !== fb.x) {
                return fa.x - fb.x;
            }
            return fa.y - fb.y;
        });
        /** 한 연결당 첫 no-run 위반만 고쳐 웨이포인트 폭주를 막는다 (외부 S-Loop와 역할 분담). */
        return validTrials[0].trial;
    }
    return out;
}

export function resolveSequenceFlowWaypointObstacles(pts, connection, elementRegistry, obstacleElements) {
    if (isSequenceFlowImportLayoutActive()) {
        return;
    }
    if (!Array.isArray(pts) || pts.length < 2 || !connection || !elementRegistry) {
        return;
    }

    var source = connection.source;
    var target = connection.target;
    if (!source || !target) {
        return;
    }

    var obstacles = Array.isArray(obstacleElements)
        ? obstacleElements
        : filterObstacleElementsBetweenEndpoints(
              source,
              target,
              collectSequenceFlowObstacleElements(connection, elementRegistry),
              WAYPOINT_OBSTACLE_ENDPOINT_PAD_PX
          ).filter(function (el) {
              return !el.labelTarget;
          });
    if (!obstacles.length) {
        return;
    }

    tryLogElementBoundsBeforeObstacleCheck(elementRegistry, connection, 'waypoint-obstacle');

    var extraPad = OBSTACLE_CLEARANCE_PX + DETOUR_EXTRA_PX;
    var iter;
    var repeatStrike = {};
    resolveObstacleLoop: for (iter = 0; iter < MAX_ITERATIONS; iter++) {
        var changed = false;
        var seg;
        for (seg = 0; seg < pts.length - 1; seg++) {
            var pa = pts[seg];
            var pb = pts[seg + 1];
            var ax = pa.x;
            var ay = pa.y;
            var bx = pb.x;
            var by = pb.y;
            if (typeof ax !== 'number' || typeof ay !== 'number' || typeof bx !== 'number' || typeof by !== 'number') {
                continue;
            }

            var firstStripHalf = seg === 0 ? getFirstSegmentStripHalfThickness(source) : 0;
            var segmentFilterPadPx = firstStripHalf > 0 ? SEGMENT_OBSTACLE_FILTER_PAD_PX + firstStripHalf : SEGMENT_OBSTACLE_FILTER_PAD_PX;

            var obstaclesSeg = filterObstaclesForSegment(obstacles, ax, ay, bx, by, segmentFilterPadPx);

            var candidates = [];
            var oi;
            for (oi = 0; oi < obstaclesSeg.length; oi++) {
                var el = obstaclesSeg[oi];
                var rectHit = obstacleRectForSegmentHitTest(el, HIT_CLEARANCE_PX);
                if (rectHit.width <= 0 || rectHit.height <= 0) {
                    continue;
                }
                var segHit =
                    firstStripHalf > 0
                        ? segmentStripIntersectsRect(ax, ay, bx, by, firstStripHalf, rectHit)
                        : segmentIntersectsRect(ax, ay, bx, by, rectHit);
                if (!segHit) {
                    continue;
                }
                var rectDetour = obstacleRectForSegmentHitTest(el, OBSTACLE_CLEARANCE_PX);
                var det = buildDetourForSegment(ax, ay, bx, by, rectDetour, extraPad, source, target, firstStripHalf);
                if (!det || !det.length) {
                    continue;
                }
                var tHit = firstHitTAlongSegment(ax, ay, bx, by, rectHit);
                candidates.push({ el: el, detour: det, tHit: tHit, id: el.id || '' });
            }

            if (!candidates.length) {
                continue;
            }

            var ranked = candidates
                .map(function (candidate) {
                    var trial = pts
                        .slice(0, seg + 1)
                        .concat(candidate.detour)
                        .concat(pts.slice(seg + 1));
                    var reduced = withoutRedundantPoints(trial);
                    return {
                        el: candidate.el,
                        detour: candidate.detour,
                        tHit: candidate.tHit,
                        id: candidate.id,
                        score: scoreDetourCandidatePath(reduced, connection, source, target, obstacles)
                    };
                })
                .filter(function (candidate) {
                    return isFinite(candidate.score);
                });

            if (!ranked.length) {
                if (!candidates.length) {
                    continue;
                }
                var legacySorted = candidates.slice().sort(function (a, b) {
                    if (a.tHit !== b.tHit) {
                        return a.tHit - b.tHit;
                    }
                    return String(a.id).localeCompare(String(b.id));
                });
                ranked = [
                    {
                        el: legacySorted[0].el,
                        detour: legacySorted[0].detour,
                        tHit: legacySorted[0].tHit,
                        id: legacySorted[0].id,
                        score: Number.MAX_SAFE_INTEGER
                    }
                ];
            }

            ranked.sort(function (a, b) {
                if (a.score !== b.score) {
                    return a.score - b.score;
                }
                if (a.tHit !== b.tHit) {
                    return a.tHit - b.tHit;
                }
                return String(a.id).localeCompare(String(b.id));
            });

            var first = ranked[0];
            var detour = first.detour;
            var hitObstacleEl = first.el;

            var strikeKey = (hitObstacleEl && hitObstacleEl.id ? hitObstacleEl.id : '?') + '#' + seg;
            repeatStrike[strikeKey] = (repeatStrike[strikeKey] || 0) + 1;
            if (repeatStrike[strikeKey] > MAX_SAME_OBSTACLE_STRIKES) {
                break resolveObstacleLoop;
            }

            var toInsert = filterDuplicateInsertions(pa, pb, detour);
            if (!toInsert.length) {
                continue;
            }

            logObstacleHit(connection, seg, ax, ay, bx, by, hitObstacleEl);

            var args = [seg + 1, 0].concat(toInsert);
            pts.splice.apply(pts, args);
            changed = true;
            break;
        }

        if (!changed) {
            break;
        }
    }

    var cleaned = withoutRedundantPoints(pts);
    var jogged = collapseMicroOrthogonalJogs(cleaned, connection, elementRegistry);
    var targetAdjusted = rerouteTailAwayFromTargetNoRunBand(jogged, target);
    var finalPts = withoutRedundantPoints(targetAdjusted);
    for (var i = 0; i < finalPts.length; i++) {
        pts[i] = finalPts[i];
    }
    pts.length = finalPts.length;
}

function sameAxisProgressSign(dFirst, dMerged) {
    if (Math.abs(dFirst) < ORTHO_EPS || Math.abs(dMerged) < ORTHO_EPS) {
        return true;
    }
    return (dFirst > 0 && dMerged > 0) || (dFirst < 0 && dMerged < 0);
}

function removeOrthogonalStairSteps(pts) {
    if (!Array.isArray(pts) || pts.length < 4) {
        return pts;
    }
    var out = cloneWaypoints(pts);
    var changed = true;
    var guard = 0;
    while (changed && guard < 48) {
        guard++;
        changed = false;
        var n = out.length;
        if (n < 4) {
            break;
        }
        var i;
        for (i = 0; i <= n - 4; i++) {
            var p0 = out[i];
            var p1 = out[i + 1];
            var p2 = out[i + 2];
            var p3 = out[i + 3];
            var h01 = Math.abs(p0.y - p1.y) < ORTHO_EPS;
            var v12 = Math.abs(p1.x - p2.x) < ORTHO_EPS;
            var h23 = Math.abs(p2.y - p3.y) < ORTHO_EPS;
            if (h01 && v12 && h23 && Math.abs(p0.x - p1.x) > ORTHO_EPS) {
                var q = snapshotWaypoint({ x: p3.x, y: p0.y });
                var dxFirst = p1.x - p0.x;
                var dxMerged = p3.x - p0.x;
                if (
                    !pointsNearlyEqualOrtho(p0, q) &&
                    !pointsNearlyEqualOrtho(p3, q) &&
                    Math.abs(p0.y - p3.y) > ORTHO_EPS &&
                    sameAxisProgressSign(dxFirst, dxMerged)
                ) {
                    out.splice(i + 1, 2, q);
                    changed = true;
                    break;
                }
            }
            var v01 = Math.abs(p0.x - p1.x) < ORTHO_EPS;
            var h12 = Math.abs(p1.y - p2.y) < ORTHO_EPS;
            var v23 = Math.abs(p2.x - p3.x) < ORTHO_EPS;
            if (v01 && h12 && v23 && Math.abs(p0.y - p1.y) > ORTHO_EPS) {
                var q2 = snapshotWaypoint({ x: p0.x, y: p3.y });
                var dyFirst = p1.y - p0.y;
                var dyMerged = p3.y - p0.y;
                if (
                    !pointsNearlyEqualOrtho(p0, q2) &&
                    !pointsNearlyEqualOrtho(p3, q2) &&
                    Math.abs(p0.x - p3.x) > ORTHO_EPS &&
                    sameAxisProgressSign(dyFirst, dyMerged)
                ) {
                    out.splice(i + 1, 2, q2);
                    changed = true;
                    break;
                }
            }
        }
    }
    return withoutRedundantPoints(out);
}

function ensureStrictlyOrthogonalWaypoints(pts) {
    if (!Array.isArray(pts) || pts.length < 2) {
        return pts;
    }
    var expanded = pts.map(snapshotWaypoint);
    var out = [expanded[0]];
    for (var j = 1; j < expanded.length; j++) {
        var prev = out[out.length - 1];
        var curr = expanded[j];
        var dx = curr.x - prev.x;
        var dy = curr.y - prev.y;
        if (Math.abs(dx) > ORTHO_EPS && Math.abs(dy) > ORTHO_EPS) {
            if (Math.abs(dx) >= Math.abs(dy)) {
                out.push({ x: curr.x, y: prev.y });
            } else {
                out.push({ x: prev.x, y: curr.y });
            }
        }
        out.push(curr);
    }
    return withoutRedundantPoints(out);
}

function inferDockSideFromPointOnShape(shape, pt) {
    var b = getShapeBounds(shape);
    if (!b || !pt) return null;
    var tol = EDGE_TOL_PX;
    var dxL = Math.abs(pt.x - b.x);
    var dxR = Math.abs(pt.x - b.r);
    var dyT = Math.abs(pt.y - b.y);
    var dyB = Math.abs(pt.y - b.b);

    var onL = dxL <= tol;
    var onR = dxR <= tol;
    var onT = dyT <= tol;
    var onB = dyB <= tol;

    if (onT && onL) return dxL < dyT ? 'l' : 't';
    if (onT && onR) return dxR < dyT ? 'r' : 't';
    if (onB && onL) return dxL < dyB ? 'l' : 'b';
    if (onB && onR) return dxR < dyB ? 'r' : 'b';
    if (onT) return 't';
    if (onB) return 'b';
    if (onL) return 'l';
    if (onR) return 'r';

    var best = 'l';
    var bestD = dxL;
    if (dxR < bestD) {
        bestD = dxR;
        best = 'r';
    }
    if (dyT < bestD) {
        bestD = dyT;
        best = 't';
    }
    if (dyB < bestD) {
        best = 'b';
    }
    return best;
}

function alignSecondPointToExitNormal(p0, p1, side) {
    if (!side || !p0 || !p1) return snapshotWaypoint(p1);
    var orig =
        p1.original && typeof p1.original.x === 'number' && typeof p1.original.y === 'number'
            ? { x: p1.original.x, y: p1.original.y }
            : { x: p1.x, y: p1.y };
    if (side === 't' || side === 'b') {
        return { x: p0.x, y: p1.y, original: orig };
    }
    if (side === 'l' || side === 'r') {
        return { x: p1.x, y: p0.y, original: orig };
    }
    return snapshotWaypoint(p1);
}

function alignPenultimateToApproachNormal(pPrev, pLast, side) {
    if (!side || !pPrev || !pLast) return snapshotWaypoint(pPrev);
    var orig =
        pPrev.original && typeof pPrev.original.x === 'number' && typeof pPrev.original.y === 'number'
            ? { x: pPrev.original.x, y: pPrev.original.y }
            : { x: pPrev.x, y: pPrev.y };
    if (side === 't' || side === 'b') {
        return { x: pLast.x, y: pPrev.y, original: orig };
    }
    if (side === 'l' || side === 'r') {
        return { x: pPrev.x, y: pLast.y, original: orig };
    }
    return snapshotWaypoint(pPrev);
}

function collapseTinyTargetJog(pts, target, side) {
    if (!Array.isArray(pts) || pts.length < 3 || !target || !side) {
        return pts;
    }

    var bounds = getShapeBounds(target);
    if (!bounds) {
        return pts;
    }

    var out = cloneWaypoints(pts);
    var n = out.length;
    var last = out[n - 1];
    var penultimate = out[n - 2];

    if (side === 'l' || side === 'r') {
        if (Math.abs(penultimate.x - last.x) < ORTHO_EPS && penultimate.y > last.y && penultimate.y - last.y <= TARGET_TINY_JOG_MAX_PX) {
            last.y = clamp(penultimate.y, bounds.y, bounds.b);
            syncPtOriginal(last);
        }

        if (n >= 4) {
            var beforeApproach = out[n - 3];
            if (
                Math.abs(beforeApproach.x - penultimate.x) < ORTHO_EPS &&
                Math.abs(beforeApproach.y - penultimate.y) <= TARGET_TINY_JOG_MAX_PX &&
                Math.abs(penultimate.y - last.y) < ORTHO_EPS
            ) {
                var alignedY = clamp(beforeApproach.y, bounds.y, bounds.b);
                penultimate.y = alignedY;
                last.y = alignedY;
                syncPtOriginal(penultimate);
                syncPtOriginal(last);
            }
        }
    }

    if (side === 't' || side === 'b') {
        if (Math.abs(penultimate.y - last.y) < ORTHO_EPS && penultimate.x > last.x && penultimate.x - last.x <= TARGET_TINY_JOG_MAX_PX) {
            last.x = clamp(penultimate.x, bounds.x, bounds.r);
            syncPtOriginal(last);
        }

        if (n >= 4) {
            var beforeApproachV = out[n - 3];
            if (
                Math.abs(beforeApproachV.y - penultimate.y) < ORTHO_EPS &&
                Math.abs(beforeApproachV.x - penultimate.x) <= TARGET_TINY_JOG_MAX_PX &&
                Math.abs(penultimate.x - last.x) < ORTHO_EPS
            ) {
                var alignedX = clamp(beforeApproachV.x, bounds.x, bounds.r);
                penultimate.x = alignedX;
                last.x = alignedX;
                syncPtOriginal(penultimate);
                syncPtOriginal(last);
            }
        }
    }

    return withoutRedundantPoints(out);
}

function alignThirdPointStraightAfterExit(pts, source) {
    if (pts.length < 4) return;
    var sideS = inferDockSideFromPointOnShape(source, pts[0]);
    var orig3 = pts[2].original;
    if (sideS === 't' || sideS === 'b') {
        pts[2] = snapshotWaypoint({
            x: pts[2].x,
            y: pts[1].y,
            original: orig3
        });
    } else if (sideS === 'l' || sideS === 'r') {
        pts[2] = snapshotWaypoint({
            x: pts[1].x,
            y: pts[2].y,
            original: orig3
        });
    }
}

function alignThirdPointStraightBeforeApproach(pts, target) {
    if (pts.length < 4) return;
    var n = pts.length;
    var sideT = inferDockSideFromPointOnShape(target, pts[n - 1]);
    var orig3 = pts[n - 3].original;
    if (sideT === 't' || sideT === 'b') {
        pts[n - 3] = snapshotWaypoint({
            x: pts[n - 3].x,
            y: pts[n - 2].y,
            original: orig3
        });
    } else if (sideT === 'l' || sideT === 'r') {
        pts[n - 3] = snapshotWaypoint({
            x: pts[n - 2].x,
            y: pts[n - 3].y,
            original: orig3
        });
    }
}

function mergeMiddleCornerForFivePoints(pts, source) {
    if (pts.length !== 5) return;
    var sideS = inferDockSideFromPointOnShape(source, pts[0]);
    if (!sideS) return;
    var orig2 = pts[2].original;
    if (sideS === 't' || sideS === 'b') {
        pts[2] = snapshotWaypoint({
            x: pts[3].x,
            y: pts[1].y,
            original: orig2
        });
    } else if (sideS === 'l' || sideS === 'r') {
        pts[2] = snapshotWaypoint({
            x: pts[1].x,
            y: pts[3].y,
            original: orig2
        });
    }
}

function syncWaypointOriginal(pt) {
    if (pt && pt.original && typeof pt.original.x === 'number' && typeof pt.original.y === 'number') {
        pt.original.x = pt.x;
        pt.original.y = pt.y;
    }
}

function ensureMinExitLegLength(p0, p1, side, minLen) {
    if (!p0 || !p1 || !side || minLen <= 0) return;
    if (side === 't') {
        if (p1.y > p0.y - minLen) p1.y = p0.y - minLen;
    } else if (side === 'b') {
        if (p1.y < p0.y + minLen) p1.y = p0.y + minLen;
    } else if (side === 'l') {
        if (p1.x > p0.x - minLen) p1.x = p0.x - minLen;
    } else if (side === 'r') {
        if (p1.x < p0.x + minLen) p1.x = p0.x + minLen;
    }
    syncWaypointOriginal(p1);
}

function ensureMinApproachLegLength(pPrev, pLast, side, minLen) {
    if (!pPrev || !pLast || !side || minLen <= 0) return;
    if (side === 't') {
        if (pPrev.y > pLast.y - minLen) pPrev.y = pLast.y - minLen;
    } else if (side === 'b') {
        if (pPrev.y < pLast.y + minLen) pPrev.y = pLast.y + minLen;
    } else if (side === 'l') {
        if (pPrev.x > pLast.x - minLen) pPrev.x = pLast.x - minLen;
    } else if (side === 'r') {
        if (pPrev.x < pLast.x + minLen) pPrev.x = pLast.x + minLen;
    }
    syncWaypointOriginal(pPrev);
}

function snapEndpointsToAdjacentSegmentSides(pts, source, target, connection) {
    if (!Array.isArray(pts) || pts.length < 2 || !source || !target) {
        return pts;
    }

    var out = cloneWaypoints(pts);
    var last = out.length - 1;
    var sourceSide = inferDockSideFromSegmentDirection(source, out[0], out[1]);
    var targetSide = inferDockSideFromSegmentDirection(target, out[last], out[last - 1]);

    if (sourceSide) {
        out[0] = connection ? dockingPointOnSharedSide(source, sourceSide, connection) : dockingPointOnSideMid(source, sourceSide);
        out[1] = alignSecondPointToExitNormal(out[0], out[1], sourceSide);
        ensureMinExitLegLength(out[0], out[1], sourceSide, EDGE_CLEARANCE_PX);
    }

    if (targetSide) {
        last = out.length - 1;
        out[last] = connection ? dockingPointOnSharedSide(target, targetSide, connection) : dockingPointOnSideMid(target, targetSide);
        out[last - 1] = alignPenultimateToApproachNormal(out[last - 1], out[last], targetSide);
        ensureMinApproachLegLength(out[last - 1], out[last], targetSide, EDGE_CLEARANCE_PX);
    }

    return withoutRedundantPoints(ensureStrictlyOrthogonalWaypoints(out));
}

function nudgeInteriorWaypointsClearOfShapeEdges(pts, source, target, marginPx) {
    if (!Array.isArray(pts) || pts.length < 3 || marginPx <= 0) return;
    var m = marginPx;
    var bs = getShapeBounds(source);
    var bt = getShapeBounds(target);
    var i;
    var last = pts.length - 1;

    function nudgePointAwayFromRect(pt, b) {
        if (!pt || !b) return;
        if (pt.x <= b.x && b.x - pt.x < m) {
            pt.x = b.x - m;
        }
        if (pt.x >= b.r && pt.x - b.r < m) {
            pt.x = b.r + m;
        }
        if (pt.y <= b.y && b.y - pt.y < m) {
            pt.y = b.y - m;
        }
        if (pt.y >= b.b && pt.y - b.b < m) {
            pt.y = b.b + m;
        }
        syncWaypointOriginal(pt);
    }

    for (i = 1; i < last; i++) {
        if (bs) {
            nudgePointAwayFromRect(pts[i], bs);
        }
        if (bt) {
            nudgePointAwayFromRect(pts[i], bt);
        }
    }
}

/** C-Short: bbox 간격·중심거리로 인접 근접 연결 판정 (도킹 스프레드 완화·끝 단순화 대상) */
var SHORT_LINK_GAP_PX = 72;
var SHORT_LINK_CENTER_DISTANCE_PX = 180;

function shapeGap1D(aStart, aEnd, bStart, bEnd) {
    if (aEnd < bStart) {
        return bStart - aEnd;
    }
    if (bEnd < aStart) {
        return aStart - bEnd;
    }
    return 0;
}

/**
 * @param {import('diagram-js/lib/core/Types').Shape} source
 * @param {import('diagram-js/lib/core/Types').Shape} target
 * @returns {boolean}
 */
export function isShortAdjacentSequenceFlow(source, target) {
    if (!source || !target) {
        return false;
    }
    var sx2 = source.x + (source.width || 0);
    var sy2 = source.y + (source.height || 0);
    var tx2 = target.x + (target.width || 0);
    var ty2 = target.y + (target.height || 0);
    var gapX = shapeGap1D(source.x, sx2, target.x, tx2);
    var gapY = shapeGap1D(source.y, sy2, target.y, ty2);
    var sm = getMid(source);
    var tm = getMid(target);
    var dx = sm.x - tm.x;
    var dy = sm.y - tm.y;
    var centerDistance = Math.sqrt(dx * dx + dy * dy);
    return (gapX <= SHORT_LINK_GAP_PX || gapY <= SHORT_LINK_GAP_PX) && centerDistance <= SHORT_LINK_CENTER_DISTANCE_PX;
}

/**
 * C-Short 후처리: 직선 직교·장애물 무겹치면 2점, 아니면 최대 4점으로 축소.
 */
function simplifyShortLinkWaypoints(pts, source, target, connection, elementRegistry) {
    if (!Array.isArray(pts) || pts.length < 2) {
        return pts;
    }
    var cleaned = withoutRedundantPoints(cloneWaypoints(pts));
    if (cleaned.length < 2) {
        return cleaned;
    }
    var first = cleaned[0];
    var last = cleaned[cleaned.length - 1];
    var f0 = snapshotWaypoint(first);
    var f1 = snapshotWaypoint(last);
    var fx = f0.x;
    var fy = f0.y;
    var lx = f1.x;
    var ly = f1.y;
    if (!isFinite(fx) || !isFinite(fy) || !isFinite(lx) || !isFinite(ly)) {
        return cleaned;
    }
    var horizontalLine = Math.abs(fy - ly) < ORTHO_EPS && Math.abs(fx - lx) > ORTHO_EPS;
    var verticalLine = Math.abs(fx - lx) < ORTHO_EPS && Math.abs(fy - ly) > ORTHO_EPS;
    if (horizontalLine || verticalLine) {
        var trial = withoutRedundantPoints([
            snapshotWaypoint({ x: fx, y: fy, original: f0.original }),
            snapshotWaypoint({ x: lx, y: ly, original: f1.original })
        ]);
        if (!connection || !elementRegistry) {
            return trial;
        }
        var obstacles = collectSequenceFlowObstacleElements(connection, elementRegistry);
        if (!waypointsIntersectFlowObstacles(trial, obstacles, SEQUENCE_FLOW_OBSTACLE_SEGMENT_CLEARANCE_PX)) {
            return trial;
        }
    }
    if (cleaned.length > 4) {
        return withoutRedundantPoints([cleaned[0], cleaned[1], cleaned[cleaned.length - 2], cleaned[cleaned.length - 1]]);
    }
    return cleaned;
}

/** 직교 우회·충돌 해소를 번갈아 적용할 때 바깥 루프 상한 (무한 루프 방지) */
// yFiles OrthogonalRouter 기준 보통 2~3 pass 면 수렴. 16 은 안전 마진이지만 어려운 케이스 대부분 8 안에서 끝남.
// perf 단계 C: 16 → 8 로 fallback 한도 절반. P2 fast path (ROUTE_ENGINE_REDUCED_OUTER_PASSES = 3) 은 그대로.
var MAX_ORTHO_OBSTACLE_OUTER_PASSES = 8;

/**
 * 연속 세그먼트가 모두 수평·수직인지 (대각선 구간 없음).
 */
function sequenceFlowSegmentsAreOrthogonal(pts) {
    if (!Array.isArray(pts) || pts.length < 2) {
        return true;
    }
    for (var i = 1; i < pts.length; i++) {
        var prev = pts[i - 1];
        var curr = pts[i];
        var dx = curr.x - prev.x;
        var dy = curr.y - prev.y;
        if (Math.abs(dx) > ORTHO_EPS && Math.abs(dy) > ORTHO_EPS) {
            return false;
        }
    }
    return true;
}

/**
 * 시퀀스 플로우가 수집된 FlowNode 장애물과 세그먼트 clearance 내에서 교차하는지.
 */
function sequenceFlowWaypointsObstacleHits(pts, connection, elementRegistry, obstacleElements) {
    if (!Array.isArray(pts) || pts.length < 2 || !connection || !elementRegistry) {
        return false;
    }
    var obstacles = Array.isArray(obstacleElements) ? obstacleElements : collectSequenceFlowObstacleElements(connection, elementRegistry);
    if (!obstacles || obstacles.length === 0) {
        return false;
    }
    return waypointsIntersectFlowObstacles(pts, obstacles, SEQUENCE_FLOW_OBSTACLE_SEGMENT_CLEARANCE_PX);
}

function sequenceFlowWaypointsObstacleHitsExhaustive(pts, obstacleElements, clearancePx) {
    if (!Array.isArray(pts) || pts.length < 2 || !Array.isArray(obstacleElements) || !obstacleElements.length) {
        return false;
    }
    var c = clearancePx == null ? SEQUENCE_FLOW_OBSTACLE_SEGMENT_CLEARANCE_PX : clearancePx;
    for (var i = 0; i < pts.length - 1; i++) {
        var a = getWpXY(pts[i]);
        var b = getWpXY(pts[i + 1]);
        if (typeof a.x !== 'number' || typeof a.y !== 'number' || typeof b.x !== 'number' || typeof b.y !== 'number') {
            continue;
        }
        for (var j = 0; j < obstacleElements.length; j++) {
            var rect = obstacleRectForSegmentHitTest(obstacleElements[j], c);
            if (rect.width > 0 && rect.height > 0 && segmentIntersectsRect(a.x, a.y, b.x, b.y, rect)) {
                return true;
            }
        }
    }
    return false;
}

/**
 * S-OrthoManhattan: 직교 정리·도킹·nudge·participant 클램프.
 * 내부 **S-Loop**: 세그먼트 직교(C-Ortho) · 장애물 충돌 · 도킹 축 일치(C-Dock) 중 하나라도 실패 시 resolve/collapse/simplify 반복.
 */
export function applyOrthogonalManhattanSequenceFlow(
    waypoints,
    source,
    target,
    _horizontalLayout,
    _connection,
    _elementRegistry,
    _lockedFacingSides
) {
    if (!Array.isArray(waypoints) || waypoints.length < 2 || !source || !target) {
        return waypoints;
    }

    var shortLink = isShortAdjacentSequenceFlow(source, target);

    var pts = waypoints.map(snapshotWaypoint);
    pts = ensureStrictlyOrthogonalWaypoints(pts);
    var obstacleContext = _connection && _elementRegistry ? createSequenceFlowObstacleContext(_connection, _elementRegistry) : null;
    var routeStart = getWpXY(pts[0]);
    var routeEnd = getWpXY(pts[pts.length - 1]);
    var isLocalClusterRange =
        Math.abs(routeEnd.x - routeStart.x) <= LOCAL_CLUSTER_MAX_DX_PX && Math.abs(routeEnd.y - routeStart.y) <= LOCAL_CLUSTER_MAX_DY_PX;
    var routeMetrics = {
        connectionId: _connection && _connection.id ? _connection.id : null,
        p1CandidateCount: 0,
        p2CandidateCount: 0,
        selectedFromP2: false,
        selectedTemplateKind: null,
        obstacleCount: obstacleContext ? obstacleContext.flowNodes.length : 0,
        outerPasses: 0,
        maxOuterPasses: MAX_ORTHO_OBSTACLE_OUTER_PASSES,
        fallbackToFullRepair: false
    };

    /** P1: 짧은 링크는 국소 기하 유지, 그 외에는 면 조합 후보·1차 점수로 도킹 쪽을 고른다 */
    var p1Candidates = [];
    var p1Best = null;
    if (_elementRegistry && _connection && !shortLink) {
        try {
            p1Candidates = getTopFacingCandidates(
                source,
                target,
                _elementRegistry,
                {
                    horizontalLayout: _horizontalLayout
                },
                P1_FACING_TOP_K
            );
            p1Best = p1Candidates.length ? p1Candidates[0] : null;
            routeMetrics.p1CandidateCount = p1Candidates.length;
        } catch (e) {
            p1Candidates = [];
            p1Best = null;
        }
    }

    var shouldRunP2Skeleton =
        !shortLink &&
        p1Candidates.length &&
        !isLocalClusterRange &&
        (pts.length > 4 || !sequenceFlowSegmentsAreOrthogonal(pts) || (obstacleContext && obstacleContext.flowNodes.length > 0));
    if (shouldRunP2Skeleton) {
        var bestP2Candidate = selectBestP2TemplateCandidate(source, target, _connection, p1Candidates, obstacleContext);
        if (bestP2Candidate && Array.isArray(bestP2Candidate.points) && bestP2Candidate.points.length >= 2) {
            pts = cloneWaypoints(bestP2Candidate.points);
            p1Best = bestP2Candidate.facing;
            routeMetrics.p2CandidateCount = bestP2Candidate.candidateCount || 0;
            routeMetrics.selectedFromP2 = true;
            routeMetrics.selectedTemplateKind = bestP2Candidate.templateKind || null;
            routeMetrics.maxOuterPasses = ROUTE_ENGINE_REDUCED_OUTER_PASSES;
        }
    }

    var n = pts.length;

    var resolveSourceSide = function () {
        var sDock = inferDockSideFromPointOnShape(source, pts[0]);
        var p1SourceSide =
            p1Best && p1Best.sourceExitSide
                ? shortLink
                    ? p1Best.sourceExitSide
                    : preferNearColumnDockSide(source, target, p1Best.sourceExitSide)
                : null;
        if (!shortLink && p1SourceSide) {
            return p1SourceSide;
        }
        if (sDock) {
            return sDock;
        }
        if (p1SourceSide) {
            return p1SourceSide;
        }
        var sInf = inferDockSideFromSegmentDirection(source, pts[0], pts[1]);
        return shortLink ? sInf : preferNearColumnDockSide(source, target, sInf);
    };
    var resolveTargetSide = function () {
        var tDock = inferDockSideFromPointOnShape(target, pts[pts.length - 1]);
        var p1TargetSide =
            p1Best && p1Best.targetEntrySide
                ? shortLink
                    ? p1Best.targetEntrySide
                    : preferNearColumnDockSide(target, source, p1Best.targetEntrySide)
                : null;
        if (!shortLink && p1TargetSide) {
            return p1TargetSide;
        }
        if (tDock) {
            return tDock;
        }
        if (p1TargetSide) {
            return p1TargetSide;
        }
        var tInf = inferDockSideFromSegmentDirection(target, pts[pts.length - 1], pts[pts.length - 2]);
        return shortLink ? tInf : preferNearColumnDockSide(target, source, tInf);
    };

    var sideS;
    var sideT;
    if (n >= 2) {
        sideS = resolveSourceSide();
        if (_connection && sideS) {
            pts[0] = dockingPointOnSharedSide(source, sideS, _connection);
        }
        pts[1] = alignSecondPointToExitNormal(pts[0], pts[1], sideS);
    }
    if (n >= 3) {
        sideT = resolveTargetSide();
        if (_connection && sideT) {
            pts[n - 1] = dockingPointOnSharedSide(target, sideT, _connection);
        }
        pts[n - 2] = alignPenultimateToApproachNormal(pts[n - 2], pts[n - 1], sideT);
    }

    if (pts.length === 5) {
        mergeMiddleCornerForFivePoints(pts, source);
    } else {
        alignThirdPointStraightBeforeApproach(pts, target);
        if (pts.length >= 6) {
            alignThirdPointStraightAfterExit(pts, source);
        }
    }

    if (pts.length >= 2 && sideS) {
        ensureMinExitLegLength(pts[0], pts[1], sideS, EDGE_CLEARANCE_PX);
    }
    if (pts.length >= 3 && sideT) {
        ensureMinApproachLegLength(pts[pts.length - 2], pts[pts.length - 1], sideT, EDGE_CLEARANCE_PX);
    }

    pts = ensureStrictlyOrthogonalWaypoints(pts);
    if (pts.length >= 2) {
        sideS = resolveSourceSide();
        if (sideS) {
            ensureMinExitLegLength(pts[0], pts[1], sideS, EDGE_CLEARANCE_PX);
        }
    }
    if (pts.length >= 3) {
        sideT = resolveTargetSide();
        if (sideT) {
            ensureMinApproachLegLength(pts[pts.length - 2], pts[pts.length - 1], sideT, EDGE_CLEARANCE_PX);
        }
    }

    pts = collapseTinyTargetJog(pts, target, sideT);

    nudgeInteriorWaypointsClearOfShapeEdges(pts, source, target, EDGE_CLEARANCE_PX);
    pts = ensureStrictlyOrthogonalWaypoints(pts);
    if (_connection && _elementRegistry && !isSequenceFlowImportLayoutActive()) {
        var obstacleElements = obstacleContext ? obstacleContext.flowNodes : null;
        var runRepairLoop = function (startPass, maxPasses) {
            var outerPass;
            for (outerPass = startPass; outerPass < maxPasses; outerPass++) {
                routeMetrics.outerPasses = outerPass + 1;
                pts = ensureStrictlyOrthogonalWaypoints(pts);
                var orthoClean = sequenceFlowSegmentsAreOrthogonal(pts);
                var obstacleClean = !sequenceFlowWaypointsObstacleHits(pts, _connection, _elementRegistry, obstacleElements);
                if (orthoClean && obstacleClean) {
                    return true;
                }
                resolveSequenceFlowWaypointObstacles(pts, _connection, _elementRegistry, obstacleElements);
                pts = ensureStrictlyOrthogonalWaypoints(pts);
                pts = collapseLeadingLocalJog(pts, _connection, source, target, _elementRegistry, obstacleElements);
                pts = ensureStrictlyOrthogonalWaypoints(pts);
                pts = simplifyLocalClusterWaypoints(pts, _connection, source, target, _elementRegistry, obstacleElements);
                pts = ensureStrictlyOrthogonalWaypoints(pts);
            }
            return false;
        };
        var maxOuterPasses = routeMetrics.selectedFromP2 ? ROUTE_ENGINE_REDUCED_OUTER_PASSES : MAX_ORTHO_OBSTACLE_OUTER_PASSES;
        var repairCompleted = runRepairLoop(0, maxOuterPasses);
        if (!repairCompleted && routeMetrics.selectedFromP2 && maxOuterPasses < MAX_ORTHO_OBSTACLE_OUTER_PASSES) {
            routeMetrics.fallbackToFullRepair = true;
            routeMetrics.maxOuterPasses = MAX_ORTHO_OBSTACLE_OUTER_PASSES;
            runRepairLoop(maxOuterPasses, MAX_ORTHO_OBSTACLE_OUTER_PASSES);
        }
    }
    pts = collapseOrthogonalBacktrackSpikes(pts);
    pts = withoutRedundantPoints(pts);
    pts = clampSequenceFlowToSharedParticipant(pts, source, target);
    pts = ensureStrictlyOrthogonalWaypoints(pts);
    pts = withoutRedundantPoints(pts);
    if (_connection && _elementRegistry) {
        pts = breakAxisSegmentsAlongTargetNoRunBand(pts, target, _connection, _elementRegistry);
        pts = ensureStrictlyOrthogonalWaypoints(pts);
        pts = withoutRedundantPoints(pts);
    }

    pts = collapseOrthogonalBacktrackSpikes(pts);
    pts = withoutRedundantPoints(pts);

    if (isSequenceFlowImportLayoutActive()) {
        return pts;
    }

    var beforeStairRemoval = cloneWaypoints(pts);
    var afterStairs = removeOrthogonalStairSteps(cloneWaypoints(pts));
    var outPts = afterStairs;
    if (_connection && _elementRegistry) {
        var obstaclesStair = obstacleContext ? obstacleContext.all : collectSequenceFlowObstacleElements(_connection, _elementRegistry);
        if (waypointsIntersectFlowObstacles(afterStairs, obstaclesStair, SEQUENCE_FLOW_OBSTACLE_SEGMENT_CLEARANCE_PX)) {
            outPts = beforeStairRemoval;
        }
    }

    if (shortLink) {
        outPts = simplifyShortLinkWaypoints(outPts, source, target, _connection, _elementRegistry);
        outPts = ensureStrictlyOrthogonalWaypoints(outPts);
        outPts = withoutRedundantPoints(outPts);
    }

    if (_connection && _elementRegistry) {
        outPts = simplifyLocalClusterWaypoints(
            outPts,
            _connection,
            source,
            target,
            _elementRegistry,
            obstacleContext ? obstacleContext.flowNodes : null
        );
        outPts = ensureStrictlyOrthogonalWaypoints(outPts);
        outPts = withoutRedundantPoints(outPts);
    }

    outPts = collapseOrthogonalBacktrackSpikes(outPts);
    outPts = withoutRedundantPoints(outPts);
    if (_lockedFacingSides && outPts.length >= 2 && sideS) {
        forceOrthogonalStartSegmentAxis(outPts, sideS, OBSTACLE_ROUTER_ORTHO_EPS);
        ensureMinExitLegLength(outPts[0], outPts[1], sideS, EDGE_CLEARANCE_PX);
    }
    if (_lockedFacingSides && outPts.length >= 2 && sideT) {
        forceOrthogonalEndSegmentAxis(outPts, sideT, OBSTACLE_ROUTER_ORTHO_EPS);
        ensureMinApproachLegLength(outPts[outPts.length - 2], outPts[outPts.length - 1], sideT, EDGE_CLEARANCE_PX);
    }

    if (!_lockedFacingSides) {
        var finalSourceSide =
            p1Best && p1Best.sourceExitSide
                ? shortLink
                    ? p1Best.sourceExitSide
                    : preferNearColumnDockSide(source, target, p1Best.sourceExitSide)
                : computeSequenceFacingSides(source, target, _horizontalLayout === true).sourceSide;
        var finalTargetSide =
            p1Best && p1Best.targetEntrySide
                ? shortLink
                    ? p1Best.targetEntrySide
                    : preferNearColumnDockSide(target, source, p1Best.targetEntrySide)
                : computeSequenceFacingSides(source, target, _horizontalLayout === true).targetSide;
        var outSourceDock = outPts.length >= 1 ? inferDockSideFromPointOnShape(source, outPts[0]) : null;
        var outTargetDock = outPts.length >= 1 ? inferDockSideFromPointOnShape(target, outPts[outPts.length - 1]) : null;

        if (
            outPts.length >= 2 &&
            finalSourceSide &&
            dockSideFacesOther(source, target, finalSourceSide) &&
            (!outSourceDock || !dockSideFacesOther(source, target, outSourceDock))
        ) {
            outPts[0] = _connection
                ? dockingPointOnSharedSide(source, finalSourceSide, _connection)
                : dockingPointOnSideMid(source, finalSourceSide);
            outPts[1] = alignSecondPointToExitNormal(outPts[0], outPts[1], finalSourceSide);
            ensureMinExitLegLength(outPts[0], outPts[1], finalSourceSide, EDGE_CLEARANCE_PX);
        }

        if (
            outPts.length >= 3 &&
            finalTargetSide &&
            dockSideFacesOther(target, source, finalTargetSide) &&
            (!outTargetDock || !dockSideFacesOther(target, source, outTargetDock))
        ) {
            outPts[outPts.length - 1] = _connection
                ? dockingPointOnSharedSide(target, finalTargetSide, _connection)
                : dockingPointOnSideMid(target, finalTargetSide);
            outPts[outPts.length - 2] = alignPenultimateToApproachNormal(
                outPts[outPts.length - 2],
                outPts[outPts.length - 1],
                finalTargetSide
            );
            ensureMinApproachLegLength(outPts[outPts.length - 2], outPts[outPts.length - 1], finalTargetSide, EDGE_CLEARANCE_PX);
        }
    }
    outPts = ensureStrictlyOrthogonalWaypoints(outPts);
    outPts = withoutRedundantPoints(outPts);
    outPts = snapEndpointsToAdjacentSegmentSides(outPts, source, target, _connection);
    if (_connection && _elementRegistry) {
        var finalObstacles = collectSequenceFlowObstacleElements(_connection, _elementRegistry).filter(function (el) {
            return !el.labelTarget;
        });
        for (var finalPass = 0; finalPass < 3; finalPass++) {
            if (
                !sequenceFlowWaypointsObstacleHits(outPts, _connection, _elementRegistry, finalObstacles) &&
                !sequenceFlowWaypointsObstacleHitsExhaustive(outPts, finalObstacles, SEQUENCE_FLOW_OBSTACLE_SEGMENT_CLEARANCE_PX)
            ) {
                break;
            }
            resolveSequenceFlowWaypointObstacles(outPts, _connection, _elementRegistry, finalObstacles);
            outPts = ensureStrictlyOrthogonalWaypoints(outPts);
            outPts = simplifyLocalClusterWaypoints(outPts, _connection, source, target, _elementRegistry, finalObstacles);
            outPts = snapEndpointsToAdjacentSegmentSides(outPts, source, target, _connection);
            outPts = withoutRedundantPoints(outPts);
        }
        var beforeBackwardAlign = outPts;
        outPts = alignBackwardReturnRunNearTargetEntry(outPts, source, target);
        if (candidateWorsensNodeNoRunBands(outPts, beforeBackwardAlign, source, target, finalObstacles)) {
            outPts = beforeBackwardAlign;
        }
        outPts = ensureStrictlyOrthogonalWaypoints(outPts);
        outPts = withoutRedundantPoints(outPts);
        outPts = snapEndpointsToAdjacentSegmentSides(outPts, source, target, _connection);
        outPts = collapseOrthogonalBacktrackSpikes(outPts);
        outPts = withoutRedundantPoints(outPts);
        var beforeOuterDogleg = outPts;
        outPts = simplifyBackwardReturnOuterDogleg(outPts, source, target, _connection, finalObstacles);
        if (candidateWorsensNodeNoRunBands(outPts, beforeOuterDogleg, source, target, finalObstacles)) {
            outPts = beforeOuterDogleg;
        }
        outPts = withoutRedundantPoints(outPts);
        var beforeGatewayReturnExit = outPts;
        outPts = simplifyBackwardGatewayReturnExit(outPts, source, target, _connection, finalObstacles);
        if (candidateWorsensNodeNoRunBands(outPts, beforeGatewayReturnExit, source, target, finalObstacles)) {
            outPts = beforeGatewayReturnExit;
        }
        outPts = withoutRedundantPoints(outPts);
        outPts = repairSameLaneBackwardReturnNoRun(outPts, source, target, _connection, finalObstacles);
        outPts = withoutRedundantPoints(outPts);
    }
    outPts = enforceFinalTargetApproachClearance(outPts, target);
    outPts = withoutRedundantPoints(outPts);
    pushRouteEngineDebugMetric(routeMetrics);
    return outPts;
}

function getWpXY(p) {
    if (!p) return { x: NaN, y: NaN };
    return {
        x: p.x !== undefined ? p.x : p.original && p.original.x,
        y: p.y !== undefined ? p.y : p.original && p.original.y
    };
}

function horizontalIntervalsOverlap(xMinA, xMaxA, xMinB, xMaxB) {
    var lo = Math.max(xMinA, xMinB);
    var hi = Math.min(xMaxA, xMaxB);
    return hi - lo > 4;
}

function collectInternalHorizontalSegmentIndices(waypoints) {
    var out = [];
    if (!Array.isArray(waypoints) || waypoints.length < 4) {
        return out;
    }
    var n = waypoints.length;
    for (var i = 1; i < n - 2; i++) {
        var p0 = getWpXY(waypoints[i - 1]);
        var p1 = getWpXY(waypoints[i]);
        var p2 = getWpXY(waypoints[i + 1]);
        var p3 = getWpXY(waypoints[i + 2]);
        if (
            [p0.x, p0.y, p1.x, p1.y, p2.x, p2.y, p3.x, p3.y].some(function (v) {
                return typeof v !== 'number' || !isFinite(v);
            })
        ) {
            continue;
        }
        var horiz = Math.abs(p1.y - p2.y) < ORTHO_EPS && Math.abs(p1.x - p2.x) > ORTHO_EPS;
        if (!horiz) continue;
        var segLen = Math.abs(p2.x - p1.x);
        if (segLen < PARALLEL_INTERNAL_SEGMENT_MIN_LENGTH_PX) continue;
        var vBefore = Math.abs(p0.x - p1.x) < ORTHO_EPS && Math.abs(p0.y - p1.y) > ORTHO_EPS;
        var vAfter = Math.abs(p2.x - p3.x) < ORTHO_EPS && Math.abs(p2.y - p3.y) > ORTHO_EPS;
        if (!vBefore || !vAfter) continue;
        out.push({
            i: i,
            y: p1.y,
            xMin: Math.min(p1.x, p2.x),
            xMax: Math.max(p1.x, p2.x)
        });
    }
    return out;
}

function segPairOverlaps(a, b) {
    if (Math.abs(a.y - b.y) > PARALLEL_Y_TOL) return false;
    return horizontalIntervalsOverlap(a.xMin, a.xMax, b.xMin, b.xMax);
}

function clusterSegmentsByOverlap(segments) {
    var n = segments.length;
    var used = Array(n).fill(false);
    var clusters = [];
    for (var s = 0; s < n; s++) {
        if (used[s]) continue;
        var stack = [s];
        used[s] = true;
        var cluster = [segments[s]];
        while (stack.length) {
            var cur = stack.pop();
            for (var t = 0; t < n; t++) {
                if (used[t]) continue;
                if (segPairOverlaps(segments[cur], segments[t])) {
                    used[t] = true;
                    stack.push(t);
                    cluster.push(segments[t]);
                }
            }
        }
        clusters.push(cluster);
    }
    return clusters;
}

function cloneWaypointsPlain(wps) {
    return wps.map(function (p) {
        var x = p.x !== undefined ? p.x : p.original && p.original.x;
        var y = p.y !== undefined ? p.y : p.original && p.original.y;
        var o = { x: x, y: y };
        if (p.original && typeof p.original.x === 'number' && typeof p.original.y === 'number') {
            o.original = { x: x, y: y };
        }
        return o;
    });
}

function syncPtOriginal(pt) {
    if (pt && pt.original && typeof pt.original.x === 'number' && typeof pt.original.y === 'number') {
        pt.original.x = pt.x;
        pt.original.y = pt.y;
    }
}

/** S-Parallel: 평행 시퀀스 플로우 분리 (스펙상 보조·약화, C-EdgeSep). */
export function applyParallelSequenceFlowSeparation(elementRegistry, modeling) {
    var sepPx = PARALLEL_SEQUENCE_FLOW_SEPARATION_PX;
    if (!elementRegistry || !modeling || typeof modeling.updateWaypoints !== 'function') {
        return 0;
    }

    var flows = elementRegistry.getAll().filter(function (el) {
        var bo = el.businessObject;
        return bo && bo.$type === 'bpmn:SequenceFlow' && el.source && el.target;
    });
    flows.sort(function (a, b) {
        return String(a.id || '').localeCompare(String(b.id || ''));
    });

    var segments = [];
    flows.forEach(function (flow) {
        var wps = flow.waypoints;
        if (!Array.isArray(wps) || wps.length < 2) return;
        var internals = collectInternalHorizontalSegmentIndices(wps);
        internals.forEach(function (seg) {
            segments.push({
                flow: flow,
                flowId: String(flow.id || ''),
                i: seg.i,
                y: seg.y,
                xMin: seg.xMin,
                xMax: seg.xMax
            });
        });
    });

    if (segments.length < 2) {
        return 0;
    }

    var clusters = clusterSegmentsByOverlap(segments);
    var dyByFlowWaypoint = Object.create(null);
    function key(flowId, idx) {
        return flowId + '::' + idx;
    }

    clusters.forEach(function (cluster) {
        if (cluster.length < 2) return;
        cluster.sort(function (a, b) {
            var c = a.flowId.localeCompare(b.flowId);
            if (c !== 0) return c;
            return a.i - b.i;
        });
        for (var r = 0; r < cluster.length; r++) {
            var dy = r * sepPx;
            if (dy === 0) continue;
            var seg = cluster[r];
            var fk = key(seg.flowId, seg.i);
            var fk1 = key(seg.flowId, seg.i + 1);
            dyByFlowWaypoint[fk] = (dyByFlowWaypoint[fk] || 0) + dy;
            dyByFlowWaypoint[fk1] = (dyByFlowWaypoint[fk1] || 0) + dy;
        }
    });

    var updated = 0;
    flows.forEach(function (flow) {
        var wps = flow.waypoints;
        if (!Array.isArray(wps) || wps.length < 2) return;
        var fid = String(flow.id || '');
        var changed = false;
        var next = cloneWaypointsPlain(wps);
        for (var j = 0; j < next.length; j++) {
            var add = dyByFlowWaypoint[key(fid, j)];
            if (add) {
                next[j].y += add;
                syncPtOriginal(next[j]);
                changed = true;
            }
        }
        if (changed) {
            next = clampSequenceFlowToSharedParticipant(next, flow.source, flow.target);
            try {
                modeling.updateWaypoints(flow, next);
                updated++;
            } catch (e) {
                /* ignore */
            }
        }
    });

    return updated;
}

/**
 * 최종 시퀀스 플로우 웨이포인트 (S-FacingSnap → S-ObstacleReroute → S-OrthoManhattan; short-link 시 C-Short 후처리).
 * @param {import('diagram-js/lib/core/Types').ConnectionLike} connection
 * @param {import('diagram-js/lib/util/Types').Point[]} waypoints
 * @param {import('diagram-js/lib/core/ElementRegistry').default} elementRegistry
 * @param {{ horizontalLayout?: boolean, snapFacingEndpoints?: boolean, rerouteObstacles?: boolean }} [options]
 * @returns {import('diagram-js/lib/util/Types').Point[]}
 */
export function computeFinalSequenceFlowWaypoints(connection, waypoints, elementRegistry, options) {
    options = options || {};
    if (!connection || !Array.isArray(waypoints)) {
        return waypoints;
    }
    var source = connection.source;
    var target = connection.target;
    if (!source || !target) {
        return waypoints;
    }

    var horizontalLayout =
        typeof options.horizontalLayout === 'boolean' ? options.horizontalLayout : isDirectionHorizontal(source, elementRegistry);
    var pts = waypoints.map(snapshotWaypoint);

    // S-FacingSnap (optional)
    if (options.snapFacingEndpoints && shouldSnapSequenceFlowFacingEndpoints(connection, source, target)) {
        pts = snapSequenceFlowWaypointsToFacingEndpoints(pts, source, target, horizontalLayout);
    }

    // S-ObstacleReroute (optional; SequenceFlowFinalLayouter는 false로 중복 방지)
    if (options.rerouteObstacles !== false && elementRegistry) {
        pts = applySequenceFlowObstacleReroute(connection, pts, elementRegistry, horizontalLayout);
    }

    // S-OrthoManhattan + 내부 S-Loop
    return applyOrthogonalManhattanSequenceFlow(pts, source, target, horizontalLayout, connection, elementRegistry);
}

export default function SequenceFlowFinalLayouter(elementRegistry) {
    this._elementRegistry = elementRegistry;
    this._delegate = new BpmnLayouter(elementRegistry);
}

inherits(SequenceFlowFinalLayouter, BaseLayouter);

SequenceFlowFinalLayouter.$inject = ['elementRegistry'];

SequenceFlowFinalLayouter.prototype.layoutConnection = function (connection, hints) {
    if (is(connection, 'bpmn:SequenceFlow')) {
        return this.layoutSequenceFlowFinal(connection, hints);
    }
    return this._delegate.layoutConnection(connection, hints);
};

SequenceFlowFinalLayouter.prototype.layoutSequenceFlowFinal = function (connection, hints) {
    var delegateHints = hints ? Object.assign({}, hints) : {};
    var wps = connection.waypoints;
    if (Array.isArray(wps) && wps.length > MAX_BPMN_DELEGATE_WAYPOINT_HINT) {
        delegateHints.waypoints = decimateWaypointsToMax(wps, MAX_BPMN_DELEGATE_WAYPOINT_HINT);
    }
    var pts = this._delegate.layoutConnection(connection, delegateHints);
    return computeFinalSequenceFlowWaypoints(connection, pts, this._elementRegistry, {
        snapFacingEndpoints: true,
        rerouteObstacles: true
    });
};
