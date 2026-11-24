// Lite 단계 카탈로그(server/lib/stepUi/catalog.json)의 이름과 그 안의 컴포넌트 · 함수 — 서버의 lib/stepUi/catalogInfo.js 와 같아야 한다
// (서버 시험 stepUi.test.js 가 견준다). 화면은 A2UI 기본 카탈로그(basic v1)에서 이 이름들만 골라 같은 id 의 카탈로그를 만든다(runtime.js).
export const CATALOG_ID = 'https://process-gpt.io/a2ui/catalogs/lite-step/v1/catalog.json'
export const COMPONENTS = ['Text', 'Row', 'Column', 'Card', 'Divider', 'Button', 'TextField', 'CheckBox', 'ChoicePicker', 'DateTimeInput', 'Slider']
export const FUNCTIONS = ['required', 'length', 'numeric', 'email', 'formatString', 'formatNumber', 'formatCurrency', 'formatDate', 'pluralize', 'and', 'or', 'not']
