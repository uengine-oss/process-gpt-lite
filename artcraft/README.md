# ArtCraft 연동 (CADCraft · VectorCraft · PhotoCraft · SoundCraft · FilmCraft)

Process GPT Lite는 에이전트가 MCP로 도면·벡터·이미지·소리·영상을 만들고, 사람이 같은 파일을 웹 편집기로 이어서 고치게 합니다. 편집기와 MCP CLI는 [storytold](https://github.com/storytold)의 오픈소스 ArtCraft 앱을 그대로 씁니다. 이 저장소에는 **바이너리를 넣지 않고**, 우리가 얹은 작은 패치와 빌드 스크립트만 둡니다.

Process GPT Lite lets agents create drawings, vectors, images, sound and video over MCP while people keep editing the same file in the web editors. The editors and MCP CLIs are the upstream open-source ArtCraft apps by [storytold](https://github.com/storytold). This folder holds **no binaries** — only our patches and a build script.

| 앱 / App | 업스트림 / Upstream | 검증한 커밋 / Tested commit | 라이선스 / License |
|---|---|---|---|
| CADCraft | https://github.com/storytold/cadcraft | `b9f96d3` (CLI 0.8.0) | MIT OR Apache-2.0 |
| VectorCraft | https://github.com/storytold/vectorcraft | `75dacb4` (CLI 0.16.0) | MIT OR Apache-2.0 |
| PhotoCraft | https://github.com/storytold/photocraft | `1c3db2e` (CLI 0.15.1) | MIT OR Apache-2.0 |
| SoundCraft | https://github.com/storytold/soundcraft | `93800e0` (CLI 0.12.1) | MIT OR Apache-2.0 |
| FilmCraft | https://github.com/storytold/filmcraft | `057f460` (CLI 0.12.0) | MIT OR Apache-2.0 |

업스트림은 MIT/Apache-2.0 이중 라이선스이므로 수정 패치를 배포할 수 있습니다. 패치를 적용해 만든 빌드를 배포할 때는 업스트림의 `LICENSE-MIT`/`LICENSE-APACHE`와 글꼴 OFL 고지를 함께 넣으세요.
The upstreams are dual-licensed MIT/Apache-2.0, so distributing these patches is allowed. If you redistribute builds, ship the upstream `LICENSE-*` files and the fonts' OFL notices with them.

## 패치 / Patches

| 파일 / File | 내용 / What it does |
|---|---|
| `patches/<app>-web-korean-font.patch` | 웹 빌드에 한글 글꼴(NanumGothic)을 대체 글꼴로 넣어 한글 이름·텍스트가 □로 깨지지 않게 함 / Adds a Hangul fallback face to the web build |
| `patches/photocraft-web-page-api.patch` | PhotoCraft 웹에 페이지 API를 열어 Lite의 라이브 공동 편집(에이전트 변경을 열린 화면에 반영)을 지원 / Exposes a page API used for live co-editing |

## 준비 / Setup

```bash
cd artcraft
mkdir -p src
for a in cadcraft vectorcraft photocraft soundcraft filmcraft; do
  git clone https://github.com/storytold/$a src/$a-src
done
# (선택) 검증한 커밋으로 고정 / optionally pin to the tested commits above
for p in patches/*.patch; do
  app=$(basename "$p" | cut -d- -f1)
  git -C src/$app-src apply "$PWD/$p"
done

# 한글 글꼴 (SIL OFL 1.1): https://fonts.google.com/specimen/Nanum+Gothic
#   → fonts-ko/fonts/NanumGothic-Regular.ttf  (manifest.txt 는 이미 있음)
# CADCraft/VectorCraft 빌드는 CRAFT_FONTS_DIR=$PWD/fonts-ko/fonts 로 글꼴 목록을 읽습니다.

./build-ko.sh cadcraft vectorcraft photocraft soundcraft filmcraft
```

빌드 결과(각 앱의 `packaging/web` 산출물)를 `artcraft/web/<app>/`에 두면 Lite 서버가 `/craft/<app>/`로 제공합니다(`PRO_CRAFT_WEB_ROOT`로 위치 변경 가능).
Put each web build under `artcraft/web/<app>/`; the Lite server serves it at `/craft/<app>/` (`PRO_CRAFT_WEB_ROOT` overrides the location).

MCP CLI는 업스트림 릴리스(예: `cadcraft-cli-0.8.0-macos-universal.zip`)를 받아 `PATH`에 두거나, `PRO_CADCRAFT_CLI` 등 환경 변수로 경로를 지정합니다(`server/.env.example` 참고).
Download the MCP CLIs from the upstream releases and put them on `PATH`, or point `PRO_<APP>_CLI` at them.

ArtCraft가 없어도 Lite의 나머지 기능은 동작합니다. / Lite works without ArtCraft; only the craft apps are unavailable.
