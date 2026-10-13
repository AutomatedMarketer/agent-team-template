import test from 'node:test'
import assert from 'node:assert/strict'
import * as realFs from 'node:fs/promises'
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ALLOWED_ORDERS,
  CEILINGS,
  readAllowedOrders,
  runnableJobs,
  dayOf,
  readCounts,
  addCount,
  decide
} from '../scripts/lib/mailbox/allow.mjs'
import { ACTIONS } from '../scripts/lib/mailbox/contract.mjs'

/* Who decides what the Mac will do. Not the board and not the team repo: both are written to by others. The
   decision is a file on the Mac itself, in a state folder outside the code and the work copy, written by the
   person at the Mac. No file: nothing runs. A file that is a link, a folder, too big or not an allowlist reads as
   "unavailable" - never as "everything". */

const IDENTITY = { hostname: 'nunos-mac', username: 'nunotavares' }
const FILE = ALLOWED_ORDERS.file

const GOOD_LINES = [
  'board: https://board.example.com',
  'repo: ExampleOwner/example-team',
  'runner: mac-mini',
  'computer: Mac Mini',
  'actions: [task, move, approve, pause, run, arm, skill, agent]',
  'jobs:',
  '  - slug: morning-intel',
  '    minutes: 20',
  '  - slug: task-sweep',
  '    minutes: 30',
  'per_day:',
  '  orders: 40',
  '  runs: 6'
]
const GOOD = `${GOOD_LINES.join('\n')}\n`

async function folder(files = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mailbox-allow-'))
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text)
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

// A good file with one line swapped for another (matched by its start).
const swap = (start, replacement) => GOOD_LINES.map((line) => (line.startsWith(start) ? replacement : line)).join('\n') + '\n'
const without = (start) => GOOD_LINES.filter((line) => !line.startsWith(start)).join('\n') + '\n'

async function read(text) {
  const state = await folder({ [FILE]: text })
  try {
    return await readAllowedOrders(state.dir, IDENTITY)
  } finally {
    await state.cleanup()
  }
}

/* ---------- the file ---------------------------------------------------------------------------------------------- */

test('the allowlist is allowed-orders.yml in the runner\'s state folder, with hard ceilings the file cannot raise', () => {
  assert.deepEqual(ALLOWED_ORDERS, { file: 'allowed-orders.yml', maxBytes: 16 * 1024 })
  assert.deepEqual(CEILINGS, { orders: 40, runs: 6, refused: 100, minutes: 30, jobs: 40 })
})

test('a good allowlist reads as the board\'s address, the team repo, this computer, its actions, its jobs with their time and its day limits', async () => {
  const found = await read(GOOD)
  assert.equal(found.state, 'ok')
  assert.deepEqual(found.allow, {
    board: 'https://board.example.com',
    repo: 'ExampleOwner/example-team',
    runner: 'mac-mini',
    computer: 'Mac Mini',
    actions: ['task', 'move', 'approve', 'pause', 'run', 'arm', 'skill', 'agent'],
    jobs: new Map([['morning-intel', 20], ['task-sweep', 30]]),
    perDay: { orders: 40, runs: 6 }
  })
})

test('an allowlist written on Windows - with line endings of its own and a byte order mark - reads the same', async () => {
  const mark = String.fromCharCode(0xfeff)
  const expected = (await read(GOOD)).allow
  for (const text of [GOOD.replaceAll('\n', '\r\n'), mark + GOOD, mark + GOOD.replaceAll('\n', '\r\n')]) {
    assert.deepEqual((await read(text)).allow, expected)
  }
})

