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
    JSON.stringify([
      'Home',
      'Messages',
      'Calendar',
      'Files',
      'Tasks',
      'Businesses',
      'Research',
      'Automations',
      'Settings'
    ]),
  navLabels.join(', ')
)

check('greeting still says Danial', (greeting ?? '').includes('Danial'), greeting)

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

// --- "Ask about this" document selection ---------------------------------
await page.fill('.command__input', 'Find my GTA operational plan')
await page.click('button:has-text("Ask Jarvis")')
await page.waitForSelector('button:has-text("Ask about this")', { timeout: 30000 })

await page.click('.result:has-text("GTA Operational Plan 2026.txt") button:has-text("Ask about this")')
await page.waitForSelector('.selection')
check(
  'selecting a document shows what is selected',
  ((await page.textContent('.selection__name')) ?? '') === 'GTA Operational Plan 2026.txt',
  await page.textContent('.selection__name')
)
check(
  'the selected result card is marked',
  (await page.locator('.result--selected .result__name').first().textContent()) ===
    'GTA Operational Plan 2026.txt'
)
check(
  'the composer prompts for the selected document',
  ((await page.getAttribute('.command__input', 'placeholder')) ?? '').includes(
    'GTA Operational Plan 2026.txt'
  )
)
await page.screenshot({ path: path.join(OUT, '07-document-selected.png') })

await page.click('.selection button:has-text("Clear")')
check('the selection can be cleared', (await page.locator('.selection').count()) === 0)
check(
  'clearing restores the general placeholder',
  (await page.getAttribute('.command__input', 'placeholder')) === 'Ask Jarvis anything…'
)

// --- model picker ---------------------------------------------------------
await page.click('.nav__item:has-text("Settings")')
await page.waitForSelector('#model')
const modelOptions = await page.$$eval('#model option', (els) => els.map((e) => e.value))
check(
  'Opus 5 and Sonnet 5 are both offered',
  modelOptions.includes('claude-opus-5') && modelOptions.includes('claude-sonnet-5'),
  modelOptions.join(', ')
)
await page.selectOption('#model', 'claude-sonnet-5')
await page.waitForTimeout(400)
check('model selection is saved', (await page.inputValue('#model')) === 'claude-sonnet-5')
await page.selectOption('#model', 'claude-opus-5')
await page.waitForTimeout(400)
check('Opus 5 remains available', (await page.inputValue('#model')) === 'claude-opus-5')
await page.screenshot({ path: path.join(OUT, '08-model-picker.png') })
await page.click('.nav__item:has-text("Home")')
await page.waitForSelector('.chat__composer')

// --- V0.2: communication surfaces are honest with no account connected ---
await page.click('.nav__item:has-text("Messages")')
await page.waitForSelector('.page-header__title:has-text("Messages")')
const messagesEmpty = (await page.textContent('.empty')) ?? ''
check(
  'Messages says what to do rather than showing fake mail',
  /Connect a Microsoft 365 account/i.test(messagesEmpty),
  messagesEmpty.slice(0, 80)
)
check('Messages shows no fabricated message cards', (await page.locator('.message').count()) === 0)

await page.click('.nav__item:has-text("Calendar")')
await page.waitForSelector('.page-header__title:has-text("Calendar")')
const calendarEmpty = (await page.textContent('.empty')) ?? ''
check(
  'Calendar says what to do rather than showing fake meetings',
  /Connect a Microsoft 365 account/i.test(calendarEmpty),
  calendarEmpty.slice(0, 80)
)
check('Calendar shows no fabricated events', (await page.locator('.event').count()) === 0)
await page.screenshot({ path: path.join(OUT, '09-messages-empty.png') })

// Home cards must show real state, not invented counts.
await page.click('.nav__item:has-text("Home")')
await page.waitForSelector('.cards')
const cardLabels = await page.$$eval('.card__label', (els) => els.map((e) => e.textContent))
check(
  'Home shows only Email, Meetings and Files cards',
  JSON.stringify(cardLabels) === JSON.stringify(['Email', 'Meetings', 'Files']),
  cardLabels.join(', ')
)
const emailCard = await page.locator('.card', { hasText: 'Email' }).first().textContent()
check(
  'Email card says connect an account rather than showing a number',
  /Connect an account/i.test(emailCard ?? ''),
  (emailCard ?? '').slice(0, 60)
)
const filesCard = await page.locator('.card', { hasText: 'Files' }).first().textContent()
check('Files card shows the real indexed count', /2/.test(filesCard ?? ''), (filesCard ?? '').slice(0, 60))
await page.screenshot({ path: path.join(OUT, '10-home-dashboard.png') })

// Connected Accounts exists and exposes no credential surface.
await page.click('.nav__item:has-text("Settings")')
await page.waitForSelector('.panel__title:has-text("Connected Accounts")')
check('Connected Accounts section exists', true)
await page.click('button:has-text("What permissions does this ask for?")')
await page.waitForSelector('.folder__label')
const scopeNames = await page.$$eval('.section-label + .folder .folder__label, .folder__label', (els) =>
  els.map((e) => e.textContent)
)
check(
  'requested permissions are shown and are delegated only',
  scopeNames.includes('Mail.Read') && scopeNames.includes('Calendars.ReadWrite') &&
    !scopeNames.some((n) => (n ?? '').endsWith('.All')),
  scopeNames.filter(Boolean).join(', ')
)
const settingsText = (await page.textContent('.main')) ?? ''
check(
  'no token or secret appears anywhere in Settings',
  !/Bearer |refresh_token|client_secret|eyJ[A-Za-z0-9]/.test(settingsText)
)
await page.screenshot({ path: path.join(OUT, '11-connected-accounts.png') })

await page.click('.nav__item:has-text("Home")')
await page.waitForSelector('.chat__composer')

// Coming-later screens are labelled, not faked.
await page.click('.nav__item:has-text("Businesses")')
await page.waitForSelector('.later__badge')
check('placeholder labelled', (await page.textContent('.later__badge')) === 'Planned for V0.3')
await page.screenshot({ path: path.join(OUT, '06-coming-later.png') })

await app.close()

const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
