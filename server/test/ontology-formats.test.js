// 이 일이 쓰는 양식 · 형식 규칙(lib/ontology/formats.js) · 도구 없이 양식 채우기 · 글을 워드로(lib/ontology/docfill.js). 모델 · DB 없이.
import test from 'node:test'
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import { repeatedSentences, commonPattern, candidatesOf, resolveChosen, checkFormat, judgedItems, maskText, customersOf, docFacts, skillText, hfText } from '../lib/ontology/formats.js'
import { setParagraphText, cloneParagraph, editsOf, applyEdits, docParagraphs, textDocx, markdownBody, pickParagraphs, sourceCaseStrings, leftoversOf, leftoverCheck, modelCaseStrings, fillDocument } from '../lib/ontology/docfill.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { outputFormat } from '../lib/ontology/stepdoc.js'
import { defaultRules } from '../lib/ontology/discovery.js'

const R = defaultRules().formats

test('되풀이되는 문장: 파일의 share 이상(그리고 minFiles 개 이상)에 있는 문장만 — 칸 이름 · 짧은 말 · 한 파일의 말은 빠진다', () => {
  const a = ['견적서', '본 견적은 발행일로부터 30일간 유효합니다.', '고객: 달빛커피', '문의: 영업팀 02-000-0000']
  const b = ['견적서', '본 견적은 발행일로부터 30일간 유효합니다.', '고객: 한빛치과', '문의: 영업팀 02-000-0000']
  const c = ['견적서', '고객: 소나무약국', '이 건만의 특별 할인 조건을 적용했습니다.']
  const got = repeatedSentences([a, b, c], { share: 0.6, minFiles: 2, minChars: 8, maxChars: 240 })
  assert.deepEqual(got.map((x) => x.text), ['본 견적은 발행일로부터 30일간 유효합니다.', '문의: 영업팀 02-000-0000'])
  assert.equal(got[0].files, 2)
  // 셋 모두에 있어야 하면(share 1) 아무것도 남지 않는다 — 「견적서」는 문장이 아니라 빠진다
  assert.deepEqual(repeatedSentences([a, b, c], { share: 1, minFiles: 2, minChars: 8 }), [])
  // 파일이 하나뿐이면 견줄 수 없다
  assert.deepEqual(repeatedSentences([a], { share: 0.6, minFiles: 2, minChars: 8 }), [])
})

test('같은 자리의 글: 파일마다 다른 부분은 「…」, 같은 부분은 고정 글', () => {
  const p = commonPattern(['경남대학교 피지컬 AI PBL | 고모텍 물류 최적화 과제 정의서', '경남대학교 피지컬 AI PBL | 디케이 RPA 과제 정의서'])
  assert.equal(p.pattern, '경남대학교 피지컬 AI PBL | … 과제 정의서')
  assert.deepEqual(p.fixed, ['경남대학교 피지컬 AI PBL |', '과제 정의서'])
  // 파일 이름은 _ 로 나눈다: 연차계산_박용주_20260112 · 연차계산_오순영_20260101
  const n = commonPattern(['연차계산_박용주_20260112', '연차계산_오순영_20260101'], '_')
  assert.equal(n.pattern, '연차계산_…')
  assert.deepEqual(n.fixed, ['연차계산'])
  // 한 글자도 같지 않으면 고정 글이 없다
  assert.deepEqual(commonPattern(['가나', '다라']).fixed, [])
})

const facts = (o) => ({ kind: 'docx', name: 'x.docx', header: [], footer: [], body: [], slides: [], master: [], images: [], ...o })

