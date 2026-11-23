// The seed policy catalog: what a company starts with (Settings › 정책 turns each on or off). Sources name the
// law or framework a policy follows; "사내 규정(예시)" marks an example in-house rule, to be replaced by the
// company's own. Facts each action carries are documented next to the action kinds.
//
//   mail.send        recipients[], external (bool), external_count, pii_count, pii_kinds[], classification (the model's reading of the mail,
//                    the marking words when it cannot answer), classification_source ('logprob'|'regex'), classification_p, attachments
//   browser.payment  amount (KRW), merchant, new_merchant (bool)
//   purchase.approve amount (KRW), supplier_new (bool), category
//   purchase.order   amount, approved (bool), speculative (bool)
//   release.deploy   audience ('public'|'internal'|'beta'), features[{name, pii}], open_findings{privacy, security}, security_scan, weekday, hour
//   data.export      rows, pii_rows, destination_external (bool)
//   data.delete      count
//   context.access   sensitive (bool, the owner marked it), topic (read from its title, purpose and summary: spec pgpt-pro_guardrail-reading; null
//                    when the owner dismissed it), topic_source ('format'|'logprob'|'regex'|'unread'), topic_p, topic_model, relation ('team'|'department'|'company'), depth ('summary'|'content'),
//                    owner_rule (what the owner's own rules say: 'allow'|'ask'|'deny')
export const SOURCES = {
  pipa17: '개인정보보호법 제17조(개인정보의 제공)',
  pipa23: '개인정보보호법 제23조(민감정보의 처리 제한)',
  pipa29: '개인정보보호법 제29조(안전조치의무)',
  euAiAct14: 'EU AI Act 제14조(사람의 감독)',
  nistGovern: 'NIST AI RMF — GOVERN·MANAGE',
  isms: 'ISMS-P 2.10(시스템 및 서비스 보안관리)',
  inhouse: '사내 규정(예시)',
}

