# 시험과 증거

## 운영에서 받아쓰기가 지나가는 길 (2026-11-25 코드 추적)

| 무엇 | 브라우저 | 서버 | 운영에서 |
|---|---|---|---|
| 입력창 마이크(이 변경 전) | `src/useDictation.js` — 브라우저의 Web Speech 만 | 거치지 않음 | Chrome · Edge 웹: Google 음성 인식이 받아씀. 데스크톱 앱(Electron, 음성 인식 서비스 없음): 「데스크톱 앱에서는 음성 인식 서비스에 닿지 못했어요」로 멈춤. Android 앱(WebView) · Firefox: 「이 브라우저는 받아쓰기를 지원하지 않아요」 |
| 입력창 마이크(이 변경 뒤, 브라우저에 음성 인식이 없을 때) | `src/serverDictation.js` + `capture.js` 조각 → `POST /lite/api/dictation` | `routes/dictation.js` → `transcribe()` | 회의와 같은 모델 |
| 회의 조각 | `capture.js`(0.8초 쉼 · 12초까지, 16kHz WAV) → `POST /lite/api/meetings/:id/audio` | `service.audio` → `transcribe()` → litellm-proxy `/v1/audio/transcriptions` | `gpt-4o-mini-transcribe`(서비스 키에 허락됨) → 안 되면 `whisper-1`(서비스 키에 없음 → 늘 401). 시도마다 15초 |

- 게이트웨이 · 웹 nginx: `/lite/api/*` 의 본문 한도 100MB(`install/docker/nginx.conf`), 조각은 12초 × 32KB/s ≈ 384KB.
- litellm v1.82.3 이 OpenAI 로 보내는 것(로컬에서 가짜 상위 서버로 확인): `gpt-4o-mini-transcribe` 는 `response_format: json`, `whisper-1` 은 `verbose_json` — 두 모델 모두 OpenAI 가 받는 값이다.
- litellm 의 공용 재시도(`num_retries: 6`)는 상위 서버의 5xx · 끊김에 7번 시도해 36초가 걸린다(로컬 실측). 키가 모델을 허락하지 않는 401 은 상위 서버로 가기 전에 바로 돌아온다.

## 단위 (데이터베이스 · 모델 없이)

```bash
cd server && node --test test/transcribeSelfTest.test.js test/dictation.test.js test/meetingTeamFixes.test.js
```

| 스펙 시나리오 | 시험 |
|---|---|
| 키에 모델이 허락되지 않았다 · 첫 모델이 실패하고 키가 둘째 모델을 거절한다 | STT-U-11 |
| litellm-proxy 에 그 이름의 모델이 없다 | STT-U-04 |
| 운영의 첫 모델이 받는다 | STT-U-02 · 11 |
| 첫 모델은 없고 대체 모델만 답한다 | STT-U-05 |
| 받아쓰기 서버가 답하지 않는다(timeout · unreachable · mismatch · empty · bad-answer) | STT-U-03 · 04 |
| (시험 소리 · 한 번만 · 시작 때 · 끄기) | STT-U-01 · 06 · 07 |
| 회의 중 받아쓰기 모델이 없다(사람의 말로) | STT-U-08 |
| `POST /api/dictation`(400 · 401 · 지어낸 말 · 503 · 429) | STT-U-09 · 10 |
| 데스크톱 앱에서 말한다 · 끄면 말하던 조각까지 · 서버가 받아쓰지 못한다 | DV-U-11~14 |

2026-11-25: `results/unit.txt` — STT-U 11개 · DV-U 14개 통과. 관련 서버 시험(회의 · 통역 · 회의록 포함) 49개 통과.

## 화면 (Playwright, 가짜 마이크 · 가로챈 `/api/dictation`)

```bash
cd e2e && npx playwright test --project=feature tests/feature/voice-dictation.spec.js
```

