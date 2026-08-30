import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, readFile, rm, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))

/* check-course-numbers.mjs grades a lesson's sample block by RUNNING the command and comparing.
   That needs a ledger.yml and a proposals.yml to read, and it used to make them by copying the
   examples INTO the repo root and deleting them afterwards. Two costs: a crash between the write
   and the delete strands a file that looks exactly like the student's own, and a repo where
   somebody had ACTUALLY done the work already had those files, so the guard refused and graded
   nothing. */

const runQuiet = (args, cwd = root) =>
  run(process.execPath, args, { cwd })
    .catch((error) => ({ stdout: error.stdout ?? '', stderr: error.stderr ?? '' }))
    .then((result) => `${result.stdout ?? ''}${result.stderr ?? ''}`)

test('check-proposals.mjs reads its data from a root you give it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'proposals-root-'))
  try {
    await writeFile(join(dir, 'ledger.yml'), await readFile(join(root, 'ledger.example.yml'), 'utf8'))
    await writeFile(join(dir, 'proposals.yml'), await readFile(join(root, 'proposals.example.yml'), 'utf8'))
    assert.match(
      await runQuiet(['scripts/check-proposals.mjs', dir]),
      /proposals?, covering/,
      'the data root was ignored - without it the guard has to write fixtures into the repo itself'
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('check-ledger.mjs reads its data from a root you give it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-root-'))
  try {
    await writeFile(join(dir, 'ledger.yml'), await readFile(join(root, 'ledger.example.yml'), 'utf8'))
    assert.match(
      await runQuiet(['scripts/check-ledger.mjs', dir]),
      /^Your week: /m,
      'check-ledger did not read the ledger it was pointed at'
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* The one that matters, and it runs in a SCRATCH COPY of the repo - never this one.
   Two earlier versions of this test were wrong in ways worth recording:

   It wrote a ledger.yml into the real repo root. That broke `npm test` for any student who had
   reached Lesson 15, which is the same defect being fixed here with a wider blast radius - and it
   raced with readme.test.mjs, which spawns the whole suite again in the same directory.

   And it asserted only that the guard did not REFUSE, which the fix could be gutted and still
   pass: delete the data root from the spawn and the guard grades the lesson against whatever
   ledger.yml is lying around. So the scratch repo gets a DIFFERENT ledger from the example, and
   the sample block below is the example's output. It can only be found if the fixture was read. */
const scratchRepo = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'course-repo-'))
  await cp(root, dir, {
    recursive: true,
    filter: (src) => !/[\\\/](node_modules|\.git|tests)([\\\/]|$)/.test(src)
  })
  return dir
}

const lessonStub = (line) => `# L\n\n\`\`\`\n${line}\n\`\`\`\n`

const stubCourse = async (ledgerLine, matchLine) => {
  const dir = await mkdtemp(join(tmpdir(), 'lessons-'))
  await writeFile(join(dir, '00-INDEX.md'), '# Index\n\n(120 minutes across 2 lessons)\n')
  await writeFile(join(dir, 'RUN_OF_SHOW.md'), '# stub\n')
  await writeFile(join(dir, 'PRESENTATION.md'), '# stub\n')
  await writeFile(join(dir, '15_YOUR_LEDGER.md'), lessonStub(ledgerLine))
  // Both sample blocks, deliberately. With only the ledger one, dropping proposals.example.yml
  // from the fixtures passed every test while making check:course report a correct lesson broken.
  await writeFile(join(dir, '16_THE_MATCH.md'), lessonStub(matchLine))
  return dir
}

test('the course check grades against the example, not against the student ledger sitting there', async () => {
  const scratch = await scratchRepo()
  // What check-ledger.mjs prints for ledger.example.yml. The student ledger written below prints
  // "Your week: 0.0 hours a week" instead, so this line appears only if the example was used.
  // What check-ledger.mjs and check-proposals.mjs print for the EXAMPLE files. The scratch repo
  // below gets a different ledger (prints 'Your week: 0.0 hours a week') and empty proposals
  // (prints '0 proposals, ...'), so neither line can be found unless the fixtures were read.
  const lessons = await stubCourse(
    'Your week: 16.3 hours a week - $2,438 a week',
    '2 proposals, covering 6.3 hours a week - $950 a week'
  )
  const studentLedger = join(scratch, 'ledger.yml')
  const ledgerText = 'owner_type: job\ntasks: []\n'
  const proposalsText = 'proposals: []\n'

  try {
    await writeFile(studentLedger, ledgerText)
    await writeFile(join(scratch, 'proposals.yml'), proposalsText)

    const output = await runQuiet([join(scratch, 'scripts', 'check-course-numbers.mjs'), lessons], scratch)

    // Proves the run reached the code under test. Without this the assertions below pass on any
    // early crash - which is exactly how a thinner version of this test fooled itself.
    assert.match(output, /15_YOUR_LEDGER\.md/,
      'the run never reached the sample-block guard, so it proves nothing about it')
    assert.doesNotMatch(output, /cannot grade sample blocks/,
      'the guard refused to run because the student had done the work - that is the defect')
    assert.match(output, /15_YOUR_LEDGER\.md: every line of its sample block is real output/,
      'the sample block was graded against the student ledger, not the example - the fixture was not used')
    assert.match(output, /16_THE_MATCH\.md: every line of its sample block is real output/,
      'the proposals sample was not graded against the example - that fixture was not read')

    assert.equal(await readFile(studentLedger, 'utf8'), ledgerText, "the student's ledger was modified")
    assert.equal(await readFile(join(scratch, 'proposals.yml'), 'utf8'), proposalsText,
      "the student's proposals were modified")
  } finally {
    await rm(lessons, { recursive: true, force: true })
    await rm(scratch, { recursive: true, force: true })
  }
})

// Guards the shape rather than the symptom: a fixture written into the repo under test is what
// made this fail, and a future edit could reintroduce it while every check stays green.
test('the course check never writes a fixture into the repo it is checking', async () => {
  const source = await readFile(join(root, 'scripts', 'check-course-numbers.mjs'), 'utf8')
  // Deliberately specific. A bare `mkdtemp(` passes even if somebody points it at templateRoot,
  // which puts the fixtures straight back inside the repo under test - the original defect, one
  // token away, with this guard still green.
  assert.match(source, /mkdtemp\(path\.join\(tmpdir\(\)/,
    'fixtures must be made under the OS temp directory, not anywhere inside the repo')
  assert.match(source, /finally \{[\s\S]*?rm\(dir, \{ recursive: true, force: true \}\)/,
    'the temp directory must be removed even when the run throws')
  assert.doesNotMatch(
    source,
    /writeFile\(\s*(target|path\.join\(templateRoot)/,
    'this writes into the repo under test - the exact shape that made the guard unrunnable'
  )
})