test('comments and blank lines are fine, a lower day limit is fine, and the board may end with a slash and be written in capitals', async () => {
  const text = ['# my Mac', '', ...GOOD_LINES.slice(0, 5).map((line) => line.replace('https://board.example.com', 'HTTPS://Board.Example.com/')), '# only these', ...GOOD_LINES.slice(5, 10), 'per_day:', '  orders: 5', '  runs: 0', ''].join('\n')
  const found = await read(text)
  assert.equal(found.state, 'ok')
  assert.equal(found.allow.board, 'https://board.example.com')
  assert.deepEqual(found.allow.perDay, { orders: 5, runs: 0 })
  const nothing = await read(swap('  orders:', '  orders: 0'))
  assert.equal(nothing.state, 'ok')
  assert.deepEqual(nothing.allow.perDay, { orders: 0, runs: 6 })
})

test('a part of a board address may be 63 letters, and no more', async () => {
  const found = await read(swap('board:', `board: https://${'a'.repeat(63)}.example.com`))
  assert.equal(found.state, 'ok')
  assert.equal(found.allow.board, `https://${'a'.repeat(63)}.example.com`)
})

test('an allowlist that lists no actions or no jobs is an allowlist that allows nothing - the person said so', async () => {
  const none = await read(swap('actions:', 'actions: []'))
  assert.equal(none.state, 'ok')
  assert.deepEqual(none.allow.actions, [])
  const noJobs = await read([...GOOD_LINES.slice(0, 5), 'jobs: []', ...GOOD_LINES.slice(10), ''].join('\n'))
  assert.equal(noJobs.state, 'ok')
  assert.deepEqual([...noJobs.allow.jobs], [])
})

test('actions can be written as a dashed list too', async () => {
  const text = GOOD.replace('actions: [task, move, approve, pause, run, arm, skill, agent]', 'actions:\n  - task\n  - run')
  assert.deepEqual((await read(text)).allow.actions, ['task', 'run'])
})

test('the same job more than once gets the shortest time written, not the first or the last; the same action twice is listed once', async () => {
  const text = GOOD.replace('actions: [task,', 'actions: [task, task,').replace('  - slug: task-sweep\n    minutes: 30\n', '  - slug: task-sweep\n    minutes: 30\n  - slug: morning-intel\n    minutes: 10\n  - slug: task-sweep\n    minutes: 30\n  - slug: morning-intel\n    minutes: 25\n')
  const found = await read(text)
  assert.deepEqual([...found.allow.jobs], [['morning-intel', 10], ['task-sweep', 30]])
  assert.equal(found.allow.actions.filter((action) => action === 'task').length, 1)
})

test('no folder, no file: missing, and nothing is allowed', async () => {
  const absent = await folder()
  try {
    assert.deepEqual(await readAllowedOrders(undefined, IDENTITY), { state: 'missing', allow: null })
    assert.deepEqual(await readAllowedOrders(join(absent.dir, 'not-there'), IDENTITY), { state: 'missing', allow: null })
    assert.deepEqual(await readAllowedOrders(absent.dir, IDENTITY), { state: 'missing', allow: null })
  } finally {
    await absent.cleanup()
  }
})

test('a file that is a folder, too big, empty, only comments or plain words: broken (unavailable), never everything', async () => {
  const asFolder = await folder()
  const big = await folder({ [FILE]: `${GOOD}# ${'x'.repeat(ALLOWED_ORDERS.maxBytes)}\n` })
  try {
    await mkdir(join(asFolder.dir, FILE))
    assert.deepEqual(await readAllowedOrders(asFolder.dir, IDENTITY), { state: 'broken', allow: null, why: 'file' })
    assert.deepEqual(await readAllowedOrders(big.dir, IDENTITY), { state: 'broken', allow: null, why: 'file' })
    for (const text of ['', '\n\n', '# nothing here\n', 'everything please\n', 'board\n', '{}\n', '[]\n', 'allow all\n']) {
      const found = await read(text)
      assert.equal(found.state, 'broken', JSON.stringify(text))
      assert.equal(found.allow, null)
    }
  } finally {
    await Promise.all([asFolder.cleanup(), big.cleanup()])
  }
})

