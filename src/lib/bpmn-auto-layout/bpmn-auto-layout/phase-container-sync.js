// Ported from Process GPT vue3 frontend — process-gpt/services/frontend/src/components/autoLayout/bpmn-auto-layout/phase-container-sync.js @ 0e85995b.
// Copied as is for Lite's BPMN views (src/lib/bpmn-auto-layout/index.js); changes here are marked "Lite:".
/**
 * phase:PhaseContainer / phase:Phase 가 bpmn:Participant 변경에 따라가도록 동기화.
 *
 * - PhaseContainer 는 항상 Participant 의 \"머리\" 쪽(가로 모드: 위, 세로 모드: 왼쪽)에 붙어있는다.
 * - 내부 Phase 들은 Participant 길이에 비례해 분배되, 마지막 Phase 가 잔여 길이를 흡수한다.
 */

function nearlyEqual(a, b, tolerance = 1) {
    return Math.abs((a ?? 0) - (b ?? 0)) < tolerance;
}

const PHASE_STRIP_THICKNESS = 60;

function setHorizontal(element, isHorizontal) {
    if (!element) {
        return;
    }

    if (element.di) {
        element.di.isHorizontal = isHorizontal;
    }

    if (element.businessObject) {
        element.businessObject.isHorizontal = isHorizontal;
    }
}

function getAttachedPhaseContainer(participant, phaseContainers, isParticipantHorizontal) {
    if (!participant || !Array.isArray(phaseContainers)) {
        return null;
    }

    const siblings = phaseContainers.filter((pc) => pc && pc.parent?.id === participant.parent?.id);
    if (!siblings.length) {
        return null;
    }

    const participantLeadingEdge = isParticipantHorizontal ? participant.y : participant.x;

    return (
        siblings
            .map((pc) => {
                const containerTrailingEdge = isParticipantHorizontal ? (pc.y ?? 0) + (pc.height ?? 0) : (pc.x ?? 0) + (pc.width ?? 0);
                const distance = Math.abs(participantLeadingEdge - containerTrailingEdge);
                return { pc, distance };
            })
            .sort((a, b) => a.distance - b.distance)[0]?.pc ?? null
    );
}

function getAdjustedPhaseLengths(phases, totalLength, isParticipantHorizontal) {
    const currentLengths = phases.map((phase) => {
        const rawLength = isParticipantHorizontal ? phase.width : phase.height;
        return typeof rawLength === 'number' && rawLength > 0 ? rawLength : 0;
    });

    if (!currentLengths.length) {
        return [];
    }

    if (currentLengths.length === 1) {
        return [totalLength];
    }

    const preservedLeadingTotal = currentLengths.slice(0, -1).reduce((sum, length) => sum + length, 0);

    if (preservedLeadingTotal < totalLength) {
        return [...currentLengths.slice(0, -1), totalLength - preservedLeadingTotal];
    }

    const currentTotal = currentLengths.reduce((sum, length) => sum + length, 0);
    if (!(currentTotal > 0)) {
        const evenLength = totalLength / currentLengths.length;
        return currentLengths.map((_, index) =>
            index === currentLengths.length - 1 ? totalLength - evenLength * (currentLengths.length - 1) : evenLength
        );
    }

    const scaledLengths = [];
    let consumed = 0;
    currentLengths.forEach((length, index) => {
        if (index === currentLengths.length - 1) {
            scaledLengths.push(Math.max(0, totalLength - consumed));
            return;
        }

        const nextLength = (length / currentTotal) * totalLength;
        scaledLengths.push(nextLength);
        consumed += nextLength;
    });

    return scaledLengths;
}

function getEvenPhaseLengths(phases, totalLength) {
    if (!phases.length) {
        return [];
    }

    const evenLength = totalLength / phases.length;
    return phases.map((_, index) => (index === phases.length - 1 ? totalLength - evenLength * (phases.length - 1) : evenLength));
}

function looksLikeRotationCompressionArtifact(phases, totalLength, isParticipantHorizontal) {
    if (phases.length < 2 || !(totalLength > 0)) {
        return false;
    }

    const lengths = phases.map((phase) => (isParticipantHorizontal ? phase.width : phase.height));
    const leading = lengths.slice(0, -1);
    const last = lengths[lengths.length - 1];

    return leading.every((length) => length <= PHASE_STRIP_THICKNESS * 1.5) && last >= totalLength / 2;
}