test('후보(규칙만): 파일 둘 — 같은 머리글 그림 · 머리글의 같은 부분 · 되풀이 문장 · 제목 · 파일 이름', () => {
  const A = facts({ name: '고모텍 PBL 과제 정의서.docx', header: ['경남대학교 PBL | 고모텍 과제 정의서'], footer: ['작성일: ____ | 더웨이'], images: [{ where: 'header', hash: 'logo1', size: 4096, media: 'image1.png' }, { where: 'body', hash: 'chart', size: 900, media: 'image2.png' }],
    body: ['고모텍 물류 최적화 PBL', '이 문서는 학생들이 직접 작성하는 제출 양식입니다.', '고모텍의 창고 동선을 다룹니다.'] })
  const B = facts({ name: '디케이 PBL 과제 정의서.docx', header: ['경남대학교 PBL | 디케이 과제 정의서'], footer: ['작성일: ____ | 더웨이'], images: [{ where: 'header', hash: 'logo1', size: 4096, media: 'image1.png' }],
    body: ['디케이 RPA PBL', '이 문서는 학생들이 직접 작성하는 제출 양식입니다.', '디케이의 엑셀 수작업을 다룹니다.'] })
  const c = candidatesOf([A, B], { fileNames: ['고모텍 PBL 과제 정의서.docx', '디케이 PBL 과제 정의서.docx'], form: 'PBL 과제 정의서.docx' }, R)
  const by = (k) => c.filter((x) => x.kind === k)
  assert.equal(by('image').length, 1, '두 파일에 같은 머리글 그림 하나(본문의 그림은 한 파일에만)')
  assert.equal(by('image')[0].hash, 'logo1')
  assert.equal(by('header')[0].text, '경남대학교 PBL | … 과제 정의서')
  assert.equal(by('footer')[0].text, '작성일: ____ | 더웨이')
  assert.deepEqual(by('phrase').map((x) => x.text), ['이 문서는 학생들이 직접 작성하는 제출 양식입니다.'])
  assert.equal(by('title')[0].text, '… PBL')
  // (파일 이름은 _ · 빈칸으로 나눠 견준다 — 점검은 띄어쓰기 · _ 를 보지 않는다)
  assert.deepEqual(by('filename')[0].fixed, ['PBL_과제_정의서'])
  assert.equal(by('filename')[0].text, '…_PBL_과제_정의서.docx')
  assert.ok(c.every((x, i) => x.id === `c${i + 1}` && x.of === 2))
})

test('후보(규칙만): 엑셀은 되풀이되는 짧은 칸(칸 이름 · 고르기 목록)이 아니라 문장 · 회사 정보만', () => {
  const sheet = (who) => facts({ kind: 'xlsx', name: `${who}_견적서.xlsx`, body: ['견적총금액 [원/VAT별도]', '2. 서비스 지원시간', who, '본 견적은 발행일로부터 30일간 유효하며 부가세는 별도입니다.', '문의: help@uengine.org'] })
  const c = candidatesOf([sheet('LGD'), sheet('SKT')], { fileNames: ['LGD_견적서.xlsx', 'SKT_견적서.xlsx'], form: '견적서.xlsx' }, R)
  assert.deepEqual(c.filter((x) => x.kind === 'phrase').map((x) => x.text), ['본 견적은 발행일로부터 30일간 유효하며 부가세는 별도입니다.', '문의: help@uengine.org'])
})

test('후보(규칙만): 파일 하나 — 머리글 · 바닥글 줄, 첫 · 끝 문단의 회사 정보 같은 줄만(본문 문장은 아니다)', () => {
  const A = facts({ name: '제안서_클라우드아이크_20261019.docx', images: [{ where: 'first-page', hash: 'logo', size: 2048, media: 'image1.png' }, { where: 'body', hash: 'pic', size: 999, media: 'image2.png' }],
    body: ['클라우드아이크 귀중 — Process GPT 도입 제안', '1. 고객 현황과 니즈', '고객사의 요청을 정리했어요.', '6. 문의', '유엔진솔루션즈 전화: 02-567-8301', '이메일: help@uengine.org 본사: 서울 서초구'] })
  const c = candidatesOf([A], { fileNames: ['제안서_클라우드아이크_20261019.docx'], form: '제안서.docx' }, R)
  assert.deepEqual(c.filter((x) => x.kind === 'image').map((x) => x.hash), ['logo'], '한 파일이면 첫 쪽 · 머리글의 그림만')
  const phrases = c.filter((x) => x.kind === 'phrase').map((x) => x.text)
  assert.ok(phrases.includes('유엔진솔루션즈 전화: 02-567-8301'))
  assert.ok(phrases.includes('클라우드아이크 귀중 — Process GPT 도입 제안'), '「귀중」은 회사 문서의 고정 꼴')
  assert.ok(!phrases.includes('고객사의 요청을 정리했어요.'))
  assert.equal(c.find((x) => x.kind === 'filename').fixed[0], '제안서')
})

