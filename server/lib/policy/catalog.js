// The seed policy catalog: what a company starts with (Settings › 정책 turns each on or off). Sources name the
// law or framework a policy follows; "사내 규정(예시)" marks an example in-house rule, to be replaced by the
// company's own. Facts each action carries are documented next to the action kinds.
//
//   mail.send        recipients[], external (bool), external_count, pii_count, pii_kinds[], classification, attachments
//   browser.payment  amount (KRW), merchant, new_merchant (bool)
//   purchase.approve amount (KRW), supplier_new (bool), category
//   purchase.order   amount, approved (bool), speculative (bool)
//   release.deploy   audience ('public'|'internal'|'beta'), features[{name, pii}], open_findings{privacy, security}, security_scan, weekday, hour
//   data.export      rows, pii_rows, destination_external (bool)
//   data.delete      count
export const SOURCES = {
  pipa17: '개인정보보호법 제17조(개인정보의 제공)',
  pipa29: '개인정보보호법 제29조(안전조치의무)',
  euAiAct14: 'EU AI Act 제14조(사람의 감독)',
  nistGovern: 'NIST AI RMF — GOVERN·MANAGE',
  isms: 'ISMS-P 2.10(시스템 및 서비스 보안관리)',
  inhouse: '사내 규정(예시)',
}

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
    title: ['기밀 자료 외부 발송은 보안 담당 승인', 'Confidential files outside need security'], explain: ['기밀로 분류된 자료를 외부로 보내려면 보안 담당자가 승인합니다.', 'Files classified confidential go outside with the security officer\'s approval.'], sources: [SOURCES.isms] },

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
]