test('a file that is a link is broken, whatever it points at', async () => {
  const state = await folder({ 'target.yml': GOOD })
  try {
    try {
      await symlink(join(state.dir, 'target.yml'), join(state.dir, FILE))
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') return
      throw error
    }
    assert.deepEqual(await readAllowedOrders(state.dir, IDENTITY), { state: 'broken', allow: null, why: 'file' })
  } finally {
    await state.cleanup()
  }
})

/* ---------- every line is held to its shape ------------------------------------------------------------------------ */

const BROKEN = [
  // [what is wrong, the text, the part it names]
  ['a board with http', swap('board:', 'board: http://board.example.com'), 'board'],
  ['a board with no scheme', swap('board:', 'board: board.example.com'), 'board'],
  ['a board with a user name in it', swap('board:', 'board: https://me@board.example.com'), 'board'],
  ['a board with a path', swap('board:', 'board: https://board.example.com/api'), 'board'],
  ['a board with a query', swap('board:', 'board: https://board.example.com?x=1'), 'board'],
  ['a board with an empty query', swap('board:', 'board: https://board.example.com/?'), 'board'],
  ['a board with a fragment', swap('board:', 'board: https://board.example.com#top'), 'board'],
  ['a board with a port', swap('board:', 'board: https://board.example.com:8443'), 'board'],
  ['a board that is an address of numbers', swap('board:', 'board: https://203.0.113.9'), 'board'],
  ['a board that is one word', swap('board:', 'board: https://localhost'), 'board'],
  ['a board that ends with a dot', swap('board:', 'board: https://board.example.com.'), 'board'],
  ['a board with a space in it', swap('board:', 'board: https://board .example.com'), 'board'],
  ['a board with a backslash', swap('board:', 'board: https:\\\\board.example.com'), 'board'],
  ['a board with an escape in its name', swap('board:', 'board: https://b%61rd.example.com'), 'board'],
  ['a board whose name starts with a dash', swap('board:', 'board: https://-board.example.com'), 'board'],
  ['a board whose ending is not letters', swap('board:', 'board: https://board.example.123'), 'board'],
  ['a board with a one-letter ending', swap('board:', 'board: https://board.example.c'), 'board'],
  ['a board with a tab inside its name', swap('board:', 'board: https://bo\tard.example.com'), 'board'],
  ['a board with a backslash after its name', swap('board:', 'board: https://board.example.com\\api'), 'board'],
  ['a board written as a list', swap('board:', 'board: [https://board.example.com]'), 'board'],
  ['a board with a part of 64 letters', swap('board:', `board: https://${'a'.repeat(64)}.example.com`), 'board'],
  ['a board whose ending has a number in it', swap('board:', 'board: https://board.example.1a'), 'board'],
  ['a board with a comment after it', swap('board:', 'board: https://board.example.com # mine'), 'board'],
  ['an empty board', swap('board:', 'board:'), 'board'],
  ['a repo that is not owner/name', swap('repo:', 'repo: example-team'), 'repo'],
  ['a repo with a space', swap('repo:', 'repo: Example Owner/example-team'), 'repo'],
  ['a runner in capitals', swap('runner:', 'runner: Mac-Mini'), 'runner'],
  ['a runner with a space', swap('runner:', 'runner: mac mini'), 'runner'],
  ['a runner that is too long', swap('runner:', `runner: ${'a'.repeat(33)}`), 'runner'],
  ['no computer name', without('computer:'), 'computer'],
  ['an empty computer name', swap('computer:', 'computer:'), 'computer'],
  ['a computer name the board would not show', swap('computer:', 'computer: Mac <Mini>'), 'computer'],
  ['a computer named after the machine', swap('computer:', 'computer: nunos-mac'), 'computer'],
  ['a computer name with the user in it', swap('computer:', 'computer: nunotavares laptop'), 'computer'],
  ['actions that are one word', swap('actions:', 'actions: task'), 'actions'],
  ['an action nobody knows', swap('actions:', 'actions: [task, taks]'), 'actions'],
  ['an action in capitals', swap('actions:', 'actions: [Task]'), 'actions'],
  ['an action that is a number', swap('actions:', 'actions: [task, 7]'), 'actions'],
  ['actions with a comment after them', swap('actions:', 'actions: [task, run] # these'), 'actions'],
  ['no actions line', without('actions:'), 'actions'],
  ['a job that is a bare word', GOOD.replace('  - slug: morning-intel\n    minutes: 20\n', '  - morning-intel\n'), 'jobs'],
  ['a job with no time', GOOD.replace('    minutes: 20\n', ''), 'jobs'],
  ['a job with no name', GOOD.replace('  - slug: morning-intel\n    minutes: 20\n', '  - minutes: 20\n'), 'jobs'],
  ['a job with a name that is not a slug', GOOD.replace('slug: morning-intel', 'slug: Morning Intel'), 'jobs'],
  ['a job named like a path', GOOD.replace('slug: morning-intel', 'slug: ../morning-intel'), 'jobs'],
  ['a job of 0 minutes', GOOD.replace('minutes: 20', 'minutes: 0'), 'jobs'],
  ['a job of 31 minutes', GOOD.replace('minutes: 30', 'minutes: 31'), 'jobs'],
  ['a job of minus 5 minutes', GOOD.replace('minutes: 20', 'minutes: -5'), 'jobs'],
  ['a job of half a minute', GOOD.replace('minutes: 20', 'minutes: 0.5'), 'jobs'],
  ['a job time in quotes', GOOD.replace('minutes: 20', 'minutes: "20"'), 'jobs'],
  ['a job time in words', GOOD.replace('minutes: 20', 'minutes: twenty'), 'jobs'],
  ['more than 40 jobs', GOOD.replace(/jobs:[\s\S]*per_day:/, `jobs:\n${Array.from({ length: 41 }, (_, at) => `  - slug: job-${at}\n    minutes: 5\n`).join('')}per_day:`), 'jobs'],
  ['no jobs line', GOOD.replace(/jobs:[\s\S]*per_day:/, 'per_day:'), 'jobs'],
  ['no day limits', GOOD.replace(/per_day:[\s\S]*$/, ''), 'per_day'],
  ['more than 40 orders a day', swap('  orders:', '  orders: 41'), 'per_day'],
  ['more than 6 runs a day', swap('  runs:', '  runs: 7'), 'per_day'],
  ['a negative number of orders', swap('  orders:', '  orders: -1'), 'per_day'],
  ['orders that are not a whole number', swap('  orders:', '  orders: 4.5'), 'per_day'],
  ['runs in words', swap('  runs:', '  runs: some'), 'per_day'],
  ['no runs line', without('  runs:'), 'per_day'],
  ['no orders line', without('  orders:'), 'per_day'],
  ['day limits written as one line', GOOD.replace('per_day:\n  orders: 40\n  runs: 6\n', 'per_day: { orders: 40, runs: 6 }\n'), 'per_day'],
  ['a key nobody knows', `${GOOD}everything: true\n`, 'key'],
  ['a key written twice', `${GOOD}runner: other-mac\n`, 'key'],
  ['a key with a prototype name', `__proto__: x\n${GOOD}`, 'key'],
  ['a job key nobody knows', GOOD.replace('    minutes: 20', '    minutes: 20\n    shell: yes'), 'line'],
  ['a job that starts with a key nobody knows', GOOD.replace('  - slug: morning-intel\n    minutes: 20\n', '  - shell: yes\n'), 'line'],
  ['a job that starts with a prototype key', GOOD.replace('  - slug: morning-intel\n    minutes: 20\n', '  - __proto__: yes\n'), 'line'],
  ['a job with a second key of this file\'s that is not a job\'s', GOOD.replace('    minutes: 20', '    minutes: 20\n    orders: 3'), 'jobs'],
  ['a job with two keys but not its own two', GOOD.replace('    minutes: 20', '    orders: 3'), 'jobs'],
  ['day limits with two keys but not their own two', swap('  runs:', '  minutes: 5'), 'per_day'],
  ['a day limit before its key', `  orders: 5\n${GOOD}`, 'key'],
  ['a day limit under a plain line', GOOD.replace('board: https://board.example.com', 'board: https://board.example.com\n  orders: 5'), 'key'],
  ['a line that is not a key or a list item', `${GOOD}hello there\n`, 'line'],
  ['a list item with no indent', GOOD.replace('actions: [task, move, approve, pause, run, arm, skill, agent]', 'actions:\n- task'), 'line']
]

