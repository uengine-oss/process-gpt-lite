// Ported from Process GPT vue3 frontend — process-gpt/services/frontend/src/components/autoLayout/bpmn-auto-layout.js @ 0e85995b.
// Copied as is for Lite's BPMN views (src/lib/bpmn-auto-layout/index.js); changes here are marked "Lite:".
/**
 * BPMN 자동 레이아웃 모듈
 * 기존 script.js 파일에서 분리된 자동 레이아웃 로직
 */

import { mergeLayoutOptions } from './layout-options.js';
import { computeFinalSequenceFlowWaypoints, dockingPointOnShapeBoundary } from './sequence-flow-final-layouter.js';
import { nowMs, pushLayoutTiming } from './bpmn-auto-layout/timing.js';
import { syncPhaseContainersWithParticipants } from './bpmn-auto-layout/phase-container-sync.js';
import { spGetNearestSubProcessId, layoutSingleSubProcess } from './bpmn-auto-layout/subprocess-pass.js';
import { adjustLabelsAfterLayout } from './bpmn-auto-layout/label-after-layout.js';
import {
    ObstacleSpatialIndex,
    setActiveObstacleSpatialIndex,
    getActiveObstacleSpatialIndex,
    clearActiveObstacleSpatialIndex
} from './sequence-flow/obstacle-spatial-index.js';

