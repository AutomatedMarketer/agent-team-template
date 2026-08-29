import test from 'node:test'
import assert from 'node:assert/strict'
import { read, exists } from './helpers/repo.mjs'
import { loadAgents } from '../scripts/lib/agents.mjs'

const OUTBOUND_AGENTS = ['email', 'customer-service']

test('outbound agents state the draft-only rule in plain words', async () => {
  const agents = await loadAgents()
  for (const slug of OUTBOUND_AGENTS) {
    const agent = agents.find((candidate) => candidate.slug === slug)
    assert.ok(agent, `${slug} definition missing`)
    assert.match(
      agent.body,
      /leave it in drafts|left in drafts/i,
      `${slug} must say it leaves replies in drafts`
    )
    assert.match(
      agent.body,
      /do not send|does not send|nothing is sent|without sending/i,
      `${slug} must say it does not send`
    )
  }
})

test('the draft-only decision is written down where a lesson can quote it', async () => {
  assert.ok(await exists('docs/safety/draft-only.md'))
  const doc = await read('docs/safety/draft-only.md')
  assert.match(doc, /why/i)
  assert.match(doc, /verif/i, 'the doc must record how the rule is verified, not just asserted')
})

// Layer 3 - denying the connector's send tools by name - cannot ship filled in, because the
// tool names depend on which connector the owner attached. So the doc ships with the table
// blank. The danger is the blank table quietly losing its "pending" label and reading as a
// guarantee: a course lesson already claimed this layer was in place when it was not.
// While the table is unfilled, the doc must say so in words.
test('an unfilled deny table still says the layer is not in place', async () => {
  const doc = await read('docs/safety/draft-only.md')
  const unfilled = doc.includes('<!-- fill: verified-send-tools -->')
  if (!unfilled) return
  assert.match(
    doc,
    /pending|not yet in place|not in place/i,
    'the deny table is empty, so the doc must say the layer is pending rather than imply a guarantee'
  )
})

// The safety doc once told the owner to verify the rule by asking the agent to send a test
// message to their own address - on the page whose whole argument is that a bad send has no
// undo. That test cannot succeed usefully: a refusal proves layer 1 and says nothing about
// layer 3, and a send means layer 1 just failed on a real account, on purpose.
test('the safety doc never asks anyone to verify the rule by sending', async () => {
  const doc = await read('docs/safety/draft-only.md')
  // Keyed on the shape of the instruction rather than its wording: something that transmits
  // (send, mail, fire off, attempt a send) aimed at the reader (yourself, your own address,
  // you a message). Earlier versions anchored on the literal "send a test", then on a fixed
  // verb order, and both were beaten by ordinary paraphrases - "mail yourself a short note",
  // "fire off a message to your own address", "make the agent send mail to yourself".
  //
  // This remains a phrasing guard. It catches the ways this has been written, not every way
  // it could be written. That limit is recorded rather than described away as a proof.
  const TRANSMITS =
    /\b(?:sends?|sending|mails?|mailing|fires? off|attempts? a send|transmits?)\b[^.\n]{0,70}\b(?:yourself|your own|your personal|to you\b|you a (?:message|note|mail|email))/i
  const AIMED_AT_READER =
    /\b(?:yourself|your own address|your personal)\b[^.\n]{0,70}\b(?:sends?|sending|mails?|mailing)\b/i
  const LITERAL = /send (?:a )?test|email yourself/i
  const SAFE =
    /do not|don't|never|rather than|instead of|not worth|cannot tell you|list every tool|watch it decline|no mail leaves/i
  const offending = doc
    .split('\n')
    .filter(
      (line) =>
        (TRANSMITS.test(line) || AIMED_AT_READER.test(line) || LITERAL.test(line)) &&
        !SAFE.test(line)
    )
  assert.deepEqual(
    offending,
    [],
    `the safety doc instructs a live send test: ${JSON.stringify(offending)}`
  )
})

// The same trap from the other side: if settings.json denies nothing that could send, the
// doc must not have been marked complete.
test('settings denies only what it actually denies', async () => {
  const settings = JSON.parse(await read('.claude/settings.json'))
  const deny = settings.permissions?.deny ?? []
  const denies = deny.some((rule) => /send|mail|message|reply|forward/i.test(rule))
  if (denies) return
  const doc = await read('docs/safety/draft-only.md')
  assert.match(
    doc,
    /pending|not yet in place|not in place/i,
    'nothing send-capable is denied, so the safety doc must not read as though layer 3 were live'
  )
})