for (const [name, text, part] of BROKEN) {
  test(`broken, nothing is allowed: ${name}`, async () => {
    const found = await read(text)
    assert.equal(found.state, 'broken')
    assert.equal(found.allow, null)
    assert.equal(found.why, part)
  })
}

test('a refusal names the part that is wrong and never repeats what was written there', async () => {
  const secret = ['sk', 'ant', 'api03', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('-')
  const found = await read(swap('board:', `board: https://${secret}.example.com/path`))
  assert.equal(found.state, 'broken')
  assert.ok(!JSON.stringify(found).includes(secret))
})

/* ---------- which jobs the code can run ---------------------------------------------------------------------------- */

test('a job runs only if the allowlist names it AND this code has rules for what it may change', async () => {
  const { allow } = await read(GOOD)
  assert.deepEqual(runnableJobs(allow, ['morning-intel', 'task-sweep', 'other']), ['morning-intel', 'task-sweep'])
  assert.deepEqual(runnableJobs(allow, ['morning-intel']), ['morning-intel'])
  assert.deepEqual(runnableJobs(allow, []), [])
  assert.deepEqual(runnableJobs({ ...allow, jobs: new Map([['zebra', 5], ['alpha', 5]]) }, ['zebra', 'alpha']), ['alpha', 'zebra'])
})

/* ---------- the day, and the day's counts -------------------------------------------------------------------------- */

test('a day is a New York day: it turns over at midnight there, in summer time and in winter time', () => {
  assert.equal(dayOf(Date.parse('2026-10-13T03:59:59Z')), '2026-10-12')
  assert.equal(dayOf(Date.parse('2026-10-13T04:00:00Z')), '2026-10-13')
  assert.equal(dayOf(Date.parse('2026-11-01T05:30:00Z')), '2026-11-01')
  assert.equal(dayOf(Date.parse('2026-11-02T04:59:59Z')), '2026-11-01')
  assert.equal(dayOf(Date.parse('2026-11-02T05:00:00Z')), '2026-11-02')
  assert.equal(dayOf(Date.parse('2026-01-01T04:59:59Z')), '2025-12-31')
  assert.equal(dayOf(Date.parse('2026-01-01T05:00:00Z')), '2026-01-01')
})

test('counts: none yet is zero; adding counts one thing at a time; the next day starts again', async () => {
  const state = await folder()
  const now = Date.parse('2026-10-12T14:05:00Z')
  try {
    assert.deepEqual(await readCounts(state.dir, now), { day: '2026-10-12', orders: 0, runs: 0, refused: 0 })
    assert.deepEqual(await addCount(state.dir, now, 'orders'), { day: '2026-10-12', orders: 1, runs: 0, refused: 0 })
    assert.deepEqual(await addCount(state.dir, now, 'orders'), { day: '2026-10-12', orders: 2, runs: 0, refused: 0 })
    assert.deepEqual(await addCount(state.dir, now, 'runs'), { day: '2026-10-12', orders: 2, runs: 1, refused: 0 })
    assert.deepEqual(await addCount(state.dir, now, 'refused'), { day: '2026-10-12', orders: 2, runs: 1, refused: 1 })
    assert.deepEqual(await readCounts(state.dir, now), { day: '2026-10-12', orders: 2, runs: 1, refused: 1 })
    assert.deepEqual(await readCounts(state.dir, now + 86400_000), { day: '2026-10-13', orders: 0, runs: 0, refused: 0 })
    assert.deepEqual(await readdir(join(state.dir, 'counts')), ['2026-10-12.json'])
  } finally {
    await state.cleanup()
  }
})

test('counts are written whole and for the owner only', async () => {
  const state = await folder()
  const now = Date.parse('2026-10-12T14:05:00Z')
  try {
    await addCount(state.dir, now, 'orders')
    const file = join(state.dir, 'counts', '2026-10-12.json')
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { day: '2026-10-12', orders: 1, runs: 0, refused: 0 })
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o077, 0)
  } finally {
    await state.cleanup()
  }
})

