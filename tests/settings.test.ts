import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { SettingsStore } from '../src/core/settings/settings-store'
import { SecretStore, unavailableEncryptor, type Encryptor } from '../src/core/security/secrets'
import { Logger } from '../src/core/logging/logger'
import { makeTempDir, cleanup } from './helpers'

/** Stand-in for Electron's safeStorage in tests. */
const reversibleEncryptor: Encryptor = {
  isAvailable: () => true,
  encrypt: (plain) => Buffer.from([...Buffer.from(plain, 'utf8')].map((b) => b ^ 0x5a)),
  decrypt: (cipher) => Buffer.from([...cipher].map((b) => b ^ 0x5a)).toString('utf8')
}

describe('settings store', () => {
  test('persists authorised folders across restarts', async (t) => {
    const dir = await makeTempDir('settings')
    t.after(() => cleanup(dir))

    const first = await SettingsStore.open(dir, 'Danial')
    await first.addFolder('/Users/d/Business', 'Business')
    assert.equal(first.get().displayName, 'Danial')

    const second = await SettingsStore.open(dir)
    assert.equal(second.get().folders.length, 1)
    assert.equal(second.get().folders[0]!.label, 'Business')
  })

  test('refuses to authorise a folder already covered by another', async (t) => {
    const dir = await makeTempDir('settings-overlap')
    t.after(() => cleanup(dir))
    const store = await SettingsStore.open(dir)
    await store.addFolder('/Users/d/Business')
    await assert.rejects(() => store.addFolder('/Users/d/Business/GTA'), /already covered/)
    await assert.rejects(() => store.addFolder('/Users/d/Business'), /already authorised/)
  })

  test('removing a folder revokes access', async (t) => {
    const dir = await makeTempDir('settings-remove')
    t.after(() => cleanup(dir))
    const store = await SettingsStore.open(dir)
    const folder = await store.addFolder('/Users/d/Business')
    assert.ok(await store.removeFolder(folder.id))
    assert.deepEqual(store.folderPaths(), [])
    assert.equal(await store.removeFolder('unknown'), null)
  })

  test('never stores an API key in settings.json', async (t) => {
    const dir = await makeTempDir('settings-secrets')
    t.after(() => cleanup(dir))
    const settings = await SettingsStore.open(dir)
    await settings.addFolder('/Users/d/Business')

    const secrets = await SecretStore.open(dir, reversibleEncryptor)
    await secrets.set('anthropic', 'sk-ant-supersecret')

    const raw = await fs.readFile(path.join(dir, 'settings.json'), 'utf8')
    assert.ok(!raw.includes('sk-ant-supersecret'))
  })
})

describe('secret store', () => {
  test('round-trips a key through the encryptor', async (t) => {
    const dir = await makeTempDir('secrets')
    t.after(() => cleanup(dir))
    const store = await SecretStore.open(dir, reversibleEncryptor)
    await store.set('anthropic', 'sk-ant-abc123')
    assert.equal(store.get('anthropic'), 'sk-ant-abc123')
    assert.deepEqual(store.configuredProviders(), ['anthropic'])

    const reopened = await SecretStore.open(dir, reversibleEncryptor)
    assert.equal(reopened.get('anthropic'), 'sk-ant-abc123')
  })

  test('the key is not readable in plain text on disk', async (t) => {
    const dir = await makeTempDir('secrets-plain')
    t.after(() => cleanup(dir))
    const store = await SecretStore.open(dir, reversibleEncryptor)
    await store.set('anthropic', 'sk-ant-abc123')
    const raw = await fs.readFile(path.join(dir, 'secrets.enc.json'), 'utf8')
    assert.ok(!raw.includes('sk-ant-abc123'))
  })

  test('refuses to write anything when the OS keychain is unavailable', async (t) => {
    const dir = await makeTempDir('secrets-unavailable')
    t.after(() => cleanup(dir))
    const store = await SecretStore.open(dir, unavailableEncryptor)
    await assert.rejects(() => store.set('anthropic', 'sk-ant-abc123'), /OS-backed encryption/)
    await assert.rejects(
      () => fs.readFile(path.join(dir, 'secrets.enc.json'), 'utf8'),
      /ENOENT/
    )
  })

  test('clearing removes the key', async (t) => {
    const dir = await makeTempDir('secrets-clear')
    t.after(() => cleanup(dir))
    const store = await SecretStore.open(dir, reversibleEncryptor)
    await store.set('anthropic', 'sk-ant-abc123')
    await store.clear('anthropic')
    assert.equal(store.get('anthropic'), null)
    assert.equal(store.has('anthropic'), false)
  })
})

describe('audit log', () => {
  test('records events and reads them back newest first', async (t) => {
    const dir = await makeTempDir('logs')
    t.after(() => cleanup(dir))
    const logger = new Logger(dir)
    logger.info('folder.authorised', { path: '/Users/d/Business' })
    logger.info('index.run_completed', { processed: 5 })
    await logger.flush()

    const entries = await logger.recent()
    assert.equal(entries.length, 2)
    assert.equal(entries[0]!.event, 'index.run_completed')
    assert.equal(entries[1]!.detail!.path, '/Users/d/Business')
  })
})