(function (global) {
    // 전역 네임스페이스
    const BpmnAutoLayout = {};

    // (timing / phase-container / subprocess-pass / label-after-layout 은 ES 모듈로 분리되었다)

    BpmnAutoLayout.syncPhaseContainersWithParticipants = syncPhaseContainersWithParticipants;
    BpmnAutoLayout.adjustLabelsAfterLayout = adjustLabelsAfterLayout;

    // 그래프 waypoints를 BPMN에 강제 적용 여부 (true 시 레인 경계 등 그래프 기반 경로 사용)
    // false 권장: layoutConnection이 source/target 기준으로 자동 재계산하여 더 안정적
    const ENABLE_WAYPOINT_PROCESSING = false;
    const PARTICIPANT_LABEL_HEADER_SIZE = 30;

    /**
     * 내부용 자동 레이아웃 코어 (SubProcess 분기 없는 v1 단일 패스).
     * 외부 호출자는 {@link BpmnAutoLayout.applyAutoLayout} 을 사용한다.
     *
     * @param {BpmnJS} bpmnModeler - BPMN-JS 모델러 인스턴스
     * @param {Object} options - 레이아웃 옵션
     * @param {boolean} options.horizontal - 가로 방향 레이아웃 사용 여부
     * @param {Object} options.layoutOptions - Sugiyama 옵션 (crossingMinimizationIterations 등)
     */
    BpmnAutoLayout.__applyAutoLayoutInternal = function (bpmnModeler, options = {}, onLoadStart = () => {}, onLoadEnd = () => {}) {
        const { horizontal = false, layoutOptions = {}, includeWaypoints = true } = options;
        const timingStartMs = nowMs();
        console.log('[BPMN-Layout] applyAutoLayout 시작 | horizontal:', horizontal);
        onLoadStart();

        // 가로 모드 여부를 전역 변수로 설정하여 다른 클래스/함수에서도 참조 가능하게 함
        window.isHorizontalLayout = horizontal;

        if (!bpmnModeler) {
            throw new Error('BPMN 모델러가 제공되지 않았습니다.');
        }

        try {
            // 그래프 객체 초기화
            const { Graph } = window.GraphAlgorithm;
            // 외부 파일로 분리된 EnhancedSugiyamaLayout 클래스 참조
            const EnhancedSugiyamaLayout = window.EnhancedSugiyamaLayout;
            const graph = new Graph();

            // BPMN 모델에서 요소 가져오기
            const elementRegistry = bpmnModeler.get('elementRegistry');
            let elements = elementRegistry.getAll();

            // (옵션) 전역 필터 훅이 정의되어 있으면 요소 목록을 한 번 더 필터링한다.
            // V2 등에서 SubProcess 자식 노드를 제외하고 싶을 때 사용.
            if (typeof global !== 'undefined' && typeof global.__bpmnAutoLayoutFilterElements === 'function') {
                try {
                    elements = elements.filter((el) => global.__bpmnAutoLayoutFilterElements(el));
                } catch (e) {
                    console.warn('[BPMN] __bpmnAutoLayoutFilterElements 실행 중 오류, 필터를 무시하고 전체 요소를 사용합니다.', e);
                }
            }
            // 노드 맵 생성 (빠른 참조를 위함)
            const nodeMap = {};

            // 실제 노드 목록 (Task, Event, Gateway 등)
            const validNodeTypes = [
                'bpmn:Task',
                'bpmn:UserTask',
                'bpmn:ServiceTask',
                'bpmn:ScriptTask',
                'bpmn:BusinessRuleTask',
                'bpmn:SendTask',
                'bpmn:ReceiveTask',
                'bpmn:ManualTask',
                'bpmn:StartEvent',
                'bpmn:EndEvent',
                'bpmn:IntermediateThrowEvent',
                'bpmn:IntermediateCatchEvent',
                'bpmn:ExclusiveGateway',
                'bpmn:ParallelGateway',
                'bpmn:InclusiveGateway',
                'bpmn:EventBasedGateway',
                'bpmn:SubProcess',
                'bpmn:CallActivity'
            ];

            // 요소 유형에 따른 레이블 가져오기
            function getTypeLabel(elementType) {
                const typeMap = {
                    'bpmn:Task': '작업',
                    'bpmn:UserTask': '사용자 작업',
                    'bpmn:ServiceTask': '서비스 작업',
                    'bpmn:SendTask': '전송 작업',
                    'bpmn:ReceiveTask': '수신 작업',
                    'bpmn:ManualTask': '수동 작업',
                    'bpmn:BusinessRuleTask': '업무 규칙 작업',
                    'bpmn:ScriptTask': '스크립트 작업',
                    'bpmn:StartEvent': '시작 이벤트',
                    'bpmn:EndEvent': '종료 이벤트',
                    'bpmn:IntermediateThrowEvent': '중간 이벤트(발생)',
                    'bpmn:IntermediateCatchEvent': '중간 이벤트(수신)',
                    'bpmn:ExclusiveGateway': '배타 게이트웨이',
                    'bpmn:ParallelGateway': '병렬 게이트웨이',
                    'bpmn:InclusiveGateway': '포괄 게이트웨이',
                    'bpmn:EventBasedGateway': '이벤트 기반 게이트웨이',
                    'bpmn:SubProcess': '서브프로세스',
                    'bpmn:Participant': '참여자',
                    'bpmn:Lane': '레인',
                    'bpmn:TextAnnotation': '텍스트 주석',
                    'bpmn:DataObjectReference': '데이터 객체',
                    'bpmn:DataStoreReference': '데이터 저장소'
                };

                return typeMap[elementType] || elementType.replace('bpmn:', '');
            }

            // SubProcess 가 여러 레인을 걸치는 정보를 활용하기 위한 맵
            const subProcVirtualMap = {}; // realId -> { canonicalId, virtualIds }

            // 먼저 노드 추가 (실제 도형 요소만)
            elements.forEach((element) => {
                if (!element.businessObject || !element.businessObject.$type || element.labelTarget) {
                    return;
                }

                const bo = element.businessObject;
                if (!validNodeTypes.includes(bo.$type)) {
                    return;
                }

                const id = element.id;
                const type = getTypeLabel(bo.$type);
                const label = bo.name || type;

                // 서브프로세스가 여러 레인을 걸치면: 레인 수만큼 가상 노드를 만든다.
                const overlappedLaneIds = bo.__v2OverlappedLaneIds;
                if (bo.$type === 'bpmn:SubProcess' && Array.isArray(overlappedLaneIds) && overlappedLaneIds.length > 1) {
                    const count = overlappedLaneIds.length;

                    // BPMN 실제 크기
                    let bpmnWidth = element.width || 100;
                    let bpmnHeight = element.height || 80;

                    // 레인 방향에 따라 BPMN 상에서 먼저 분할을 적용한다.
                    // - horizontal=true  : Lane 이 위아래로 쌓임 → 세로(height)를 Lane 수로 나눈다.
                    // - horizontal=false : Lane 이 좌우로 배치 → 가로(width)를 Lane 수로 나눈다.
                    if (horizontal) {
                        bpmnHeight = bpmnHeight / count;
                    } else {
                        bpmnWidth = bpmnWidth / count;
                    }

                    // 그래프 알고리즘은 "세로 레이아웃" 기준이므로,
                    // 가로 스윔레인(horizontal=true) 인 경우 width/height 를 반대로 넣어준다.
                    let baseWidth = bpmnWidth;
                    let baseHeight = bpmnHeight;
                    if (horizontal) {
                        const tmp = baseWidth;
                        baseWidth = baseHeight;
                        baseHeight = tmp;
                    }

                    const virtualIds = [];

                    overlappedLaneIds.forEach((laneId, idx) => {
                        const virtualId = `${id}__lane${idx}`;
                        graph.addNode(virtualId, label);
                        const vNode = graph.getNode(virtualId);
                        vNode.width = baseWidth;
                        vNode.height = baseHeight;
                        vNode.nodeType = bo.$type;
                        vNode.group = laneId;
                        vNode.__realSubProcessId = id;
                        vNode.__isCanonical = idx === 0;
                        vNode.originalLayoutX = horizontal ? element.y || 0 : element.x || 0;

                        virtualIds.push(virtualId);

                        // 해당 레인 ID 를 그룹으로 갖는 Lane 그룹을 미리 생성/갱신
                        graph.createGroup(laneId, [virtualId]);
                    });

                    if (virtualIds.length) {
                        subProcVirtualMap[id] = {
                            canonicalId: virtualIds[0],
                            virtualIds
                        };
                        // 실제 BPMN 서브프로세스는 canonical 가상 노드에 매핑
                        nodeMap[virtualIds[0]] = element;
                    }

                    return; // 이 서브프로세스에 대해서는 별도 실노드를 추가하지 않는다.
                }

                // 일반 노드 처리 (기존 로직)
                graph.addNode(id, label);
                const node = graph.getNode(id);
                let nodeWidth = element.width || 100;
                let nodeHeight = element.height || 80;

                // Integrated Node Labeling: 라벨 영역을 포함한 유효 크기 계산 (노드 중심 대칭 유지)
                if (element.labels && element.labels.length > 0) {
                    const ex = element.x ?? 0;
                    const ey = element.y ?? 0;
                    const ew = element.width || 100;
                    const eh = element.height || 80;
                    let minX = ex;
                    let maxX = ex + ew;
                    let minY = ey;
                    let maxY = ey + eh;
                    element.labels.forEach((l) => {
                        if (!l || typeof l.x !== 'number' || typeof l.y !== 'number') return;
                        const lw = l.width || 40;
                        const lh = l.height || 20;
                        minX = Math.min(minX, l.x);
                        maxX = Math.max(maxX, l.x + lw);
                        minY = Math.min(minY, l.y);
                        maxY = Math.max(maxY, l.y + lh);
                    });
                    const leftExt = ex - minX;
                    const rightExt = maxX - (ex + ew);
                    const topExt = ey - minY;
                    const bottomExt = maxY - (ey + eh);
                    nodeWidth = ew + 2 * Math.max(leftExt, rightExt);
                    nodeHeight = eh + 2 * Math.max(topExt, bottomExt);
                }

                // 가로 스윔레인 모드일 때는 그래프가 세로 기준으로 동작하므로
                // width/height 를 반대로 넣어서 레이아웃 계산이 일관되게 되도록 한다.
                if (horizontal) {
                    const tmp = nodeWidth;
                    nodeWidth = nodeHeight;
                    nodeHeight = tmp;
                }

                node.width = nodeWidth;
                node.height = nodeHeight;
                node.nodeType = bo.$type;
                node.originalLayoutX = horizontal ? element.y || 0 : element.x || 0;

                nodeMap[id] = element;
            });

            // 서브프로세스 가상 노드를 고려한 노드 ID 매핑
            function resolveNodeIdForEdge(originalId) {
                const info = subProcVirtualMap[originalId];
                return info ? info.canonicalId : originalId;
            }

            function resolveSequenceFlowSourceForLayout(source) {
                const bo = source && source.businessObject;
                if (!bo || bo.$type !== 'bpmn:BoundaryEvent') {
                    return source;
                }
                return source.host || bo.attachedToRef || source;
            }

            function getLaneSortValue(lane) {
                return horizontal ? lane.y || 0 : lane.x || 0;
            }

            function isMultiLaneVirtualSubProcess(element) {
                const bo = element && element.businessObject;
                return !!(
                    bo &&
                    bo.$type === 'bpmn:SubProcess' &&
                    Array.isArray(bo.__v2OverlappedLaneIds) &&
                    bo.__v2OverlappedLaneIds.length > 1
                );
            }

            function buildLaneMembershipContext(allElements) {
                const laneElements = allElements
                    .filter(
                        (element) =>
                            element &&
                            element.businessObject &&
                            element.businessObject.$type === 'bpmn:Lane' &&
                            element.parent &&
                            element.parent.businessObject &&
                            element.parent.businessObject.$type === 'bpmn:Participant'
                    )
                    .sort((a, b) => getLaneSortValue(a) - getLaneSortValue(b));

                const laneById = {};
                const participantLaneIdsById = {};
                const flowNodeRefLaneIdByBoId = {};
                const membershipByElementId = {};
                const laneMemberIdsByLaneId = {};

                laneElements.forEach((lane) => {
                    laneById[lane.id] = lane;
                    laneMemberIdsByLaneId[lane.id] = [];
                    const participantId = lane.parent && lane.parent.id;
                    if (participantId) {
                        if (!participantLaneIdsById[participantId]) {
                            participantLaneIdsById[participantId] = [];
                        }
                        participantLaneIdsById[participantId].push(lane.id);
                    }
                    const refs =
                        lane.businessObject && Array.isArray(lane.businessObject.flowNodeRef) ? lane.businessObject.flowNodeRef : [];
                    refs.forEach((ref) => {
                        if (ref && ref.id && !flowNodeRefLaneIdByBoId[ref.id]) {
                            flowNodeRefLaneIdByBoId[ref.id] = lane.id;
                        }
                    });
                });

                function addLaneMember(laneId, elementId) {
                    if (!laneId || !elementId || !laneMemberIdsByLaneId[laneId]) {
                        return;
                    }
                    if (!laneMemberIdsByLaneId[laneId].includes(elementId)) {
                        laneMemberIdsByLaneId[laneId].push(elementId);
                    }
                }

                function resolveLaneForElement(element) {
                    if (!element || !element.businessObject || element.labelTarget || element.waypoints) {
                        return null;
                    }
                    if (element.businessObject.$type === 'bpmn:Lane' || element.businessObject.$type === 'bpmn:Participant') {
                        return null;
                    }
                    if (isMultiLaneVirtualSubProcess(element)) {
                        return null;
                    }

                    const boId = element.businessObject && element.businessObject.id;
                    if (boId && flowNodeRefLaneIdByBoId[boId]) {
                        return flowNodeRefLaneIdByBoId[boId];
                    }

                    const ancestorLane = findAncestorByType(element, 'bpmn:Lane');
                    if (ancestorLane && ancestorLane.id) {
                        return ancestorLane.id;
                    }

                    const participant = findAncestorByType(element, 'bpmn:Participant');
                    const candidateLaneIds =
                        participant && participantLaneIdsById[participant.id]
                            ? participantLaneIdsById[participant.id]
                            : laneElements.map((lane) => lane.id);
                    const lane = candidateLaneIds
                        .map((laneId) => laneById[laneId])
                        .find((candidate) => candidate && isElementInLane(element, candidate));
                    return lane ? lane.id : null;
                }

                allElements.forEach((element) => {
                    const laneId = resolveLaneForElement(element);
                    if (!laneId) {
                        return;
                    }
                    membershipByElementId[element.id] = laneId;
                    addLaneMember(laneId, element.id);
                });

                return {
                    laneElements,
                    laneById,
                    participantLaneIdsById,
                    membershipByElementId,
                    laneMemberIdsByLaneId
                };
            }

            const laneMembershipContext = buildLaneMembershipContext(elements);

            Object.keys(nodeMap).forEach((nodeId) => {
                const element = nodeMap[nodeId];
                const node = graph.getNode(nodeId);
                const laneId = element && laneMembershipContext.membershipByElementId[element.id];
                if (node && laneId) {
                    node.group = laneId;
                    node.__laneId = laneId;
                }
            });

            // 엣지 추가 (연결선 - SequenceFlow만)
            elements.forEach((element) => {
                if (!element.businessObject || element.businessObject.$type !== 'bpmn:SequenceFlow' || !element.source || !element.target) {
                    return;
                }

                const layoutSource = resolveSequenceFlowSourceForLayout(element.source);
                const resolvedSourceId = resolveNodeIdForEdge(layoutSource.id);
                const resolvedTargetId = resolveNodeIdForEdge(element.target.id);

                if (resolvedSourceId !== resolvedTargetId && nodeMap[resolvedSourceId] && nodeMap[resolvedTargetId]) {
                    graph.addEdge(resolvedSourceId, resolvedTargetId, element.id);
                }
            });

            // 그룹화 처리 (서브프로세스나 풀/레인 등이 있는 경우)
            let groupId = 0;
            const participantsWithLanes = new Set(); // lane이 있는 participant 추적

            // 1. 먼저 어떤 participant가 lane을 가지고 있는지 확인
            elements.forEach((element) => {
                if (element.businessObject && element.businessObject.$type === 'bpmn:Lane') {
                    if (element.parent && element.parent.businessObject && element.parent.businessObject.$type === 'bpmn:Participant') {
                        participantsWithLanes.add(element.parent.id);
                    }
                }
            });

            function sortGroupsAndOrder(graph, elements) {
                // 1. groupOrder 정렬
                graph.groupOrder.sort((a, b) => {
                    const elA = elements.find((el) => el.id === a);
                    const elB = elements.find((el) => el.id === b);
                    if (!elA || !elB) return 0;
                    if (horizontal) {
                        return elA.y - elB.y;
                    } else {
                        return elA.x - elB.x;
                    }
                });

                // 2. groups 배열도 groupOrder 순서에 맞게 재정렬
                graph.groups = graph.groupOrder.map((id) => graph.groups.find((g) => g.id === id)).filter(Boolean); // 혹시 없는 id는 제거
            }
            // 2. 그룹화 처리 진행
            elements.forEach((element) => {
                if (element.businessObject && element.businessObject.$type) {
                    // 서브프로세스 처리
                    if (element.businessObject.$type === 'bpmn:SubProcess') {
                        const childElements = [];
                        elements.forEach((child) => {
                            if (child.parent && child.parent.id === element.id && child.businessObject && !child.labelTarget) {
                                childElements.push(child.id);
                            }
                        });

                        if (childElements.length > 0) {
                            // 그룹 ID로 요소의 ID 사용
                            graph.createGroup(element.id, childElements);
                        }
                    }
                    // 레인 처리 - participant 안에 레인이 있는 경우
                    else if (element.businessObject.$type === 'bpmn:Lane') {
                        const childElements = laneMembershipContext.laneMemberIdsByLaneId[element.id] || [];
                        if (childElements.length > 0) {
                            // 그룹 ID로 레인의 ID 사용
                            graph.createGroup(element.id, childElements);
                        }
                    }
                    // Participant 처리 - lane이 없는 경우에만 그룹화
                    else if (element.businessObject.$type === 'bpmn:Participant' && !participantsWithLanes.has(element.id)) {
                        const childElements = [];

                        elements.forEach((child) => {
                            if (child.parent && child.parent.id === element.id && child.businessObject && !child.labelTarget) {
                                childElements.push(child.id);
                            }
                        });

                        if (childElements.length > 0) {
                            // 그룹 ID로 참여자의 ID 사용
                            graph.createGroup(element.id, childElements);
                        }
                    }
                }
            });

            sortGroupsAndOrder(graph, elements);

            // Lane 내부 요소 확인 helper 함수
            function isElementInLane(element, lane) {
                // 요소나 레인에 경계가 없는 경우 처리
                if (!element || !lane) return false;

                // 요소의 중심점이 레인 내부에 있는지 확인
                const elementMidX = element.x + element.width / 2;
                const elementMidY = element.y + element.height / 2;

                return (
                    elementMidX >= lane.x &&
                    elementMidX <= lane.x + lane.width &&
                    elementMidY >= lane.y &&
                    elementMidY <= lane.y + lane.height
                );
            }

            // Boundary 이벤트가 어느 노드의 어느 변에, 어느 비율로 붙어있는지 사전 캡처
            function captureBoundaryAttachments(elements) {
                const map = new Map();

                elements.forEach((el) => {
                    if (!el.businessObject || el.businessObject.$type !== 'bpmn:BoundaryEvent') return;

                    // host는 우선 shape.host를 사용, 없으면 attachedToRef로 검색
                    let host = el.host;
                    if (!host && el.businessObject.attachedToRef) {
                        const hostBoId = el.businessObject.attachedToRef.id;
                        host = elements.find((e) => e.businessObject && e.businessObject.id === hostBoId);
                    }
                    if (!host) return;

                    if (typeof host.x !== 'number' || typeof host.y !== 'number') return;

                    const bw = el.width || 36;
                    const bh = el.height || 36;

                    const centerX = el.x + bw / 2;
                    const centerY = el.y + bh / 2;

                    const hostLeft = host.x;
                    const hostRight = host.x + host.width;
                    const hostTop = host.y;
                    const hostBottom = host.y + host.height;

                    // 네 변까지의 거리 계산
                    const dLeft = Math.abs(centerX - hostLeft);
                    const dRight = Math.abs(centerX - hostRight);
                    const dTop = Math.abs(centerY - hostTop);
                    const dBottom = Math.abs(centerY - hostBottom);

                    let side = 'left';
                    let min = dLeft;

                    if (dRight < min) {
                        min = dRight;
                        side = 'right';
                    }
                    if (dTop < min) {
                        min = dTop;
                        side = 'top';
                    }
                    if (dBottom < min) {
                        min = dBottom;
                        side = 'bottom';
                    }

                    let t = 0.5;
                    const hostWidth = host.width || 100;
                    const hostHeight = host.height || 80;

                    if ((side === 'left' || side === 'right') && hostHeight > 0) {
                        t = (centerY - hostTop) / hostHeight;
                    } else if ((side === 'top' || side === 'bottom') && hostWidth > 0) {
                        t = (centerX - hostLeft) / hostWidth;
                    }

                    // 0~1 범위로 클램프
                    t = Math.min(1, Math.max(0, t));

                    // Boundary에 붙어있는 라벨의 상대 위치(center 기준)도 같이 저장
                    const labels = [];
                    if (el.labels && el.labels.length > 0) {
                        el.labels.forEach((label) => {
                            if (!label || typeof label.x !== 'number' || typeof label.y !== 'number') return;
                            const lw = label.width || 0;
                            const lh = label.height || 0;
                            const labelCenterX = label.x + lw / 2;
                            const labelCenterY = label.y + lh / 2;
                            labels.push({
                                labelId: label.id,
                                dx: labelCenterX - centerX,
                                dy: labelCenterY - centerY,
                                width: lw,
                                height: lh
                            });
                        });
                    }

                    map.set(el.id, {
                        boundaryId: el.id,
                        hostId: host.id,
                        side,
                        t,
                        labels
                    });
                });

                return map;
            }

            // 주어진 포인트가 요소의 어느 변에 붙어있는지, 그리고 그 변을 따라 어느 비율에 있는지 계산
            function getElementAttachmentFromPoint(point, element) {
                if (
                    !point ||
                    !element ||
                    typeof element.x !== 'number' ||
                    typeof element.y !== 'number' ||
                    typeof element.width !== 'number' ||
                    typeof element.height !== 'number'
                ) {
                    return null;
                }

                const left = element.x;
                const right = element.x + element.width;
                const top = element.y;
                const bottom = element.y + element.height;

                const centerX = point.x;
                const centerY = point.y;

                const dLeft = Math.abs(centerX - left);
                const dRight = Math.abs(centerX - right);
                const dTop = Math.abs(centerY - top);
                const dBottom = Math.abs(centerY - bottom);

                let side = 'left';
                let min = dLeft;

                if (dRight < min) {
                    min = dRight;
                    side = 'right';
                }
                if (dTop < min) {
                    min = dTop;
                    side = 'top';
                }
                if (dBottom < min) {
                    min = dBottom;
                    side = 'bottom';
                }

                let t = 0.5;

                if ((side === 'left' || side === 'right') && element.height > 0) {
                    t = (centerY - top) / element.height;
                } else if ((side === 'top' || side === 'bottom') && element.width > 0) {
                    t = (centerX - left) / element.width;
                }

                t = Math.min(1, Math.max(0, t));

                return { side, t };
            }

            // Boundary와 연결된 SequenceFlow의 양 끝이 어떤 변에 어떤 비율로 붙어 있었는지,
            // 그리고 중간 꺾임(waypoint)들이 전체 경로 박스 안에서 어느 위치(비율)에 있었는지 사전 캡처
            function captureBoundaryFlowEndpoints(elements) {
                const map = new Map();

                elements.forEach((el) => {
                    if (
                        !el.businessObject ||
                        el.businessObject.$type !== 'bpmn:SequenceFlow' ||
                        !el.waypoints ||
                        !Array.isArray(el.waypoints) ||
                        el.waypoints.length < 2
                    ) {
                        return;
                    }

                    const source = el.source;
                    const target = el.target;

                    const isSourceBoundary = source && source.businessObject && source.businessObject.$type === 'bpmn:BoundaryEvent';

                    const isTargetBoundary = target && target.businessObject && target.businessObject.$type === 'bpmn:BoundaryEvent';

                    if (!isSourceBoundary && !isTargetBoundary) {
                        return;
                    }

                    const startPoint = el.waypoints[0];
                    const endPoint = el.waypoints[el.waypoints.length - 1];

                    const sourceAttach = getElementAttachmentFromPoint(startPoint, source);
                    const targetAttach = getElementAttachmentFromPoint(endPoint, target);

                    // 꺾이는 중간 포인트들을 전체 경로 박스 기준 비율로 저장
                    const innerPoints = el.waypoints.slice(1, el.waypoints.length - 1);

                    let minX = Math.min(startPoint.x, endPoint.x);
                    let maxX = Math.max(startPoint.x, endPoint.x);
                    let minY = Math.min(startPoint.y, endPoint.y);
                    let maxY = Math.max(startPoint.y, endPoint.y);

                    innerPoints.forEach((p) => {
                        if (typeof p.x === 'number' && typeof p.y === 'number') {
                            if (p.x < minX) minX = p.x;
                            if (p.x > maxX) maxX = p.x;
                            if (p.y < minY) minY = p.y;
                            if (p.y > maxY) maxY = p.y;
                        }
                    });

                    const width = maxX - minX || 1;
                    const height = maxY - minY || 1;

                    const innerNormalized = innerPoints.map((p) => ({
                        nx: (p.x - minX) / width,
                        ny: (p.y - minY) / height
                    }));

                    map.set(el.id, {
                        source: sourceAttach,
                        target: targetAttach,
                        inner: innerNormalized
                    });
                });

                return map;
            }

            /**
             * Integrated Labeling: 라벨(노드/엣지)이 다른 노드·요소와 겹치지 않도록 위치 조정
             */
            function adjustLabelsToAvoidOverlap(elements, modeling) {
                if (!modeling || !elements || elements.length === 0) return;

                const MARGIN = 4;
                const STEP = 12;
                const MAX_ATTEMPTS = 20;

                const isObstacle = (el) => {
                    if (!el || el.labelTarget) return false;
                    const t = el.businessObject?.$type;
                    if (!t || t === 'bpmn:SequenceFlow') return false;
                    return typeof el.x === 'number' && typeof el.y === 'number' && (el.width || el.height) > 0;
                };

                const nodeObstacles = elements.filter(isObstacle).map((el) => ({
                    id: el.id,
                    left: el.x - MARGIN,
                    right: el.x + (el.width || 0) + MARGIN,
                    top: el.y - MARGIN,
                    bottom: el.y + (el.height || 0) + MARGIN
                }));

                const labelObstacles = [];
                elements.forEach((host) => {
                    if (!host.labels || host.labels.length === 0) return;
                    host.labels.forEach((label, idx) => {
                        if (!label || typeof label.x !== 'number' || typeof label.y !== 'number') return;
                        const lw = label.width || 40;
                        const lh = label.height || 20;
                        const lid = label.id || host.id + '_label_' + idx;
                        labelObstacles.push({
                            id: lid,
                            left: label.x - MARGIN,
                            right: label.x + lw + MARGIN,
                            top: label.y - MARGIN,
                            bottom: label.y + lh + MARGIN,
                            hostId: host.id
                        });
                    });
                });
                const obstacles = [...nodeObstacles, ...labelObstacles];

                const boxesOverlap = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

                elements.forEach((host) => {
                    if (!host.labels || host.labels.length === 0) return;

                    host.labels.forEach((label, labelIdx) => {
                        if (!label || typeof label.x !== 'number' || typeof label.y !== 'number') return;
                        const lw = label.width || 40;
                        const lh = label.height || 20;
                        const currentLabelId = label.id || host.id + '_label_' + labelIdx;

                        let lx = label.x;
                        let ly = label.y;
                        const labelBox = () => ({
                            left: lx,
                            right: lx + lw,
                            top: ly,
                            bottom: ly + lh
                        });

                        const overlaps = () => {
                            const lb = labelBox();
                            return obstacles.some((obs) => {
                                if (obs.id === currentLabelId) return false;
                                return boxesOverlap(lb, obs);
                            });
                        };

                        if (!overlaps()) return;

                        const directions = [
                            { dx: 0, dy: -STEP },
                            { dx: 0, dy: STEP },
                            { dx: -STEP, dy: 0 },
                            { dx: STEP, dy: 0 },
                            { dx: -STEP, dy: -STEP },
                            { dx: STEP, dy: -STEP },
                            { dx: -STEP, dy: STEP },
                            { dx: STEP, dy: STEP }
                        ];

                        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                            let found = false;
                            for (const { dx, dy } of directions) {
                                lx = label.x + dx * attempt;
                                ly = label.y + dy * attempt;
                                if (!overlaps()) {
                                    found = true;
                                    break;
                                }
                            }
                            if (found) {
                                try {
                                    const moveX = lx - label.x;
                                    const moveY = ly - label.y;
                                    if (Math.abs(moveX) > 0.5 || Math.abs(moveY) > 0.5) {
                                        modeling.moveShape(label, { x: moveX, y: moveY });
                                    }
                                } catch (e) {
                                    console.warn('[AUTO_LAYOUT] 라벨 겹침 방지 이동 실패:', label.id, e);
                                }
                                break;
                            }
                        }
                    });
                });
            }

            // 캡처된 정보를 바탕으로, 최종 레이아웃 이후 boundary 위치를 보정
            function applyBoundaryAttachments(attachments, elements, modeling) {
                if (!attachments || attachments.size === 0) return;

                attachments.forEach((info) => {
                    const boundary = elements.find((e) => e.id === info.boundaryId);
                    const host = elements.find((e) => e.id === info.hostId);

                    if (
                        !boundary ||
                        !host ||
                        typeof host.x !== 'number' ||
                        typeof host.y !== 'number' ||
                        typeof host.width !== 'number' ||
                        typeof host.height !== 'number'
                    ) {
                        return;
                    }

                    const bw = boundary.width || 36;
                    const bh = boundary.height || 36;

                    const hostLeft = host.x;
                    const hostRight = host.x + host.width;
                    const hostTop = host.y;
                    const hostBottom = host.y + host.height;

                    let centerX = hostLeft + host.width / 2;
                    let centerY = hostTop + host.height / 2;

                    const t = typeof info.t === 'number' ? info.t : 0.5;

                    if (info.side === 'left') {
                        centerX = hostLeft;
                        centerY = hostTop + host.height * t;
                    } else if (info.side === 'right') {
                        centerX = hostRight;
                        centerY = hostTop + host.height * t;
                    } else if (info.side === 'top') {
                        centerX = hostLeft + host.width * t;
                        centerY = hostTop;
                    } else if (info.side === 'bottom') {
                        centerX = hostLeft + host.width * t;
                        centerY = hostBottom;
                    }

                    const newX = centerX - bw / 2;
                    const newY = centerY - bh / 2;

                    const dx = newX - boundary.x;
                    const dy = newY - boundary.y;

                    // Boundary 자체 위치 보정
                    if (Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5) {
                        try {
                            modeling.moveShape(boundary, { x: dx, y: dy });
                        } catch (err) {
                            console.warn(`Boundary ${boundary.id} 최종 위치 보정 중 오류:`, err);
                        }
                    }

                    // Boundary에 붙어있던 라벨들의 상대 위치도 함께 복원
                    const labelsInfo = info.labels || [];
                    const boundaryCenterX = centerX;
                    const boundaryCenterY = centerY;

                    labelsInfo.forEach((li) => {
                        const labelEl = elements.find((e) => e.id === li.labelId);
                        if (!labelEl || typeof labelEl.x !== 'number' || typeof labelEl.y !== 'number') {
                            return;
                        }

                        const lw = labelEl.width || li.width || 0;
                        const lh = labelEl.height || li.height || 0;

                        const newLabelCenterX = boundaryCenterX + li.dx;
                        const newLabelCenterY = boundaryCenterY + li.dy;

                        const labelNewX = newLabelCenterX - lw / 2;
                        const labelNewY = newLabelCenterY - lh / 2;

                        const ldx = labelNewX - labelEl.x;
                        const ldy = labelNewY - labelEl.y;

                        if (Math.abs(ldx) < 0.5 && Math.abs(ldy) < 0.5) {
                            return;
                        }

                        try {
                            modeling.moveShape(labelEl, { x: ldx, y: ldy });
                        } catch (err) {
                            console.warn(`Boundary 라벨 ${labelEl.id} 위치 보정 중 오류:`, err);
                        }
                    });
                });
            }

            // 레이아웃 전에 boundary 부착 정보 및 boundary 플로우 endpoint 정보 캡처
            const boundaryAttachments = captureBoundaryAttachments(elements);
            const boundaryFlowEndpoints = captureBoundaryFlowEndpoints(elements);
            // 확장된 Sugiyama 레이아웃 적용 (layoutOptions: crossingMinimizationIterations 등)
            const mergedOptions = mergeLayoutOptions(layoutOptions);
            const layout = new EnhancedSugiyamaLayout(graph, horizontal, mergedOptions);
            layout.run();

            // 서브프로세스: 레인 수만큼의 가상 노드가 있을 때,
            // 그 가상 노드들의 중간 지점에 실제 서브프로세스를 위치시키기 위해
            // canonical 가상 노드의 좌표를 보정한다.
            Object.entries(subProcVirtualMap).forEach(([realId, info]) => {
                const { canonicalId, virtualIds } = info;
                const virtualNodes = virtualIds.map((vid) => graph.getNode(vid)).filter(Boolean);
                if (!virtualNodes.length) return;

                const canonicalNode = graph.getNode(canonicalId);
                if (!canonicalNode) return;

                let sumX = 0;
                let sumY = 0;
                virtualNodes.forEach((n) => {
                    sumX += n.x;
                    sumY += n.y;
                });

                const midX = sumX / virtualNodes.length;
                const midY = sumY / virtualNodes.length;

                // 여러 레인에 걸친 가상 노드들의 "중심" 위치에 canonical 노드를 두어
                // 실제 서브프로세스 박스가 두 레인을 고르게 관통하도록 한다.
                canonicalNode.x = midX;
                canonicalNode.y = midY;
            });

            // 모델러의 캔버스와 변환 모듈 가져오기
            const canvas = bpmnModeler.get('canvas');
            const modeling = bpmnModeler.get('modeling');
            const connectionDocking = bpmnModeler.get('connectionDocking');

            // 노드의 테두리(모서리가 아닌 가장자리 포함)에 가장 가까운 점으로 스냅시키는 헬퍼
            function snapPointToElementCorner(point, element) {
                if (!point || !element || typeof element.x !== 'number' || typeof element.y !== 'number') {
                    return;
                }

                const left = element.x;
                const right = element.x + element.width;
                const top = element.y;
                const bottom = element.y + element.height;

                // 포인트의 x/y를 요소 범위로 클램프
                const clampedX = Math.min(Math.max(point.x, left), right);
                const clampedY = Math.min(Math.max(point.y, top), bottom);

                // 네 개의 변 위에서 후보 점 생성 (좌/우/상/하 변의 가장 가까운 점)
                const candidates = [
                    { x: left, y: clampedY }, // 왼쪽 변
                    { x: right, y: clampedY }, // 오른쪽 변
                    { x: clampedX, y: top }, // 위쪽 변
                    { x: clampedX, y: bottom } // 아래쪽 변
                ];

                let best = candidates[0];
                let bestDist = Infinity;

                candidates.forEach((c) => {
                    const dx = c.x - point.x;
                    const dy = c.y - point.y;
                    const dist = dx * dx + dy * dy;
                    if (dist < bestDist) {
                        bestDist = dist;
                        best = c;
                    }
                });

                point.x = best.x;
                point.y = best.y;
            }

            function findAncestorByType(element, type) {
                let current = element && element.parent;
                while (current) {
                    if (current.type === type) {
                        return current;
                    }
                    current = current.parent;
                }
                return null;
            }

            function clamp(value, min, max) {
                return Math.max(min, Math.min(max, value));
            }

            const lanePadding = Math.max(20, mergedOptions.lanePadding ?? mergedOptions.nodeMargin ?? 20);

            function getLaneBandRectForElement(element, pad = lanePadding) {
                if (!element || !element.id) {
                    return null;
                }
                const laneId = laneMembershipContext.membershipByElementId[element.id];
                const lane = laneId ? laneMembershipContext.laneById[laneId] : null;
                const participant = findAncestorByType(element, 'bpmn:Participant');
                if (!lane && !participant) {
                    return null;
                }

                const x = lane && typeof lane.x === 'number' ? lane.x : participant.x;
                const y = lane && typeof lane.y === 'number' ? lane.y : participant.y;
                const width = lane && typeof lane.width === 'number' ? lane.width : participant.width;
                const height = lane && typeof lane.height === 'number' ? lane.height : participant.height;
                return {
                    laneId: lane ? lane.id : null,
                    participantId: participant ? participant.id : null,
                    minX: x + pad,
                    maxX: x + width - pad,
                    minY: y + pad,
                    maxY: y + height - pad
                };
            }

            function clampNodePositionToLaneBand(element, position, pad = lanePadding) {
                if (!element || !position) {
                    return position;
                }
                const rect = getLaneBandRectForElement(element, pad);
                if (!rect) {
                    return position;
                }
                const maxX = rect.maxX - (element.width || 0);
                const maxY = rect.maxY - (element.height || 0);
                return {
                    x: clamp(position.x, rect.minX, Math.max(rect.minX, maxX)),
                    y: clamp(position.y, rect.minY, Math.max(rect.minY, maxY))
                };
            }

            function syncLaneAndParticipantBounds(allElements) {
                const lanePad = lanePadding;
                const minLaneSpan = lanePad * 2;
                const laneIds = laneMembershipContext.laneElements.map((lane) => lane.id);
                const elementsById = {};
                const laneLayoutById = {};
                allElements.forEach((element) => {
                    if (element && element.id) {
                        elementsById[element.id] = element;
                    }
                });

                laneIds.forEach((laneId) => {
                    const lane = laneMembershipContext.laneById[laneId];
                    const memberIds = laneMembershipContext.laneMemberIdsByLaneId[laneId] || [];
                    let members = memberIds
                        .map((id) => elementsById[id])
                        .filter(
                            (element) =>
                                element &&
                                typeof element.x === 'number' &&
                                typeof element.y === 'number' &&
                                typeof element.width === 'number' &&
                                typeof element.height === 'number'
                        );
                    if (!lane || !members.length) {
                        return;
                    }

                    if (horizontal) {
                        const contentTop = Math.min(...members.map((element) => element.y));
                        const contentBottom = Math.max(...members.map((element) => element.y + element.height));
                        const nextY = Math.min(lane.y, contentTop - lanePad);
                        const nextBottom = Math.max(lane.y + lane.height, contentBottom + lanePad);
                        laneLayoutById[laneId] = {
                            preferredStart: nextY,
                            preferredEnd: nextBottom,
                            minEnd: contentBottom + lanePad
                        };
                        modeling.resizeShape(lane, {
                            x: lane.x,
                            y: nextY,
                            width: lane.width,
                            height: nextBottom - nextY
                        });
                        return;
                    }

                    const contentRight = Math.max(...members.map((element) => element.x + element.width));
                    const contentTop = Math.min(...members.map((element) => element.y));
                    const contentBottom = Math.max(...members.map((element) => element.y + element.height));
                    const nextX = lane.x;
                    const nextRight = Math.max(lane.x + lane.width, contentRight + lanePad);
                    const nextY = Math.min(lane.y, contentTop - lanePad);
                    const nextBottom = Math.max(contentBottom + lanePad, nextY + minLaneSpan);
                    laneLayoutById[laneId] = {
                        preferredStart: nextX,
                        preferredEnd: nextRight,
                        minEnd: contentRight + lanePad,
                        preferredY: nextY,
                        preferredBottom: nextBottom
                    };
                    modeling.resizeShape(lane, {
                        x: nextX,
                        y: nextY,
                        width: nextRight - nextX,
                        height: nextBottom - nextY
                    });
                });

                Object.entries(laneMembershipContext.participantLaneIdsById).forEach(([participantId, laneIds]) => {
                    const participant = elementsById[participantId];
                    const lanes = laneIds.map((laneId) => laneMembershipContext.laneById[laneId]).filter(Boolean);
                    if (!participant || !lanes.length) {
                        return;
                    }

                    if (horizontal) {
                        const sortedLanes = lanes.slice().sort((a, b) => a.y - b.y);
                        let stackedBottom = null;
                        sortedLanes.forEach((lane) => {
                            const layout = laneLayoutById[lane.id] || {
                                preferredStart: lane.y,
                                preferredEnd: lane.y + lane.height,
                                minEnd: lane.y + lane.height
                            };
                            const nextY = stackedBottom == null ? layout.preferredStart : Math.max(layout.preferredStart, stackedBottom);
                            const nextBottom = Math.max(layout.preferredEnd, layout.minEnd, nextY + minLaneSpan);
                            if (Math.abs(nextY - lane.y) >= 1 || Math.abs(nextBottom - nextY - lane.height) >= 1) {
                                modeling.resizeShape(lane, {
                                    x: lane.x,
                                    y: nextY,
                                    width: lane.width,
                                    height: nextBottom - nextY
                                });
                            }
                            stackedBottom = nextBottom;
                        });
                        const minY = Math.min(...sortedLanes.map((lane) => lane.y));
                        const maxY = Math.max(...sortedLanes.map((lane) => lane.y + lane.height));
                        const minX = Math.min(...sortedLanes.map((lane) => lane.x));
                        const maxX = Math.max(...sortedLanes.map((lane) => lane.x + lane.width));
                        modeling.resizeShape(participant, {
                            x: minX - PARTICIPANT_LABEL_HEADER_SIZE,
                            y: minY,
                            width: maxX - minX + PARTICIPANT_LABEL_HEADER_SIZE,
                            height: maxY - minY
                        });
                        return;
                    }

                    const sortedLanes = lanes.slice().sort((a, b) => a.x - b.x);
                    let stackedRight = null;
                    sortedLanes.forEach((lane) => {
                        const layout = laneLayoutById[lane.id] || {
                            preferredStart: lane.x,
                            preferredEnd: lane.x + lane.width,
                            minEnd: lane.x + lane.width
                        };
                        const nextX = stackedRight == null ? layout.preferredStart : Math.max(layout.preferredStart, stackedRight);
                        const nextRight = Math.max(layout.preferredEnd, layout.minEnd, nextX + minLaneSpan);
                        if (Math.abs(nextX - lane.x) >= 1 || Math.abs(nextRight - nextX - lane.width) >= 1) {
                            modeling.resizeShape(lane, {
                                x: nextX,
                                y: lane.y,
                                width: nextRight - nextX,
                                height: lane.height
                            });
                        }
                        stackedRight = nextRight;
                    });
                    const minX = Math.min(...sortedLanes.map((lane) => lane.x));
                    const maxX = Math.max(...sortedLanes.map((lane) => lane.x + lane.width));
                    const minY = Math.min(...sortedLanes.map((lane) => lane.y));
                    const maxY = Math.max(...sortedLanes.map((lane) => lane.y + lane.height));
                    sortedLanes.forEach((lane) => {
                        if (Math.abs(lane.y - minY) >= 1 || Math.abs(lane.height - (maxY - minY)) >= 1) {
                            modeling.resizeShape(lane, {
                                x: lane.x,
                                y: minY,
                                width: lane.width,
                                height: maxY - minY
                            });
                        }
                    });
                    modeling.resizeShape(participant, {
                        x: minX,
                        y: minY - PARTICIPANT_LABEL_HEADER_SIZE,
                        width: maxX - minX,
                        height: maxY - minY + PARTICIPANT_LABEL_HEADER_SIZE
                    });
                });
            }

            function resizeBottomContainerIfNeeded(container, requiredBottom) {
                if (!container || typeof container.y !== 'number' || typeof container.height !== 'number') {
                    return;
                }
                const currentBottom = container.y + container.height;
                if (requiredBottom <= currentBottom) {
                    return;
                }
                try {
                    modeling.resizeShape(container, {
                        x: container.x,
                        y: container.y,
                        width: container.width,
                        height: requiredBottom - container.y
                    });
                } catch (err) {
                    console.warn('[BPMN-Layout] 컨테이너 하단 확장 실패:', container.id, err);
                }
            }

            function rebalanceBottomMergeSinkTasks(allElements) {
                if (!horizontal) {
                    return;
                }

                const candidates = allElements.filter((el) => {
                    if (!el || !el.businessObject || el.labelTarget || el.waypoints) {
                        return false;
                    }
                    const type = el.businessObject.$type || '';
                    if (!type.startsWith('bpmn:') || type.includes('Gateway')) {
                        return false;
                    }
                    const incoming = Array.isArray(el.incoming) ? el.incoming.filter((flow) => flow && flow.source) : [];
                    const outgoing = Array.isArray(el.outgoing) ? el.outgoing.filter((flow) => flow && flow.target) : [];
                    if (incoming.length < 2) {
                        return false;
                    }
                    if (outgoing.length === 0) {
                        return true;
                    }
                    if (outgoing.length !== 1) {
                        return false;
                    }
                    const feedbackTarget = outgoing[0].target;
                    return !!(
                        feedbackTarget &&
                        typeof feedbackTarget.x === 'number' &&
                        typeof el.x === 'number' &&
                        feedbackTarget.x < el.x - 120
                    );
                });

                candidates.forEach((target) => {
                    const laneId = laneMembershipContext.membershipByElementId[target.id];
                    const laneFromMembership = laneId ? laneMembershipContext.laneById[laneId] : null;
                    const lane = laneFromMembership || findAncestorByType(target, 'bpmn:Lane');
                    const participant = findAncestorByType(target, 'bpmn:Participant');
                    const container = lane || participant;
                    if (!container) {
                        return;
                    }

                    if (lane && participant) {
                        const siblingLanes = (laneMembershipContext.participantLaneIdsById[participant.id] || [])
                            .map((siblingLaneId) => laneMembershipContext.laneById[siblingLaneId])
                            .filter((child) => child && typeof child.y === 'number')
                            .sort((a, b) => a.y - b.y);
                        if (siblingLanes.length && siblingLanes[siblingLanes.length - 1].id !== lane.id) {
                            return;
                        }
                    }

                    const incomingSources = target.incoming
                        .map((flow) => flow && flow.source)
                        .filter((source) => {
                            if (!source || typeof source.x !== 'number' || typeof source.y !== 'number') {
                                return false;
                            }
                            const sourceParticipant = findAncestorByType(source, 'bpmn:Participant');
                            return !participant || !sourceParticipant || sourceParticipant.id === participant.id;
                        });

                    if (incomingSources.length < 2) {
                        return;
                    }

                    const sourceCentersX = incomingSources.map((source) => source.x + (source.width || 0) / 2);
                    const sourceBottom = Math.max(...incomingSources.map((source) => source.y + (source.height || 0)));
                    const targetCenterX = target.x + (target.width || 0) / 2;
                    const desiredCenterX = clamp(
                        (Math.min(...sourceCentersX) + Math.max(...sourceCentersX)) / 2,
                        container.x + (target.width || 0) / 2 + 20,
                        container.x + container.width - (target.width || 0) / 2 - 20
                    );
                    const requiredBottom = sourceBottom + 24 + (target.height || 0) + 32;
                    if (lane) {
                        resizeBottomContainerIfNeeded(lane, requiredBottom);
                    }
                    if (participant) {
                        resizeBottomContainerIfNeeded(participant, requiredBottom);
                    }

                    const desiredPosition = clampNodePositionToLaneBand(
                        target,
                        {
                            x: desiredCenterX - (target.width || 0) / 2,
                            y: sourceBottom + 24
                        },
                        32
                    );
                    const dx = desiredPosition.x - target.x;
                    const dy = desiredPosition.y - target.y;

                    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) {
                        return;
                    }

                    try {
                        modeling.moveShape(target, { x: dx, y: dy });
                        const requiredBottom = target.y + target.height + 20;
                        resizeBottomContainerIfNeeded(container, requiredBottom);
                        if (participant && participant !== container) {
                            resizeBottomContainerIfNeeded(participant, requiredBottom);
                        }
                    } catch (err) {
                        console.warn('[BPMN-Layout] bottom merge sink 재배치 실패:', target.id, err);
                    }
                });

                syncLaneAndParticipantBounds(allElements);
            }

            // 계산된 위치로 요소 이동
            graph.nodes.forEach((node) => {
                const element = nodeMap[node.id];
                if (element) {
                    // 요소 위치 업데이트 (중앙점을 기준으로)
                    const newPosition = {
                        x: node.x - element.width / 2,
                        y: node.y - element.height / 2
                    };

                    // 좌표값 유효성 검사
                    const dx = newPosition.x - element.x;
                    const dy = newPosition.y - element.y;

                    // 무한대나 NaN 값이 아닌지 확인
                    if (!isFinite(dx) || !isFinite(dy) || isNaN(dx) || isNaN(dy)) {
                        console.warn(`요소 ${element.id} 이동에 유효하지 않은 좌표가 있습니다:`, dx, dy);
                        return; // 이 요소는 건너뜀
                    }

                    // 0이 아닌 이동만 적용 (최소 1px 이상 차이날 때만 적용)
                    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) {
                        return; // 거의 이동이 없는 경우 건너뜀
                    }

                    // element가 Root(캔버스 루트)인지 여부에 따라 처리 분기
                    // - 일반 노드/서브프로세스/레인은 element 자신을 그대로 이동
                    // - 진짜 루트(프로세스/콜라보레이션)인 경우에만 children 중 실제 shape 를 찾아 이동
                    if (!element.waypoints) {
                        let elementToMove = element;

                        const boType = element.businessObject && element.businessObject.$type;
                        const isRootLike = !element.parent || boType === 'bpmn:Process' || boType === 'bpmn:Collaboration';

                        if (isRootLike && element.labels && element.children) {
                            // 루트 요소인 경우, 실제 shape 요소(Participant 등)를 찾아 이동시킴
                            const childrenWithShape = element.children.filter(
                                (child) => child.type && !child.waypoints && child.type.includes('bpmn:')
                            );

                            if (childrenWithShape.length > 0) {
                                elementToMove = childrenWithShape[0];
                            }
                        }

                        if (elementToMove && elementToMove.id && typeof elementToMove.x === 'number') {
                            const COORD_DEBUG_MOVE = typeof window !== 'undefined' && window.__BPMN_LAYOUT_COORD_DEBUG__;
                            if (COORD_DEBUG_MOVE) {
                                const bo = elementToMove.businessObject;
                                const label = bo && bo.name ? bo.name.substring(0, 12) : elementToMove.id;
                                const newX = elementToMove.x + dx;
                                const newY = elementToMove.y + dy;
                                console.log(
                                    '[BPMN-Layout] MOVE',
                                    elementToMove.id,
                                    label,
                                    '| (',
                                    elementToMove.x?.toFixed(0),
                                    ',',
                                    elementToMove.y?.toFixed(0),
                                    ') → (',
                                    newX?.toFixed(0),
                                    ',',
                                    newY?.toFixed(0),
                                    ')',
                                    '| Δ(',
                                    dx?.toFixed(0),
                                    ',',
                                    dy?.toFixed(0),
                                    ')'
                                );
                            }
                            try {
                                modeling.moveShape(elementToMove, { x: dx, y: dy });

                                // 경계 이벤트(바운더리 이벤트)가 붙어 있으면 같이 이동
                                if (elementToMove.attachers && elementToMove.attachers.length > 0) {
                                    elementToMove.attachers.forEach((attacher) => {
                                        if (attacher && typeof attacher.x === 'number') {
                                            try {
                                                modeling.moveShape(attacher, { x: dx, y: dy });
                                            } catch (attErr) {
                                                console.warn(`경계 이벤트 ${attacher.id} 이동 중 오류:`, attErr);
                                            }
                                        }
                                    });
                                }

                                // 라벨 요소가 있는 경우 함께 이동
                                if (element.labels && element.labels.length > 0) {
                                    element.labels.forEach((label) => {
                                        if (label && label.id && typeof label.x === 'number') {
                                            try {
                                                modeling.moveShape(label, { x: dx, y: dy });
                                            } catch (labelErr) {
                                                console.warn(`라벨 ${label.id} 이동 중 오류:`, labelErr);
                                            }
                                        }
                                    });
                                }
                            } catch (err) {
                                console.warn(`요소 ${elementToMove.id} 이동 중 오류:`, err);
                            }
                        }
                    }
                }
            });

            const participantChildrenMap = {};

            // 1. 참가자 → 레인 관계 구성
            graph.groups.forEach((group) => {
                const element = elements.find((e) => e.id === group.id);
                if (!element) return;

                if (element.type === 'bpmn:Lane' && element.parent?.type === 'bpmn:Participant') {
                    const parentId = element.parent.id;
                    if (!participantChildrenMap[parentId]) {
                        participantChildrenMap[parentId] = [];
                    }
                    participantChildrenMap[parentId].push(group.id);
                }
            });

            // 2. 레인 우선 크기 조정
            graph.groups.forEach((group) => {
                const element = elements.find((el) => el.id === group.id);
                if (!element) return;
                if (element.type === 'bpmn:Participant' && participantsWithLanes.has(element.id)) return;

                const minX = group.minX ?? Infinity;
                const maxX = group.maxX ?? -Infinity;
                const minY = group.minY ?? Infinity;
                const maxY = group.maxY ?? -Infinity;

                const margin = 0;
                const labelSpace = element.type === 'bpmn:Participant' ? 30 : 0;

                if (element.type === 'bpmn:Participant') {
                    if (horizontal) {
                        modeling.resizeShape(element, {
                            x: minY - margin - labelSpace,
                            y: minX - margin,
                            width: maxY - minY + margin * 2 + labelSpace,
                            height: maxX - minX + margin * 2
                        });
                    } else {
                        modeling.resizeShape(element, {
                            x: minX - margin,
                            y: minY - margin - labelSpace,
                            width: maxX - minX + margin * 2,
                            height: maxY - minY + margin * 2 + labelSpace
                        });
                    }
                    return;
                }

                // 가로 배치 모드인 경우 x, y 값 교환 고려
                if (horizontal) {
                    modeling.resizeShape(element, {
                        x: minY - margin, // x에 minY 사용
                        y: minX - margin, // y에 minX 사용
                        width: maxY - minY + margin * 2, // width에 y 차이 사용
                        height: maxX - minX + margin * 2 // height에 x 차이 사용
                    });
                } else {
                    modeling.resizeShape(element, {
                        x: minX - margin,
                        y: minY - margin,
                        width: maxX - minX + margin * 2,
                        height: maxY - minY + margin * 2
                    });
                }
            });

            // 3. 참가자(Pool) 크기 조정 - 자식 레인의 합으로 계산
            Object.entries(participantChildrenMap).forEach(([participantId, laneIds]) => {
                const laneBounds = laneIds.map((id) => graph.getGroup(id)).filter(Boolean);

                if (laneBounds.length === 0) return;

                let minX = Math.min(...laneBounds.map((g) => g.minX));
                let maxX = Math.max(...laneBounds.map((g) => g.maxX));
                let minY = Math.min(...laneBounds.map((g) => g.minY));
                let maxY = Math.max(...laneBounds.map((g) => g.maxY));

                const margin = 0;
                const participantElement = elements.find((el) => el.id === participantId);
                if (participantElement) {
                    if (participantElement.type === 'bpmn:Participant') {
                        // 가로 배치 모드에서는 레이블을 위한 공간을 다르게 조정
                        minY = minY - 30; // 가로 모드에서는 왼쪽에 여유 공간
                    }

                    // 가로 배치 모드인 경우 x, y 값 교환 고려
                    if (horizontal) {
                        modeling.resizeShape(participantElement, {
                            x: minY - margin, // x에 minY 사용
                            y: minX - margin, // y에 minX 사용
                            width: maxY - minY + margin * 2, // width에 y 차이 사용
                            height: maxX - minX + margin * 2 // height에 x 차이 사용
                        });
                    } else {
                        modeling.resizeShape(participantElement, {
                            x: minX - margin,
                            y: minY - margin,
                            width: maxX - minX + margin * 2,
                            height: maxY - minY + margin * 2
                        });
                    }
                }
            });

            syncLaneAndParticipantBounds(elements);

            // 4. Phase(PhaseContainer, Phase)를 Participant 길이 축에 맞춘다.
            syncPhaseContainersWithParticipants(bpmnModeler, { horizontal });

            // 레이아웃이 모두 끝난 후 boundary 위치를 최종적으로 보정
            applyBoundaryAttachments(boundaryAttachments, elements, modeling);

            // 다중 incoming 을 가진 sink 노드는 하단 lane에서 분기 아래로 내려
            // 긴 우측 corridor 대신 로컬 클러스터 안에서 마무리되도록 보정한다.
            rebalanceBottomMergeSinkTasks(elements);

            // waypoints 적용 함수 호출
            if (ENABLE_WAYPOINT_PROCESSING && includeWaypoints) {
                applyGraphWaypointsToBpmnModeler(graph, bpmnModeler);
            }

            // 피드백 라인(루프 백엣지): 레이아웃 시 graph.edges에서 제거됨. ID는 layout._feedbackFlowIds에 보관
            const feedbackFlowIds = new Set(layout._feedbackFlowIds || []);

            // 기본 자동레이아웃에서도 waypoint 최종 정리를 함께 수행한다.
            // 모든 시퀀스 플로우에 대해 bpmn-js layoutConnection을 호출하여
            // 노드 이동 후 연결선을 source/target 기준으로 자동 재계산한다.
            // - 필터된 elements가 아닌 elementRegistry 전체를 사용 (V2에서 SubProcess 내부 플로우 포함)
            // - boundary 이벤트와 연결된 플로우는 제외 (별도 updateWaypoints로 처리)
            // - 피드백 라인(루프를 닫는 플로우)은 시퀀스/waypoints 적용 제외
            const allElements = elementRegistry.getAll();
            const sequenceFlowsForLayout = allElements.filter((el) => {
                if (!el.businessObject || el.businessObject.$type !== 'bpmn:SequenceFlow' || !el.source || !el.target) {
                    return false;
                }
                if (feedbackFlowIds.has(el.id)) return false;

                const source = el.source;
                const target = el.target;

                const isSourceBoundary = source && source.businessObject && source.businessObject.$type === 'bpmn:BoundaryEvent';

                const isTargetBoundary = target && target.businessObject && target.businessObject.$type === 'bpmn:BoundaryEvent';

                return !isSourceBoundary && !isTargetBoundary;
            });

            if (!includeWaypoints) {
                console.log('[BPMN-Layout] waypoints 갱신 생략 (includeWaypoints=false).');
            } else {
                // includeWaypoints일 때 layoutConnection 호출
                // perf A 진짜 활용: 노드 이동이 모두 끝난 시점이므로 spatial index 를 fresh 좌표로 rebuild.
                // 이후 layoutConnection 호출들이 segment-level spatial query 로 obstacle 검사를 좁힐 수 있다.
                try {
                    const __activeIdx = getActiveObstacleSpatialIndex();
                    if (__activeIdx) {
                        __activeIdx.rebuild(elementRegistry.getAll());
                    }
                } catch (_e) {}
                const LAYOUT_DEBUG = typeof window !== 'undefined' && window.__BPMN_LAYOUT_DEBUG__;
                const COORD_DEBUG = typeof window !== 'undefined' && window.__BPMN_LAYOUT_COORD_DEBUG__;

                function dist(p1, p2) {
                    if (!p1 || !p2 || typeof p1.x !== 'number' || typeof p1.y !== 'number') return null;
                    const dx = (p2.x || 0) - p1.x;
                    const dy = (p2.y || 0) - p1.y;
                    return Math.sqrt(dx * dx + dy * dy);
                }
                function elemCenter(el) {
                    if (!el || typeof el.x !== 'number') return null;
                    return {
                        x: el.x + (el.width || 0) / 2,
                        y: el.y + (el.height || 0) / 2
                    };
                }

                function inferDockSideFromPoint(shape, point) {
                    if (!shape || !point) return null;
                    const left = shape.x;
                    const right = shape.x + (shape.width || 0);
                    const top = shape.y;
                    const bottom = shape.y + (shape.height || 0);
                    const dxL = Math.abs(point.x - left);
                    const dxR = Math.abs(point.x - right);
                    const dyT = Math.abs(point.y - top);
                    const dyB = Math.abs(point.y - bottom);
                    const min = Math.min(dxL, dxR, dyT, dyB);
                    if (min === dxL) return 'l';
                    if (min === dxR) return 'r';
                    if (min === dyT) return 't';
                    return 'b';
                }

                function sideFacesShape(shape, otherShape, side) {
                    const sc = elemCenter(shape);
                    const oc = elemCenter(otherShape);
                    if (!sc || !oc || !side) return false;
                    const dx = oc.x - sc.x;
                    const dy = oc.y - sc.y;
                    const eps = 1e-3;
                    if (side === 'l') return dx < -eps;
                    if (side === 'r') return dx > eps;
                    if (side === 't') return dy < -eps;
                    if (side === 'b') return dy > eps;
                    return false;
                }

                function pickPreferredSide(shape, otherShape) {
                    const sc = elemCenter(shape);
                    const oc = elemCenter(otherShape);
                    if (!sc || !oc) return null;
                    const dx = oc.x - sc.x;
                    const dy = oc.y - sc.y;
                    const adx = Math.abs(dx);
                    const ady = Math.abs(dy);
                    if (horizontal && adx * 1.2 >= ady) {
                        return dx >= 0 ? 'r' : 'l';
                    }
                    if (!horizontal && ady * 1.2 >= adx) {
                        return dy >= 0 ? 'b' : 't';
                    }
                    if (adx >= ady) {
                        return dx >= 0 ? 'r' : 'l';
                    }
                    return dy >= 0 ? 'b' : 't';
                }

                function dockPointOnSide(shape, side) {
                    if (!shape || !side) return null;
                    const point = dockingPointOnShapeBoundary(shape, side, 0);
                    return point ? { x: point.x, y: point.y } : null;
                }

                function isGatewayShape(shape) {
                    const type = shape && shape.businessObject && shape.businessObject.$type;
                    return typeof type === 'string' && type.indexOf('Gateway') !== -1;
                }

                function pointClose(a, b, eps = 0.5) {
                    return !!a && !!b && Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;
                }

                function alignPointFromSide(anchor, refPoint, side, minLeg = 16) {
                    const point = { x: refPoint.x, y: refPoint.y };
                    if (side === 'l') {
                        point.x = Math.min(anchor.x - minLeg, point.x);
                        point.y = anchor.y;
                    } else if (side === 'r') {
                        point.x = Math.max(anchor.x + minLeg, point.x);
                        point.y = anchor.y;
                    } else if (side === 't') {
                        point.x = anchor.x;
                        point.y = Math.min(anchor.y - minLeg, point.y);
                    } else if (side === 'b') {
                        point.x = anchor.x;
                        point.y = Math.max(anchor.y + minLeg, point.y);
                    }
                    return point;
                }

                function projectPointFromSide(anchor, side, minLeg = 16) {
                    if (!anchor || !side) return null;
                    if (side === 'l') return { x: anchor.x - minLeg, y: anchor.y };
                    if (side === 'r') return { x: anchor.x + minLeg, y: anchor.y };
                    if (side === 't') return { x: anchor.x, y: anchor.y - minLeg };
                    if (side === 'b') return { x: anchor.x, y: anchor.y + minLeg };
                    return { x: anchor.x, y: anchor.y };
                }

                function compactWaypointList(points) {
                    const out = [];
                    points.forEach((point) => {
                        if (!point || typeof point.x !== 'number' || typeof point.y !== 'number') return;
                        const prev = out[out.length - 1];
                        if (!prev || Math.abs(prev.x - point.x) > 0.5 || Math.abs(prev.y - point.y) > 0.5) {
                            out.push(point);
                        }
                    });
                    return out;
                }

                function getBoundaryAttachedOuterSide(boundary) {
                    if (!boundary) return null;
                    const host = boundary.host || (boundary.businessObject && boundary.businessObject.attachedToRef);
                    if (!host || typeof host.x !== 'number' || typeof host.y !== 'number') {
                        return null;
                    }
                    const center = elemCenter(boundary);
                    if (!center) return null;
                    const distances = [
                        { side: 'l', value: Math.abs(center.x - host.x) },
                        { side: 'r', value: Math.abs(center.x - (host.x + (host.width || 0))) },
                        { side: 't', value: Math.abs(center.y - host.y) },
                        { side: 'b', value: Math.abs(center.y - (host.y + (host.height || 0))) }
                    ];
                    distances.sort((a, b) => a.value - b.value);
                    return distances[0] && distances[0].value <= 2 ? distances[0].side : null;
                }

                function samePoint(a, b) {
                    return !!a && !!b && a.x === b.x && a.y === b.y;
                }

                function orthogonalizeNormalizedWaypoints(points) {
                    if (!Array.isArray(points) || points.length < 2) {
                        return points;
                    }
                    const normalized = [points[0]];
                    for (let i = 1; i < points.length; i++) {
                        const a = normalized[normalized.length - 1];
                        const b = points[i];
                        if (!a || !b) continue;
                        if (a.x !== b.x && a.y !== b.y) {
                            const prev = normalized.length >= 2 ? normalized[normalized.length - 2] : null;
                            const next = i + 1 < points.length ? points[i + 1] : null;
                            const elbowA = { x: a.x, y: b.y };
                            const elbowB = { x: b.x, y: a.y };
                            let elbow = null;

                            if (next && next.y === b.y && !samePoint(elbowB, prev) && !samePoint(elbowB, next)) {
                                elbow = elbowB;
                            } else if (next && next.x === b.x && !samePoint(elbowA, prev) && !samePoint(elbowA, next)) {
                                elbow = elbowA;
                            } else if (prev && prev.y === a.y && !samePoint(elbowA, prev)) {
                                elbow = elbowA;
                            } else if (prev && prev.x === a.x && !samePoint(elbowB, prev)) {
                                elbow = elbowB;
                            } else if (!samePoint(elbowB, prev) && !samePoint(elbowB, next)) {
                                elbow = elbowB;
                            } else {
                                elbow = elbowA;
                            }

                            if (!samePoint(elbow, a) && !samePoint(elbow, b) && !samePoint(elbow, prev)) {
                                normalized.push(elbow);
                            }
                        }
                        if (!samePoint(b, normalized[normalized.length - 1])) {
                            normalized.push(b);
                        }
                    }
                    return normalized;
                }

                function routeBoundarySourceFlow(flow, currentWaypoints) {
                    if (!flow || !flow.source || !flow.target || !Array.isArray(currentWaypoints) || currentWaypoints.length < 2) {
                        return currentWaypoints;
                    }
                    const bo = flow.source.businessObject;
                    if (!bo || bo.$type !== 'bpmn:BoundaryEvent') {
                        return currentWaypoints;
                    }

                    const sourceSide =
                        getBoundaryAttachedOuterSide(flow.source) ||
                        pickPreferredSide(flow.source, flow.target) ||
                        inferDockSideFromPoint(flow.source, currentWaypoints[0]);
                    const targetSide =
                        inferDockSideFromPoint(flow.target, currentWaypoints[currentWaypoints.length - 1]) ||
                        pickPreferredSide(flow.target, flow.source);
                    const sourceDock = dockPointOnSide(flow.source, sourceSide);
                    const targetDock = dockPointOnSide(flow.target, targetSide);
                    const sourceLead = projectPointFromSide(sourceDock, sourceSide);
                    const targetLead = projectPointFromSide(targetDock, targetSide);
                    if (!sourceDock || !targetDock || !sourceLead || !targetLead) {
                        return currentWaypoints;
                    }

                    const bridge =
                        sourceSide === 't' || sourceSide === 'b'
                            ? { x: targetLead.x, y: sourceLead.y }
                            : { x: sourceLead.x, y: targetLead.y };

                    return compactWaypointList(orthogonalizeNormalizedWaypoints([sourceDock, sourceLead, bridge, targetLead, targetDock]));
                }

                function normalizeSequenceFlowEndpointFacing(flow) {
                    if (!flow || !flow.source || !flow.target || !Array.isArray(flow.waypoints) || flow.waypoints.length < 2) {
                        return null;
                    }
                    const nextWaypoints = flow.waypoints.map((p) => ({ x: p.x, y: p.y }));
                    const sourceSide = pickPreferredSide(flow.source, flow.target);
                    const targetSide = pickPreferredSide(flow.target, flow.source);
                    const currentSourceSide = inferDockSideFromPoint(flow.source, nextWaypoints[0]);
                    const currentTargetSide = inferDockSideFromPoint(flow.target, nextWaypoints[nextWaypoints.length - 1]);
                    let changed = false;

                    if (isGatewayShape(flow.source) && currentSourceSide) {
                        const sourceDock = dockPointOnSide(flow.source, currentSourceSide);
                        if (sourceDock && !pointClose(nextWaypoints[0], sourceDock)) {
                            nextWaypoints[0] = sourceDock;
                            nextWaypoints[1] = alignPointFromSide(nextWaypoints[0], nextWaypoints[1], currentSourceSide);
                            changed = true;
                        }
                    }

                    if (
                        sourceSide &&
                        sideFacesShape(flow.source, flow.target, sourceSide) &&
                        !sideFacesShape(flow.source, flow.target, currentSourceSide)
                    ) {
                        nextWaypoints[0] = dockPointOnSide(flow.source, sourceSide);
                        nextWaypoints[1] = alignPointFromSide(nextWaypoints[0], nextWaypoints[1], sourceSide);
                        changed = true;
                    }

                    if (isGatewayShape(flow.target) && currentTargetSide && nextWaypoints.length >= 2) {
                        const lastIdx = nextWaypoints.length - 1;
                        const targetDock = dockPointOnSide(flow.target, currentTargetSide);
                        if (targetDock && !pointClose(nextWaypoints[lastIdx], targetDock)) {
                            nextWaypoints[lastIdx] = targetDock;
                            nextWaypoints[lastIdx - 1] = alignPointFromSide(
                                nextWaypoints[lastIdx],
                                nextWaypoints[lastIdx - 1],
                                currentTargetSide
                            );
                            changed = true;
                        }
                    }

                    if (
                        nextWaypoints.length >= 3 &&
                        targetSide &&
                        sideFacesShape(flow.target, flow.source, targetSide) &&
                        !sideFacesShape(flow.target, flow.source, currentTargetSide)
                    ) {
                        const lastIdx = nextWaypoints.length - 1;
                        nextWaypoints[lastIdx] = dockPointOnSide(flow.target, targetSide);
                        nextWaypoints[lastIdx - 1] = alignPointFromSide(nextWaypoints[lastIdx], nextWaypoints[lastIdx - 1], targetSide);
                        changed = true;
                    }

                    return changed ? orthogonalizeNormalizedWaypoints(nextWaypoints) : null;
                }

                function routeInternalSubProcessFeedback(flow) {
                    if (!flow || !flow.source || !flow.target) return null;
                    const sourceType = flow.source.businessObject && flow.source.businessObject.$type;
                    const targetType = flow.target.businessObject && flow.target.businessObject.$type;
                    if (!sourceType || !targetType || !sourceType.includes('Gateway') || !targetType.includes('Gateway')) {
                        return null;
                    }

                    const sourceSpId = spGetNearestSubProcessId(flow.source);
                    const targetSpId = spGetNearestSubProcessId(flow.target);
                    if (!sourceSpId || sourceSpId !== targetSpId) {
                        return null;
                    }

                    const subProcess = elementRegistry.get(sourceSpId);
                    if (!subProcess) return null;

                    const sourceCenter = elemCenter(flow.source);
                    const targetCenter = elemCenter(flow.target);
                    if (!sourceCenter || !targetCenter || targetCenter.x >= sourceCenter.x) {
                        return null;
                    }

                    const sourceDock = dockingPointOnShapeBoundary(flow.source, 'b', 0);
                    const targetDock = dockingPointOnShapeBoundary(flow.target, 't', 0);
                    if (!sourceDock || !targetDock) return null;

                    const minY = sourceDock.y + 28;
                    const maxY = targetDock.y - 28;
                    const corridorY =
                        minY <= maxY
                            ? (minY + maxY) / 2
                            : Math.max(sourceDock.y + 28, Math.min(subProcess.y + subProcess.height - 28, sourceCenter.y + 58));

                    return compactWaypointList(
                        orthogonalizeNormalizedWaypoints([
                            { x: sourceDock.x, y: sourceDock.y },
                            { x: sourceDock.x, y: corridorY },
                            { x: targetDock.x, y: corridorY },
                            { x: targetDock.x, y: targetDock.y }
                        ])
                    );
                }

                console.log('[BPMN-Layout] layoutConnection 대상:', sequenceFlowsForLayout.length, '개');
                sequenceFlowsForLayout.forEach((flow) => {
                    const src = flow.source;
                    const tgt = flow.target;
                    const wpBefore = flow.waypoints ? [...flow.waypoints.map((w) => ({ x: w.x, y: w.y }))] : [];
                    const wpBeforeLen = wpBefore.length;

                    let metricsBefore = null;
                    if (COORD_DEBUG && src && tgt && wpBeforeLen >= 2) {
                        const sc = elemCenter(src);
                        const tc = elemCenter(tgt);
                        const firstWp = wpBefore[0];
                        const lastWp = wpBefore[wpBeforeLen - 1];
                        const dSrcFirst = dist(sc, firstWp);
                        const dLastTgt = dist(lastWp, tc);
                        const dSrcTgt = dist(sc, tc);
                        metricsBefore = {
                            source: { id: src.id, x: src.x, y: src.y, w: src.width, h: src.height, center: sc },
                            target: { id: tgt.id, x: tgt.x, y: tgt.y, w: tgt.width, h: tgt.height, center: tc },
                            distSrcToFirstWp: dSrcFirst,
                            distLastWpToTgt: dLastTgt,
                            distSrcToTgt: dSrcTgt,
                            firstWp: firstWp,
                            lastWp: lastWp
                        };
                    }

                    try {
                        modeling.layoutConnection(flow);
                        const normalizedWaypoints = routeInternalSubProcessFeedback(flow) || normalizeSequenceFlowEndpointFacing(flow);
                        if (normalizedWaypoints) {
                            modeling.updateWaypoints(flow, normalizedWaypoints);
                        }
                        const wpAfter = flow.waypoints || [];
                        const wpAfterLen = wpAfter.length;

                        if (LAYOUT_DEBUG && !COORD_DEBUG) {
                            console.log(
                                '[BPMN-Layout] layoutConnection OK:',
                                flow.id,
                                '| source:',
                                src?.id,
                                '→ target:',
                                tgt?.id,
                                '| waypoints:',
                                wpBeforeLen,
                                '→',
                                wpAfterLen
                            );
                        }

                        if (COORD_DEBUG && metricsBefore && wpAfterLen >= 2) {
                            const sc = elemCenter(src);
                            const tc = elemCenter(tgt);
                            const firstWpAfter = { x: wpAfter[0].x, y: wpAfter[0].y };
                            const lastWpAfter = { x: wpAfter[wpAfterLen - 1].x, y: wpAfter[wpAfterLen - 1].y };
                            const dSrcFirstAfter = dist(sc, firstWpAfter);
                            const dLastTgtAfter = dist(lastWpAfter, tc);
                            const dSrcTgtAfter = dist(sc, tc);

                            const deltaSrcFirst =
                                metricsBefore.distSrcToFirstWp != null && dSrcFirstAfter != null
                                    ? (dSrcFirstAfter - metricsBefore.distSrcToFirstWp).toFixed(1)
                                    : '-';
                            const deltaLastTgt =
                                metricsBefore.distLastWpToTgt != null && dLastTgtAfter != null
                                    ? (dLastTgtAfter - metricsBefore.distLastWpToTgt).toFixed(1)
                                    : '-';
                            const deltaFirstWp = Math.sqrt(
                                Math.pow(firstWpAfter.x - metricsBefore.firstWp.x, 2) +
                                    Math.pow(firstWpAfter.y - metricsBefore.firstWp.y, 2)
                            ).toFixed(1);
                            const deltaLastWp = Math.sqrt(
                                Math.pow(lastWpAfter.x - metricsBefore.lastWp.x, 2) + Math.pow(lastWpAfter.y - metricsBefore.lastWp.y, 2)
                            ).toFixed(1);

                            console.log(
                                '[BPMN-Layout] COORD',
                                flow.id,
                                '| source:',
                                src.id,
                                `(${src.x?.toFixed(0)},${src.y?.toFixed(0)})`,
                                '| target:',
                                tgt.id,
                                `(${tgt.x?.toFixed(0)},${tgt.y?.toFixed(0)})`
                            );
                            console.log(
                                '[BPMN-Layout]   dist(source→첫WP):',
                                metricsBefore.distSrcToFirstWp?.toFixed(1),
                                '→',
                                dSrcFirstAfter?.toFixed(1),
                                '(Δ' + deltaSrcFirst + ')',
                                '| dist(끝WP→target):',
                                metricsBefore.distLastWpToTgt?.toFixed(1),
                                '→',
                                dLastTgtAfter?.toFixed(1),
                                '(Δ' + deltaLastTgt + ')'
                            );
                            console.log(
                                '[BPMN-Layout]   첫WP 이동:',
                                deltaFirstWp,
                                'px | 끝WP 이동:',
                                deltaLastWp,
                                'px',
                                '| src↔tgt:',
                                metricsBefore.distSrcToTgt?.toFixed(1),
                                '→',
                                dSrcTgtAfter?.toFixed(1)
                            );
                        }
                    } catch (e) {
                        console.warn('[BPMN-Layout] layoutConnection 실패:', flow.id, e);
                    }
                });

                const feedbackFlowsForLayout = allElements.filter((el) => {
                    if (
                        !el.businessObject ||
                        el.businessObject.$type !== 'bpmn:SequenceFlow' ||
                        !el.source ||
                        !el.target ||
                        !feedbackFlowIds.has(el.id)
                    ) {
                        return false;
                    }
                    const isSourceBoundary = el.source.businessObject && el.source.businessObject.$type === 'bpmn:BoundaryEvent';
                    const isTargetBoundary = el.target.businessObject && el.target.businessObject.$type === 'bpmn:BoundaryEvent';
                    return !isSourceBoundary && !isTargetBoundary;
                });

                feedbackFlowsForLayout.forEach((flow) => {
                    try {
                        modeling.layoutConnection(flow);
                        const newWaypoints = computeFinalSequenceFlowWaypoints(
                            flow,
                            (flow.waypoints || []).map((p) => ({ x: p.x, y: p.y })),
                            elementRegistry,
                            {
                                horizontalLayout: horizontal,
                                snapFacingEndpoints: true
                            }
                        );
                        if (Array.isArray(newWaypoints) && newWaypoints.length >= 2) {
                            modeling.updateWaypoints(flow, newWaypoints);
                        }
                    } catch (e) {
                        console.warn('[BPMN-Layout] feedback layoutConnection 실패:', flow.id, e);
                    }
                });

                // Integrated Labeling: 노드·엣지 라벨 겹침 방지 (waypoints와 무관하게 항상 실행).
                // perf: 이전엔 elements (필터된 set) 와 getAll() 두 번 호출 → 같은 element ref 라 중복 처리.
                // getAll() 한 번이면 superset 이라 같은 결과.
                adjustLabelsToAvoidOverlap(elementRegistry.getAll(), modeling);

                // boundary 이벤트와 연결된 시퀀스 플로우는 모든 레이아웃이 끝난 "마지막 타이밍"에 별도로 재계산
                const boundaryFlows = elements.filter((el) => {
                    if (
                        !el.businessObject ||
                        el.businessObject.$type !== 'bpmn:SequenceFlow' ||
                        !el.waypoints ||
                        !Array.isArray(el.waypoints)
                    ) {
                        return false;
                    }

                    const source = el.source;
                    const target = el.target;

                    const isSourceBoundary = source && source.businessObject && source.businessObject.$type === 'bpmn:BoundaryEvent';

                    const isTargetBoundary = target && target.businessObject && target.businessObject.$type === 'bpmn:BoundaryEvent';

                    return isSourceBoundary || isTargetBoundary;
                });

                boundaryFlows.forEach((flow) => {
                    try {
                        const source = flow.source;
                        const target = flow.target;
                        const endpointInfo = boundaryFlowEndpoints.get(flow.id) || {};
                        const innerInfo = endpointInfo.inner || [];

                        if (
                            !source ||
                            !target ||
                            typeof source.x !== 'number' ||
                            typeof source.y !== 'number' ||
                            typeof source.width !== 'number' ||
                            typeof source.height !== 'number' ||
                            typeof target.x !== 'number' ||
                            typeof target.y !== 'number' ||
                            typeof target.width !== 'number' ||
                            typeof target.height !== 'number'
                        ) {
                            return;
                        }

                        // 시작점/끝점: "이전에 붙어있던 변 + 비율" 정보를 우선 사용
                        function computeEndpoint(element, attachInfo) {
                            const centerFallback = {
                                x: element.x + element.width / 2,
                                y: element.y + element.height / 2
                            };

                            if (!attachInfo || !attachInfo.side) {
                                const p = { ...centerFallback };
                                snapPointToElementCorner(p, element);
                                return p;
                            }

                            const side = attachInfo.side;
                            const t = typeof attachInfo.t === 'number' ? Math.min(1, Math.max(0, attachInfo.t)) : 0.5;

                            let cx = element.x + element.width / 2;
                            let cy = element.y + element.height / 2;

                            if (side === 'left') {
                                cx = element.x;
                                cy = element.y + element.height * t;
                            } else if (side === 'right') {
                                cx = element.x + element.width;
                                cy = element.y + element.height * t;
                            } else if (side === 'top') {
                                cx = element.x + element.width * t;
                                cy = element.y;
                            } else if (side === 'bottom') {
                                cx = element.x + element.width * t;
                                cy = element.y + element.height;
                            }

                            return { x: cx, y: cy };
                        }

                        const start = computeEndpoint(source, endpointInfo.source);
                        const end = computeEndpoint(target, endpointInfo.target);

                        // 예전 경로의 꺾임(inner waypoint)들을 start/end 기준 박스 안에서 같은 비율 위치로 복원
                        let minX = Math.min(start.x, end.x);
                        let maxX = Math.max(start.x, end.x);
                        let minY = Math.min(start.y, end.y);
                        let maxY = Math.max(start.y, end.y);

                        const width = maxX - minX || 1;
                        const height = maxY - minY || 1;

                        const restoredInner = innerInfo.map((p) => ({
                            x: minX + p.nx * width,
                            y: minY + p.ny * height
                        }));

                        const newWaypoints = routeBoundarySourceFlow(
                            flow,
                            computeFinalSequenceFlowWaypoints(flow, [start, ...restoredInner, end], elementRegistry, {
                                horizontalLayout: horizontal,
                                snapFacingEndpoints: false
                            })
                        );

                        modeling.updateWaypoints(flow, newWaypoints);
                    } catch (e) {
                        console.warn('Boundary 시퀀스 플로우 레이아웃 재적용 실패:', flow.id, e);
                    }
                });
            }
        } catch (error) {
            console.error('[BPMN-Layout] 자동 레이아웃 오류:', error);
            throw error;
        } finally {
            pushLayoutTiming('v1.applyAutoLayout', timingStartMs, {
                horizontal: !!horizontal,
                includeWaypoints: includeWaypoints !== false
            });
            console.log('[BPMN-Layout] applyAutoLayout 완료');
            onLoadEnd();
        }
    };

    /**
     * 개선된 waypoints를 BPMN 모델에 적용하는 유틸리티 함수
     * @param {Object} graph - 레이아웃이 적용된 그래프 객체
     * @param {BpmnJS} bpmnModeler - BPMN-JS 모델러 인스턴스
     */
    function applyGraphWaypointsToBpmnModeler(graph, bpmnModeler) {
        const modeling = bpmnModeler.get('modeling');
        const elementRegistry = bpmnModeler.get('elementRegistry');

        if (!graph || !graph.edges || graph.edges.length === 0) return;

        graph.edges.forEach((edge) => {
            // 피드백 엣지는 graph.edges에 포함되지 않음 (레이아웃 run()에서 제거됨)
            const source = graph.getNode(edge.source);
            const target = graph.getNode(edge.target);
            const waypoints = edge.waypoints;

            if (!source || !target || !Array.isArray(waypoints) || waypoints.length < 2) return;

            const connectionElement = elementRegistry.filter((el) => {
                return (
                    el.businessObject &&
                    el.businessObject.$type === 'bpmn:SequenceFlow' &&
                    el.source &&
                    el.target &&
                    el.source.id === source.id &&
                    el.target.id === target.id
                );
            })[0];

            if (!connectionElement) return;

            try {
                modeling.updateWaypoints(connectionElement, waypoints);
            } catch (err) {
                console.warn(`연결선(${source.id} -> ${target.id}) waypoints 적용 실패`, err);
            }
        });
    }

    // (SubProcess 흡수본 / 라벨 후처리 알고리즘은 ./bpmn-auto-layout/subprocess-pass.js,
    //  ./bpmn-auto-layout/label-after-layout.js 로 분리되어 위에서 import 함)

    /**
     * 자동 레이아웃 통합 진입점.
     * - SubProcess 가 있으면 안쪽부터 개별 레이아웃 + 컨테이너 리사이즈를 먼저 수행한 뒤,
     *   SubProcess 자식을 제외한 상위 다이어그램을 한 번 더 v1 코어로 재배치한다.
     * - SubProcess 가 없으면 v1 코어만 수행한다.
     * - 마지막으로 라벨 위치를 정리한다.
     */
    BpmnAutoLayout.applyAutoLayout = function (bpmnModeler, options = {}, onLoadStart = () => {}, onLoadEnd = () => {}) {
        const { horizontal = false, layoutOptions = {}, includeWaypoints = true } = options;
        const timingStartMs = nowMs();
        console.log('[BPMN-Layout] applyAutoLayout 시작 | horizontal:', horizontal);
        onLoadStart();

        window.isHorizontalLayout = horizontal;

        if (!bpmnModeler) {
            throw new Error('BPMN 모델러가 제공되지 않았습니다.');
        }

        // perf A: 한 자동 레이아웃 호출 동안 element pool 을 spatial index 에 캐싱.
        // collectSequenceFlowObstacleElements 가 매 connection 마다 elementRegistry.getAll() 호출하던 비용을
        // O(N×M) → O(N+M) 으로 절감. 인덱스가 없으면 fallback 으로 elementRegistry.getAll() 사용.
        const __spatialIndex = new ObstacleSpatialIndex();
        setActiveObstacleSpatialIndex(__spatialIndex);

        try {
            const elementRegistry = bpmnModeler.get('elementRegistry');
            const all = elementRegistry.getAll();
            __spatialIndex.build(all);

            const subProcesses = all.filter((el) => el.businessObject && el.businessObject.$type === 'bpmn:SubProcess');

            if (!subProcesses.length) {
                BpmnAutoLayout.__applyAutoLayoutInternal(
                    bpmnModeler,
                    { horizontal, layoutOptions, includeWaypoints },
                    () => {},
                    () => {}
                );
                adjustLabelsAfterLayout(bpmnModeler);
                return;
            }

            // 부모 체인 깊이 기준 안쪽부터 처리
            const withDepth = subProcesses.map((sp) => {
                let depth = 0;
                let p = sp.parent;
                while (p) {
                    if (p.businessObject && p.businessObject.$type === 'bpmn:SubProcess') depth++;
                    p = p.parent;
                }
                return { element: sp, depth };
            });
            withDepth.sort((a, b) => b.depth - a.depth);

            const shouldRefreshSubProcessWaypoints = includeWaypoints;

            withDepth.forEach(({ element: sp }) => {
                layoutSingleSubProcess(bpmnModeler, sp, {
                    horizontal,
                    layoutOptions,
                    includeWaypoints: shouldRefreshSubProcessWaypoints
                });
            });

            // 2단계: SubProcess 컨테이너를 단일 노드처럼 두고 상위 다이어그램 재배치
            const prevFilter = global.__bpmnAutoLayoutFilterElements;
            global.__bpmnAutoLayoutFilterElements = function (el) {
                if (!el || !el.businessObject) return true;
                const bo = el.businessObject;
                if (bo.$type === 'bpmn:SubProcess') return true;
                const nearestSpId = spGetNearestSubProcessId(el);
                if (nearestSpId) return false;
                return true;
            };

            try {
                BpmnAutoLayout.__applyAutoLayoutInternal(
                    bpmnModeler,
                    { horizontal, layoutOptions, includeWaypoints },
                    () => {},
                    () => {}
                );
            } finally {
                global.__bpmnAutoLayoutFilterElements = prevFilter;
            }

            adjustLabelsAfterLayout(bpmnModeler);
        } catch (error) {
            console.error('[BPMN-Layout] 자동 레이아웃 적용 중 오류:', error);
            throw error;
        } finally {
            clearActiveObstacleSpatialIndex();
            pushLayoutTiming('applyAutoLayout', timingStartMs, {
                horizontal: !!horizontal,
                includeWaypoints: includeWaypoints !== false
            });
            onLoadEnd();
        }
    };

    /** Waypoints 만 갱신. BpmnWaypointsRefresh 모듈에 위임. */
    BpmnAutoLayout.refreshWaypointsOnly = function (bpmnModeler) {
        if (!bpmnModeler) return;
        if (global.BpmnWaypointsRefresh && typeof global.BpmnWaypointsRefresh.refreshAll === 'function') {
            global.BpmnWaypointsRefresh.refreshAll(bpmnModeler);
        } else {
            console.warn('[BPMN-Layout] BpmnWaypointsRefresh 가 로드되지 않았습니다. waypoints 갱신을 건너뜁니다.');
        }
    };

    // 글로벌 객체에 추가 (구 BpmnAutoLayoutV2 는 동일 객체를 가리키는 alias)
    global.BpmnAutoLayout = BpmnAutoLayout;
    global.BpmnAutoLayoutV2 = BpmnAutoLayout;
})(typeof window !== 'undefined' ? window : this);