test('counts: a count that cannot be trusted reads as FULL, never as zero - a damaged file must not hand out a fresh day', async () => {
  const state = await folder()
  const now = Date.parse('2026-10-12T14:05:00Z')
  const file = join(state.dir, 'counts', '2026-10-12.json')
  const full = { day: '2026-10-12', orders: 40, runs: 6, refused: 100, broken: true }
  try {
    await mkdir(join(state.dir, 'counts'))
    const bad = [
      'not json',
      '',
      '[]',
      'null',
      '{"day":"2026-10-12","orders":-1,"runs":0,"refused":0}',
      '{"day":"2026-10-12","orders":"3","runs":0,"refused":0}',
      '{"day":"2026-10-12","orders":1.5,"runs":0,"refused":0}',
      '{"day":"2026-10-12","orders":1,"runs":0}',
      '{"day":"2026-10-12","orders":1,"runs":0,"refused":0,"more":1}',
      '{"day":"2026-10-11","orders":1,"runs":0,"refused":0}',
      '{"day":"2026-10-12","orders":100000,"runs":0,"refused":0}'
    ]
    for (const text of bad) {
      await writeFile(file, text)
      assert.deepEqual(await readCounts(state.dir, now), full, text)
      assert.equal(await addCount(state.dir, now, 'orders'), null, `${text} must not be counted on`)
      assert.equal(await readFile(file, 'utf8'), text, 'a damaged file is left as it is for the person to look at')
    }
    await rm(file)
    await mkdir(file)
    assert.deepEqual(await readCounts(state.dir, now), full, 'a folder where the file should be')
  } finally {
    await state.cleanup()
  }
})

