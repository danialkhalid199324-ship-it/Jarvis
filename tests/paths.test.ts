import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  isWithin,
  assertReadable,
  describeOverlap,
  PathNotAuthorisedError
} from '../src/core/security/paths'
import { makeTempDir, cleanup } from './helpers'

describe('path containment guard', () => {
  test('accepts the root itself and files beneath it', () => {
    assert.equal(isWithin('/Users/me/Docs', '/Users/me/Docs'), true)
    assert.equal(isWithin('/Users/me/Docs', '/Users/me/Docs/a.pdf'), true)
    assert.equal(isWithin('/Users/me/Docs', '/Users/me/Docs/sub/deep/a.pdf'), true)
  })

  test('rejects a sibling directory that shares a name prefix', () => {
    // The bug a naive startsWith check would have.
    assert.equal(isWithin('/Users/me/Docs', '/Users/me/Docs-private/secret.pdf'), false)
    assert.equal(isWithin('/Users/me/Docs', '/Users/me/Documents/secret.pdf'), false)
  })

  test('rejects traversal out of the root', () => {
    assert.equal(isWithin('/Users/me/Docs', '/Users/me/Docs/../../etc/passwd'), false)
    assert.equal(isWithin('/Users/me/Docs', '/etc/passwd'), false)
  })

  test('a symlink inside an authorised folder cannot reach outside it', async (t) => {
    const base = await makeTempDir('symlink')
    t.after(() => cleanup(base))

    const authorised = path.join(base, 'authorised')
    const secret = path.join(base, 'secret')
    await fs.mkdir(authorised, { recursive: true })
    await fs.mkdir(secret, { recursive: true })
    await fs.writeFile(path.join(secret, 'private.txt'), 'confidential', 'utf8')

    const link = path.join(authorised, 'escape.txt')
    await fs.symlink(path.join(secret, 'private.txt'), link)

    // Lexically the link looks like it lives inside the authorised folder.
    assert.equal(isWithin(authorised, link), true)
    // Resolving it reveals the real target, which is out of bounds.
    await assert.rejects(() => assertReadable([authorised], link), PathNotAuthorisedError)
  })

  test('allows a real file inside an authorised folder', async (t) => {
    const base = await makeTempDir('allowed')
    t.after(() => cleanup(base))
    const file = path.join(base, 'plan.txt')
    await fs.writeFile(file, 'hello', 'utf8')
    const resolved = await assertReadable([base], file)
    assert.equal(await fs.readFile(resolved, 'utf8'), 'hello')
  })

  test('refuses overlapping authorisations in both directions', () => {
    assert.match(describeOverlap(['/a/b'], '/a/b/c') ?? '', /already covered/)
    assert.match(describeOverlap(['/a/b/c'], '/a/b') ?? '', /contains an already authorised/)
    assert.match(describeOverlap(['/a/b'], '/a/b') ?? '', /already authorised/)
    assert.equal(describeOverlap(['/a/b'], '/x/y'), null)
  })
})
