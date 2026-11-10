"""ProcessGPT 엔진이 저장된 프로세스 정의의 분기를 어떻게 가르는지 엔진 코드 그대로 본다.

프로세스 마이닝에서 관리자가 어떤 단계를 옵션으로 확정하면 정의에 배타 게이트웨이와 조건 흐름이 생긴다
(server/lib/mining/shape.js). 이 스크립트는 그 정의를 엔진(process-gpt-completion/polling_service)의
load_process_definition → get_sequence_condition_data → _evaluate_sequence_conditions(엔진의 모델로
자연어 조건 판단) → resolve_next_activity_payloads 로 돌려, 앞 단계가 주어진 값으로 끝났을 때 다음 단계가
무엇인지 출력한다. 워크아이템을 만들거나 DB 를 바꾸지 않는다.

    cd <process-gpt-completion>/polling_service
    .venv/bin/python <process-gpt-lite>/scripts/mining-engine-branch-check.py \\
        --def definition.json --after '견적서 작성' --data '{"견적 합계": 30000000}'
    → {"after": "견적서 작성", "data": {...}, "next": ["고객 회신"], "conditions": {...}}
"""
import argparse
import asyncio
import json
import sys

sys.path.insert(0, '.')
import workitem_processor as w  # noqa: E402  (the engine, run from its own folder: its .env and venv)
from process_definition import load_process_definition  # noqa: E402


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--def', dest='defn', required=True, help='flattened proc_def.definition JSON file')
    ap.add_argument('--after', required=True, help='name of the step that just finished')
    ap.add_argument('--data', required=True, help='JSON of the values that step finished with')
    a = ap.parse_args()
    defn = load_process_definition(json.load(open(a.defn, encoding='utf-8')))
    names = {x.id: x.name for x in defn.activities}
    step = next(x for x in defn.activities if x.name == a.after)
    data = json.loads(a.data)
    wi = {"id": "branch-check", "user_id": "check@example.com", "proc_inst_id": "branch-check", "proc_def_id": defn.processDefinitionId,
          "activity_id": step.id, "tenant_id": "localhost", "output": data}
    near = [x.id for x in defn.find_near_next_activities(step.id, True)]
    scd = w.get_sequence_condition_data(defn, step.id, near)
    ctx = {a.after: data}
    await w._evaluate_sequence_conditions(w.model, w.parser, defn, ctx, ctx, scd, [], workitem=wi)
    nxt = w.resolve_next_activity_payloads(defn, step.id, wi, scd)
    print(json.dumps({"after": a.after, "data": data,
                      "next": [names.get(x.get("nextActivityId"), x.get("nextActivityId")) for x in nxt],
                      "conditions": {k: {kk: v.get(kk) for kk in ("condition", "default", "conditionEval", "conditionReason") if kk in v}
                                     for k, v in scd.items() if isinstance(v, dict)}}, ensure_ascii=False))


asyncio.run(main())