test('counts: a counts folder that is a file or a link reads as full', async () => {
  const asFile = await folder({ counts: 'x' })
  const target = await folder()
  const linked = await folder()
  const now = Date.parse('2026-10-12T14:05:00Z')
  try {
    assert.equal((await readCounts(asFile.dir, now)).broken, true)
    assert.equal(await addCount(asFile.dir, now, 'orders'), null)
    try {
      await symlink(target.dir, join(linked.dir, 'counts'), 'junction')
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') return
      throw error
    }
    assert.equal((await readCounts(linked.dir, now)).broken, true)
    assert.equal(await addCount(linked.dir, now, 'orders'), null)
    assert.deepEqual(await readdir(target.dir), [])
  } finally {
    await Promise.all([asFile.cleanup(), target.cleanup(), linked.cleanup()])
  }
})

test('counts: a folder that cannot be looked at reads as full, not as nothing counted', async () => {
  const refusing = {
    async lstat() {
      throw Object.assign(new Error('a message with a path in it'), { code: 'EACCES' })
    }
  }
  const found = await readCounts('/state', Date.parse('2026-10-12T14:05:00Z'), refusing)
  assert.deepEqual(found, { day: '2026-10-12', orders: 40, runs: 6, refused: 100, broken: true })
})

test('counts: a count may be as big as 10000 and no bigger', async () => {
  const state = await folder()
  const now = Date.parse('2026-10-12T14:05:00Z')
  try {
    await mkdir(join(state.dir, 'counts'))
    const file = join(state.dir, 'counts', '2026-10-12.json')
    await writeFile(file, '{"day":"2026-10-12","orders":10000,"runs":0,"refused":0}')
    assert.deepEqual(await readCounts(state.dir, now), { day: '2026-10-12', orders: 10000, runs: 0, refused: 0 })
    await writeFile(file, '{"day":"2026-10-12","orders":10001,"runs":0,"refused":0}')
    assert.equal((await readCounts(state.dir, now)).broken, true)
  } finally {
    await state.cleanup()
  }
})

