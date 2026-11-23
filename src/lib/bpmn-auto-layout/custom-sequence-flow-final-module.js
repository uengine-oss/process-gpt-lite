// Ported from Process GPT vue3 frontend — process-gpt/services/frontend/src/components/autoLayout/custom-sequence-flow-final-module.js @ 0e85995b.
// Copied as is for Lite's BPMN views (src/lib/bpmn-auto-layout/index.js); changes here are marked "Lite:".
/**
 * ModelingModule 에서 다음만 교체합니다.
 * - layouter: sequence-flow-final-layouter.js
 * - connectionDocking: sequence-flow-final-connection-docking.js (CroppingConnectionDocking 복사 + visual crop only 유지)
 */
import SequenceFlowFinalLayouter from './sequence-flow-final-layouter.js';
import CroppingConnectionDocking from './sequence-flow-final-connection-docking.js';

export const customSequenceFlowFinalModule = {
    layouter: ['type', SequenceFlowFinalLayouter],
    connectionDocking: ['type', CroppingConnectionDocking]
};

export default customSequenceFlowFinalModule;
