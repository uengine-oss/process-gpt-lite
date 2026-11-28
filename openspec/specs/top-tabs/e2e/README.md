# 시험과 증거

```bash
cd e2e && RT_WORKERS=1 npx playwright test --project=feature tests/feature/top-tabs.spec.js   # F-NAV-01~03
```

시험은 사용하지 않는 포트에서 전용 스택(회사 `top-tabs-ui`의 BFF와 Vite)을 실행하고, 끝나면 정리한다. 모델과 지도 저장소는 호출하지 않는다. 따라서 이 스택에서 「프로세스」는 진행 중인 일 목록을 연다. 지도가 있는 회사에서 지도가 열리는지는 `process-ontology.spec.js`의 F-PO-18 · F-PO-22가 탭 id(`routine`)를 사용해 확인한다.

| 스펙 시나리오 | 시험 | 증거 |
|---|---|---|
| F-NAV-01 PC에서 메뉴 순서 · 「프로세스」를 누른다 | F-NAV-01 | `results/f-nav-01-pc-chat.png` · `results/f-nav-01-pc-process.png` |
| F-NAV-02 휴대폰에서 메뉴 순서 · 「프로세스」를 누른다 | F-NAV-02 | `results/f-nav-02-phone-chat.png` · `results/f-nav-02-phone-process.png` |
| F-NAV-03 영어 화면 | F-NAV-03 | `results/f-nav-03-pc-english.png` |
