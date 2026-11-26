# 시험과 증거

`src/safeMarkdown.js` 의 규칙은 브라우저의 파서에 의존하므로, 단위 시험도 브라우저 안에서 실행한다: F-SH-01 이 Vite 가 제공하는 모듈을 그대로 불러와 까다로운 입력 모음과 일반적인 Markdown 을 렌더링하고, 그 결과를 실제 문서에 삽입한 뒤(화면의 `v-html` 과 같다) 남은 요소 · 속성 · 링크와 `window.__x` 를 읽는다. 화면 시험(F-SH-02~05)은 실제 BFF 와 Vite 위에서 메시지 · 할 일을 DB 에 직접 입력하고 대화 · 「이미 한 요청」 카드 · 스킬 시트 · 인스턴스 화면을 연다. 팀원의 지난 답(`GET /api/context/repeats/:id/answer`)에 대해서만 시험이 응답을 대신 제공한다. F-SH-06 은 페이지의 meta 정책을 브라우저에서 확인하고, 도커와 `nginx:1.27-alpine` 이미지가 있으면 설치 번들의 `nginx.conf` 로 실제 nginx 를 실행하여 모의 저장소 앞에서 헤더를 읽는다. F-SH-07은 CLI 에이전트 단계의 작업 폴더(`PRO_CLI_WORKSPACE_ROOT`)에 파일을 저장하고 BFF의 작업실 원본 응답 헤더를 읽는다.

```bash
cd e2e && RT_WORKERS=1 npx playwright test --project=feature tests/feature/safe-html.spec.js
```

| 스펙 시나리오 | 시험 | 사진 |
|---|---|---|
| 에이전트의 답에 HTML 이 섞여 있다 | F-SH-02 | `results/f-sh-02-chat.png` |
| 팀원의 지난 답을 펼친다 | F-SH-03 | `results/f-sh-03-repeat.png` |
| 스킬 시트와 단계 결과 | F-SH-04 · F-SH-05 | `results/f-sh-04-skill.png` · `results/f-sh-05-instance.png` |
| 그림 문법 | F-SH-01 · F-SH-02 | — |
| 보고서 형식의 답 | F-SH-01 · F-SH-02 | `results/f-sh-02-chat.png` |
| 패널 앱이 웹 주소가 아닌 곳을 열려고 한다 | — (코드만) | — |
| 저장소의 HTML 파일을 따로 연다 | F-SH-06 | — |
| 작업실의 XHTML 파일 | F-SH-07 | — |

마지막 실행 결과는 `results/e2e.txt` 에 있다.