test('모델 답은 받은 후보에만: 지어낸 id 는 버리고, keep:false 는 빼고, 파일 하나면 본문 문장은 꼭 지킬 것이 아니다', () => {
  const cands = [{ id: 'c1', kind: 'image', where: 'header', text: '그림', files: 1, of: 1 }, { id: 'c2', kind: 'phrase', where: 'last-page', text: '문의: 02-000', files: 1, of: 1 }, { id: 'c3', kind: 'header', where: 'header', text: '고모텍 과제', files: 1, of: 1 }]
  const ans = { items: [{ id: 'c1', keep: true, name: '회사 로고', mandatory: true, why: '머리글 그림' }, { id: 'c2', keep: true, name: '문의처', mandatory: true }, { id: 'c3', keep: false }, { id: 'c9', keep: true, name: '지어낸 것', mandatory: true }] }
  const items = judgedItems(cands, ans, { lowConfidence: true })
  assert.deepEqual(items.map((x) => x.id), ['c1', 'c2'])
  assert.equal(items[0].name, '회사 로고'); assert.equal(items[0].mandatory, true)
  assert.equal(items[1].mandatory, false, '파일 하나: 본문 문장은 꼭 지킬 것으로 두지 않는다')
  // 모델이 답하지 못하면 규칙 기본값(틀의 것만 꼭)
  const fb = judgedItems(cands, null, { lowConfidence: true })
  assert.deepEqual(fb.map((x) => [x.id, x.mandatory, x.by]), [['c1', true, 'rule'], ['c2', false, 'rule'], ['c3', true, 'rule']])
})

test('모델에 가는 글: 사람 이름 · 고객 이름 · 연락처는 가린다', () => {
  const customers = customersOf(['LGD_26년MA견적서_유엔진솔루션즈.xlsx', 'LGD_27년MA견적서_업체명변경.xlsx'], '유지보수 견적서.xlsx')
  assert.ok(customers.includes('유엔진솔루션즈') || customers.includes('업체명변경'))
  const t = maskText('유지보수 영업대표 정석진 전무 · 010-1234-5678 · kim@example.com · 고객 달빛커피', { customers: ['달빛커피'], people: R.people })
  assert.ok(!/정석진/.test(t) && !/010-1234/.test(t) && !/kim@example/.test(t) && !/달빛커피/.test(t), t)
  assert.ok(/○○○ 전무/.test(t) && /\(고객\)/.test(t))
})

test('이 일이 쓰는 양식: 관리자가 고른 것 → 일 정의의 양식 → 가장 많이 쓴 양식(자동), 파일 없는 양식은 실행에 못 쓴다', () => {
  const forms = [{ name: '견적서.xlsx', file: 'forms/a.xlsx' }, { name: '제안서.docx', file: null }, { name: '회의록.docx', file: 'forms/b.docx' }]
  assert.deepEqual(resolveChosen({ forms }).chosenBy, 'auto')
  assert.equal(resolveChosen({ forms }).form.name, '견적서.xlsx')
  assert.equal(resolveChosen({ forms, definitionTemplate: '회의록.docx' }).chosenBy, 'definition')
  assert.equal(resolveChosen({ forms, definitionTemplate: '회의록.docx', choice: { form: '견적서.xlsx' } }).chosenBy, 'person')
  const noFile = resolveChosen({ forms, choice: { form: '제안서.docx' } })
  assert.equal(noFile.chosenBy, 'auto'); assert.deepEqual(noFile.wanted, { name: '제안서.docx', chosenBy: 'person', why: 'no-file' })
  // 다른 일의 양식을 골랐으면 그것
  const other = resolveChosen({ forms, choice: { form: '강의계획서.docx', of_task: '강의 준비' }, picked: { name: '강의계획서.docx', file: 'forms/c.docx' } })
  assert.equal(other.chosenBy, 'person'); assert.equal(other.form.name, '강의계획서.docx'); assert.equal(other.ofTask, '강의 준비')
  assert.deepEqual(resolveChosen({ forms: [{ name: 'x.docx', file: null }] }), { form: null, chosenBy: null })
})

