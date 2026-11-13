// Ported from Process GPT vue3 frontend — process-gpt/services/frontend/src/components/autoLayout/bpmn-waypoints-refresh.js @ 0e85995b.
// Copied as is for Lite's BPMN views (src/lib/bpmn-auto-layout/index.js); changes here are marked "Lite:".
/**
 * BPMN Waypoints 갱신 — 커스텀 Layouter와 동일 경로(modeling.layoutConnection)
 *
 * - EdgeRouterOrthogonal 경로 제거: 레인/참가자 등과 규칙 불일치 방지, import 후 보정과 동일한 시각 결과
 * - 장애물·변 여백·직교는 현재 `sequence-flow-final-layouter.js` 단일 호스트에서 처리
 */

(function (global) {
    const BpmnWaypointsRefresh = {};

    /**
     * 모델 waypoint는 갱신됐는데 연결선 SVG가 한 프레임 늦게 따라오는 경우가 있어,
     * 최종 waypoint 기준으로 시퀀스 플로우 그래픽을 한 번 더 그린다.
     * (스크린샷·캡처 직후 경로 불일치 완화)
     */
    function flushSequenceConnectionGraphics(bpmnModeler) {
        if (!bpmnModeler) return;
        var elementRegistry = bpmnModeler.get('elementRegistry');
        var graphicsFactory = bpmnModeler.get('graphicsFactory');
        if (!elementRegistry || !graphicsFactory || typeof graphicsFactory.update !== 'function') {
            return;
        }
        var all = elementRegistry.getAll();
        for (var i = 0; i < all.length; i++) {
            var el = all[i];
            var bo = el && el.businessObject;
            if (!bo || bo.$type !== 'bpmn:SequenceFlow' || !el.source || !el.target) {
                continue;
            }
            var gfx = elementRegistry.getGraphics(el);
            if (gfx) {
                graphicsFactory.update('connection', el, gfx);
            }
        }
    }

    /**
     * 주어진 연결선(flows)에 대해 layoutConnection 을 호출한다.
     */
    BpmnWaypointsRefresh.refreshFlows = function (flows, modeling, allElements, options = {}) {
        if (!Array.isArray(flows) || !modeling) return 0;

        let count = 0;
        flows.forEach((flow) => {
            if (!flow || !flow.source || !flow.target) return;
            try {
                modeling.layoutConnection(flow);
                count++;
            } catch (err) {
                if (options.debug) {
                    console.warn('[BpmnWaypointsRefresh] layoutConnection 실패:', flow.id, err);
                }
            }
        });

        if (options.debug && flows.length > 0) {
            console.log('[BpmnWaypointsRefresh] refreshFlows:', count, '/', flows.length, '개 (layoutConnection)');
        }
        return count;
    };

    /**
     * 다이어그램 전체의 모든 SequenceFlow waypoints 를 갱신한다.
     */
    BpmnWaypointsRefresh.refreshAll = function (bpmnModeler, options = {}) {
        if (!bpmnModeler) return 0;

        const elementRegistry = bpmnModeler.get('elementRegistry');
        const modeling = bpmnModeler.get('modeling');

        if (!elementRegistry || !modeling) return 0;

        const all = elementRegistry.getAll();
        const flows = all.filter((el) => {
            const bo = el.businessObject;
            return bo && bo.$type === 'bpmn:SequenceFlow' && el.source && el.target;
        });

        const participant = all.filter((el) => el.type === 'bpmn:Participant')[0];
        const horizontal = options.horizontal ?? participant?.di?.isHorizontal ?? true;

        const count = BpmnWaypointsRefresh.refreshFlows(flows, modeling, all, {
            ...options,
            debug: !!options.debug,
            horizontal
        });

        flushSequenceConnectionGraphics(bpmnModeler);

        return count;
    };

    global.BpmnWaypointsRefresh = BpmnWaypointsRefresh;
})(typeof window !== 'undefined' ? window : this);
