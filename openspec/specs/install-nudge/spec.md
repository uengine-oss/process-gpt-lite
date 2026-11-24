# 앱 설치 안내와 링크 미리보기 — 설치하지 않았다면 설치 방법을, 공유한 링크에는 내용을

## Purpose
Process GPT Lite는 홈 화면에 앱으로 설치할 수 있는 웹 앱이다. 2026-11-24 사용자가 동료에게 카카오톡으로 「핸드폰에서 uengine.process-gpt.io/lite 로 들어가시면 앱설치가 유도됩니다」라고 안내했지만, 동료는 「앱설치가 저는 안 나오는. 위 링크 클릭하면 그냥 웹버전으로 로딩됩니다.」라고 답했다. 링크가 카카오톡 안의 브라우저에서 열려 설치할 수 없었고, 화면도 그 사실을 알려 주지 않았다. 카카오톡 미리보기에는 제목만 나오고 설명과 그림이 없었다. 이 스펙은 사용자의 요청 「lite 로 직접 들어갔을때도 앱설치가 안된상태면 앱설치유도」에 따라 다음을 정한다. 설치하지 않은 사람에게는 지금 쓰는 브라우저에 맞는 설치 방법을 보여 준다. 설치할 수 없는 브라우저라면 설치할 수 있는 브라우저로 같은 주소를 열어 준다. 공유한 링크에는 설명과 그림이 나오게 한다. Android 래퍼 앱(`android/`)은 배포된 적이 없으므로(스토어 등록이나 APK 공개 없음), 여기서 말하는 설치는 웹 앱 설치다.

## Requirements

### Requirement: 설치된 앱 안에서는 설치를 안내하지 않는다
시스템은 이미 앱으로 열린 화면에서는 설치 안내 카드와 설정의 「앱 설치」 줄을 보여 주지 않아야 한다(SHALL). 앱으로 열린 화면은 홈 화면에 설치한 앱(브라우저가 알려 주는 표시 방식이 standalone 등인 경우, iOS 홈 화면에서 연 경우), Android 래퍼 앱(사용자 에이전트에 `pgpt-pro-android/`가 있거나 `window.AndroidBridge`가 있는 경우), 데스크톱 앱(`<html>`에 `pgl-desktop` 또는 `desktop` 클래스가 있거나 사용자 에이전트에 `Electron/`이 있는 경우)이다. 앱으로 연 적이 있으면 같은 기기의 브라우저 탭에서도 설치한 것으로 기억한다. Android Chrome이 설치한 앱이 있다고 알려 주면(`getInstalledRelatedApps`) 그것도 설치한 것으로 본다.

#### Scenario: 홈 화면에 설치한 앱으로 연다
- **WHEN** 사용자가 홈 화면의 Process GPT 아이콘으로 Lite를 연다
- **THEN** 로그인 화면, Home, 설정 어디에도 설치 안내가 보이지 않는다

#### Scenario: 데스크톱 앱
- **WHEN** 데스크톱 앱이 Lite를 연다(사용자 에이전트에는 Electron이 없고 `<html class="pgl-desktop">`만 있다)
- **THEN** 브라우저가 설치를 제안하더라도 설치 안내가 보이지 않는다

---

### Requirement: Chrome 계열 브라우저에서는 브라우저의 설치 창을 「앱 설치」로 연다
시스템은 브라우저가 설치를 제안하면(`beforeinstallprompt` — Android Chrome, 삼성 인터넷, Edge, 컴퓨터의 Chrome·Edge) 브라우저 자체의 설치 막대 대신 「앱으로 설치하기」 카드에 「앱 설치」 단추를 보여 주어야 한다(SHALL). 휴대폰에서는 로그인 화면(로그인 단추 아래)과 로그인 뒤 Home에 카드를 보여 준다. 「앱 설치」를 누르면 브라우저의 설치 창이 열린다. 설치하면 카드가 사라지고 이 기기에 설치한 것으로 기억한다. 설치 창을 닫으면 「나중에」를 누른 것과 같다. 브라우저가 설치를 제안하지 않는 동안에는(이미 설치했거나 조건이 맞지 않음) 카드를 자동으로 띄우지 않는다.