test('형식 규칙 점검(글): 꼭 지킬 것만 — 자리의 글 · 고정 부분 · 양식의 그림 · 파일 이름', () => {
  const items = [
    { id: 'c1', kind: 'image', where: 'header', name: '회사 로고', hash: 'logo1', mandatory: true },
    { id: 'c2', kind: 'header', where: 'header', name: '머리글', text: '경남대 PBL | … 과제 정의서', fixed: ['경남대 PBL |', '과제 정의서'], mandatory: true },
    { id: 'c3', kind: 'phrase', where: 'last-page', name: '문의처', text: '문의: 02-000-0000', mandatory: true },
    { id: 'c4', kind: 'phrase', where: 'body', name: '안내', text: '있으면 좋은 글', mandatory: false },
    { id: 'c5', kind: 'filename', where: 'name', name: '파일 이름', text: '… 과제 정의서.docx', fixed: ['과제 정의서'], mandatory: true },
  ]
  const ok = checkFormat(items, facts({ header: ['경남대 PBL | 한빛 과제 정의서'], body: ['본문', '문의 : 02-000-0000'], images: [{ where: 'header', hash: 'logo1' }] }), '한빛 과제 정의서.docx')
  assert.deepEqual(ok.map((x) => [x.id, x.ok]), [['c1', true], ['c2', true], ['c3', true], ['c5', true]])
  const bad = checkFormat(items, facts({ header: ['한빛 과제'], body: ['본문'], images: [{ where: 'header', hash: 'other' }] }), '한빛.docx')
  assert.deepEqual(bad.map((x) => [x.id, x.ok]), [['c1', false], ['c2', false], ['c3', false], ['c5', false]])
  assert.match(bad[0].note, /달라요/)
  assert.match(bad[1].note, /경남대 PBL/)
})

