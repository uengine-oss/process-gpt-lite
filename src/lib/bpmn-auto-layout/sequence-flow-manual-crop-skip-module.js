// Ported from Process GPT vue3 frontend — process-gpt/services/frontend/src/components/autoLayout/sequence-flow-manual-crop-skip-module.js @ 0e85995b.
// Copied as is for Lite's BPMN views (src/lib/bpmn-auto-layout/index.js); changes here are marked "Lite:".
/**
 * 벤드포인트·연결 세그먼트 드래그 시 CroppingConnectionDocking.getCroppedWaypoints 가 호출되는데,
 * 이때 장애물 회피·직교 맨해튼 보정을 하면 사용자가 둔 경로가 덮어씌워짐 → 드래그 구간에만 스킵.
 * (connection.layout / connection.create 등 자동 라우팅은 영향 없음)
 * 전역 플래그가 아니라 모듈 내부 상태만 사용한다.
 */

var manualCropPostprocessSkipped = false;

export function isSequenceFlowManualCropPostprocessSkipped() {
    return manualCropPostprocessSkipped;
}

function SequenceFlowManualCropSkip(eventBus) {
    function setSkip(v) {
        manualCropPostprocessSkipped = !!v;
    }

    eventBus.on('bendpoint.move.start', function () {
        setSkip(true);
    });
    eventBus.on(['bendpoint.move.cleanup', 'bendpoint.move.cancel'], function () {
        setSkip(false);
    });

    eventBus.on('connectionSegment.move.start', function () {
        setSkip(true);
    });
    eventBus.on(['connectionSegment.move.cleanup', 'connectionSegment.move.cancel'], function () {
        setSkip(false);
    });
}

SequenceFlowManualCropSkip.$inject = ['eventBus'];

export const sequenceFlowManualCropSkipModule = {
    __init__: ['sequenceFlowManualCropSkip'],
    sequenceFlowManualCropSkip: ['type', SequenceFlowManualCropSkip]
};

export default sequenceFlowManualCropSkipModule;
