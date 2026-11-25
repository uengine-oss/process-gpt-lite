# 모델 호환 — 주 모델을 Claude로 바꿔도 판정 · JSON 응답이 그대로 작동한다

## Purpose
2026-11-25 사용자: 「이 앤트로픽 키로 서비스하는 기본 모델을 바꾸자.」 운영 환경의 주 모델(`PRO_LLM_MODEL`)을 litellm-proxy의 `claude-opus-5-5`로 바꾸면 Lite가 의존하던 두 가지가 달라진다.
- Claude는 로그 확률을 제공하지 않는다. 첫 토큰 확률을 기준으로 선택하는 판정(고르기 · 습관 · 가드레일 등)이 주 모델로 전달되면 확률을 받지 못해 실패한다.
- Claude에는 스키마 없는 `response_format: json_object`에 대응하는 기능이 없어, 프롬프트에 따라 JSON을 Markdown 울타리(```json … ```)로 감싸 응답한다. 운영 환경 측정(11-25)에서는 "Answer as JSON {…}" 프롬프트로 요청한 5번 모두 울타리로 감싼 응답이 왔으며, 그대로 JSON.parse를 적용하면 모두 실패했다. 「…로만 답하세요」 프롬프트에는 울타리 없이 응답했다.

따라서 확률을 읽는 모델을 별도로 두고(`PRO_LLM_ODDS_MODEL`), JSON을 요청한 응답이 울타리 하나로 감싸져 오면 그 안쪽을 응답으로 사용한다. 운영 환경의 litellm-proxy 훅(`claude_compat`, process-gpt-k8s)도 같은 처리를 하지만, 설치판처럼 해당 훅이 없는 프록시에 Claude를 연결해도 작동하도록 Lite 쪽에도 이 처리를 둔다.

관련 코드: `server/lib/llm.js`(chat · chatJson · firstTokenTop), `server/lib/jsonReply.js`, `server/config.js`.

## Requirements

### Requirement: 확률을 읽는 호출은 확률 모델로 보낸다
시스템은 첫 토큰 확률을 읽는 호출(모델 이름을 지정하지 않은 호출)을 `PRO_LLM_ODDS_MODEL`로 보내야 한다(SHALL). 값이 비어 있으면 주 모델로 보낸다. 모델 이름을 지정한 호출은 지정한 이름 그대로 보낸다.

#### Scenario: 주 모델이 Claude이고 확률 모델이 따로 있다
- **WHEN** `PRO_LLM_MODEL=claude-opus-5-5`, `PRO_LLM_ODDS_MODEL=frentis-ai-model`이고 판정에서 첫 토큰 확률을 요청한다
- **THEN** 요청의 모델은 `frentis-ai-model`이다
- **AND** 후보와 확률을 받는다

#### Scenario: 확률 모델을 비워 두었다
- **WHEN** `PRO_LLM_ODDS_MODEL`이 비어 있다
- **THEN** 요청의 모델은 주 모델이다(변경 전과 같다)

#### Scenario: 설치판에서 확률 모델을 별도로 설정한다
- **WHEN** 설치 번들의 `.env`에 `LLM_ODDS_MODEL=frentis-ai-model`을 입력하고 다시 실행한다
- **THEN** 서버의 `PRO_LLM_ODDS_MODEL`은 `frentis-ai-model`로 설정된다
- **AND** 비워 두면 빈 값으로 유지되어 주 모델을 사용한다

### Requirement: JSON을 요청한 응답이 울타리 하나로 감싸져 오면 그 안쪽을 응답으로 사용한다
시스템은 `response_format: json_object`로 요청한 응답이 정확히 하나의 울타리 블록(언어 표시는 없거나 `json`, 대소문자 무관)으로만 이루어져 있고 그 안의 내용을 JSON으로 읽을 수 있을 때, 그 안쪽을 응답 내용으로 사용해야 한다(SHALL). 그 밖의 응답(울타리 앞뒤에 설명이 있음, 다른 언어 표시, 내부의 잘못된 JSON, 한 줄 울타리)은 변경해서는 안 된다(MUST NOT). JSON을 요청하지 않은 응답의 울타리는 그대로 둔다.

#### Scenario: 분류 판정에 Claude가 울타리로 감싸 응답한다
- **WHEN** chatJson으로 분류를 요청하고 모델이 "```json\n{\"topic\": \"견적서 요청\", \"urgent\": true}\n```"로 응답한다
- **THEN** 결과는 객체 `{ topic: "견적서 요청", urgent: true }`이다

#### Scenario: 응답을 직접 읽는 호출(폴더 색인 · 브라우저 계획)
- **WHEN** `chat({ json: true })`의 응답이 언어 표시 없는 울타리로 감싸져 온다
- **THEN** 응답 내용은 울타리 안의 JSON이다
- **AND** 종료 사유(`finish`)는 그대로 유지된다

#### Scenario: 코드 블록을 보여 달라는 대화
- **WHEN** JSON을 요청하지 않은 대화의 응답이 ```json 울타리로 감싸져 있다
- **THEN** 응답은 울타리를 포함해 그대로 유지된다

#### Scenario: 울타리 안의 JSON이 잘못되었다
- **WHEN** chatJson의 응답이 울타리로 감싸져 있고 그 안의 내용을 JSON으로 읽을 수 없다
- **THEN** 기존과 같이 「the model's answer is not JSON」 오류로 실패한다

### Requirement: 모델이 거절한 temperature는 빼고 다시 보내며 이를 기억한다
시스템은 모델이 400 응답으로 temperature를 거절하면(「unsupported」 · 「not support」 · Claude 5.5의 「`temperature` is deprecated for this model.」) 해당 요청을 temperature 없이 다시 보내고, 그 모델에 보내는 다음 요청부터는 처음부터 temperature를 빼야 한다(SHALL). 프록시가 매개변수를 걸러 주지 않는 설치 환경(LiteLLM에 `additional_drop_params`를 넣지 않음)에서도 Claude가 응답하도록 하기 위한 것이다.

#### Scenario: 프록시를 거친 Claude가 temperature를 거절한다
- **WHEN** chatJson이 temperature를 0으로 설정해 Claude에 요청하고 프록시가 400 응답과 함께 「`temperature` is deprecated for this model.」을 반환한다
- **THEN** 같은 요청을 temperature 없이 한 번 더 보내 응답을 받는다
- **AND** 그 모델에 보내는 다음 요청에는 처음부터 temperature가 포함되지 않는다