#### Scenario: Android Chrome에서 링크를 연다
- **WHEN** 설치하지 않은 사람이 Android Chrome에서 `/lite`를 열고 브라우저가 설치를 제안한다
- **THEN** 로그인 단추 아래에 「앱으로 설치하기」와 「앱 설치」가 보인다
- **AND** 「앱 설치」를 누르면 브라우저의 설치 창이 열리고, 설치하면 카드가 사라진다

#### Scenario: 설치 창에서 취소한다
- **WHEN** 사용자가 Home 카드의 「앱 설치」를 누른 뒤 브라우저의 설치 창을 닫는다
- **THEN** 카드가 사라지고, 다음 방문에 브라우저가 다시 제안해도 7일 동안은 보이지 않는다

---

### Requirement: iPhone·iPad에서는 「홈 화면에 추가」 순서를 보여 준다
시스템은 iPhone·iPad(iPadOS가 기기를 Mac으로 알려도 터치 화면이면 iPad로 본다)의 브라우저에서 공유 › 「홈 화면에 추가」 › 「추가」 순서를 보여 주어야 한다(SHALL). iOS에는 설치 창을 여는 기능이 없기 때문이다. 로그인 화면에는 한 줄로 짧게(공유 › 홈 화면에 추가 › 추가), Home과 설정의 시트에는 단계마다 한 줄로 보여 준다. 공유 버튼이 ⋯ 메뉴 안에 있을 수 있으므로, 공유 버튼이 보이지 않으면 ⋯ 버튼을 먼저 누르라고 함께 알려 준다.

#### Scenario: iPhone Safari로 연다
- **WHEN** 설치하지 않은 사람이 iPhone Safari에서 `/lite`를 연다
- **THEN** 로그인 단추 아래에 「홈 화면에 추가하기」와 공유 › 홈 화면에 추가 › 추가가 보이고, 「앱 설치」 단추는 없다

#### Scenario: 짧은 화면
- **WHEN** 브라우저의 위·아래 막대 때문에 화면에 보이는 영역의 높이가 낮아 로그인 화면이 다 들어가지 않는다
- **THEN** 로그인 화면을 위아래로 밀어 카드와 로그인 단추를 모두 볼 수 있으며, 위나 아래가 잘리지 않는다

---

### Requirement: 앱 속 브라우저에서는 외부 브라우저로 같은 주소를 연다
시스템은 다른 앱 안의 브라우저(카카오톡, 네이버 앱, 라인, 인스타그램, 페이스북, 스레드, 밴드, 다음 앱, 에브리타임, 텔레그램, Google 앱, 그리고 이름을 알 수 없는 앱의 웹뷰)에서는 설치할 수 없다고 알리고, 설치할 수 있는 브라우저에서 같은 주소를 여는 방법을 보여 주어야 한다(SHALL). 카드에는 「브라우저에서 열어야 설치할 수 있어요」와 「카카오톡 안의 브라우저에서는 앱을 설치할 수 없어요.」처럼 그 앱의 이름이 나온다. 여는 주소는 지금 주소의 경로와 쿼리를 그대로 유지하고(`/lite/...`), `#` 뒤의 조각만 뺀다.
- Android(앱 종류와 상관없음): 「Chrome에서 열기」. 링크는 `intent://<호스트><경로><쿼리>#Intent;scheme=<http|https>;package=com.android.chrome;S.browser_fallback_url=<주소>;end`이다. Chrome이 없으면 기본 브라우저가 연다.
- iPhone 카카오톡: 「Safari에서 열기」. 링크는 `kakaotalk://web/openExternal?url=<주소>`이다.
- iPhone 라인: 「Safari에서 열기」. 링크는 주소에 `openExternalBrowser=1`을 붙인 것이다.
- 그 밖의 iPhone 앱: ⋯ 메뉴에서 「Safari로 열기」나 「외부 브라우저로 열기」를 누르라는 안내와 「주소 복사」를 보여 준다.

