// Ported from Process GPT vue3 frontend — process-gpt/services/frontend/src/components/autoLayout/enhancedSugiyamaLayout.js @ 0e85995b.
// Copied as is for Lite's BPMN views (src/lib/bpmn-auto-layout/index.js); changes here are marked "Lite:".
/**
 * 향상된 Sugiyama 레이아웃 모듈
 * BPMN 자동 레이아웃을 위한 확장된 Sugiyama 알고리즘 구현
 */

(function (global) {
    // 전역 네임스페이스에서 GraphAlgorithm 참조
    const { SugiyamaLayout } = window.GraphAlgorithm;

    /**
     * EnhancedSugiyamaLayout - SugiyamaLayout을 확장한 향상된 레이아웃 클래스
     * 계층 할당 최적화 및 가로/세로 방향 레이아웃 지원
     */
    class EnhancedSugiyamaLayout extends SugiyamaLayout {
        /**
         * 생성자
         * @param {Object} graph - 레이아웃을 적용할 그래프 객체
         * @param {boolean} horizontal - 가로 방향 레이아웃 사용 여부
         * @param {Object} options - 레이아웃 옵션 (crossingMinimizationIterations 등)
         */
        constructor(graph, horizontal = false, options = {}) {
            super(graph, options);
            this.horizontal = horizontal;
        }

        /**
         * 계층 할당 단계를 오버라이드
         * @returns {EnhancedSugiyamaLayout} - 체이닝을 위한 this 반환
         */
        assignLayers() {
            // 먼저 기본 계층 할당 수행
            super.assignLayers();

            // 계층 할당 후 추가 최적화 수행
            this.optimizeLayers();

            return this;
        }

        /**
         * 추가 최적화: 게이트웨이 출력 노드 레이어링 개선
         */
        optimizeLayers() {
            let changed = true;

            // 무한 반복 방지를 위한 장치들
            let iterations = 0;
            // perf: 100 → 30. 현실 BPMN 다이어그램은 보통 5~10 iteration 안에 수렴.
            // 30 회까지 안 끝나면 루프 외부에 안내 (이전 100 도 동일한 상한 - 단지 더 일찍 stop).
            const maxIterations = 30;

            let previousChangesCount = 0;
            let currentChangesCount = 0;
            let stabilityCounter = 0;

            // 모든 변경이 안정화될 때까지 반복 (최대 반복 횟수 제한 추가)
            while (changed && iterations < maxIterations && stabilityCounter < 3) {
                changed = false;
                currentChangesCount = 0;
                iterations++;

                // 모든 노드 순회
                for (const node of this.graph.nodes) {
                    // 게이트웨이 노드 식별
                    const isGateway = node.nodeType && node.nodeType.includes('Gateway');

                    // 모든 노드에 대해 출력 엣지 검사 (게이트웨이에만 제한하지 않음)
                    const outgoingEdges = this.graph.getOutgoingEdges(node.id).filter((e) => !e.feedback);

                    // 노드에서 나가는 모든 노드는 현재 노드보다 더 높은 레이어에 있어야 함
                    for (const edge of outgoingEdges) {
                        const targetNode = this.graph.getNode(edge.target);

                        // 타겟 노드가 현재 노드와 같거나 더 낮은 레이어에 있으면 레이어 증가
                        if (targetNode.layer <= node.layer) {
                            targetNode.layer = node.layer + 1;
                            changed = true;
                            currentChangesCount++;
                        }
                    }
                }

                // 변경 안정화 감지
                if (currentChangesCount === previousChangesCount && currentChangesCount > 0) {
                    stabilityCounter++;
                } else {
                    stabilityCounter = 0;
                }

                previousChangesCount = currentChangesCount;

                // 로그 추가 (디버깅용)
                if (iterations % 10 === 0) {
                    console.log(`optimizeLayers: 반복 ${iterations}, 변경 ${currentChangesCount}, 안정화 카운터 ${stabilityCounter}`);
                }
            }

            // 최대 반복 횟수에 도달했는지 확인
            if (iterations >= maxIterations) {
                console.warn(`optimizeLayers: 최대 반복 횟수(${maxIterations})에 도달했습니다. 순환 의존성이 있을 수 있습니다.`);
            }

            // 변화 안정화로 중단된 경우
            if (stabilityCounter >= 3) {
                console.warn(`optimizeLayers: 레이어 변경이 안정화되지 않고 반복됩니다. ${stabilityCounter}회 동일한 변경 패턴 감지됨.`);
            }

            // 레이어 배열 재구성
            this.layers = [];
            let maxLayer = 0;

            this.graph.nodes.forEach((node) => {
                maxLayer = Math.max(maxLayer, node.layer);
            });

            for (let i = 0; i <= maxLayer; i++) {
                this.layers[i] = this.graph.nodes.filter((node) => node.layer === i);
            }
        }

        /**
         * 레이아웃 실행 - 가로/세로 방향 처리
         * @returns {EnhancedSugiyamaLayout} - 체이닝을 위한 this 반환
         */
        run() {
            // 기본 레이아웃 실행
            super.run();

            // 가로 배치 모드인 경우 x, y 좌표 교환
            if (this.horizontal) {
                // 모든 노드의 좌표를 교환하여 가로 방향 레이아웃으로 변환
                this.graph.nodes.forEach((node) => {
                    const tempX = node.x;
                    node.x = node.y; // x에 원래 y값 할당
                    node.y = tempX; // y에 원래 x값 할당

                    // 가로/세로 크기도 교환하여 노드 방향 조정
                    const tempWidth = node.width;
                    node.width = node.height;
                    node.height = tempWidth;
                });

                // 모든 엣지의 waypoints도 교환
                this.graph.edges.forEach((edge) => {
                    if (edge.waypoints && edge.waypoints.length > 0) {
                        edge.waypoints.forEach((point) => {
                            const tempX = point.x;
                            point.x = point.y;
                            point.y = tempX;
                        });
                    }
                });
            }

            return this;
        }
    }

    // 글로벌 객체에 추가
    global.EnhancedSugiyamaLayout = EnhancedSugiyamaLayout;
})(typeof window !== 'undefined' ? window : this);
