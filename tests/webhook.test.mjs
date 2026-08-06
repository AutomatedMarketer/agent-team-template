import test from 'node:test'
import assert from 'node:assert/strict'
import { read } from './helpers/repo.mjs'

test('the webhook contract documents the POST body and every field', async () => {
  const doc = await read('docs/webhook-contract.md')
  for (const field of ['question', 'from', 'received_at', 'ticket_id', 'channel']) {
    assert.match(doc, new RegExp(`\`${field}\``), `webhook contract never documents ${field}`)
  }
  assert.match(doc, /POST/, 'the contract must show the HTTP method')
  assert.match(
    doc,
    /one hour|60 minutes|hourly/i,
    'the contract must explain why a webhook exists rather than a schedule'
  )
})

test('the webhook contract carries no secret and no live endpoint', async () => {
  const doc = await read('docs/webhook-contract.md')
  assert.doesNotMatch(doc, /sk-ant-|ghp_|Bearer [A-Za-z0-9]{10,}/)
})