#### Scenario: 카카오톡에서 링크를 누른다 (Android)
- **WHEN** 사용자가 카카오톡에 공유된 `/lite` 링크를 눌러 카카오톡 안의 브라우저에서 연다
- **THEN** 로그인 단추 아래에 카카오톡 안에서는 설치할 수 없다는 안내와 「Chrome에서 열기」가 보인다
- **AND** 「Chrome에서 열기」를 누르면 Chrome이 같은 경로와 쿼리로 Lite를 연다

#### Scenario: 카카오톡에서 링크를 누른다 (iPhone)
- **WHEN** iPhone 카카오톡 안의 브라우저에서 `/lite/login?from=kakao`가 열린다
- **THEN** 「Safari에서 열기」의 링크가 `kakaotalk://web/openExternal?url=`에 인코딩한 주소를 붙인 것이다

#### Scenario: 링크로 나갈 수 없는 앱
- **WHEN** iPhone 인스타그램 안의 브라우저에서 Lite가 열린다
- **THEN** ⋯ 메뉴에서 「Safari로 열기」를 누르라는 안내와 「주소 복사」가 보이고, 여는 링크는 없다

---

### Requirement: 컴퓨터에서는 Home에만 작게 보여 준다
시스템은 컴퓨터의 Chrome·Edge가 설치를 제안하면 Home에만 작은 카드를 보여 주고, 로그인 화면에는 보여 주지 않아야 한다(SHALL). 카드에는 「브라우저 탭 없이 별도 창으로 열려요.」가 표시된다.

#### Scenario: 컴퓨터의 Chrome
- **WHEN** 컴퓨터의 Chrome이 설치를 제안한다
- **THEN** Home에는 「앱으로 설치하기」 카드가 보이고, 로그인 화면에는 보이지 않는다

---

### Requirement: 「나중에」와 「다시 보지 않기」는 이 기기에 기억한다
시스템은 자동으로 띄우는 카드에 「나중에」와 「다시 보지 않기」를 두어야 한다(SHALL). 「나중에」를 누르면 7일 동안, 「다시 보지 않기」를 누르면 그 뒤로 계속 로그인 화면과 Home 모두에서 카드를 띄우지 않는다. 이 선택은 기기(브라우저)마다 저장하며, 다른 기기에는 영향을 주지 않는다. 브라우저에서 저장을 허용하지 않으면 다음 방문에 다시 묻는다. 카드는 화면을 가리거나 앱 사용을 막지 않는다.

#### Scenario: 「나중에」
- **WHEN** 사용자가 Home 카드의 「나중에」를 누른다
- **THEN** 카드가 사라지고, 새로 고쳐도 7일 동안은 보이지 않으며, 7일이 지나면 다시 보인다

#### Scenario: 「다시 보지 않기」
- **WHEN** 사용자가 「다시 보지 않기」를 누른다
- **THEN** 이 기기의 Home과 로그인 화면에 카드가 다시 보이지 않는다
- **AND** 설정 › 「앱 설치」는 그대로 있어 언제든 설치 방법을 볼 수 있다

---

### Requirement: 설정에 「앱 설치」가 늘 있다
시스템은 앱으로 열린 화면이 아니면 설정 첫 화면에 「앱 설치」 줄을 두어야 한다(SHALL). 이 줄은 「나중에」나 「다시 보지 않기」와 상관없이 보인다. 줄을 누르면 현재 브라우저에 맞는 설치 방법을 담은 시트가 열린다. 앞에서 정한 설치 창, iPhone 순서, 앱 속 브라우저 안내에 더해, 브라우저가 설치를 제안하지 않을 때는 브라우저 메뉴로 설치하는 방법을 보여 준다. Android에서는 「브라우저 메뉴(⋮)에서 「앱 설치」나 「홈 화면에 추가」를 누르세요.」, Mac Safari에서는 「파일 › Dock에 추가」, 컴퓨터의 Chrome·Edge에서는 주소창의 설치 아이콘이나 메뉴를 안내한다. 설치할 수 없는 브라우저(컴퓨터의 Firefox 등)에서는 Chrome이나 Edge에서 열라고 안내한다. 이 기기에 설치한 것으로 기억하면 「이미 설치했어요」와 아이콘으로 여는 방법을 보여 준다.

