// Ported from Process GPT vue3 frontend — process-gpt/services/frontend/src/components/autoLayout/layout-options.js @ 0e85995b.
// Copied as is for Lite's BPMN views (src/lib/bpmn-auto-layout/index.js); changes here are marked "Lite:".
/**
 * 레이아웃 옵션 (yFiles HierarchicalLayout 스타일)
 * 하드코딩 제거 및 설정 가능한 옵션 제공
 */

/**
 * 기본 레이아웃 옵션 - yFiles HierarchicalLayout 참고
 * @see https://docs.yworks.com/yfiles-html/dguide/automatic-layouts-main-chapter/hierarchical_layout.html
 */
export const DEFAULT_LAYOUT_OPTIONS = {
    // === 거리 관련 (yFiles: minimumLayerDistance, nodeDistance, edgeDistance 등) ===
    /** 인접 레이어 간 최소 거리 */
    minimumLayerDistance: 72,
    /** 같은 레이어 내 노드 간 최소 거리 */
    nodeDistance: 42,
    /** 노드와 엣지 간 최소 거리 */
    nodeToEdgeDistance: 20,
    /** 엣지 간 최소 거리 */
    edgeDistance: 12,

    // === 노드 기본 크기 ===
    /** 노드 기본 너비 (요소 크기 없을 때) */
    defaultNodeWidth: 100,
    /** 노드 기본 높이 */
    defaultNodeHeight: 80,

    // === 여백 ===
    /** 그룹/참여자 외곽 여백 */
    margin: 40,
    /** 서브프로세스 내부 여백 */
    subprocessMargin: 20,
    /** 참여자 레이블 공간 */
    participantLabelSpace: 30,
    /** 노드와 레인 경계 사이 최소 여백 */
    nodeMargin: 12,
    /** 레인/참여자 경계와 내부 콘텐츠 사이 여백 */
    lanePadding: 22,

    // === 교차 최소화 (yFiles: 반복 수행) ===
    /** 교차 최소화 반복 횟수 (yFiles 스타일) */
    crossingMinimizationIterations: 4,

    // === 증분 레이아웃 (fromSketchMode) ===
    /** 기존 배치를 참고하여 mental map 유지 (yFiles fromSketchMode) */
    fromSketchMode: false,

    // === 엣지 라우팅 스타일 ===
    /** 'orthogonal' | 'polyline' | 'octilinear' | 'curved' */
    edgeRoutingStyle: 'orthogonal',
    /** Bus Routing: 동일 소스/타겟의 다중 엣지가 공통 경로 세그먼트 공유 (번들링) */
    useBusRouting: true,
    /** Bus 세그먼트 길이 (px) */
    busSegmentLength: 35,

    // === 시간 제한 ===
    /** 레이아웃 최대 실행 시간(ms), 0이면 제한 없음 (yFiles stopDuration) */
    stopDuration: 0,

    // === 제약 조건 ===
    /** 레이어 고정 { nodeId: layerIndex } */
    layerConstraints: {},
    /** 노드 순서 제약 [{ before: nodeId, after: nodeId }] - before가 after보다 왼쪽 */
    sequenceConstraints: [],
    /** 레이어 최적화 최대 반복 횟수 */
    layerOptimizationMaxIterations: 100,

    // === 엣지 라우팅 ===
    /** 장애물 회피 시 노드/엣지 간격 */
    edgeObstacleSpacing: 28,
    /** 경로 탐색 그리드 크기 */
    pathGridSize: 20,
    /** 경로 탐색 최대 스텝 */
    pathMaxSteps: 300,
    /** 포트 테스트 거리 */
    portTestLength: 60,
    /** 시작/끝점에서 벗어나는 기본 거리 */
    edgePortOffset: 36,
    /** 직선 샘플링 스텝 */
    lineSamplingSteps: 10,
    /** 경로 탐색 거리 제한 (초과 시 단순 경로) */
    pathDistanceLimit: 2000,
    /** A* 큐 최대 크기 */
    pathQueueMaxSize: 1000,
    /** A* 큐 유지 개수 */
    pathQueueKeepSize: 100,
    /** 최소 노드 간격 (공간 부족 시) */
    minNodeSpacing: 5,
    /** fallback 그룹 최소 너비 */
    fallbackGroupMinWidth: 200,
    /** 그룹 base 너비 (레이어당 노드) */
    groupBaseWidth: 120,
    /** 디버그 로그 출력 */
    debug: false
};

/**
 * 옵션 병합 - 사용자 옵션으로 기본값 덮어쓰기
 */
export function mergeLayoutOptions(userOptions = {}) {
    return { ...DEFAULT_LAYOUT_OPTIONS, ...userOptions };
}