export function syncPhaseContainersWithParticipants(bpmnModeler, options = {}) {
    if (!bpmnModeler) {
        return 0;
    }

    const { horizontal = false } = options;
    const elementRegistry = bpmnModeler.get('elementRegistry');
    const modeling = bpmnModeler.get('modeling');
    if (!elementRegistry || !modeling) {
        return 0;
    }

    const elements = elementRegistry.getAll();
    const participants = elements.filter((el) => el.type === 'bpmn:Participant');
    const phaseContainers = elements.filter((el) => el.type === 'phase:PhaseContainer');
    let changed = 0;

    participants.forEach((participant) => {
        if (
            typeof participant.x !== 'number' ||
            typeof participant.y !== 'number' ||
            typeof participant.width !== 'number' ||
            typeof participant.height !== 'number'
        ) {
            return;
        }

        const isParticipantHorizontal =
            typeof participant.di?.isHorizontal === 'boolean'
                ? participant.di.isHorizontal
                : typeof horizontal === 'boolean'
                ? horizontal
                : false;
        const attached = getAttachedPhaseContainer(participant, phaseContainers, isParticipantHorizontal);
        if (!attached) {
            return;
        }

        const phases = elements
            .filter((el) => el.type === 'phase:Phase' && el.parent?.id === attached.id)
            .sort((a, b) => (isParticipantHorizontal ? (a.x || 0) - (b.x || 0) : (a.y || 0) - (b.y || 0)));

        const thickness = PHASE_STRIP_THICKNESS;

        const nextBounds = isParticipantHorizontal
            ? {
                  x: participant.x,
                  y: participant.y - thickness,
                  width: participant.width,
                  height: thickness
              }
            : {
                  x: participant.x - thickness,
                  y: participant.y,
                  width: thickness,
                  height: participant.height
              };

        try {
            setHorizontal(attached, !isParticipantHorizontal);
            if (
                !nearlyEqual(attached.x, nextBounds.x) ||
                !nearlyEqual(attached.y, nextBounds.y) ||
                !nearlyEqual(attached.width, nextBounds.width) ||
                !nearlyEqual(attached.height, nextBounds.height)
            ) {
                modeling.resizeShape(attached, nextBounds);
                changed++;
            }
        } catch (e) {
            console.warn('[AUTO_LAYOUT] PhaseContainer 리사이즈 중 오류:', attached.id, e);
            return;
        }

        if (!phases.length) {
            return;
        }

        const totalLength = isParticipantHorizontal ? nextBounds.width : nextBounds.height;
        const forceEvenLengths =
            attached.businessObject?.__equalPhaseLengthsOnce === true ||
            looksLikeRotationCompressionArtifact(phases, totalLength, isParticipantHorizontal);
        const adjustedLengths = forceEvenLengths
            ? getEvenPhaseLengths(phases, totalLength)
            : getAdjustedPhaseLengths(phases, totalLength, isParticipantHorizontal);
        if (forceEvenLengths) {
            delete attached.businessObject.__equalPhaseLengthsOnce;
        }
        let cursor = isParticipantHorizontal ? nextBounds.x : nextBounds.y;

        phases.forEach((phase, index) => {
            const phaseLength = adjustedLengths[index] ?? 0;
            const phaseBounds = isParticipantHorizontal
                ? {
                      x: cursor,
                      y: nextBounds.y,
                      width: phaseLength,
                      height: nextBounds.height
                  }
                : {
                      x: nextBounds.x,
                      y: cursor,
                      width: nextBounds.width,
                      height: phaseLength
                  };

            try {
                setHorizontal(phase, !isParticipantHorizontal);
                if (
                    !nearlyEqual(phase.x, phaseBounds.x) ||
                    !nearlyEqual(phase.y, phaseBounds.y) ||
                    !nearlyEqual(phase.width, phaseBounds.width) ||
                    !nearlyEqual(phase.height, phaseBounds.height)
                ) {
                    modeling.resizeShape(phase, phaseBounds);
                    changed++;
                }
            } catch (e) {
                console.warn('[AUTO_LAYOUT] Phase 리사이즈 중 오류:', phase.id, e);
            }

            cursor += phaseLength;
        });
    });

    return changed;
}
