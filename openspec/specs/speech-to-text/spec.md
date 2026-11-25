# 받아쓰기(음성 → 글) — 서버가 직접 시험해 결과를 알리고, 브라우저에 음성 인식이 없으면 입력창의 말도 서버가 받아쓴다

## Purpose
2026-11-25 사용자: 「지금 서버에 위스퍼모델이 없는 것 같아 위스퍼 모델이 있어야 바다쓰기 이런게 되는데 그것도 반영을 좀 해줘」.

받아쓰기는 두 가지 경로로 나뉘어 있었다.
- 채팅 입력창의 마이크: 브라우저의 음성 인식(Web Speech)만 사용하고 서버는 거치지 않았다. Chrome · Edge 웹에서는 Google의 음성 인식이 말을 받아썼지만, 데스크톱 앱(Electron의 Chromium에는 음성 인식 서비스가 없다)에서는 「데스크톱 앱에서는 음성 인식 서비스에 닿지 못했어요」라는 안내와 함께 멈췄다. Android 앱(WebView) · Firefox에서는 「이 브라우저는 받아쓰기를 지원하지 않아요」라는 안내만 보였다. 서버에 받아쓰기 모델이 있어도 이 마이크에서는 사용할 수 없었다.
- 회의: 말한 사람의 브라우저가 음성 조각(WAV)을 `POST /api/meetings/:id/audio`로 보내면, 서버가 litellm-proxy의 `/v1/audio/transcriptions`를 통해 받아쓴다(`PRO_TRANSCRIBE_MODEL`의 기본값은 `gpt-4o-mini-transcribe`, 실패하면 `PRO_TRANSCRIBE_FALLBACK_MODEL`의 기본값인 `whisper-1`을 사용하며, 시도마다 15초). 운영 litellm-proxy는 두 모델을 데이터베이스에 등록해 두고(GitOps 설정 파일에는 없다) 요청을 OpenAI로 보낸다. 그런데 서비스들이 사용하는 키(`process-gpt`)에는 `gpt-4o-mini-transcribe`만 허용되어 있고 `whisper-1`은 허용되어 있지 않다. 따라서 첫 모델이 실패하면 둘째 모델의 요청은 항상 401로 거절된다. 이런 상황은 회의에서 직접 말해 보기 전에는(로그인해 `GET /api/meetings/stats`를 읽기 전에는) 알 수 없었다.

이제는 다음과 같이 동작한다.
- 입력창의 마이크는 브라우저에 음성 인식이 있으면 지금처럼 브라우저의 음성 인식을 사용하고, 없으면(데스크톱 앱 · Android 앱 · Firefox) 서버 받아쓰기(`POST /api/dictation`)를 사용한다. 서버 받아쓰기는 회의와 같은 설정과 모델을 사용한다.
- 서버는 받아쓰기가 되는지 직접 시험하고 `/api/config`의 `transcribe`로 결과를 알린다. 키에 모델 사용이 허용되어 있지 않으면 `http-401`로 표시한다. 운영 점검 `e2e/tests/deploy/stt.spec.js`(D-STT-*)가 이를 확인한다.
- 둘째 모델도 실패하면 회의 통계의 `lastError`에 첫 모델의 실패 이유도 함께 남는다(`first`).

관련 코드: `server/lib/meetings/transcribe.js`(받아쓰기 · 자체 시험), `server/routes/dictation.js`, `src/serverDictation.js`, `src/useDictation.js`, `src/components/meetings/capture.js`, `server/fixtures/stt/selftest-ko.wav`(시험용 음성).

## Requirements

### Requirement: 서버는 받아쓰기가 되는지 직접 시험하고 `/api/config`로 결과를 알린다
시스템은 함께 제공하는 시험용 음성(「회의를 시작합니다」, 1.3초, 16kHz 모노 16비트 WAV)을 회의와 같은 설정(`PRO_TRANSCRIBE_BASE_URL` · `PRO_TRANSCRIBE_MODEL` · `PRO_TRANSCRIBE_FALLBACK_MODEL`)으로 받아쓰고, 그 결과를 `/api/config`의 `transcribe`로 알려야 한다(SHALL).
- 시점: 서버가 시작되고 3초 뒤에 시험하고, 이후에는 `PRO_TRANSCRIBE_SELFTEST_MIN`분마다 시험한다(기본 10분, 실패하면 1분 뒤). `0`이면 시험하지 않는다. `PRO_BACKGROUND=0`인 개발 서버는 시작할 때 한 번만 시험한다.
- 통과 조건: 응답이 도착하고, 글자가 있으며, 글자 오류율(띄어쓰기 · 문장 부호를 뺀 편집 거리 ÷ 글자 수)이 0.5 이하이다.
- 값: `ok`(참 · 거짓, 아직 시험하지 않았으면 null), `model`(응답한 모델, 없으면 처음 시도한 모델), `ms`, `at`, `error`(짧은 코드: `no-key` · `timeout` · `unreachable` · `http-<상태>` · `bad-answer` · `empty` · `mismatch`), `fallback`(첫 모델은 실패하고 대체 모델만 응답했다).
- 주소 · 키 · 상위 서버의 오류 원문은 공개하지 않는다(MUST NOT).
- 동시에 두 번 호출해도 시험은 한 번만 한다. `/api/config`는 시험이 끝날 때까지 기다리지 않는다. 쿠버네티스가 준비 상태를 확인할 때 이 주소를 호출하기 때문이다.
- 회의 통계(`GET /api/meetings/stats`)의 `transcription.selfTest`에도 같은 값을 넣는다.

