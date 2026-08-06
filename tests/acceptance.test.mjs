import test from 'node:test'
import assert from 'node:assert/strict'
import { listDir, read } from './helpers/repo.mjs'

// Every criterion row carries a verdict. "pending" is a verdict. Blank is not.
test('a sweep record has a verdict on every criterion row', async () => {
  const files = (await listDir('docs/acceptance')).filter((file) => file.endsWith('.md'))
  assert.ok(files.length > 0, 'docs/acceptance is empty; the sweep record is the Phase 2 deliverable')
  for (const file of files) {
    const body = await read(`docs/acceptance/${file}`)
    const rows = body.split('\n').filter((line) => /^\|\s*(R\d|A\d|G\d)\b/.test(line))
    assert.ok(rows.length > 0, `${file} has no criterion rows`)
    for (const row of rows) {
      const cells = row.split('|').map((cell) => cell.trim())
      const verdict = cells[3] ?? ''
      assert.ok(verdict.length > 0, `${file} has an unjudged row:\n${row}`)
    }
  }
})