2026-11-25(BFF :8970 · Vite :5370): F-VD-01~08 통과. F-VD-07 은 데스크톱 앱에서 브라우저 인식기를 만들지 않고 서버 쪽으로 가는지(마이크 거절 → 권한 안내)를, F-VD-08 은 데스크톱 앱 · 음성 인식 없는 브라우저에서 조각마다 `POST /api/dictation`(WAV · 토큰), 늦게 온 첫 답도 차례대로, 끄면 말하던 조각까지, 503 이면 그 까닭을 본다.

## 운영 점검 (로그인 없이 읽기만)

```bash
cd e2e
PGPT_ROOT_URL=https://uengine.process-gpt.io npx playwright test --project=deploy tests/deploy/stt.spec.js
```

2026-11-25 로컬:
- 운영과 같은 설정(모델 · 대체 모델은 기본값, 키는 프록시 키): D-STT-01~03 통과, `transcribe` = `{ ok: true, model: "gpt-4o-mini-transcribe", ms: 1337, error: null, fallback: false }`.
- 받아쓰기 모델이 없는 프록시(`PRO_TRANSCRIBE_FALLBACK_MODEL=''`): D-STT-01 이 「speech-to-text is not working here: model gpt-4o-mini-transcribe, error http-400 — litellm-proxy has no model of that name …」로, D-STT-03 이 「D-STT-01 first」로 실패, D-STT-02 통과.

## 로컬 끝까지 (2026-11-25)

Lite BFF(:8970, 운영과 같은 받아쓰기 설정) → litellm v1.82.3(:8971, 공용 재시도 6 · 120초, `gpt-4o-mini-transcribe` 이름) → OpenAI 형식 받아쓰기 서버(:8973 — OpenAI 대신 speaches 0.8.3 + faster-whisper small, 도커). 기록: `results/local-e2e-1125.txt`.
- 자가 시험: ok, 1.3초 소리 1337ms.
- `POST /api/dictation` 4~7초 조각 6개: 모두 200, 1.9~2.5초. 로그인 없이 401.
- 회의(시험 계정 둘의 방, 동의 · 도우미 켬): 13~16초 조각 3개 → 200 · 줄 3개(3.3~4.4초), 회의 통계 `failed 0`, 끝내기 → 회의록 블록과 회의록(LLM 요약 · 결정 · 할 일). 방은 지웠다.
- 실제 브라우저(Playwright Chromium, 데스크톱 앱 표시 `pgl-desktop`, 브라우저 인식기 없음, 녹음한 한국어 두 조각을 마이크로 흘림): 입력창 → 페이지의 조각 나누기 → `/api/dictation` 두 번(각 2.3초) → 입력창에 「회의록 초안을 팀 채널에 올리고 의견을 받아줘 오늘 들어온 매일 중에 급한 것만 골라서 알려줘.」, 보낸 메시지 없음.

## 검토했지만 운영에 넣지 않은 것 — 클러스터 안 Whisper(CPU)

운영 litellm-proxy 에 받아쓰기 모델이 데이터베이스로 이미 있어(OpenAI) 쓰지 않기로 했다. 다시 볼 때를 위해 실측만 남긴다: `results/whisper-cpu-measure-1125.md`(M4 Max, CTranslate2 4.5 int8 arm64, 4스레드, 다른 일로 부하 30~64, 한국어 TTS 조각 40개 + 시험 소리).
- small: 4~7초 조각 p50 2.0초 · p95 3.7초, 10~16초 조각 p50 2.9초 · p95 5.8초, 글자 오류 1.4~1.6%(「메일 → 매일」 · 「달 → 탈」).
- medium: p50 5.6초 · 7.7초, p95 8.5초 · 14.6초, 오류 0.4~0.6%. large-v3-turbo: p50 6.8초 · 7.0초, p95 9.2초 · 10.5초, 오류 0~1.2%.
- speaches 0.8.3 의 주의점: 모델을 미리 내려받아야 하고(`POST /v1/models`, 없으면 404), 5분 쉬면 모델을 내린다(`WHISPER__TTL=-1`), `whisper-1` 별칭은 large-v3 다. 도커(arm64, 4 CPU)에서 small 로 한 번에 1조각 2.8초, 2조각 4~5초, 4조각 10~14초, 6조각째는 20초를 넘었다.
