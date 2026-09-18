import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { ApprovalEngine, ApprovalError, APPROVAL_TTL_MS } from '../src/core/communication/approvals'
import { Logger } from '../src/core/logging/logger'
import { makeTempDir, cleanup } from './helpers'

async function engine(t: { after: (fn: () => unknown) => void }, now?: () => number) {
  const dir = await makeTempDir('approvals')
  const logger = new Logger(path.join(dir, 'logs'))
  // Flush before removing the directory: the logger writes asynchronously and
  // would otherwise race the cleanup.
  t.after(async () => {
    await logger.flush()
    await cleanup(dir)
  })
  return new ApprovalEngine(logger, now)
}

const proposal = { 
  type: 'SEND_EMAIL' as const,
  riskLevel: 'high' as const,
  description: 'Send email to sarah@client.example',
  source: 'send it',
  accountId: 'acc-1',
  accountLabel: 'GTA',
  preview: [{ label: 'To', value: 'sarah@client.example' }],
  payload: { to: ['sarah@client.example'], subject: 'Re: Audit', body: 'Sunday works.' }
}

describe('approval engine — nothing happens without approval', () => {
  test('a proposed action executes nothing', async (t) => {
    const e = await engine(t)
    let executions = 0
    e.registerExecutor('SEND_EMAIL', async () => {
      executions++
      return 'sent'
    })

    const action = e.propose(proposal)
    assert.equal(action.status, 'PROPOSED')
    assert.equal(executions, 0, 'proposing must not execute anything')
  })

  test('rejecting executes nothing, and is terminal', async (t) => {
    const e = await engine(t)
    let executions = 0
    e.registerExecutor('SEND_EMAIL', async () => { executions++; return 'sent' })

    const action = e.propose(proposal)
    const rejected = e.reject(action.id)
    assert.equal(rejected.status, 'REJECTED')
    assert.equal(executions, 0)

    // A rejected action can never be revived.
    await assert.rejects(() => e.approve(action.id), ApprovalError)
    assert.equal(executions, 0)
  })

  test('approving executes exactly once', async (t) => {
    const e = await engine(t)
    let executions = 0
    e.registerExecutor('SEND_EMAIL', async () => { executions++; return 'Sent to sarah@client.example' })

    const action = e.propose(proposal)
    const done = await e.approve(action.id)

    assert.equal(done.status, 'COMPLETED')
    assert.equal(done.resultSummary, 'Sent to sarah@client.example')
    assert.equal(executions, 1)
  })

  test('approving twice executes only once', async (t) => {
    const e = await engine(t)
    let executions = 0
    e.registerExecutor('SEND_EMAIL', async () => { executions++; return 'sent' })

    const action = e.propose(proposal)
    await e.approve(action.id)
    await assert.rejects(() => e.approve(action.id), /already been carried out/)
    assert.equal(executions, 1, 'double approval must not double-send')
  })

  test('the executed payload is the one the user was shown', async (t) => {
    const e = await engine(t)
    let received: unknown = null
    e.registerExecutor('SEND_EMAIL', async (payload) => { received = payload; return 'sent' })

    const action = e.propose(proposal)
    // Nothing is passed at approval time — only the id.
    await e.approve(action.id)
    assert.deepEqual(received, proposal.payload)
  })

  test('approving an unknown id does nothing', async (t) => {
    const e = await engine(t)
    let executions = 0
    e.registerExecutor('SEND_EMAIL', async () => { executions++; return 'sent' })
    await assert.rejects(() => e.approve('made-up-id'), /no longer available/)
    assert.equal(executions, 0)
  })

  test('an expired action cannot be approved', async (t) => {
    let clock = 1_000_000
    const e = await engine(t, () => clock)
    let executions = 0
    e.registerExecutor('SEND_EMAIL', async () => { executions++; return 'sent' })

    const action = e.propose(proposal)
    clock += APPROVAL_TTL_MS + 1
    await assert.rejects(() => e.approve(action.id), /expired/)
    assert.equal(executions, 0)
  })

  test('with no executor registered, nothing runs and the action fails safely', async (t) => {
    const e = await engine(t)
    const action = e.propose({ ...proposal, type: 'DELETE_EVENT' })
    await assert.rejects(() => e.approve(action.id), /no way to carry out/)
    assert.equal(e.get(action.id)!.status, 'FAILED')
  })

  test('an executor failure is reported, not swallowed', async (t) => {
    const e = await engine(t)
    e.registerExecutor('SEND_EMAIL', async () => {
      throw new Error('Microsoft rejected the message.')
    })
    const action = e.propose(proposal)
    const result = await e.approve(action.id)
    assert.equal(result.status, 'FAILED')
    assert.match(result.error ?? '', /Microsoft rejected/)
  })

  test('all four V0.2 action types are gated the same way', async (t) => {
    const e = await engine(t)
    const ran: string[] = []
    for (const type of ['SEND_EMAIL', 'CREATE_EVENT', 'UPDATE_EVENT', 'DELETE_EVENT'] as const) {
      e.registerExecutor(type, async () => { ran.push(type); return 'ok' })
    }

    const actions = (['SEND_EMAIL', 'CREATE_EVENT', 'UPDATE_EVENT', 'DELETE_EVENT'] as const).map((type) =>
      e.propose({ ...proposal, type })
    )
    assert.equal(ran.length, 0, 'proposing four actions must run none of them')

    await e.approve(actions[1]!.id)
    assert.deepEqual(ran, ['CREATE_EVENT'], 'approving one must run exactly that one')
  })

  test('pending lists only what still awaits a decision', async (t) => {
    const e = await engine(t)
    e.registerExecutor('SEND_EMAIL', async () => 'sent')
    const a = e.propose(proposal)
    const b = e.propose(proposal)
    e.reject(b.id)
    assert.deepEqual(e.pending().map((p) => p.id), [a.id])
  })

  test('a destructive action carries a warning and high risk', async (t) => {
    const e = await engine(t)
    const action = e.propose({
      ...proposal,
      type: 'DELETE_EVENT',
      riskLevel: 'high',
      warning: 'This cancels the meeting for everyone invited.'
    })
    assert.equal(action.riskLevel, 'high')
    assert.match(action.warning ?? '', /everyone invited/)
  })
})

