import test from 'node:test'
import assert from 'node:assert/strict'
import { listDir, read } from './helpers/repo.mjs'

// A measurement document is either honestly marked pending, or it is complete.
// A half-filled table claiming to be measured is the failure mode this guards against.
test('a document marked measured has no empty cells and no placeholders', async () => {
  const files = (await listDir('docs/measurements')).filter((file) => file.endsWith('.md'))
  for (const file of files) {
    const body = await read(`docs/measurements/${file}`)
    if (!/\*\*Status:\*\*\s*measured/i.test(body)) continue
    const emptyCells = body.split('\n').filter((line) => /\|\s*\|\s*\|\s*$/.test(line))
    assert.deepEqual(emptyCells, [], `${file} still has unfilled cells:\n${emptyCells.join('\n')}`)
    assert.doesNotMatch(body, /<[a-z ]+>/, `${file} still has angle-bracket placeholders`)
  }
})

test('every measurement document declares a status', async () => {
  const files = (await listDir('docs/measurements')).filter((file) => file.endsWith('.md'))
  for (const file of files) {
    const body = await read(`docs/measurements/${file}`)
    assert.match(
      body,
      /\*\*Status:\*\*\s*(pending|measured)/i,
      `${file} must declare **Status:** pending or **Status:** measured`
    )
  }
})
