// 받은 파일이 무엇인지 앞 바이트로 — 이름이 아무것도 말하지 않는 다운로드(NotebookLM 오디오 개요가 「download」로 온 2026-11-22 녹화)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import { sniffExt, nameByContent } from '../lib/fileSniff.js'

const b = (...parts) => Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))))
// 운영에서 받은 파일의 첫 24바이트(ftyp 상자, 브랜드 M4A)
const M4A = b([0, 0, 0, 0x18], 'ftypM4A ', [0, 0, 0, 0], 'isommp42', [0, 0, 0x41, 0x19], 'uuid')
const zipWith = async (part) => { const z = new JSZip(); z.file(part, '<x/>'); return z.generateAsync({ type: 'nodebuffer' }) }

test('소리 · 영상: M4A · MP4 · MOV · MP3(ID3·프레임) · AAC · WAV · OGG · FLAC · WebM', async () => {
  assert.equal(await sniffExt(M4A), 'm4a')
  assert.equal(await sniffExt(b([0, 0, 0, 0x20], 'ftypisom', [0, 0, 2, 0], 'isomiso2avc1mp41')), 'mp4')
  assert.equal(await sniffExt(b([0, 0, 0, 0x14], 'ftypqt  ', [0, 0, 2, 0])), 'mov')
  assert.equal(await sniffExt(b('ID3', [4, 0, 0, 0, 0, 0, 0])), 'mp3')
  assert.equal(await sniffExt(b([0xff, 0xfb, 0x90, 0x64, 0, 0])), 'mp3')
  assert.equal(await sniffExt(b([0xff, 0xf1, 0x50, 0x80, 0, 0])), 'aac')
  assert.equal(await sniffExt(b('RIFF', [0, 0, 0, 0], 'WAVEfmt ')), 'wav')
  assert.equal(await sniffExt(b('OggS', [0, 2])), 'ogg')
  assert.equal(await sniffExt(b('fLaC', [0, 0, 0, 0x22])), 'flac')
  assert.equal(await sniffExt(b([0x1a, 0x45, 0xdf, 0xa3, 0x9f])), 'webm')
})

test('문서 · 그림: PDF · PPTX · DOCX · XLSX · HWPX · 그냥 zip · PNG · JPEG · GIF · WebP', async () => {
  assert.equal(await sniffExt(b('%PDF-1.7\n')), 'pdf')
  assert.equal(await sniffExt(await zipWith('ppt/presentation.xml')), 'pptx')
  assert.equal(await sniffExt(await zipWith('word/document.xml')), 'docx')
  assert.equal(await sniffExt(await zipWith('xl/workbook.xml')), 'xlsx')
  assert.equal(await sniffExt(await zipWith('Contents/content.hpf')), 'hwpx')
  assert.equal(await sniffExt(await zipWith('readme.txt')), 'zip')
  assert.equal(await sniffExt(b([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])), 'png')
  assert.equal(await sniffExt(b([0xff, 0xd8, 0xff, 0xe0])), 'jpg')
  assert.equal(await sniffExt(b('GIF89a')), 'gif')
  assert.equal(await sniffExt(b('RIFF', [0, 0, 0, 0], 'WEBPVP8 ')), 'webp')
})

test('모르는 내용 · 빈 파일은 null, 열리지 않는 zip 은 그냥 zip', async () => {
  assert.equal(await sniffExt(b('hello, plain text')), null)
  assert.equal(await sniffExt(Buffer.alloc(0)), null)
  assert.equal(await sniffExt(b([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])), 'zip')
})

test('이름: 확장자가 없거나 모르는 것이면 내용의 확장자를 붙이고, 아는 확장자 · 알 수 없는 내용은 그대로', async () => {
  const known = (ext) => ['mp3', 'm4a', 'pdf', 'pptx', 'csv'].includes(ext)
  assert.equal(await nameByContent('download', M4A, known), 'download.m4a')
  assert.equal(await nameByContent('audio.bin', M4A, known), 'audio.bin.m4a')
  // 사이트가 붙인 아는 확장자는 믿는다(내용과 달라도 고치지 않는다)
  assert.equal(await nameByContent('팟캐스트.mp3', M4A, known), '팟캐스트.mp3')
  assert.equal(await nameByContent('표.csv', b('a,b\n1,2\n'), known), '표.csv')
  // 모르는 확장자라도 내용과 같으면 그대로, 내용을 모르면 그대로
  assert.equal(await nameByContent('보고서.hwpx', await zipWith('Contents/content.hpf'), known), '보고서.hwpx')
  assert.equal(await nameByContent('notes', b('just text'), known), 'notes')
})
