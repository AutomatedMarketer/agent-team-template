import test from 'node:test'
import assert from 'node:assert/strict'
import { read } from './helpers/repo.mjs'

const ALLOWED_MODELS = ['opus', 'sonnet', 'haiku']
const ALLOWED_EFFORT = ['low', 'medium', 'high', 'xhigh', 'max']

async function settings() {
  return JSON.parse(await read('.claude/settings.json'))
}

test('model is an alias, never a pinned id', async () => {
  const config = await settings()
  assert.ok(
    ALLOWED_MODELS.includes(config.model),
    `model was "${config.model}" — use an alias from ${ALLOWED_MODELS.join(', ')}`
  )
  assert.doesNotMatch(config.model, /claude-|-\d/, 'a pinned model id rots; aliases upgrade themselves')
})

test('effortLevel is set and valid', async () => {
  const config = await settings()
  assert.ok(ALLOWED_EFFORT.includes(config.effortLevel), `effortLevel was "${config.effortLevel}"`)
})

test('thinking is never disabled', async () => {
  const raw = await read('.claude/settings.json')
  assert.doesNotMatch(
    raw,
    /"thinking"\s*:\s*(false|"off"|"disabled")/,
    'Opus 5 emits tool calls as plain text when thinking is off — lower effort instead'
  )
})

test('reading a .env file is denied', async () => {
  const config = await settings()
  const deny = config.permissions?.deny ?? []
  for (const rule of ['Read(**/.env)', 'Read(**/.env.*)', 'Edit(**/.env)']) {
    assert.ok(deny.includes(rule), `permissions.deny is missing ${rule}`)
  }
})
