// Lite 단계 카탈로그(catalog.json)의 이름과 그 안에 든 것. 화면 쪽 src/components/a2ui/catalogIds.js 에 같은 목록이 있다(서버 시험이
// 둘이 같은지 본다). A2UI 기본 카탈로그(basic v1)의 안전한 부분집합이다:
//   - 그림 · 영상 · 소리(Image · Video · AudioPlayer)는 없다 — 바깥 주소를 읽는 화면은 그 주소로 값을 내보낼 수 있다.
//   - Icon · List · Tabs · Modal 도 없다 — 입력 화면에 필요 없고, List 는 템플릿 경로(상대 경로)를 따로 검사해야 한다.
//   - openUrl(바깥 주소 열기) · regex(모델이 쓴 정규식을 서버가 다시 돌리면 오래 걸릴 수 있다) 함수는 없다.
//   - TextField 의 obscured(비밀번호 칸)는 없다.
export const CATALOG_ID = 'https://process-gpt.io/a2ui/catalogs/lite-step/v1/catalog.json'
export const PROTOCOL = '1.0'
export const COMPONENTS = ['Text', 'Row', 'Column', 'Card', 'Divider', 'Button', 'TextField', 'CheckBox', 'ChoicePicker', 'DateTimeInput', 'Slider']
export const FUNCTIONS = ['required', 'length', 'numeric', 'email', 'formatString', 'formatNumber', 'formatCurrency', 'formatDate', 'pluralize', 'and', 'or', 'not']
// the input components and the type their bound value has
export const INPUTS = { TextField: 'string', CheckBox: 'boolean', ChoicePicker: 'list', DateTimeInput: 'string', Slider: 'number' }
// keys the host writes next to a step's values (the text the next steps read, the agent's draft fields, the A2UI record)
export const RESERVED = ['result', 'summary', 'title', 'checkpoints', 'mail', 'assumptions', 'a2ui']
