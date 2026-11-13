// Ported from Process GPT vue3 frontend — process-gpt/services/frontend/src/components/autoLayout/bpmn-auto-layout/label-after-layout.js @ 0e85995b.
// Copied as is for Lite's BPMN views (src/lib/bpmn-auto-layout/index.js); changes here are marked "Lite:".
/**
 * 자동 레이아웃 종료 후 노드/시퀀스 라벨 위치 정렬.
 *
 * - Lane / Participant 라벨은 좌측 중앙으로
 * - 일반 노드 라벨은 노드 중앙 하단으로
 * - SequenceFlow 라벨은 경로 중간에서 법선 방향으로 살짝 오프셋해 선과 겹치지 않게
 *
 * 같은 파일 시리즈의 `core-single-pass` 단계에 있는 `adjustLabelsToAvoidOverlap` 와는
 * 별개의 알고리즘이며, SubProcess 흡수 시점 이후 한 번 더 호출된다 (구 v2.adjustLabelsAfterLayoutV2).
 */

/** 시퀀스 플로우 라벨이 선과 겹치지 않게 법선 방향으로 오프셋한 중심점을 반환 */
export function computeFlowLabelCenterAvoidingLine(waypoints, lw, lh) {
    if (!Array.isArray(waypoints) || waypoints.length < 2) return null;

    const midIndex = Math.floor((waypoints.length - 1) / 2);
    const p1 = waypoints[midIndex];
    const p2 = waypoints[midIndex + 1] || p1;

    const baseCenterX = (p1.x + p2.x) / 2;
    const baseCenterY = (p1.y + p2.y) / 2;

    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;

    let nx = -dy / len;
    let ny = dx / len;
    if (Math.abs(ny) < 0.1 && Math.abs(nx) < 0.1) {
        nx = 0;
        ny = -1;
    }

    const halfExtent = Math.max(lw || 0, lh || 0) / 2;
    const threshold = 8 + halfExtent;

    const isTooClose = (cx, cy) => {
        for (let i = 0; i < waypoints.length - 1; i++) {
            const s1 = waypoints[i];
            const s2 = waypoints[i + 1];
            const vx = s2.x - s1.x;
            const vy = s2.y - s1.y;
            const segLen2 = vx * vx + vy * vy || 1;
            let t = ((cx - s1.x) * vx + (cy - s1.y) * vy) / segLen2;
            t = Math.max(0, Math.min(1, t));
            const px = s1.x + vx * t;
            const py = s1.y + vy * t;
            const dist = Math.sqrt((cx - px) * (cx - px) + (cy - py) * (cy - py));
            if (dist < threshold) return true;
        }
        return false;
    };

    const maxOffset = 40;
    const step = 5;
    const dirs = [1, -1];
    for (let d = 0; d < dirs.length; d++) {
        const sign = dirs[d];
        for (let off = 0; off <= maxOffset; off += step) {
            const cx = baseCenterX + nx * off * sign;
            const cy = baseCenterY + ny * off * sign;
            if (!isTooClose(cx, cy)) {
                return { x: cx, y: cy };
            }
        }
    }
    return { x: baseCenterX, y: baseCenterY };
}

/** 두 사각형이 겹치는지 (가장자리 닿음은 허용) */
function rectsOverlap(a, b) {
    return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
}

/**
 * Gateway 라벨이 인접 노드/엣지 다이아몬드와 겹치지 않는 위치 찾기.
 * 위 → 아래 → 오른쪽 → 왼쪽 순으로 4방향 후보를 시도하고 collision 없는 첫 위치 반환.
 * 모두 충돌이면 기본 (중앙 하단) 사용.
 *
 * 결함 5 (게이트웨이 라벨이 인접 다이아몬드/엣지를 덮음) 수정.
 */
function findGatewayLabelPosition(gateway, label, allElements) {
    const lw = label.width || 0;
    const lh = label.height || 0;
    const margin = 8;

    const cx = gateway.x + gateway.width / 2;
    const cy = gateway.y + gateway.height / 2;

    const candidates = [
        { x: cx, y: gateway.y - lh / 2 - margin }, // 위
        { x: cx, y: gateway.y + gateway.height + lh / 2 + margin }, // 아래 (default)
        { x: gateway.x + gateway.width + lw / 2 + margin, y: cy }, // 오른쪽
        { x: gateway.x - lw / 2 - margin, y: cy } // 왼쪽
    ];

    // collision 검사 대상: 다른 노드 (자기 자신 / 라벨 / Lane / Participant 제외) + 그 라벨들
    const obstacles = allElements
        .filter(
            (el) =>
                el &&
                el !== gateway &&
                el.businessObject &&
                !el.waypoints &&
                el.businessObject.$type !== 'bpmn:Lane' &&
                el.businessObject.$type !== 'bpmn:Participant' &&
                typeof el.x === 'number' &&
                typeof el.y === 'number' &&
                typeof el.width === 'number' &&
                typeof el.height === 'number'
        )
        .map((el) => ({ x: el.x, y: el.y, w: el.width, h: el.height }));

    for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        const labelRect = { x: c.x - lw / 2, y: c.y - lh / 2, w: lw, h: lh };
        let hit = false;
        for (let j = 0; j < obstacles.length; j++) {
            if (rectsOverlap(labelRect, obstacles[j])) {
                hit = true;
                break;
            }
        }
        if (!hit) {
            return c;
        }
    }
    // fallback: 기본 위치 (중앙 하단)
    return candidates[1];
}

