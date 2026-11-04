# craft

전자 제품 시작품 도구(spec `pgpt-pro_prototype-request`). 오픈소스 앱을 크래프트 시리즈처럼 `/craft/<app>/` 로 띄우고 MCP 로 에이전트에게 준다.

| 폴더 | 무엇 | 바탕 | 라이선스 |
|---|---|---|---|
| `pspice/` | PSpice 문서 읽기·쓰기, ngspice 용으로 옮기기 | 직접 작성 | 이 저장소 |
| `circuitcraft/` | 웹 회로도·시뮬레이션 | WebSpice(MIT), eecircuit-engine(MIT, ngspice) | MIT |
| `circuitcraft-cli/` | 시뮬레이션 MCP | eecircuit-engine | 이 저장소 |
| `solidcraft/` | 웹 3D, Chili3D 플러그인과 빌드 | Chili3D(AGPL-3.0, cpp/ 는 LGPL-3.0), OpenCascade(LGPL) | 플러그인은 AGPL 앱과 함께 돈다 |
| `solidcraft-cli/` | 선언형 3D MCP | Chili3D WASM | 같음 |
| `orcad/` | OrCAD .dsn·.olb 읽기 | OpenOrCadParser(MIT) | 이 저장소 |

Chili3D 는 AGPL-3.0 이다. 제품에 넣어 판매하기 전에 수정분 소스 공개나 상용 라이선스(저자에게 문의)를 정해야 한다.

## 설치

```bash
# Chili3D 를 받아 artcraft/chili3d-src 에 두고(npm ci), OpenOrCadParser 를 받아 artcraft/openorcad-src 에 두고 빌드한다
(cd craft/circuitcraft-cli && npm i) && (cd craft/solidcraft-cli && npm i)
craft/circuitcraft/build.sh   # → artcraft/web/circuitcraft
craft/solidcraft/build.sh     # → artcraft/web/solidcraft
craft/orcad/build.sh          # → artcraft/orcad2json
```

서버는 `PRO_ARTCRAFT_ROOT`(웹 빌드 위치)를 본다. CLI 경로는 기본값이 이 폴더이고 `PRO_CIRCUITCRAFT_CLI`, `PRO_SOLIDCRAFT_CLI`, `PRO_DSN2CIR` 로 바꿀 수 있다. 없는 앱의 단계는 건너뛰고 알린다.

## 저장소에 넣지 않은 파일

벤더 모델(저작권 표시, TDK 는 재배포 금지), 라이선스를 확인하지 못한 CAD 표본, 실제 설계 파일. 받는 법은 `pspice/test/fetch-models.sh`, `solidcraft/test/fetch-samples.sh`, `orcad/test/fetch-evidence.sh`.