#### Scenario: 설치 제안이 없는 Android Chrome
- **WHEN** 사용자가 설정 › 「앱 설치」를 누르고, 브라우저는 아직 설치를 제안하지 않았다
- **THEN** 시트에 브라우저 메뉴(⋮)로 설치하는 방법이 보인다
- **AND** 그사이 브라우저가 설치를 제안하면 시트에 「앱 설치」가 나타나고, 누르면 설치 창이 열린다

---

### Requirement: 공유한 링크에는 설명과 그림이 나온다
시스템은 페이지를 실행하지 않고 읽는 링크 미리보기(카카오톡, 슬랙, 페이스북 등)에도 Lite의 제목, 설명, 그림이 나오도록 처음 보내는 HTML에 다음 태그를 넣어야 한다(SHALL): `description`, `og:type`, `og:site_name`(Process GPT), `og:title`(Process GPT Lite — 대화로 일하는 AI 업무 비서), `og:description`(메일 답장, 문서 작성, 반복 업무까지 말로 맡기면 AI가 대신 처리해요.), `og:image`(1200×630 PNG, `og-image.png`)와 그 크기·설명, `og:locale`(ko_KR), `twitter:card`(summary_large_image)와 `twitter:` 제목·설명·그림. 주소는 모두 절대 주소다. 빌드할 때 공개 주소(`LITE_PUBLIC_ORIGIN`, 기본 `https://uengine.process-gpt.io`)와 앱 경로(`/lite`)로 채운다. 웹 이미지의 nginx는 요청이 공개 호스트를 알려 주면(`X-Forwarded-Host`, 또는 도메인이나 localhost로 된 `Host`) 그 요청의 주소로 바꿔 보낸다. 클러스터 안의 이름(`process-gpt-lite-web`, `*.svc`, `*.local`)이나 호스트에 쓸 수 없는 글자가 들어오면 바꾸지 않는다. `og:url`은 넣지 않는다. 운영 게이트웨이가 원래 호스트를 넘기지 않아 다른 회사의 링크도 한 회사 주소를 가리키게 되므로, 미리보기는 공유한 링크 자체를 쓴다.

#### Scenario: 카카오톡에 링크를 붙인다
- **WHEN** 사용자가 카카오톡 대화에 `https://uengine.process-gpt.io/lite`를 붙인다
- **THEN** 미리보기에 제목 「Process GPT Lite — 대화로 일하는 AI 업무 비서」, 설명, 1200×630 그림이 나온다

#### Scenario: 회사마다 다른 주소
- **WHEN** 요청이 `X-Forwarded-Host: acme.process-gpt.io`, `X-Forwarded-Proto: https`를 포함한다
- **THEN** `og:image`는 `https://acme.process-gpt.io/lite/og-image.png`다

#### Scenario: 게이트웨이가 호스트를 넘기지 않는다
- **WHEN** 요청의 `Host`가 `process-gpt-lite-web`이고 `X-Forwarded-Host`가 없다
- **THEN** 빌드할 때 넣은 `https://uengine.process-gpt.io/lite/...` 주소가 그대로 전달된다

---

### Requirement: 설치 정보(매니페스트)는 앱 경로 아래를 가리킨다
시스템의 매니페스트는 설치 조건을 갖추어야 한다(SHALL). `start_url`은 `<앱 경로>/chat`, `scope`는 `<앱 경로>/`, `display`는 `standalone`이다. 아이콘은 192·512와 maskable 512가 있다. `id`는 `<앱 경로>/chat`이며, 이전에 브라우저가 `start_url`로 정한 값과 같아서 이미 설치한 앱이 다른 앱으로 바뀌지 않는다. `related_applications`에는 자기 자신을 `webapp`으로 넣는다(설치한 앱이 있는지 Android Chrome이 알려 주도록). 서비스 워커의 범위는 `<앱 경로>/`이다.

#### Scenario: 게이트웨이 뒤의 매니페스트
- **WHEN** `/lite/`로 빌드한 웹 이미지가 `/lite/manifest.webmanifest`를 보낸다
- **THEN** `id`는 `/lite/chat`이고, `start_url`과 `scope`는 `/lite/` 아래로 풀린다
