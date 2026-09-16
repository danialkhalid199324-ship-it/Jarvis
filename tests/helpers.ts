import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AIProvider, CompletionRequest, CompletionResponse } from '../src/core/ai/provider'

export async function makeTempDir(name: string): Promise<string> {
  const dir = path.join(os.tmpdir(), `jarvis-test-${name}-${process.pid}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

export async function cleanup(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true })
}

/** Minimal uncompressed PDF so parser tests need no binary fixtures in git. */
export function makePdfBuffer(lines: string[]): Buffer {
  const content =
    `BT /F1 12 Tf 72 720 Td 14 TL\n` +
    lines.map((l) => `(${l.replace(/([()\\])/g, '\\$1')}) Tj T*`).join('\n') +
    `\nET`
  const objs = [
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`,
    `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`,
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`,
    `4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`,
    `5 0 obj\n<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream\nendobj\n`
  ]
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  for (const o of objs) {
    offsets.push(pdf.length)
    pdf += o
  }
  const xref = pdf.length
  pdf +=
    `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return Buffer.from(pdf, 'latin1')
}

/** Scripted provider so assistant behaviour is tested without network calls. */
export class FakeProvider implements AIProvider {
  readonly id = 'fake'
  readonly label = 'Fake Provider'
  readonly local = true
  readonly requiresApiKey = false
  readonly dataNotice = 'Test provider. Nothing leaves the machine.'
  readonly models = [{ id: 'fake-model', label: 'Fake' }]

  readonly calls: Array<{ request: CompletionRequest; model: string }> = []
  private readonly responder: (request: CompletionRequest) => string

  constructor(responder: (request: CompletionRequest) => string) {
    this.responder = responder
  }

  isConfigured(): boolean {
    return true
  }

  async complete(request: CompletionRequest, model: string): Promise<CompletionResponse> {
    this.calls.push({ request, model })
    return { text: this.responder(request), model }
  }
}

/** Build a minimal but valid .docx so DOCX indexing is covered end to end. */
export async function writeDocx(file: string, paragraphs: string[]): Promise<void> {
  const JSZip = (await import('jszip')).default
  const zip = new JSZip()

  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
  )
  zip.folder('_rels')!.file(
    '.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
  )
  const escape = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${escape(p)}</w:t></w:r></w:p>`).join('')
  zip.folder('word')!.file(
    'document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`
  )

  const buffer = await zip.generateAsync({ type: 'nodebuffer' })
  const fsp = await import('node:fs/promises')
  await fsp.writeFile(file, buffer)
}

/** Build a real .xlsx workbook for spreadsheet coverage. */
export async function writeXlsx(
  file: string,
  sheetName: string,
  rows: Array<Array<string | number>>
): Promise<void> {
  const ExcelJS = (await import('exceljs')).default
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet(sheetName)
  for (const row of rows) sheet.addRow(row)
  await workbook.xlsx.writeFile(file)
}