function isHorizontalContainer(element) {
    const width = element?.width || 0;
    const height = element?.height || 0;

    // Rotation changes the rendered lane/participant geometry, while DI orientation
    // can remain stale. Use the current shape dimensions when they are decisive.
    if (width > 0 && height > 0 && Math.abs(width - height) > 1) {
        return width >= height;
    }

    if (typeof element?.di?.isHorizontal === 'boolean') {
        return element.di.isHorizontal;
    }
    if (typeof element?.businessObject?.isHorizontal === 'boolean') {
        return element.businessObject.isHorizontal;
    }
    return true;
}

function getContainerLabelCenter(element, boType, label, allElements = []) {
    const horizontal = isHorizontalContainer(element);

    if (horizontal) {
        return {
            x: element.x + (boType === 'bpmn:Participant' ? 15 : 20),
            y: element.y + element.height / 2
        };
    }

    const labelHeight = label?.height || 12;
    if (boType === 'bpmn:Lane') {
        return {
            x: element.x + element.width / 2,
            y: element.y + labelHeight / 2
        };
    }

    return {
        x: element.x + element.width / 2,
        y: element.y + labelHeight / 2
    };
}

export function adjustLabelsAfterLayout(bpmnModeler) {
    if (!bpmnModeler) return;

    const elementRegistry = bpmnModeler.get('elementRegistry');
    const modeling = bpmnModeler.get('modeling');
    if (!elementRegistry || !modeling) return;

    const elements = elementRegistry.getAll();
    if (!elements || !elements.length) return;

    elements.forEach((el) => {
        if (!el || !el.businessObject || el.waypoints) return;
        if (!el.labels || el.labels.length === 0) return;
        if (typeof el.x !== 'number' || typeof el.y !== 'number' || typeof el.width !== 'number' || typeof el.height !== 'number') return;

        const boType = el.businessObject.$type || '';
        const isGateway = /Gateway$/.test(boType);

        el.labels.forEach((label) => {
            if (!label || typeof label.x !== 'number' || typeof label.y !== 'number') return;

            const lw = label.width || 0;
            const lh = label.height || 0;

            let centerX = el.x + el.width / 2;
            let centerY;

            if (boType === 'bpmn:Lane' || boType === 'bpmn:Participant') {
                const center = getContainerLabelCenter(el, boType, label, elements);
                centerX = center.x;
                centerY = center.y;
            } else if (isGateway) {
                const pos = findGatewayLabelPosition(el, label, elements);
                centerX = pos.x;
                centerY = pos.y;
            } else {
                centerY = el.y + el.height + 20;
            }

            const newX = centerX - lw / 2;
            const newY = centerY - lh / 2;
            const dx = newX - label.x;
            const dy = newY - label.y;

            if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;

            try {
                modeling.moveShape(label, { x: dx, y: dy });
            } catch (e) {
                console.warn(`[BPMN-Layout] 라벨 ${label.id} 위치 조정 중 오류:`, e);
            }
        });
    });

    elements.forEach((conn) => {
        if (!conn || !conn.businessObject || conn.businessObject.$type !== 'bpmn:SequenceFlow') return;

        const waypoints = conn.waypoints;
        if (!Array.isArray(waypoints) || waypoints.length < 2) return;

        const label = conn.label || (Array.isArray(conn.labels) && conn.labels.length > 0 ? conn.labels[0] : null);

        if (!label || typeof label.x !== 'number' || typeof label.y !== 'number') return;

        const lw = label.width || 0;
        const lh = label.height || 0;

        const center = computeFlowLabelCenterAvoidingLine(waypoints, lw, lh);
        if (!center) return;

        const newX = center.x - lw / 2;
        const newY = center.y - lh / 2;
        const dx = newX - label.x;
        const dy = newY - label.y;

        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;

        try {
            modeling.moveShape(label, { x: dx, y: dy });
        } catch (e) {
            console.warn(`[BPMN-Layout] 시퀀스 플로우 라벨 ${label.id} 위치 조정 중 오류:`, e);
        }
    });
}
