import test from 'node:test'
import assert from 'node:assert/strict'
import { read, stageDone } from './helpers/repo.mjs'

const BRAIN_FILES = ['shared/about-me.md', 'shared/business-brain.md', 'shared/writing-rules.md']

test('every business-brain file exists and names itself in an h1', async () => {
  for (const file of BRAIN_FILES) {
    const body = await read(file)
    assert.match(body, /^# .+/m, `${file} needs a top-level heading`)
  }
})

test('every unfilled field uses the fill marker so /onboard can find it', async () => {
  const briefDone = await stageDone('1 · Brief')
  for (const file of BRAIN_FILES) {
    const body = await read(file)
    if (!briefDone) {
      assert.match(
        body,
        /<!-- fill: [a-z0-9-]+ -->/,
        `${file} has no <!-- fill: ... --> markers; /onboard cannot see what is empty`
      )
    }
    assert.doesNotMatch(
      body,
      /\bTBD\b|\bTODO\b|\[your .+?\]/i,
      `${file} uses a placeholder that is not a fill marker`
    )
  }
})

test('an agent is told what to do when the brain is empty', async () => {
  const readme = await read('shared/README.md')
  assert.match(readme, /fill marker/i)
  assert.match(
    readme,
    /still.*(useful|work)/i,
    'shared/README.md must state that agents degrade gracefully on an empty brain'
  )
})
