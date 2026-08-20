import test from 'node:test'
import assert from 'node:assert/strict'
import {
  loadCatalogue,
  loadSelection,
  validateSelection,
  boardFor,
  isUnfilled
} from '../scripts/lib/tiles.mjs'

const base = { hero: 'hours-saved', chosen: [] }

test('the catalogue holds four fixed tiles and a bounded choosable set', async () => {
  const catalogue = await loadCatalogue()
  assert.equal(catalogue.fixed.length, 4)
  assert.deepEqual(
    catalogue.fixed.map((tile) => tile.id),
    ['today', 'workflows', 'agents', 'overnight']
  )
  assert.ok(catalogue.choosable.length >= 8, 'too few tiles to make a real choice')
  assert.ok(catalogue.choosable.length <= 12, 'the catalogue is meant to stay bounded')
})

test('every catalogue tile has an id, a name and a wiring', async () => {
  const catalogue = await loadCatalogue()
  for (const tile of catalogue.choosable) {
    assert.ok(tile.id, 'a tile is missing an id')
    assert.ok(tile.name, `${tile.id} is missing a name`)
    assert.ok(tile.wiring, `${tile.id} is missing a wiring`)
    // "none" is the absence of wiring, not a preference — a tile that reads the repo needs
    // nothing connected behind it.
    assert.ok(
      tile.wiring === 'none' || catalogue.wiringOrder.preferred.includes(tile.wiring),
      `${tile.id} has wiring "${tile.wiring}" which is neither "none" nor in the preference order`
    )
  }
})

test('tile ids are unique across fixed and choosable', async () => {
  const catalogue = await loadCatalogue()
  const ids = [...catalogue.fixed, ...catalogue.choosable].map((tile) => tile.id)
  assert.equal(new Set(ids).size, ids.length)
})

// MCP last is the single most expensive habit to get wrong, so the order is asserted, not
// just written down in a lesson.
test('the wiring preference puts a CLI first and MCP last', async () => {
  const catalogue = await loadCatalogue()
  const order = catalogue.wiringOrder.preferred
  assert.equal(order[0], 'cli')
  assert.equal(order[order.length - 1], 'mcp')
})

test('a board within the cap validates clean', async () => {
  const catalogue = await loadCatalogue()
  const selection = { ...base, chosen: ['revenue', 'inbox', 'calendar', 'pipeline'] }
  assert.deepEqual(validateSelection(selection, catalogue), [])
})

test('one tile over the cap is rejected', async () => {
  const catalogue = await loadCatalogue()
  const selection = { ...base, chosen: ['revenue', 'inbox', 'calendar', 'pipeline', 'tasks'] }
  const problems = validateSelection(selection, catalogue)
  assert.ok(problems.some((problem) => problem.includes(`holds ${catalogue.maxChosen}`)))
})

test('an unknown tile is rejected', async () => {
  const catalogue = await loadCatalogue()
  const problems = validateSelection({ ...base, chosen: ['crypto-ticker'] }, catalogue)
  assert.ok(problems.some((problem) => problem.includes('crypto-ticker')))
})

test('choosing a tile twice is rejected', async () => {
  const catalogue = await loadCatalogue()
  const problems = validateSelection({ ...base, chosen: ['revenue', 'revenue'] }, catalogue)
  assert.ok(problems.some((problem) => problem.includes('more than once')))
})

test('choosing a tile that is always on the board is rejected', async () => {
  const catalogue = await loadCatalogue()
  const problems = validateSelection({ ...base, chosen: ['today'] }, catalogue)
  assert.ok(problems.some((problem) => problem.includes('does not need choosing')))
})

test('a missing hero is reported', async () => {
  const catalogue = await loadCatalogue()
  const problems = validateSelection({ chosen: [] }, catalogue)
  assert.ok(problems.some((problem) => problem.startsWith('hero is required')))
})

test('a hero left as its placeholder is reported', async () => {
  const catalogue = await loadCatalogue()
  const problems = validateSelection({ hero: '<!-- fill: hero-metric -->', chosen: [] }, catalogue)
  assert.ok(problems.some((problem) => problem.includes('placeholder')))
  assert.ok(isUnfilled('<!-- fill: hero-metric -->'))
  assert.ok(!isUnfilled('hours-saved'))
})

test('a chosen tile with nothing wired behind it is reported', async () => {
  const catalogue = await loadCatalogue()
  const problems = validateSelection({ ...base, chosen: ['revenue'] }, catalogue, [])
  assert.ok(problems.some((problem) => problem.includes('no connection wired')))
})

test('tiles that need no wiring pass the connection check', async () => {
  const catalogue = await loadCatalogue()
  assert.deepEqual(validateSelection({ ...base, chosen: ['memory'] }, catalogue, []), [])
})

test('the board is the four fixed tiles plus whatever was chosen', async () => {
  const catalogue = await loadCatalogue()
  const board = boardFor({ ...base, chosen: ['revenue', 'tasks'] }, catalogue)
  assert.equal(board.length, 6)
  assert.deepEqual(board.slice(0, 4).map((tile) => tile.id), [
    'today',
    'workflows',
    'agents',
    'overnight'
  ])
  assert.deepEqual(board.slice(4).map((tile) => tile.id), ['revenue', 'tasks'])
})

test('the board never exceeds eight tiles at the cap', async () => {
  const catalogue = await loadCatalogue()
  const chosen = catalogue.choosable.slice(0, catalogue.maxChosen).map((tile) => tile.id)
  assert.equal(boardFor({ ...base, chosen }, catalogue).length, 8)
})

// The shipped tiles.yml is what every student starts from, so it has to be a valid starting
// point: no tiles chosen yet, and a hero still waiting to be filled in during onboarding.
test('the shipped selection parses and starts empty', async () => {
  const selection = await loadSelection()
  assert.deepEqual(selection.chosen, [])
  assert.ok(isUnfilled(selection.hero), 'tiles.yml should ship with its hero placeholder intact')
})