#### Scenario: 키에 모델 사용이 허용되어 있지 않다
- **WHEN** litellm-proxy의 키에 `PRO_TRANSCRIBE_MODEL` 사용이 허용되어 있지 않다(「key not allowed to access model」)
- **THEN** `transcribe`는 `{ ok: false, error: "http-401", fallback: false }`이다
- **AND** D-STT-01이 「the key was refused for this model — a LiteLLM virtual key answers only its allowed models …」라는 메시지와 함께 실패한다

#### Scenario: litellm-proxy에 그 이름의 모델이 없다
- **WHEN** litellm-proxy의 설정 파일과 데이터베이스 어디에도 `PRO_TRANSCRIBE_MODEL`이라는 이름의 모델이 없다
- **THEN** `transcribe`는 `{ ok: false, error: "http-400" }`이고, D-STT-01이 「litellm-proxy has no model of that name …」이라는 메시지와 함께 실패한다

#### Scenario: 운영 환경에서 첫 모델이 받아쓴다
- **WHEN** 키에 `gpt-4o-mini-transcribe` 사용이 허용되어 있고, 그 모델이 시험용 음성을 받아쓴다
- **THEN** `transcribe`는 `{ ok: true, model: "gpt-4o-mini-transcribe", error: null, fallback: false }`이고, 둘째 모델에는 요청하지 않는다
- **AND** D-STT-01 · 02 · 03이 통과한다

#### Scenario: 첫 모델은 없고 대체 모델만 응답한다
- **WHEN** 첫 모델이 404를 반환하고, 대체 모델은 시험용 음성을 받아쓴다
- **THEN** `transcribe`는 `{ ok: true, model: <대체 모델>, error: "http-404", fallback: true }`이다
- **AND** D-STT-01은 「only the fallback model … answered」라는 메시지와 함께 실패한다. 회의 음성 조각마다 첫 모델의 응답을 먼저 기다려야 하기 때문이다

#### Scenario: 받아쓰기 서버가 응답하지 않는다
- **WHEN** 상위 서버가 시도별 제한 시간(`PRO_TRANSCRIBE_TIMEOUT_MS`, 15초) 안에 응답하지 않거나, 연결할 수 없거나, 다른 말을 반환한다
- **THEN** `error`는 각각 `timeout` · `unreachable` · `mismatch`이고 `ok`는 거짓이다. 1분 뒤 다시 시험한다

---

### Requirement: 받아쓰기가 실패하면 사람이 이해할 수 있는 이유를 반환한다
시스템은 받아쓰기가 실패하면(첫 모델이 실패하고 대체 모델이 없거나, 두 모델이 모두 실패하면) 상태 503과 사람이 이해할 수 있는 이유(「받아쓰기 서버가 응답하지 않아요. …」)를 반환해야 한다(SHALL). 상위 서버의 오류 원문(모델 이름 · 주소가 들어 있을 수 있다)은 사용자에게 보여 주지 않는다. 원문은 운영자가 확인할 수 있도록 `lastError`(회의 통계)에만 남긴다. 두 모델이 모두 실패하면 `lastError`에 둘째 모델의 실패 이유와 함께 첫 모델의 실패 이유(`first: { model, message }`)도 남긴다. 키에 둘째 모델 사용이 허용되어 있지 않아 항상 401이 반환되면, 그 401이 첫 모델의 실제 실패 이유를 가리기 때문이다.

#### Scenario: 첫 모델이 실패하고 키가 둘째 모델의 사용을 거절한다
- **WHEN** `gpt-4o-mini-transcribe`가 500을 반환하고, 키에 `whisper-1` 사용이 허용되어 있지 않아 둘째 시도에서 401이 반환된다
- **THEN** 말한 사람에게는 「받아쓰기 서버가 응답하지 않아요. …」가 보이고, 회의 통계의 `lastError`는 `{ model: "whisper-1", message: "transcription 401: …", first: { model: "gpt-4o-mini-transcribe", message: "transcription 500: …" } }`이다

