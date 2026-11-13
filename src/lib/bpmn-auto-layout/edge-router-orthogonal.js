// Ported from Process GPT vue3 frontend — process-gpt/services/frontend/src/components/autoLayout/edge-router-orthogonal.js @ 0e85995b.
// Copied as is for Lite's BPMN views (src/lib/bpmn-auto-layout/index.js); changes here are marked "Lite:".
/**
 * 직교 엣지 라우터 (yFiles Polyline/Orthogonal 스타일)
 *
 * - 직선 연결 우선, 단일 꺾임, 그 다음 A* 탐색
 * - 최단거리 우선: 경로 후보 중 총 길이가 가장 짧은 것 선택
 * - gridSize(20px) 정렬, spacing(20px), 장애물 회피
 * - 노드 형식: { id, x, y, width, height } (x,y = 중심)
 *
 * [리팩토링] ORTHO 강제: 모든 세그먼트는 (x1==x2) 또는 (y1==y2) 여야 함.
 * - validateOrthogonal: 대각선 즉시 탈락
 * - normalizeWaypoints: 파이프라인 마지막에 필수 호출
 */

(function (global) {
    const EdgeRouterOrthogonal = {};

    const DEFAULT_OPTIONS = {
        spacing: 20,
        gridSize: 20,
        maxSteps: 300,
        baseStep: 15,
        defaultNodeWidth: 100,
        defaultNodeHeight: 40,
        horizontal: false,
        epsilon: 2,
        minSegmentLength: 4
    };

    const ORTHO_EPS = 1e-6;

    /**
     * 모든 세그먼트가 수평 또는 수직인지 검증. 대각선이면 즉시 false.
     * @param {Array<{x:number,y:number}>} waypoints
     * @returns {boolean}
     */
    function validateOrthogonal(waypoints) {
        if (!Array.isArray(waypoints) || waypoints.length < 2) return false;
        for (let i = 0; i < waypoints.length - 1; i++) {
            const p1 = waypoints[i];
            const p2 = waypoints[i + 1];
            const dx = Math.abs((p2.x ?? 0) - (p1.x ?? 0));
            const dy = Math.abs((p2.y ?? 0) - (p1.y ?? 0));
            if (dx > ORTHO_EPS && dy > ORTHO_EPS) return false;
        }
        return true;
    }

    function snapValue(v, eps) {
        if (eps <= 0) return v;
        return Math.round(v / eps) * eps;
    }

    /**
     * Waypoints 정규화: 연속 중복 제거, 동일 직선 B 제거, 수평/수직 스냅, 짧은 세그먼트 제거.
     * ORTHO 위반 세그먼트는 축 정렬 보정점 삽입으로 수정.
     * @param {Array<{x:number,y:number}>} points
     * @param {number} epsilon
     * @param {number} minSeg
     * @returns {Array<{x:number,y:number}>}
     */
    function normalizeWaypoints(points, epsilon, minSeg) {
        if (!points || points.length < 2) return points ? [...points] : [];
        const eps = epsilon ?? DEFAULT_OPTIONS.epsilon;
        const minSegment = minSeg ?? DEFAULT_OPTIONS.minSegmentLength;

        let out = [{ x: points[0].x, y: points[0].y }];
        for (let i = 1; i < points.length; i++) {
            const prev = out[out.length - 1];
            const curr = points[i];
            const dx = curr.x - prev.x;
            const dy = curr.y - prev.y;
            if (Math.abs(dx) < ORTHO_EPS && Math.abs(dy) < ORTHO_EPS) continue;
            if (out.length >= 2) {
                const p0 = out[out.length - 2];
                const sameLineX = Math.abs(dx) < ORTHO_EPS && Math.abs(p0.x - prev.x) < ORTHO_EPS;
                const sameLineY = Math.abs(dy) < ORTHO_EPS && Math.abs(p0.y - prev.y) < ORTHO_EPS;
                if (sameLineX || sameLineY) out.pop();
            }
            let nx = snapValue(curr.x, eps);
            let ny = snapValue(curr.y, eps);
            if (Math.abs(dx) > ORTHO_EPS && Math.abs(dy) > ORTHO_EPS) {
                const ax = Math.abs(dx) >= Math.abs(dy);
                const mid = ax ? { x: snapValue(curr.x, eps), y: prev.y } : { x: prev.x, y: snapValue(curr.y, eps) };
                if (mid.x !== prev.x || mid.y !== prev.y) out.push(mid);
                nx = snapValue(curr.x, eps);
                ny = snapValue(curr.y, eps);
            }
            out.push({ x: nx, y: ny });
        }

        let i = 1;
        while (i < out.length - 1) {
            const a = out[i - 1];
            const b = out[i];
            const c = out[i + 1];
            const d1 = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
            const d2 = Math.abs(c.x - b.x) + Math.abs(c.y - b.y);
            if (d1 < minSegment || d2 < minSegment) {
                out.splice(i, 1);
                continue;
            }
            i++;
        }
        return out;
    }

    /** 노드의 4방향 포트 좌표 반환 - BPMN 좌표계 기준 (width=가로, height=세로) */
    function getAllPortPoints(node, options) {
        const opts = { ...DEFAULT_OPTIONS, ...options };
        const halfWidth = (node.width || opts.defaultNodeWidth) / 2;
        const halfHeight = (node.height || opts.defaultNodeHeight) / 2;
        return {
            left: { x: node.x - halfWidth, y: node.y },
            right: { x: node.x + halfWidth, y: node.y },
            top: { x: node.x, y: node.y - halfHeight },
            bottom: { x: node.x, y: node.y + halfHeight }
        };
    }

    function findOrthogonalPath(start, end, obstacles, options) {
        const opts = { ...DEFAULT_OPTIONS, ...options };
        const { gridSize, maxSteps } = opts;
        const allowedPoints = opts.allowedPoints || [];
        const EPS = 2; // 포트 경계 허용 오차

        const isAllowed = (p) => allowedPoints.some((a) => Math.abs(a.x - p.x) < EPS && Math.abs(a.y - p.y) < EPS);

        const intersectsObstacle = (p, obsList) => {
            if (isAllowed(p)) return false; // 시작/끝 포트는 노드 겹침 허용
            return obsList.some((obs) => {
                const left = obs.x - obs.width / 2;
                const right = obs.x + obs.width / 2;
                const top = obs.y - obs.height / 2;
                const bottom = obs.y + obs.height / 2;
                return p.x >= left && p.x <= right && p.y >= top && p.y <= bottom;
            });
        };

        const manhattan = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

        const pathLength = (path) => {
            let len = 0;
            for (let i = 1; i < path.length; i++) {
                len += manhattan(path[i - 1], path[i]);
            }
            return len;
        };

        const intersectsObstacleExcluding = (p, obsList, exclude) => {
            if (isAllowed(p)) return false;
            return obsList.some((obs) => {
                if (exclude && exclude.includes(obs.id)) return false;
                const left = obs.x - obs.width / 2;
                const right = obs.x + obs.width / 2;
                const top = obs.y - obs.height / 2;
                const bottom = obs.y + obs.height / 2;
                return p.x >= left && p.x <= right && p.y >= top && p.y <= bottom;
            });
        };

        const canDrawDirectLine = (p1, p2, obsList, exclude) => {
            if (p1.x !== p2.x && p1.y !== p2.y) return false;
            const steps = Math.max(20, Math.floor((Math.abs(p2.x - p1.x) + Math.abs(p2.y - p1.y)) / 5));
            const ddx = (p2.x - p1.x) / steps;
            const ddy = (p2.y - p1.y) / steps;
            for (let i = 0; i <= steps; i++) {
                const pt = { x: p1.x + ddx * i, y: p1.y + ddy * i };
                if (intersectsObstacleExcluding(pt, obsList, exclude)) return false;
            }
            return true;
        };

        const optimizePath = (path) => {
            if (path.length <= 2) return path;
            const result = [path[0]];
            for (let i = 1; i < path.length - 1; i++) {
                const prev = result[result.length - 1];
                const curr = path[i];
                const next = path[i + 1];
                const sameX = prev.x === curr.x && curr.x === next.x;
                const sameY = prev.y === curr.y && curr.y === next.y;
                if (!sameX && !sameY) result.push(curr);
            }
            result.push(path[path.length - 1]);
            return result;
        };

        if (canDrawDirectLine(start, end, obstacles)) {
            return optimizePath([start, end]);
        }

        const mid1 = { x: end.x, y: start.y };
        const mid2 = { x: start.x, y: end.y };
        const candidates = [];
        if (canDrawDirectLine(start, mid1, obstacles) && canDrawDirectLine(mid1, end, obstacles)) {
            candidates.push(optimizePath([start, mid1, end]));
        }
        if (canDrawDirectLine(start, mid2, obstacles) && canDrawDirectLine(mid2, end, obstacles)) {
            candidates.push(optimizePath([start, mid2, end]));
        }
        if (candidates.length > 0) {
            return candidates.sort((a, b) => pathLength(a) - pathLength(b))[0];
        }

        const visited = new Set();
        const queue = [{ point: start, path: [start], turns: 0 }];
        const serialize = (p) => `${p.x},${p.y}`;

        for (let steps = 0; steps < maxSteps; steps++) {
            if (queue.length > 1000) {
                queue.sort((a, b) => a.turns * 10 + manhattan(a.point, end) - (b.turns * 10 + manhattan(b.point, end)));
                queue.splice(100);
            }
            if (queue.length === 0) break;

            queue.sort((a, b) => {
                if (a.turns !== b.turns) return a.turns - b.turns;
                return manhattan(a.point, end) - manhattan(b.point, end);
            });

            const { point, path, turns } = queue.shift();
            if (manhattan(point, end) < gridSize) {
                return optimizePath([...path, end]);
            }

            const currDir = path.length > 1 ? { dx: point.x - path[path.length - 2].x, dy: point.y - path[path.length - 2].y } : null;
            const dx = end.x - point.x;
            const dy = end.y - point.y;
            const dirs = [];
            if (currDir) {
                if (currDir.dx !== 0) dirs.push({ dx: dx > 0 ? gridSize : -gridSize, dy: 0 });
                if (currDir.dy !== 0) dirs.push({ dx: 0, dy: dy > 0 ? gridSize : -gridSize });
            }
            const allDirs = [
                { dx: gridSize, dy: 0 },
                { dx: -gridSize, dy: 0 },
                { dx: 0, dy: gridSize },
                { dx: 0, dy: -gridSize }
            ];
            dirs.push(...allDirs.filter((d) => !dirs.some((e) => e.dx === d.dx && e.dy === d.dy)));

            for (const d of dirs) {
                const next = {
                    x: Math.round((point.x + d.dx) / gridSize) * gridSize,
                    y: Math.round((point.y + d.dy) / gridSize) * gridSize
                };
                const key = serialize(next);
                if (visited.has(key)) continue;
                visited.add(key);
                if (!intersectsObstacle(next, obstacles)) {
                    let newTurns = turns;
                    if (path.length > 1 && currDir && ((currDir.dx !== 0) !== (d.dx !== 0) || (currDir.dy !== 0) !== (d.dy !== 0)))
                        newTurns++;
                    queue.push({ point: next, path: [...path, next], turns: newTurns });
                }
            }
        }

        // A* 실패 시: 노드 위/아래로 우회 경로 생성 (노드 겹침 방지)
        // 전역 -200/+200 확장 제거: 전달된 장애물·시작/끝 기준으로만 채널 잡아 과도한 하강 방지
        const pad = Math.max(opts.spacing || 0, 8) + 8;
        let minY = Math.min(start.y, end.y);
        let maxY = Math.max(start.y, end.y);
        obstacles.forEach((obs) => {
            const t = obs.y - obs.height / 2;
            const b = obs.y + obs.height / 2;
            minY = Math.min(minY, t);
            maxY = Math.max(maxY, b);
        });
        const aboveY = minY - pad;
        const belowY = maxY + pad;

        const srcId = opts.sourceId;
        const tgtId = opts.targetId;
        const tryPath = (wayY) => {
            const p1 = { x: start.x, y: wayY };
            const p2 = { x: end.x, y: wayY };
            const seg1 = canDrawDirectLine(start, p1, obstacles, srcId ? [srcId] : []);
            const seg2 = canDrawDirectLine(p1, p2, obstacles, []);
            const seg3 = canDrawDirectLine(p2, end, obstacles, tgtId ? [tgtId] : []);
            if (seg1 && seg2 && seg3) return optimizePath([start, p1, p2, end]);
            return null;
        };

        const abovePath = tryPath(aboveY);
        if (abovePath) return abovePath;
        const belowPath = tryPath(belowY);
        if (belowPath) return belowPath;

        const mid = Math.abs(end.x - start.x) > Math.abs(end.y - start.y) ? { x: end.x, y: start.y } : { x: start.x, y: end.y };
        return optimizePath([start, mid, end]);
    }

    function pathLength(path) {
        let len = 0;
        for (let i = 1; i < path.length; i++) {
            len += Math.abs(path[i].x - path[i - 1].x) + Math.abs(path[i].y - path[i - 1].y);
        }
        return len;
    }

    EdgeRouterOrthogonal.computeWaypoints = function (source, target, obstacles, options) {
        const opts = { ...DEFAULT_OPTIONS, ...options };
        const obs = (obstacles || []).map((o) => ({
            ...o,
            width: (o.width || opts.defaultNodeWidth) + opts.spacing,
            height: (o.height || opts.defaultNodeHeight) + opts.spacing
        }));

        const sourcePorts = getAllPortPoints(source, opts);
        const targetPorts = getAllPortPoints(target, opts);
        const dirs = ['left', 'right', 'top', 'bottom'];
        const matchingPortsOnly = opts.matchingPortsOnly === true;

        let bestPath = null;
        let bestLen = Infinity;

        // 가능한 모든 (source포트, target포트) 조합에 대해 경로 탐색 후 최단거리 선택
        // matchingPortsOnly: 아래→아래, 오른쪽→오른쪽 등 같은 면끼리만 (BPMN 시퀀스 일관 도킹)
        for (const sd of dirs) {
            for (const td of dirs) {
                if (matchingPortsOnly && sd !== td) continue;
                const sp = sourcePorts[sd];
                const tp = targetPorts[td];
                const path = findOrthogonalPath(sp, tp, obs, {
                    ...opts,
                    allowedPoints: [sp, tp],
                    sourceId: source.id,
                    targetId: target.id
                });
                if (path && path.length >= 2) {
                    const len = pathLength(path);
                    if (len < bestLen) {
                        bestLen = len;
                        bestPath = path;
                    }
                }
            }
        }

        if (!bestPath || bestPath.length < 2) {
            const sp = sourcePorts.right;
            const tp = targetPorts.left;
            const fallback = [sp, tp].map((p) => ({ x: p.x, y: p.y }));
            const normalized = normalizeWaypoints(fallback, opts.epsilon, opts.minSegmentLength);
            if (!validateOrthogonal(normalized) && opts.debug) {
                console.warn('[EdgeRouterOrthogonal] fallback waypoints ORTHO 위반');
            }
            return normalized;
        }

        let result = bestPath.map((p) => ({ x: p.x, y: p.y }));
        result = normalizeWaypoints(result, opts.epsilon, opts.minSegmentLength);
        if (!validateOrthogonal(result)) {
            if (opts.debug) console.warn('[EdgeRouterOrthogonal] 정규화 후 ORTHO 위반, 축 정렬 보정 재시도');
            result = normalizeWaypoints(result, opts.epsilon, opts.minSegmentLength);
        }
        if (!validateOrthogonal(result)) {
            const sp = sourcePorts.right;
            const tp = targetPorts.left;
            result = normalizeWaypoints(
                [sp, tp].map((p) => ({ x: p.x, y: p.y })),
                opts.epsilon,
                opts.minSegmentLength
            );
        }
        return result;
    };

    EdgeRouterOrthogonal.validateOrthogonal = validateOrthogonal;
    EdgeRouterOrthogonal.normalizeWaypoints = normalizeWaypoints;

    global.EdgeRouterOrthogonal = EdgeRouterOrthogonal;
})(typeof window !== 'undefined' ? window : this);