test('counts are written for the owner only - asked for in the write itself, since Windows would not show it', async () => {
  const state = await folder()
  const writes = []
  const recording = {
    ...realFs,
    async writeFile(path, data, options) {
      writes.push(options)
      return realFs.writeFile(path, data, options)
    }
  }
  try {
    await addCount(state.dir, Date.parse('2026-10-12T14:05:00Z'), 'orders', recording)
    assert.deepEqual(writes, [{ mode: 0o600 }])
  } finally {
    await state.cleanup()
  }
})

test('counts: only orders, runs and refused can be counted', async () => {
  const state = await folder()
  try {
    for (const kind of ['order', 'ORDERS', '__proto__', 'day', '', undefined, 7]) {
      await assert.rejects(addCount(state.dir, Date.parse('2026-10-12T14:05:00Z'), kind), /count/, String(kind))
    }
  } finally {
    await state.cleanup()
  }
})

/* ---------- may this order be done --------------------------------------------------------------------------------- */

const ALLOW = {
  board: 'https://board.example.com',
  repo: 'ExampleOwner/example-team',
  runner: 'mac-mini',
  computer: 'Mac Mini',
  actions: ['task', 'move', 'approve', 'pause', 'run', 'arm', 'skill', 'agent'],
  jobs: new Map([['morning-intel', 20], ['task-sweep', 30]]),
  perDay: { orders: 40, runs: 6 }
}
const NONE_YET = { day: '2026-10-12', orders: 0, runs: 0, refused: 0 }
const RUNNABLE = ['morning-intel', 'task-sweep']

test('decide: an action on the list is done, and a run carries its time limit', () => {
  assert.deepEqual(decide(ALLOW, NONE_YET, 'task', { title: 'Chase the invoice' }, RUNNABLE), { ok: true })
  assert.deepEqual(decide(ALLOW, NONE_YET, 'run', { workflow: 'morning-intel' }, RUNNABLE), { ok: true, minutes: 20 })
  assert.deepEqual(decide(ALLOW, NONE_YET, 'run', { workflow: 'task-sweep' }, RUNNABLE), { ok: true, minutes: 30 })
})

test('decide: every one of the contract\'s actions can be allowed, and one that is not listed is not-allowed', () => {
  for (const action of ACTIONS) {
    const fields = action === 'run' ? { workflow: 'morning-intel' } : {}
    assert.equal(decide(ALLOW, NONE_YET, action, fields, RUNNABLE).ok, true, action)
    const narrowed = { ...ALLOW, actions: ACTIONS.filter((one) => one !== action) }
    assert.deepEqual(decide(narrowed, NONE_YET, action, fields, RUNNABLE), { ok: false, why: 'not-allowed' }, action)
  }
  assert.deepEqual(decide(ALLOW, NONE_YET, 'delete-everything', {}, RUNNABLE), { ok: false, why: 'not-allowed' })
  assert.deepEqual(decide(ALLOW, NONE_YET, '__proto__', {}, RUNNABLE), { ok: false, why: 'not-allowed' })
})