test('형식 규칙 스킬 글: 꼭 지킬 것 · 있으면 좋은 것, 파일 하나면 낮은 확신이라고', () => {
  const md = skillText({ task: '진행현황 공유', form: 'PBL 과제 정의서.docx', type: 'docx', items: [{ name: '회사 로고', kind: 'image', where: 'header', text: '그림 image1.png · 4KB', mandatory: true, files: 1, of: 1 }, { name: '안내문', kind: 'phrase', where: 'body', text: '이 문서는 제출 양식입니다.', mandatory: false }], source: { n: 1, files: [{ name: '고모텍.docx' }], lowConfidence: true } })
  assert.match(md, /^---\nname: format-진행현황-공유-pbl-과제-정의서\n/)
  assert.match(md, /kind: format/)
  assert.match(md, /## 꼭 지킬 것\n1\. 회사 로고 — 머리글에 양식의 그림/)
  assert.match(md, /## 있으면 좋은 것\n- 안내문 — 본문에 「이 문서는 제출 양식입니다\.」/)
  assert.match(md, /파일 하나에서 찾았어요\(낮은 확신\)/)
})

test('엑셀 머리글 · 바닥글 코드는 글로', () => {
  assert.equal(hfText('&L&"맑은 고딕"&10 (주)유엔진솔루션즈&C&P / &N'), '(주)유엔진솔루션즈 | [쪽] / [전체 쪽]')
})

test('도구 없이 문단 채우기: 첫 글 조각이 글을 받고 나머지는 비운다, 더한 문단은 그림 없이 같은 모양, 형식 규칙의 글이 든 문단은 그대로', () => {
  const p = '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>고모텍</w:t></w:r><w:r><w:drawing>PIC</w:drawing></w:r><w:r><w:t xml:space="preserve"> 물류</w:t></w:r></w:p>'
  const s = setParagraphText(p, 'w', '한빛 & 강의')
  assert.match(s, /<w:b\/><\/w:rPr><w:t xml:space="preserve">한빛 &amp; 강의<\/w:t>/)
  assert.match(s, /<w:drawing>PIC<\/w:drawing>/)
  assert.match(s, /<w:t xml:space="preserve"><\/w:t>/)
  assert.doesNotMatch(cloneParagraph(p, 'w', '더한 줄'), /drawing/)
  // 글 조각이 없는 빈 칸에는 하나를 넣는다
  assert.equal(setParagraphText('<w:p><w:pPr/></w:p>', 'w', '값'), '<w:p><w:pPr/><w:r><w:t xml:space="preserve">값</w:t></w:r></w:p>')
  assert.equal(setParagraphText('<w:p/>', 'w', '값'), '<w:p><w:r><w:t xml:space="preserve">값</w:t></w:r></w:p>')
  const list = [{ i: 0, text: '문의: 영업팀 02-000-0000' }, { i: 1, text: '고객: 달빛커피' }, { i: 2, text: '1회차' }]
  const { edits, kept } = editsOf({ paragraphs: [{ i: 0, text: '문의: 바꾼 번호' }, { i: 1, text: '고객: 한빛치과' }, { i: 2, text: '1회차 개요\n2회차 실습', add: ['3회차 발표'] }, { i: 7, text: '없는 문단' }] }, list, ['문의: 영업팀 02-000-0000'])
  assert.deepEqual([...edits.keys()], [1, 2])
  assert.deepEqual(kept, [0])
  assert.deepEqual(edits.get(2), { text: '1회차 개요', add: ['2회차 실습', '3회차 발표'] })
  const xml = `<w:body>${['<w:p><w:r><w:t>문의</w:t></w:r></w:p>', '<w:p><w:r><w:t>고객: 달빛커피</w:t></w:r></w:p>', '<w:p><w:r><w:t>1회차</w:t></w:r></w:p>'].join('')}</w:body>`
  const paras = [...xml.matchAll(/<w:p>[\s\S]*?<\/w:p>/g)].map((m, i) => ({ i, start: m.index, end: m.index + m[0].length, xml: m[0] }))
  const out = applyEdits(xml, paras, edits, 'w')
  assert.equal(out, '<w:body><w:p><w:r><w:t>문의</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">고객: 한빛치과</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">1회차 개요</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">2회차 실습</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">3회차 발표</w:t></w:r></w:p></w:body>')
})

async function sampleDocx() {
  const zip = new JSZip()
  zip.file('word/document.xml', '<w:document><w:body><w:p><w:r><w:t>제목</w:t></w:r></w:p><w:p><w:r><w:drawing><a:blip r:embed="rId9"/></w:drawing></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>팀명</w:t></w:r></w:p></w:tc><w:tc><w:p/></w:tc></w:tr></w:tbl></w:body></w:document>')
  zip.file('word/_rels/document.xml.rels', '<Relationships><Relationship Id="rId9" Type="image" Target="media/image2.png"/></Relationships>')
  zip.file('word/header1.xml', '<w:hdr><w:p><w:r><w:drawing><a:blip r:embed="rId1"/></w:drawing></w:r><w:r><w:t>회사 머리글</w:t></w:r></w:p></w:hdr>')
  zip.file('word/_rels/header1.xml.rels', '<Relationships><Relationship Id="rId1" Type="image" Target="media/image1.png"/></Relationships>')
  zip.file('word/footer1.xml', '<w:ftr><w:p><w:r><w:t>문의 02-000</w:t></w:r></w:p></w:ftr>')
  zip.file('word/media/image1.png', Buffer.from('LOGO'))
  zip.file('word/media/image2.png', Buffer.from('COVER'))
  return zip.generateAsync({ type: 'nodebuffer' })
}

test('워드 파일에서 형식의 재료: 머리글 · 바닥글 글, 머리글 그림과 첫 쪽 그림(해시), 본문 문단 · 빈 표 칸은 채울 문단으로', async () => {
  const buf = await sampleDocx()
  const f = await docFacts('a.docx', buf)
  assert.deepEqual(f.header, ['회사 머리글'])
  assert.deepEqual(f.footer, ['문의 02-000'])
  assert.deepEqual(f.body, ['제목', '팀명'])
  assert.deepEqual(f.images.map((x) => x.where).sort(), ['first-page', 'header'])
  assert.equal(new Set(f.images.map((x) => x.hash)).size, 2)
  const { list } = await docParagraphs(buf, 'docx')
  assert.deepEqual(list.map((x) => [x.part, x.text, !!x.cell]), [['body', '제목', false], ['body', '팀명', true], ['body', '', true], ['header', '회사 머리글', false], ['footer', '문의 02-000', false]])
})

test('글 → 워드: 제목 · 머리말 · 목록 · 표가 문단으로, 다시 읽으면 같은 글', async () => {
  const md = '# 강의계획서\n\n## 1. 개요\n- 대상: 3학년 40명\n- 시간: 3시간\n\n| 회차 | 내용 |\n|---|---|\n| 1 | **생성형 AI** 이해 |\n| 2 | 실습 |\n\n끝.'
  assert.match(markdownBody(md), /<w:tbl>/)
  const buf = await textDocx({ title: '강의계획서', text: md })
  const f = await docFacts('plan.docx', buf)
  assert.deepEqual(f.body, ['강의계획서', '1. 개요', '• 대상: 3학년 40명', '• 시간: 3시간', '회차', '내용', '1', '생성형 AI 이해', '2', '실습', '끝.'])
})

test('단계가 내놓는 문서 형식: 일 정의의 outputs 에서', () => {
  assert.equal(outputFormat({ outputs: [{ name: '강의계획서', format: 'DOCX' }] }), 'docx')
  assert.equal(outputFormat({ outputs: [{ name: '회신', format: 'mail' }] }), '')
  assert.equal(outputFormat({}), '')
})

// ---------- 앞 건의 값: 양식 파일에 남아 온 지난 건의 이름 · 날짜 ----------
const W = (t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`
const row = (cells) => `<w:tr>${cells.map((c) => `<w:tc>${c ? W(c) : '<w:p/>'}</w:tc>`).join('')}</w:tr>`
// a form file as the last case sent it: 고모텍's 과제 정의서, its header naming 고모텍, a long body that pushes the header past the cap
async function lastCaseDocx({ filler = 0 } = {}) {
  const zip = new JSZip()
  const body = [W('고모텍 물류 최적화 PBL'), W('팀별 과제 정의서 작성 양식 | 2026년 11월 10일 수업용'), W('이 문서는 학생들이 직접 작성하는 제출 양식입니다.'),
    `<w:tbl>${row(['팀명 / 분반', '1팀'])}${row(['팀원·학번·담당 역할', '김현석 / 강수용'])}${row(['과제명(잠정)', '물류 최적화'])}${row(['구분', '내용'])}${row(['대상 기업', '비교 시사점'])}${row(['제출일 / 버전', '26.11.10'])}</w:tbl>`,
    ...Array.from({ length: filler }, (_, k) => W(`설명 문단 ${k + 1}번입니다.`))].join('')
  zip.file('word/document.xml', `<w:document><w:body>${body}</w:body></w:document>`)
  zip.file('word/header1.xml', `<w:hdr>${W('경남대학교 피지컬 AI PBL  |  고모텍 물류 최적화 과제 정의서')}</w:hdr>`)
  zip.file('word/footer1.xml', `<w:ftr>${W('더웨이(The Way) | 문의 02-000-0000')}</w:ftr>`)
  return zip.generateAsync({ type: 'nodebuffer' })
}
const linesOf = (parts) => parts.flatMap((p) => p.paras.map((x) => ({ text: x.text, part: x.part, cell: x.cell, row: x.row, col: x.col })))

test('채울 문단: 머리글 · 바닥글과 앞 건의 값이 든 문단은 긴 본문에 밀리지 않는다(문서 순서는 그대로)', async () => {
  const { parts } = await docParagraphs(await lastCaseDocx({ filler: 40 }), 'docx', { max: 5 })
  const old = pickParagraphs(parts, { max: 5 }).map((x) => x.part)
  assert.deepEqual([...new Set(old)], ['body', 'header', 'footer'], '머리글 · 바닥글은 max 를 넘어도 들어간다')
  const list = pickParagraphs(parts, { max: 5, must: (p) => p.text.includes('설명 문단 40번') })
  assert.ok(list.some((x) => x.text === '설명 문단 40번입니다.'))
  assert.ok(list.length <= 5 + 3)
  assert.deepEqual(list.map((x) => x.i), [...list.map((x) => x.i)].sort((a, b) => a - b))
})

test('앞 건의 값(규칙): 파일 이름의 고객 부분 · 다른 파일과 같은 자리에서 다른 글 · 칸 이름 옆의 값 · 첫 문단의 날짜 — 열 이름 · 틀 · 이 건의 말은 빠진다', async () => {
  const { parts } = await docParagraphs(await lastCaseDocx(), 'docx')
  const other = facts({ header: ['경남대학교 피지컬 AI PBL | 디케이 RPA 과제 정의서'], body: ['디케이 RPA PBL', '이 문서는 학생들이 직접 작성하는 제출 양식입니다.'] })
  const got = sourceCaseStrings({ form: '과제 정의서.docx', templateName: '고모텍.docx', lines: linesOf(parts), others: [other], fileNames: ['고모텍 PBL 과제 정의서.docx', '디케이 PBL 과제 정의서.docx'], R })
  const by = Object.fromEntries(got.map((x) => [x.text, x.why]))
  assert.equal(by['고모텍'], 'name')
  assert.equal(by['고모텍 물류 최적화'], 'differs', '머리글에서 디케이 파일과 다른 부분')
  assert.equal(by['1팀'], 'label'); assert.equal(by['김현석'], 'label'); assert.equal(by['강수용'], 'label')
  assert.equal(by['물류 최적화'], 'label', '과제명 칸의 값은 낱말이어도')
  assert.equal(by['26.11.10'], 'label')
  assert.equal(by['2026년 11월 10일'], 'date')
  for (const no of ['디케이', 'PBL', '비교 시사점', '내용', '더웨이(The Way)', '이 문서는 학생들이 직접 작성하는 제출 양식입니다.']) assert.ok(!(no in by), no)
  // 이 건의 요청에 있는 글은 앞 건의 값이 아니다 · 같은 양식의 모든 파일에 있는 글도
  const same = sourceCaseStrings({ form: '과제 정의서.docx', templateName: '고모텍.docx', lines: linesOf(parts), fileNames: ['고모텍 PBL 과제 정의서.docx', '디케이 PBL 과제 정의서.docx'], caseText: '고모텍 1팀 후속 과제', R })
  assert.ok(!same.some((x) => x.text === '고모텍' || x.text === '1팀'))
  const everywhere = sourceCaseStrings({ form: '과제 정의서.docx', lines: linesOf(parts), others: [facts({ body: ['1팀 · 김현석 · 강수용 · 26.11.10'] })], R })
  assert.ok(!everywhere.some((x) => ['1팀', '김현석', '26.11.10'].includes(x.text)))
  // 「작성일: 26.11.05」 같은 한 줄 안의 칸
  const inline = sourceCaseStrings({ form: '기업분석표.docx', lines: [{ text: '기업명: 한빛정밀     팀: 2팀     작성일: 26.11.05     작성자: ____', part: 'body' }], R })
  assert.deepEqual(inline.map((x) => x.text), ['한빛정밀', '2팀', '26.11.05'])
})

test('남은 앞 건의 값: 그 글이 든 문단, 형식 규칙이 지키는 문단은 표시, 단계 결과의 못 지킨 점검 한 줄', () => {
  const parts = [{ paras: [{ i: 0, part: 'body', text: '한빛정밀 공정 개선 PBL' }, { i: 1, part: 'header', text: '경남대 PBL | 고모텍 과제 정의서' }, { i: 2, part: 'footer', text: '더웨이 · 고모텍 협력' }] }]
  const left = leftoversOf(parts, ['고모텍', '26.11.10'], ['더웨이 · 고모텍 협력'])
  assert.deepEqual(left.map((x) => [x.i, x.found, x.fixed]), [[1, ['고모텍'], false], [2, ['고모텍'], true]])
  assert.equal(leftoverCheck({ left: [] }), null)
  const c = leftoverCheck({ left: ['고모텍'], leftWhere: ['머리글'], leftFixed: false })
  assert.deepEqual([c.item, c.ok, c.kind], ['앞 건의 값', false, 'leftover'])
  assert.equal(c.note, '앞 건의 이름이 남았어요: 고모텍 — 머리글')
  assert.match(leftoverCheck({ left: ['고모텍'], leftWhere: ['바닥글'], leftFixed: true }).note, /형식 규칙의 꼭 지킬 글 안/)
  // 규칙이 못 찾으면 모델이 적은 것: 양식에 있고 · 이 건의 말이 아니고 · 형식 규칙의 글이 아닌 것만
  assert.deepEqual(modelCaseStrings(['고모텍', '없는 이름', '더웨이', '한빛정밀'], { lines: [{ text: '고모텍 과제 · 더웨이 · 한빛정밀' }], keep: ['더웨이(The Way)'], caseText: '한빛정밀 요청' }), ['고모텍'])
})

test('양식 채우기: 모델이 머리글을 두고 가면 그 문단만 한 번 더 묻고, 그래도 남으면 남았다고 — 형식 규칙의 글은 그대로', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docfill-'))
  const p = path.join(dir, '고모텍.docx')
  fs.writeFileSync(p, await lastCaseDocx({ filler: 30 }))
  const input = { form: '과제 정의서.docx', case: { subject: '한빛정밀 공정 개선 과제', body: '한빛정밀 2팀', customer: '한빛정밀' } }
  const source = { fileNames: ['고모텍 PBL 과제 정의서.docx', '디케이 PBL 과제 정의서.docx'] }
  const asked = []
  // first answer: only the body title (the header stays); asked again: it fixes what it is shown
  const fixer = async (inp) => {
    asked.push(inp)
    if (!inp.left) return { paragraphs: [{ i: inp.paragraphs.find((x) => x.text === '고모텍 물류 최적화 PBL').i, text: '한빛정밀 공정 개선 PBL' }], summary: '제목을 바꿨어요' }
    return { paragraphs: inp.paragraphs.map((x) => ({ i: x.i, text: x.text.replace(/고모텍 물류 최적화|고모텍/g, '한빛정밀 공정 개선').replace('1팀', '2팀').replace(/김현석|강수용/g, '____').replace('물류 최적화', '공정 개선').replace(/26\.11\.10|2026년 11월 10일/g, '____') })) }
  }
  const ok = await fillDocument({ template: { name: '과제 정의서.docx', path: p }, kind: 'docx', input, ask: fixer, max: 8, source, rules: R })
  assert.ok(asked[0].source_case.includes('고모텍'), '모델에 앞 건의 값을 알린다')
  assert.ok(asked[0].paragraphs.some((x) => x.part === 'header'), '머리글도 보낸다')
  assert.ok(asked[1].left.includes('고모텍') && asked[1].paragraphs.some((x) => x.part === 'header'))
  assert.deepEqual(ok.left, [])
  assert.equal(ok.retried > 0, true)
  const f = await docFacts('x.docx', ok.buf)
  assert.ok(!/고모텍/.test([...f.header, ...f.body].join('\n')), f.header.join())
  assert.equal(f.footer[0], '더웨이(The Way) | 문의 02-000-0000')
  // a model that never changes the header: what stays is reported, never passed silently
  const lazy = async (inp) => (inp.left ? { paragraphs: [] } : { paragraphs: [{ i: inp.paragraphs.find((x) => x.text === '고모텍 물류 최적화 PBL').i, text: '한빛정밀 공정 개선 PBL' }] })
  const bad = await fillDocument({ template: { name: '과제 정의서.docx', path: p }, kind: 'docx', input, ask: lazy, max: 8, source, rules: R })
  assert.ok(bad.left.includes('고모텍') && bad.leftWhere.includes('머리글'))
  assert.match(leftoverCheck(bad).note, /^앞 건의 이름이 남았어요: .*고모텍/)
  // a format rule's fixed text that holds the old name: kept as it is (not asked again) and reported
  const keepHeader = ['경남대학교 피지컬 AI PBL | 고모텍 물류 최적화 과제 정의서']
  const asked2 = []
  const kept = await fillDocument({ template: { name: '과제 정의서.docx', path: p }, kind: 'docx', input, keep: keepHeader, ask: async (inp) => { asked2.push(inp); return fixer(inp) }, max: 8, source, rules: R })
  const f2 = await docFacts('x.docx', kept.buf)
  assert.equal(f2.header[0], '경남대학교 피지컬 AI PBL | 고모텍 물류 최적화 과제 정의서', '형식 규칙의 꼭 지킬 글은 그대로')
  assert.ok(!(asked2[1]?.paragraphs || []).some((x) => x.part === 'header'), '지키는 문단은 다시 묻지 않는다')
  assert.equal(kept.leftFixed, true)
  assert.match(leftoverCheck(kept).note, /형식 규칙의 꼭 지킬 글 안/)
  fs.rmSync(dir, { recursive: true, force: true })
})