#### Scenario: 회의 중 받아쓰기 모델이 없다
- **WHEN** 회의에서 말한 음성 조각을 보냈는데 litellm-proxy가 「Invalid model name … api_base=…」라는 메시지와 함께 거절한다
- **THEN** 말한 사람에게는 「받아쓰기 서버가 응답하지 않아요.」가 보이고, 응답에는 litellm과 주소가 포함되지 않는다

---

### Requirement: 브라우저에 음성 인식이 없으면 서버가 채팅 입력창의 말을 받아쓴다
시스템은 사용자가 채팅 입력창의 마이크를 눌렀을 때 브라우저에 음성 인식 서비스가 없으면(데스크톱 앱의 Chromium, Android 앱의 WebView, Firefox) 서버 받아쓰기를 사용해야 한다(SHALL). 페이지에서 녹음할 수 있어야 하며(마이크 API와 Web Audio), 둘 다 없으면 이전처럼 「이 브라우저는 받아쓰기를 지원하지 않아요」를 보여 준다. 브라우저에 음성 인식이 있으면(Chrome · Edge 웹) 지금처럼 브라우저의 음성 인식을 사용한다.
- 마이크(`getUserMedia`)를 열면 「듣는 중…」이 표시된다. 회의와 같은 방법(`capture.js`)으로 말을 조각으로 나눈다. 0.8초 동안 소리가 없으면 한 조각을 끝내고, 각 조각의 길이는 12초를 넘지 않는다. 조각이 완성될 때마다 바로 `POST /api/dictation`으로 보낸다.
- 각 조각을 받아쓴 글은 말한 순서대로 입력창의 글 뒤에 붙는다. 뒤 조각의 응답이 먼저 와도 앞 조각의 응답을 기다린다. 글이 없는 조각(소리가 없거나, 모델이 소리 없는 구간에서 지어낸 「시청해 주셔서 감사합니다」 같은 말)은 입력창에 아무것도 붙이지 않는다.
- 마이크를 누를 때의 동작 규칙인 「켜 두면 끌 때까지 듣고 저절로 보내지 않는다」는 브라우저 받아쓰기와 같다(`useDictation.js`).
- 끄면 마지막으로 쉰 뒤에 말한 부분도 한 조각으로 보낸다. 그 글이 입력창에 붙은 뒤 받아쓰기가 꺼진다(최대 20초 기다림). 마이크는 바로 꺼진다.
- 보내기(Enter · 보내기 단추)를 누르면 받아쓰기가 바로 꺼지고, 수신 중이던 글은 버린다.
- 서버가 한 조각을 받아쓰지 못하면 실패 이유를 보여 주고 멈춘다. 마이크 권한이 없거나 마이크가 없으면 브라우저 받아쓰기와 같은 안내를 보여 준다.
- 서버(`POST /api/dictation`): 로그인한 사람만 사용할 수 있다. 음성은 3MB까지 받고, 1600바이트보다 짧으면 400을 반환한다. 사용자의 주 언어로 받아쓰며, 회의와 같은 모델을 사용하고 같은 방식으로 「지어낸 말」을 걸러 낸다. 아무것도 저장하지 않는다. 한 사람이 동시에 보낼 수 있는 조각은 3개이며, 이를 넘으면 429를 반환한다.

#### Scenario: 데스크톱 앱에서 말한다
- **WHEN** 데스크톱 앱(`html.pgl-desktop`)에서 마이크를 누르고 「내일 오전에 고객사 미팅 일정을 잡아 줘」라고 말한 뒤 잠시 쉰다
- **THEN** 몇 초 안에 그 글이 입력창에 붙으며, 전송되지는 않는다(로컬 실측: 조각마다 2~4초)

#### Scenario: 끄면 말하던 조각까지 입력된다
- **WHEN** 말하는 도중에 마이크를 다시 누른다
- **THEN** 그때까지 한 말이 한 조각으로 서버에 전송되고, 받아쓴 글이 입력창에 붙은 뒤 「듣는 중…」이 사라진다. 응답에 3초 넘게 걸려도 글은 버려지지 않는다

#### Scenario: 서버가 받아쓰지 못한다
- **WHEN** 받아쓰기 서버가 없거나 응답하지 않는다
- **THEN** 입력창 위에 「받아쓰기 서버가 응답하지 않아요. …」가 표시되고 받아쓰기가 꺼진다. 입력창의 글은 그대로 유지된다