test('decide: a run of a job that is not on the list, or that this code has no rules for, is job-not-allowed', () => {
  assert.deepEqual(decide(ALLOW, NONE_YET, 'run', { workflow: 'weekly-report' }, RUNNABLE), { ok: false, why: 'job-not-allowed' })
  assert.deepEqual(decide(ALLOW, NONE_YET, 'run', { workflow: 'morning-intel' }, ['task-sweep']), { ok: false, why: 'job-not-allowed' })
  assert.deepEqual(decide(ALLOW, NONE_YET, 'run', { workflow: '__proto__' }, RUNNABLE), { ok: false, why: 'job-not-allowed' })
  assert.deepEqual(decide(ALLOW, NONE_YET, 'run', {}, RUNNABLE), { ok: false, why: 'job-not-allowed' })
})

test('decide: a job both lists name must be in the allowlist too - a run never gets a time limit from nowhere', () => {
  assert.deepEqual(decide(ALLOW, NONE_YET, 'run', { workflow: 'weekly-report' }, [...RUNNABLE, 'weekly-report']), { ok: false, why: 'job-not-allowed' })
})

test('decide: the other actions do not need their job on the list - pausing a schedule or asking for one is not a run', () => {
  assert.equal(decide(ALLOW, NONE_YET, 'pause', { workflow: 'weekly-report' }, RUNNABLE).ok, true)
  assert.equal(decide(ALLOW, NONE_YET, 'arm', { workflow: 'weekly-report' }, RUNNABLE).ok, true)
})

test('decide: the day limits stop an order at the number, and a run at its own number', () => {
  const perDay = { orders: 3, runs: 2 }
  const allow = { ...ALLOW, perDay }
  assert.equal(decide(allow, { ...NONE_YET, orders: 2 }, 'task', { title: 'x' }, RUNNABLE).ok, true)
  assert.deepEqual(decide(allow, { ...NONE_YET, orders: 3 }, 'task', { title: 'x' }, RUNNABLE), { ok: false, why: 'daily-limit' })
  assert.deepEqual(decide(allow, { ...NONE_YET, orders: 4 }, 'task', { title: 'x' }, RUNNABLE), { ok: false, why: 'daily-limit' })
  assert.equal(decide(allow, { ...NONE_YET, orders: 1, runs: 1 }, 'run', { workflow: 'morning-intel' }, RUNNABLE).ok, true)
  assert.deepEqual(decide(allow, { ...NONE_YET, orders: 1, runs: 2 }, 'run', { workflow: 'morning-intel' }, RUNNABLE), { ok: false, why: 'daily-limit' })
  assert.equal(decide(allow, { ...NONE_YET, orders: 1, runs: 2 }, 'task', { title: 'x' }, RUNNABLE).ok, true, 'runs used up does not stop a card')
  assert.deepEqual(decide({ ...allow, perDay: { orders: 3, runs: 0 } }, NONE_YET, 'run', { workflow: 'morning-intel' }, RUNNABLE), { ok: false, why: 'daily-limit' })
})

test('decide: a count that cannot be trusted stops everything', () => {
  const full = { day: '2026-10-12', orders: 40, runs: 6, refused: 100, broken: true }
  assert.deepEqual(decide(ALLOW, full, 'task', { title: 'x' }, RUNNABLE), { ok: false, why: 'daily-limit' })
  assert.deepEqual(decide({ ...ALLOW, perDay: { orders: 0, runs: 0 } }, full, 'task', { title: 'x' }, RUNNABLE), { ok: false, why: 'daily-limit' })
})

test('decide: the action is checked before the job, and the job before the day limit', () => {
  const full = { ...NONE_YET, orders: 40, runs: 6 }
  assert.deepEqual(decide({ ...ALLOW, actions: [] }, full, 'run', { workflow: 'weekly-report' }, RUNNABLE), { ok: false, why: 'not-allowed' })
  assert.deepEqual(decide(ALLOW, full, 'run', { workflow: 'weekly-report' }, RUNNABLE), { ok: false, why: 'job-not-allowed' })
  assert.deepEqual(decide(ALLOW, full, 'run', { workflow: 'morning-intel' }, RUNNABLE), { ok: false, why: 'daily-limit' })
})
