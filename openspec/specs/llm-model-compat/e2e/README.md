# 모델 호환 — 시험과 증거

```bash
cd server && node --test test/llm-json-fence.test.js test/llm-logprob.test.js   # 가짜 OpenAI 형식 서버, 네트워크 · DB 없이
```

| 스펙 시나리오 | 시험 |
|---|---|
| 주 모델이 Claude 이고 확률 모델이 따로 있다 · 확률 모델을 비워 두었다 | `llm-logprob.test.js` 「확률 읽기는 PRO_LLM_ODDS_MODEL 로(없으면 주 모델로)」 |
| 분류 판정에 Claude 가 울타리로 답한다 | JF-U-02 |
| 답을 직접 읽는 호출(폴더 색인 · 브라우저 계획) | JF-U-03 |
| 코드 블록을 보여 달라는 대화 | JF-U-04 |
| 울타리 안이 깨졌다 | JF-U-05, 사례표 `server/test/json-fence-cases.json`(JF-U-01) |

## 실측(2026-11-25)

- 운영 litellm-proxy(v1.82.3) `claude-opus-5-5`, `response_format: json_object`, 시스템 프롬프트 "Classify the message. Answer as JSON {…}": 훅 7 이전 5/5 가 ```json 울타리, 그대로 JSON.parse 0/5.
- 같은 이미지 v1.82.3 로컬 프록시 + 새 훅(claude_compat 7) + 실제 Anthropic: 5/5 파싱, JSON 을 청하지 않은 답의 울타리는 그대로, json_schema 는 그대로.
- 결과: `results/unit.txt`.
