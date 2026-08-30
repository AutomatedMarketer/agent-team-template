import test from 'node:test'
import assert from 'node:assert/strict'
import { listDir, read, exists } from './helpers/repo.mjs'
import { AGENT_SLUGS } from '../scripts/lib/run-log.mjs'
import { KNOWLEDGE, fillMarkers, answered } from '../scripts/lib/knowledge.mjs'

test('there is exactly one workspace per agent slug', async () => {
  const found = (await listDir('agents')).filter(
    (entry) => !entry.startsWith('.') && entry !== 'README.md'
  )
  assert.deepEqual(found, [...AGENT_SLUGS].sort())
})

test('every workspace has a README and an output folder', async () => {
  for (const slug of AGENT_SLUGS) {
    assert.ok(await exists(`agents/${slug}/README.md`), `agents/${slug}/README.md missing`)
    assert.ok(await exists(`agents/${slug}/output`), `agents/${slug}/output missing`)
  }
})

test('customer-service ships an editable FAQ and sales ships an offer sheet', async () => {
  // Either state is correct: still carrying markers so /audit can see the gaps, or answered.
  // This used to demand the markers outright, which is a property of the SHIPPED template and not
  // of a repo somebody has used - and both files tell their reader, in the file, to delete the
  // markers once they have answered. Lessons 9 and 10 say the same. So a student who followed the
  // course failed their own suite permanently, having done exactly what they were told, under a
  // README that reads "If this fails, the clone is broken".
  for (const path of Object.values(KNOWLEDGE)) {
    const body = await read(path)
    assert.ok(
      fillMarkers(body).length > 0 || answered(body),
      `${path} has neither fill markers nor an answer - nothing can tell whether it is blank or done`
    )
  }
})

test('an answered knowledge file is not reported as unfilled, and a hollow one still is', () => {
  const shipped = '# FAQ\n\nAnswer only from here.\n\n## What do you sell?\n<!-- fill: faq-offer -->\n'
  const off = '# FAQ\n\n## What do you sell?\nI do not deal with customers - support is the contracts team\'s.\n'
  const hollow = '# FAQ\n\n## What do you sell?\n'

  const ok = (body) => fillMarkers(body).length > 0 || answered(body)
  assert.equal(ok(shipped), true, 'the shipped file carries markers')
  assert.equal(ok(off), true, 'a file answered with a refusal is finished, not empty')
  assert.equal(ok(hollow), false, 'markers deleted with nothing written is neither')
})

test('sales ships a pipeline file so the no-CRM default works on day one', async () => {
  const pipeline = await read('agents/sales/output/pipeline.md')
  assert.match(pipeline, /\|.*prospect.*\|/i, 'pipeline.md needs a table header the agent appends to')
})

test('agents/README.md explains the split between definitions and workspaces', async () => {
  const doc = await read('agents/README.md')
  assert.match(doc, /\.claude\/agents\//)
  assert.match(doc, /output/)
})
