import fs from 'node:fs/promises'
import type { DocumentParser, ParsedDocument, TextSegment } from './types'
import type { SupportedFileType } from '../../shared/types'

type PdfJsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs')

let pdfjsPromise: Promise<PdfJsModule> | null = null
let assetPaths: { standardFontDataUrl?: string; cMapUrl?: string } | null = null

/**
 * Locate pdf.js's bundled font and character-map data on disk.
 *
 * Without these, PDFs using standard or CJK fonts extract with missing
 * characters. They ship inside `pdfjs-dist`, and `pdfjs-dist` is unpacked from
 * the app archive at build time (see `asarUnpack` in electron-builder.yml) so
 * these paths are real files at runtime.
 */
function resolveAssetPaths(): { standardFontDataUrl?: string; cMapUrl?: string } {
  if (assetPaths) return assetPaths
  assetPaths = {}
  try {
    const pkg = require.resolve('pdfjs-dist/package.json')
    const root = pkg.slice(0, pkg.length - '/package.json'.length)
    assetPaths = {
      standardFontDataUrl: `${root}/standard_fonts/`,
      cMapUrl: `${root}/cmaps/`
    }
  } catch {
    // Fall back to pdf.js's defaults; extraction still works for most files.
  }
  return assetPaths
}

/**
 * pdfjs-dist ships as ESM only, so it is loaded on demand rather than at
 * module scope. Doing it lazily also keeps Jarvis's cold start fast for users
 * whose folders contain no PDFs.
 */
async function loadPdfJs(): Promise<PdfJsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs')
  }
  return pdfjsPromise
}

/**
 * Reconstructs the reading order of a PDF page from pdf.js text items, using
 * the `hasEOL` marker and the y-coordinate to decide where lines break.
 */
function itemsToText(items: Array<{ str?: string; hasEOL?: boolean; transform?: number[] }>): string {
  let out = ''
  let lastY: number | null = null
  for (const item of items) {
    const str = item.str ?? ''
    const y = item.transform?.[5] ?? null
    if (lastY !== null && y !== null && Math.abs(y - lastY) > 1 && !out.endsWith('\n')) {
      out += '\n'
    }
    out += str
    if (item.hasEOL) out += '\n'
    lastY = y
  }
  return out
}

export class PdfParser implements DocumentParser {
  readonly fileType: SupportedFileType = 'pdf'

  async parse(filePath: string): Promise<ParsedDocument> {
    const pdfjs = await loadPdfJs()
    const bytes = new Uint8Array(await fs.readFile(filePath))

    const assets = resolveAssetPaths()

    const loadingTask = pdfjs.getDocument({
      data: bytes,
      ...(assets.standardFontDataUrl ? { standardFontDataUrl: assets.standardFontDataUrl } : {}),
      ...(assets.cMapUrl ? { cMapUrl: assets.cMapUrl, cMapPacked: true } : {}),
      // Jarvis extracts text only. Disabling external font and URL fetching
      // keeps parsing offline and side-effect free.
      useSystemFonts: false,
      useWorkerFetch: false,
      disableFontFace: true
    })
    const doc = await loadingTask.promise

    try {
      const segments: TextSegment[] = []
      let charCount = 0
      for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
        const page = await doc.getPage(pageNo)
        try {
          const content = await page.getTextContent()
          const text = itemsToText(content.items as never[])
            .replace(/[ \t]+/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim()
          if (text) {
            segments.push({ text, locator: `page ${pageNo}` })
            charCount += text.length
          }
        } finally {
          page.cleanup()
        }
      }

      if (segments.length === 0) {
        return {
          segments: [],
          charCount: 0,
          warning:
            'No text layer found. This looks like a scanned PDF — Jarvis can list it but cannot read its contents yet.'
        }
      }
      return { segments, charCount }
    } finally {
      await loadingTask.destroy()
    }
  }
}
