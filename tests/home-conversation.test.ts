import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReplyBody } from '../src/renderer/pages/HomePage'
import type { JarvisReply, ScoredMailMessage } from '../src/shared/communication'

function supportingMessage(id: string, subject: string): ScoredMailMessage {
  return {
    id,
    accountId: 'account-1',
    accountLabel: 'Work',
    conversationId: `conversation-${id}`,
    subject,
    preview: 'Please review this item.',
    receivedAt: Date.parse('2026-09-20T09:00:00Z'),
    isRead: false,
    importance: 'normal',
    isFlagged: false,
    hasAttachments: false,
    from: { name: 'Accounts', address: 'accounts@example.test' },
    to: [],
    cc: [],
    webLink: '',
    attention: { score: 4, needsAttention: true, reasons: ['concerns payment'] }
  }
}

function analysisReply(id: string): JarvisReply {
  const message = supportingMessage(id, `Invoice ${id}`)
  return {
    kind: 'answer',
    capability: 'mail',
    shape: 'analyse',
    text: `Analysis for ${id}`,
    results: [],
    sources: [],
    suggestions: [],
    messages: [message],
    mailSources: [{
      messageId: message.id,
      accountId: message.accountId,
      accountLabel: message.accountLabel,
      subject: message.subject,
      from: message.from!.address,
      receivedAt: message.receivedAt
    }],
    disclosure: {
      providerId: 'anthropic',
      providerLabel: 'Claude',
      local: false,
      model: 'claude-opus-5',
      excerptCount: 1,
      charsSent: 500,
      fileNames: [],
      itemKind: 'emails',
      itemLabels: [message.subject],
      accountLabels: ['Work']
    }
  }
}

function render(reply: JarvisReply): string {
  return renderToStaticMarkup(createElement(ReplyBody, {
    reply,
    onOpen: () => undefined,
    onReveal: () => undefined,
    onSelect: () => undefined,
    selectedId: null
  }))
}

describe('Home response evidence ownership', () => {
  test('one Jarvis response renders exactly one messages-behind control', () => {
    const html = render(analysisReply('INV-0258'))
    assert.equal((html.match(/Messages behind this \(1\)/g) ?? []).length, 1)
  })

  test('retrieval replies use the same messages-behind label and underlying count', () => {
    const reply = analysisReply('INV-0258')
    reply.shape = 'retrieve'
    const html = render(reply)
    assert.equal((html.match(/Messages behind this \(1\)/g) ?? []).length, 1)
    assert.doesNotMatch(html, />1 messages</)
  })

  test('related evidence is visibly grouped while every source message remains accessible', () => {
    const first = supportingMessage('notice-a', 'Invoice INV-0258')
    const second = supportingMessage('notice-b', 'Reminder: Invoice INV-0258')
    const reply = analysisReply('unused')
    reply.messages = [first, second]
    reply.messageGroups = [{
      key: 'reference:INV0258',
      title: first.subject,
      messages: [
        { accountId: first.accountId, messageId: first.id },
        { accountId: second.accountId, messageId: second.id }
      ]
    }]
    reply.mailSources = [first, second].map((message) => ({
      messageId: message.id,
      accountId: message.accountId,
      accountLabel: message.accountLabel,
      subject: message.subject,
      from: message.from!.address,
      receivedAt: message.receivedAt
    }))

    const html = render(reply)
    assert.match(html, /Messages behind this \(2\)/)
    assert.match(html, /Matter 1 · 2 messages/)
    assert.match(html, /Invoice INV-0258/)
    assert.match(html, /Reminder: Invoice INV-0258/)
    assert.equal((html.match(/Sent to Claude/g) ?? []).length, 1)
  })

  test('evidence and provider disclosure stay with their own response', () => {
    const first = render(analysisReply('INV-0258'))
    const second = render(analysisReply('INV-0261'))

    assert.match(first, /Invoice INV-0258/)
    assert.doesNotMatch(first, /INV-0261/)
    assert.match(second, /Invoice INV-0261/)
    assert.doesNotMatch(second, /INV-0258/)
    assert.equal((first.match(/Sent to Claude/g) ?? []).length, 1)
    assert.equal((second.match(/Sent to Claude/g) ?? []).length, 1)
  })
})