// Possibly sensitive topics: HR, pay, contract terms, health, discipline, personal identifiers. They live in the policy
// context-sensitive-topic, so a company edits the list there. The model reads the text and names one of them; the patterns decide
// only when the model cannot answer (they miss what is said in other words and catch 「서버 건강」: spec pgpt-pro_guardrail-reading).
// 「인사」 counts as a word only (인사이트, 인사말 are not).
export const SENSITIVE_TOPICS = [
  { name: '인사', pattern: /(^|[\s·,(「『'"])인사($|[\s·,.)」』'"]|\s?(평가|고과|발령|상담|기록|위원회|조치|정보|이동|카드))/.source },
  { name: '급여', pattern: /급여|월급|임금|상여금|성과급/.source },
  { name: '연봉', pattern: /연봉/.source },
  { name: '계약 조건', pattern: /(계약|근로|고용|채용)\s*조건|근로\s*계약|고용\s*계약/.source },
  { name: '건강', pattern: /건강|진단서|병력/.source },
  { name: '병가', pattern: /병가|병\s*휴가/.source },
  { name: '징계', pattern: /징계/.source },
  { name: '주민등록', pattern: /주민\s*등록|주민\s*번호/.source },
  { name: '개인정보', pattern: /개인\s*정보|개인\s*식별|신원\s*정보/.source },
  { name: '이직', pattern: /이직\s*(준비|상담|면접)|퇴사/.source },
]

export const CATALOG = [
  // ── 메일·자료 반출 (시나리오: 외부 메일)
  { id: 'mail-internal', category: 'audit', scope: { action: ['mail.send'] },
    when: { '!': { var: 'external' } }, decide: 'allow',
    title: ['사내 메일은 바로 보내기', 'Internal mail goes out at once'], explain: ['받는 사람이 모두 사내면 확인 없이 보냅니다.', 'Everyone on it is in the company: it goes out without a check.'], sources: [SOURCES.inhouse] },
  { id: 'mail-external', category: 'audit', scope: { action: ['mail.send'] },
    when: { var: 'external' }, decide: 'allow_audit', window: { span: '1d', count: 20, then: 'require_approval' }, approver: { role: '팀장' },
    title: ['외부 메일은 보내고 기록', 'External mail is sent and recorded'],
    explain: ['외부 메일은 보내되 감사 기록에 남기고 10분 안에 회수할 수 있습니다. 하루 20건을 넘으면 팀장 승인을 받습니다.', 'External mail is sent, recorded and can be recalled for 10 minutes; past 20 a day it needs the team lead.'],
    sources: [SOURCES.inhouse, SOURCES.nistGovern] },
  { id: 'mail-external-pii', category: 'privacy', scope: { action: ['mail.send'] },
    when: { and: [{ var: 'external' }, { '>': [{ var: 'pii_count' }, 0] }] }, decide: 'require_approval', approver: { role: '개인정보 책임자' },
    title: ['개인정보가 든 외부 메일은 승인 후', 'External mail with personal data waits for approval'],
    explain: ['외부로 나가는 메일·첨부에 개인정보가 있으면 개인정보 책임자가 승인해야 보냅니다.', 'Personal data leaving the company needs the privacy officer\'s approval.'],
    sources: [SOURCES.pipa17] },
  { id: 'mail-bulk-pii', category: 'privacy', scope: { action: ['mail.send', 'data.export'] },
    when: { or: [{ '>=': [{ var: 'pii_count' }, 50] }, { '>=': [{ var: 'pii_rows' }, 50] }] }, decide: 'deny', approver: { role: '개인정보 책임자' },
    title: ['개인정보 대량 반출 차단', 'Bulk personal data does not leave'],
    explain: ['개인정보 50건 이상을 한 번에 내보내지 않습니다. 필요하면 가명처리하거나 승인된 전송 경로를 씁니다.', 'Fifty or more personal data items never leave at once: pseudonymise, or use an approved transfer.'],
    sources: [SOURCES.pipa17, SOURCES.pipa29] },
  { id: 'mail-confidential', category: 'security', scope: { action: ['mail.send'] },
    when: { and: [{ var: 'external' }, { '==': [{ var: 'classification' }, 'confidential'] }] }, decide: 'require_approval', approver: { role: '보안 담당자' },
    title: ['기밀 자료 외부 발송은 보안 담당 승인', 'Confidential files outside need security'], explain: ['모델이 메일과 첨부를 읽어 기밀 자료로 판단하면 보안 담당자가 승인합니다. 모델이 답하지 못할 때는 기밀·대외비 표시로 판단합니다.', 'When the model reads the mail and its files as confidential, the security officer approves. If the model cannot answer, the marking words decide.'], sources: [SOURCES.isms] },

  // ── 결제 (브라우저 에이전트)
  { id: 'payment-approval', category: 'authority', scope: { action: ['browser.payment'] },
    when: { '>': [{ var: 'amount' }, 100000] }, decide: 'require_approval', approver: { role: '팀장' },
    tolerance: { field: 'amount', limit: 100000, over: 0.1 },
    title: ['10만 원 넘는 결제는 팀장 승인', 'Payments over ₩100,000 need the team lead'],
    explain: ['10만 원을 넘으면 팀장이 승인합니다. 11만 원까지는 허용 오차로 기록만 합니다.', 'Over ₩100,000 the team lead approves; up to ₩110,000 is within tolerance and only recorded.'], sources: [SOURCES.inhouse] },
  { id: 'payment-large', category: 'authority', scope: { action: ['browser.payment'] },
    when: { '>': [{ var: 'amount' }, 5000000] }, decide: 'deny', approver: { role: '재무 책임자' },
    title: ['500만 원 넘는 결제는 에이전트가 하지 않음', 'Agents never pay over ₩5,000,000'], explain: ['500만 원을 넘는 결제는 구매 프로세스로 처리합니다.', 'Over ₩5,000,000 goes through purchasing.'], sources: [SOURCES.inhouse] },
  { id: 'payment-new-merchant', category: 'security', scope: { action: ['browser.payment'] },
    when: { var: 'new_merchant' }, decide: 'require_approval', approver: { role: '팀장' },
    title: ['처음 쓰는 판매처 결제는 승인 후', 'A new merchant waits for approval'], explain: ['처음 거래하는 판매처는 금액과 상관없이 승인합니다.', 'A merchant used for the first time is approved whatever the amount.'], sources: [SOURCES.inhouse] },

  // ── 구매 (시나리오: 구매 승인)
  { id: 'purchase-finance', category: 'authority', scope: { action: ['purchase.approve'] },
    when: { '>': [{ var: 'amount' }, 10000000] }, decide: 'require_approval', approver: { role: '재무 책임자' },
    title: ['1,000만 원 넘는 구매는 재무 승인 추가', 'Purchases over ₩10M add finance approval'], explain: ['팀장 승인에 더해 재무 책임자가 승인합니다.', 'Finance approves on top of the team lead.'], sources: [SOURCES.inhouse] },
  { id: 'purchase-new-supplier', category: 'legal', scope: { action: ['purchase.approve'] },
    when: { var: 'supplier_new' }, decide: 'require_approval', approver: { role: '구매 담당' },
    title: ['신규 공급사는 구매 담당 확인', 'A new supplier is checked by purchasing'], explain: ['처음 거래하는 공급사는 계약·실사 확인이 필요합니다.', 'A first-time supplier needs a contract and due-diligence check.'], sources: [SOURCES.inhouse] },
  { id: 'purchase-order-before-approval', category: 'authority', scope: { action: ['purchase.order'] },
    when: { and: [{ '!': { var: 'approved' } }, { '!': { var: 'speculative' } }] }, decide: 'deny',
    title: ['승인 전 발주 금지 (초안·견적은 허용)', 'No order before approval (drafts and quotes are fine)'],
    explain: ['승인 전에는 되돌릴 수 있는 준비(발주서 초안, 재고·견적 확인)만 미리 합니다. 실제 발주는 승인 뒤에.', 'Before approval only reversible preparation runs (order drafts, stock and quote checks); the order itself waits.'],
    sources: [SOURCES.inhouse] },

  // ── 릴리스 (시나리오: 금요일 출시)
  { id: 'release-open-pii', category: 'privacy', scope: { action: ['release.deploy'] },
    when: { and: [{ '==': [{ var: 'audience' }, 'public'] }, { '>': [{ var: 'open_findings.privacy' }, 0] }, { some: [{ var: 'features' }, { var: 'pii' }] }] },
    decide: 'deny', approver: { role: '개인정보 책임자' },
    title: ['개인정보 위험이 열린 기능은 공개 출시 금지', 'No public release with an open privacy finding'],
    explain: ['개인정보를 다루는 기능에 해결되지 않은 개인정보 위험이 있으면 일반 공개하지 않습니다.', 'A feature handling personal data with an open privacy finding is not released to the public.'],
    sources: [SOURCES.pipa29, SOURCES.euAiAct14] },
  { id: 'release-security-scan', category: 'security', scope: { action: ['release.deploy'] },
    when: { '!=': [{ var: 'security_scan' }, 'passed'] }, decide: 'deny', approver: { role: '보안 담당자' },
    title: ['보안 점검을 통과해야 출시', 'Release only after the security scan'], explain: ['보안 점검이 통과하지 않은 빌드는 어디에도 배포하지 않습니다.', 'A build that failed the security scan is deployed nowhere.'], sources: [SOURCES.isms] },
  { id: 'release-internal', category: 'audit', scope: { action: ['release.deploy'] },
    when: { in: [{ var: 'audience' }, ['internal', 'beta']] }, decide: 'allow_audit',
    title: ['내부·베타 배포는 기록만', 'Internal and beta releases are recorded'], explain: ['내부 사용자나 베타 그룹에만 배포하면 기록만 남깁니다.', 'A release to internal users or a beta group is only recorded.'], sources: [SOURCES.inhouse] },
  { id: 'release-friday-public', category: 'quality', scope: { action: ['release.deploy'] },
    when: { and: [{ '==': [{ var: 'audience' }, 'public'] }, { '==': [{ var: 'weekday' }, 5] }, { '>=': [{ var: 'hour' }, 15] }] },
    decide: 'require_approval', approver: { role: '릴리스 책임자' },
    title: ['금요일 오후 공개 출시는 릴리스 책임자 승인', 'Friday-afternoon public releases need the release manager'],
    explain: ['주말 대응 인력이 적으니 금요일 15시 이후 공개 출시는 승인 후에.', 'Fewer people on call over the weekend: after 15:00 on Friday a public release is approved first.'], sources: [SOURCES.inhouse] },

  // ── 데이터
  { id: 'data-export-pii', category: 'privacy', scope: { action: ['data.export'] },
    when: { and: [{ var: 'destination_external' }, { '>': [{ var: 'pii_rows' }, 0] }] }, decide: 'require_approval', approver: { role: '개인정보 책임자' },
    title: ['개인정보가 든 데이터 외부 반출은 승인 후', 'Exporting personal data outside needs approval'], explain: ['개인정보가 포함된 데이터를 외부로 내보내려면 승인합니다.', 'Data with personal records leaving the company is approved first.'], sources: [SOURCES.pipa17] },
  { id: 'data-delete-bulk', category: 'security', scope: { action: ['data.delete'] },
    when: { '>': [{ var: 'count' }, 100] }, decide: 'require_approval', approver: { role: '팀장' },
    title: ['100건 넘는 삭제는 승인 후', 'Deleting over 100 records needs approval'], explain: ['한 번에 100건 넘게 지우는 일은 되돌리기 어려워 승인합니다.', 'Deleting over 100 records at once is hard to undo: it is approved first.'], sources: [SOURCES.inhouse] },

  // ── 팀원 맥락 참고 (팀 맥락 공유: 참고 요청의 결정). 주인의 자동 허용 규칙은 이 정책들 안에서만 쓰인다.
  { id: 'context-sensitive-owner', category: 'privacy', scope: { action: ['context.access'] },
    when: { var: 'sensitive' }, decide: 'require_approval', approver: { role: '맥락 주인', owner: true },
    title: ['민감 맥락은 주인이 직접 허락', 'Sensitive contexts wait for their owner'],
    explain: ['민감 표시가 된 맥락은 주인의 자동 허용 규칙과 관계없이, 주인이 홈 카드에서 직접 허락해야 참고됩니다.', 'A context marked sensitive is referenced only when its owner allows it on the home card, whatever the owner\'s automatic rules say.'],
    sources: [SOURCES.pipa23, SOURCES.inhouse] },
  { id: 'context-sensitive-topic', category: 'privacy', scope: { action: ['context.access'] },
    when: { and: [{ '!': { var: 'sensitive' } }, { '!!': { var: 'topic' } }] }, decide: 'require_approval', approver: { role: '맥락 주인', owner: true },
    topics: SENSITIVE_TOPICS,
    title: ['민감할 수 있는 주제는 자동 허용하지 않음', 'Possibly sensitive topics are never allowed automatically'],
    explain: ['모델이 제목·목적·요약을 읽어 인사·급여·건강·징계·개인정보처럼 민감한 내용이라고 판단하거나 주민번호 형식이 보이면, 주인이 민감 표시를 하기 전이라도 자동으로 허락하지 않고 주인에게 묻습니다. 맥락 요약을 만들 때도 같은 판별로 민감 표시를 제안합니다. 모델이 답하지 못할 때는 이 주제 목록의 낱말과 계좌·전화 형식으로 판단하고, 모델이 잠시 끊긴 동안의 요청은 언제나 주인에게 묻습니다.',
      'When the model reads a context\'s title, purpose and summary as sensitive (HR, pay, health, discipline, personal data), or a resident number shows, requests go to the owner even before the owner marks it; the same reading proposes a sensitive mark when the context summary is built. If the model cannot answer, these topics\' words and account or phone numbers decide, and while the model is briefly down every request goes to the owner.'],
    sources: [SOURCES.pipa23, SOURCES.inhouse] },
  { id: 'context-access-record', category: 'audit', scope: { action: ['context.access'] }, decide: 'allow_audit',
    title: ['팀원 맥락 참고는 기록', 'Using a teammate\'s context is recorded'],
    explain: ['자동 허용을 포함한 모든 참고 허락·거절·회수를 결정 원장에 남깁니다. 주인은 언제든 회수할 수 있습니다.', 'Every allow, refusal and revocation, automatic ones included, goes into the ledger; the owner can revoke at any time.'],
    sources: [SOURCES.inhouse, SOURCES.nistGovern] },
]
