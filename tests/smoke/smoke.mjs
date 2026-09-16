/**
 * End-to-end smoke test: launches the real packaged-shape Electron app and
 * drives the real UI.
 *
 * Playwright is not a project dependency, because it is large and Jarvis does
 * not need it to run. Install it only when you want to run this:
 *
 *   npm run build
 *   npm i --no-save playwright
 *   SMOKE_OUT=/tmp/jarvis-smoke node tests/smoke/smoke.mjs
 *
 * Screenshots of each screen are written to SMOKE_OUT.
 */
import { _electron as electron } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const OUT = process.env.SMOKE_OUT ?? os.tmpdir()
const archive = path.join(os.tmpdir(), 'jarvis-smoke-archive')
fs.rmSync(archive, { recursive: true, force: true })
fs.mkdirSync(path.join(archive, 'GTA'), { recursive: true })
fs.writeFileSync(
  path.join(archive, 'GTA', 'GTA Operational Plan 2026.txt'),
  'GTA Operational Plan 2026.\n\nStaffing model finalised for all sites.\nOutstanding: the annual compliance audit has not been scheduled.\nOutstanding: public liability insurance renewal is due in June.'
)
fs.writeFileSync(
  path.join(archive, 'Titan Security Roster.csv'),
  'Site,Guard,Shift\nNorth,J. Ahmed,Night\nSouth,K. Rivers,Day'
)

const userData = path.join(os.tmpdir(), 'jarvis-smoke-data')
fs.rmSync(userData, { recursive: true, force: true })
fs.mkdirSync(userData, { recursive: true })

// Seed an authorised folder the way the app itself stores one, since the native
// macOS folder picker cannot be driven headlessly. Everything after this point
// exercises the real code path.
fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify(
    {
      displayName: 'Danial',
      folders: [
        {
          id: 'smoke-folder',
          path: archive,
          label: 'Smoke Test',
          addedAt: new Date().toISOString()
        }
      ],
      ai: { activeProviderId: 'anthropic', model: 'claude-opus-5' },
      maxContextChars: 60000,
      maxFileSizeBytes: 41943040
    },
    null,
    2
  )
)

const app = await electron.launch({
  args: ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${userData}`],
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
})

const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForSelector('.brand__name', { timeout: 20000 })

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

check('branding renders', (await page.textContent('.brand__name')) === 'JARVIS')
check(
  'tagline renders',
  (await page.textContent('.brand__tagline')) === 'Your Life. Organised. Ahead.'
)
const greeting = await page.textContent('.greeting__hello')
check('personalised greeting', /^Good (morning|afternoon|evening), /.test(greeting ?? ''), greeting)
check('date and time shown', ((await page.textContent('.greeting__meta')) ?? '').length > 10)
check(
  'command area present',
  (await page.getAttribute('.command__input', 'placeholder')) === 'Ask Jarvis anything…'
)

const navLabels = await page.$$eval('.nav__item span:first-child', (els) =>
  els.map((e) => e.textContent)
)
check(
  'navigation complete',
  JSON.stringify(navLabels) ===
    JSON.stringify(['Home', 'Tasks', 'Businesses', 'Files', 'Research', 'Automations', 'Settings']),
  navLabels.join(', ')
)

check('greeting uses the configured name', (greeting ?? '').includes('Danial'), greeting)

await page.screenshot({ path: path.join(OUT, '01-home.png') })

await page.click('.nav__item:has-text("Settings")')
await page.waitForSelector('.folder__label')
check('authorised folder listed', ((await page.textContent('.folder__path')) ?? '').includes(archive))

await page.click('button:has-text("Index now")')
await page.waitForFunction(
  () => {
    const el = document.querySelector('.stat__value')
    return el && Number(el.textContent?.replace(/\D/g, '')) > 0
  },
  { timeout: 30000 }
)
const indexed = await page.textContent('.stat__value')
check('indexing completed', Number(indexed) === 2, `${indexed} files`)

await page.screenshot({ path: path.join(OUT, '02-settings.png') })

// Files page reflects real indexed state.
await page.click('.nav__item:has-text("Files")')
await page.waitForSelector('.result__name')
const fileNames = await page.$$eval('.result__name', (els) => els.map((e) => e.textContent))
check(
  'files page lists indexed documents',
  fileNames.includes('GTA Operational Plan 2026.txt') &&
    fileNames.includes('Titan Security Roster.csv'),
  fileNames.join(', ')
)
await page.screenshot({ path: path.join(OUT, '03-files.png') })

// The acceptance query, end to end through the real UI.
await page.click('.nav__item:has-text("Home")')
await page.waitForSelector('.command__input')
await page.fill('.command__input', 'Find my latest GTA operational plan')
await page.click('button:has-text("Ask Jarvis")')
await page.waitForSelector('.result__name', { timeout: 30000 })
const topResult = await page.textContent('.result__name')
check('search returns the right file', topResult === 'GTA Operational Plan 2026.txt', topResult)
check('relevance reason shown', ((await page.textContent('.result__reason')) ?? '').length > 10)
await page.screenshot({ path: path.join(OUT, '04-search-results.png') })

// Without a provider, Jarvis must say why it cannot summarise rather than invent.
await page.fill('.command__input', 'Summarise it')
await page.click('button:has-text("Ask Jarvis")')
await page.waitForFunction(
  () => document.querySelectorAll('.turn--jarvis').length >= 2,
  { timeout: 30000 }
)
const notices = await page.$$eval('.notice', (els) => els.map((e) => e.textContent))
check(
  'no provider -> honest notice, no fabrication',
  notices.some((n) => (n ?? '').includes('AI provider')),
  notices.join(' | ').slice(0, 120)
)
await page.screenshot({ path: path.join(OUT, '05-no-provider.png') })

// Coming-later screens are labelled, not faked.
await page.click('.nav__item:has-text("Businesses")')
await page.waitForSelector('.later__badge')
check('placeholder labelled', (await page.textContent('.later__badge')) === 'Planned for V0.3')
await page.screenshot({ path: path.join(OUT, '06-coming-later.png') })

await app.close()

const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
