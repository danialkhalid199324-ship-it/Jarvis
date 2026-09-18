/**
 * Fixed-composer regression test.
 *
 * Guards the layout guarantee: the composer stays at the bottom of the window,
 * only the conversation scrolls, and no reply — however long — can end up
 * hidden behind it. Run it the same way as smoke.mjs:
 *
 *   npm run build
 *   npm i --no-save playwright
 *   SMOKE_OUT=/tmp/jarvis-smoke node tests/smoke/composer.mjs
 */
import { _electron as electron } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const OUT = process.env.SMOKE_OUT ?? os.tmpdir()
const archive = path.join(os.tmpdir(), 'jarvis-composer-archive')
fs.rmSync(archive, { recursive: true, force: true })
fs.mkdirSync(path.join(archive, 'GTA'), { recursive: true })
const body = Array.from({ length: 40 }, (_, i) =>
  `Section ${i + 1}. GTA operational plan detail covering staffing, rosters, compliance obligations and outstanding audit actions for site ${i + 1}.`
).join('\n\n')
fs.writeFileSync(path.join(archive, 'GTA', 'GTA Operational Plan 2026.txt'), `GTA Operational Plan 2026\n\n${body}`)
for (let i = 0; i < 6; i++) {
  fs.writeFileSync(path.join(archive, `GTA plan variant ${i}.txt`), `GTA operational plan variant ${i}. ${body.slice(0, 900)}`)
}
const userData = path.join(os.tmpdir(), 'jarvis-composer-data')
fs.rmSync(userData, { recursive: true, force: true })
fs.mkdirSync(userData, { recursive: true })
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
  displayName: 'Danial',
  folders: [{ id: 'f1', path: archive, label: 'Business', addedAt: new Date().toISOString() }],
  ai: { activeProviderId: 'anthropic', model: 'claude-opus-5' },
  microsoft: {},
  maxContextChars: 60000, maxFileSizeBytes: 41943040
}))

const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${userData}`] })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForSelector('.chat__composer')

const checks = []
const check = (n, ok, d = '') => { checks.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`) }
const box = async (sel) => page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom } })

await page.click('.nav__item:has-text("Settings")')
await page.click('button:has-text("Index now")')
await page.waitForFunction(() => Number(document.querySelector('.stat__value')?.textContent) >= 7, { timeout: 40000 })
await page.click('.nav__item:has-text("Home")')
await page.waitForSelector('.chat__composer')

const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
const before = await box('.chat__composer')
check('composer sits at the bottom', Math.abs(before.bottom - viewport.height) < 2, `bottom=${before.bottom.toFixed(0)}`)

for (let i = 0; i < 4; i++) {
  await page.fill('.command__input', 'Find GTA operational plan')
  await page.click('button:has-text("Ask Jarvis")')
  await page.waitForFunction((n) => document.querySelectorAll('.turn--jarvis').length >= n, i + 1, { timeout: 40000 })
}

const info = await page.$eval('.chat__scroll', (el) => ({ sh: el.scrollHeight, ch: el.clientHeight }))
check('conversation overflows', info.sh > info.ch + 100, `${info.sh} > ${info.ch}`)
const after = await box('.chat__composer')
check('composer did not move after long answers', Math.abs(after.top - before.top) < 2)

await page.$eval('.chat__scroll', (el) => el.scrollTo({ top: 0 }))
await page.waitForTimeout(250)
check('composer fixed while scrolling', Math.abs((await box('.chat__composer')).top - before.top) < 2)

const pageScrolls = await page.evaluate(() => {
  const main = document.querySelector('.main')
  return { body: document.body.scrollHeight > window.innerHeight + 2, main: main.scrollHeight > main.clientHeight + 2 }
})
check('only the conversation scrolls', !pageScrolls.body && !pageScrolls.main)

await page.$eval('.chat__scroll', (el) => el.scrollTo({ top: el.scrollHeight }))
await page.waitForTimeout(300)
const cards = await page.$$('.result')
const lastBox = await cards[cards.length - 1].boundingBox()
check('last card not overlapped', lastBox.y + lastBox.height <= (await box('.chat__composer')).top + 1)

await app.evaluate(async ({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1000, 600) })
await page.waitForTimeout(500)
const vp2 = await page.evaluate(() => ({ height: innerHeight }))
check('still pinned after resize', Math.abs((await box('.chat__composer')).bottom - vp2.height) < 2)
check('still scrollable after resize', await page.$eval('.chat__scroll', (el) => el.scrollHeight > el.clientHeight))

await page.fill('.command__input', 'still works')
check('composer accepts input', (await page.inputValue('.command__input')) === 'still works')
await page.screenshot({ path: path.join(OUT, 'c3-composer-v02.png') })

await app.close()
const failed = checks.filter((c) => !c).length
console.log(`\n${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