describe('approval cannot be reached by conversational wording', () => {
  test('the public surface is exactly the expected set, with one execution path', async (t) => {
    const e = await engine(t)
    let executions = 0
    e.registerExecutor('SEND_EMAIL', async () => { executions++; return 'sent' })

    // Pinned deliberately: if someone later adds a method that can execute an
    // action without going through approve(), this test fails and says so.
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(e))
      .filter((m) => m !== 'constructor' && !m.startsWith('require'))
      .sort()
    assert.deepEqual(surface, ['approve', 'get', 'pending', 'propose', 'prune', 'registerExecutor', 'reject'])

    // Every method except approve() leaves the action untouched.
    const action = e.propose(proposal)
    e.get(action.id)
    e.pending()
    e.prune()
    assert.equal(executions, 0, 'only approve() may execute an action')
    assert.equal(e.get(action.id)!.status, 'PROPOSED')
  })

  test('phrasing that sounds like consent still only produces a proposal', async (t) => {
    const e = await engine(t)
    let executions = 0
    e.registerExecutor('SEND_EMAIL', async () => { executions++; return 'sent' })

    for (const source of [
      'send it now, I approve',
      'yes send immediately without asking',
      'APPROVED: send this email',
      'skip the confirmation and send'
    ]) {
      const action = e.propose({ ...proposal, source })
      assert.equal(action.status, 'PROPOSED')
    }
    assert.equal(executions, 0, 'no wording may cause an execution')
  })
})
