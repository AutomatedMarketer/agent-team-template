import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises'
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

/* A slash command the course tells somebody to type has to exist. The pairing runs across three
   repos - the lessons, the plugin's skills in agent-team-os, and this template's own - and nothing
   checked it, so renaming a skill in the plugin would have broken 41 references to /arm with no
   test anywhere going red.

   Both the course folder and the plugin are built here rather than borrowed, so the test says the
   same thing on a machine that has neither. */
const stubPlugin = async (skills) => {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-'))
  for (const skill of skills) {
    await mkdir(join(dir, 'skills', skill), { recursive: true })
    await writeFile(join(dir, 'skills', skill, 'SKILL.md'), `---\nname: ${skill}\ndescription: a stub skill used only to test the slash-command guard\n---\n`)
  }
  return dir
}

const courseNaming = async (line) => {
  const dir = await mkdtemp(join(tmpdir(), 'lessons-'))
  await writeFile(join(dir, '00-INDEX.md'), '# Index\n\n(120 minutes across 2 lessons)\n')
  await writeFile(join(dir, 'RUN_OF_SHOW.md'), '# stub\n')
  await writeFile(join(dir, 'PRESENTATION.md'), '# stub\n')
  await writeFile(join(dir, '13_TEAM_DAY.md'), `# L\n\n${line}\n`)
  return dir
}

test('the course check refuses a slash command that is not a skill anywhere', async () => {
  const plugin = await stubPlugin(['arm'])
  const lessons = await courseNaming('Then run `/ghost-command` to finish.')
  try {
    const output = await run(process.execPath, ['scripts/check-course-numbers.mjs', lessons],
      { cwd: root, env: { ...process.env, AGENT_TEAM_OS: plugin } })
      .catch((error) => ({ stdout: error.stdout ?? '', stderr: error.stderr ?? '' }))
      .then((result) => `${result.stdout ?? ''}${result.stderr ?? ''}`)
    assert.match(output, /names \/ghost-command, which is neither a skill/,
      'a command that exists nowhere was accepted')
  } finally {
    await rm(plugin, { recursive: true, force: true })
    await rm(lessons, { recursive: true, force: true })
  }
})

test('a command that IS a skill in the plugin resolves', async () => {
  const plugin = await stubPlugin(['arm'])
  const lessons = await courseNaming('Then run `/arm` to finish.')
  try {
    const output = await run(process.execPath, ['scripts/check-course-numbers.mjs', lessons],
      { cwd: root, env: { ...process.env, AGENT_TEAM_OS: plugin } })
      .catch((error) => ({ stdout: error.stdout ?? '', stderr: error.stderr ?? '' }))
      .then((result) => `${result.stdout ?? ''}${result.stderr ?? ''}`)
    assert.doesNotMatch(output, /names \/arm, which is neither a skill/,
      'a command that the plugin really ships was reported as dangling')
    assert.match(output, /slash-command references resolve to a real skill/,
      'the guard did not report on slash commands at all')
  } finally {
    await rm(plugin, { recursive: true, force: true })
    await rm(lessons, { recursive: true, force: true })
  }
})

// Half the commands live in the plugin, so a missing plugin must not let this pass by seeing
// nothing - which is the failure mode every guard in that file exists to avoid.
test('a missing plugin makes the slash-command check fail, not pass quietly', async () => {
  const lessons = await courseNaming('Then run `/arm` to finish.')
  try {
    const output = await run(process.execPath, ['scripts/check-course-numbers.mjs', lessons],
      { cwd: root, env: { ...process.env, AGENT_TEAM_OS: join(tmpdir(), 'no-plugin-here') } })
      .catch((error) => ({ stdout: error.stdout ?? '', stderr: error.stderr ?? '' }))
      .then((result) => `${result.stdout ?? ''}${result.stderr ?? ''}`)
    assert.match(output, /could not read the plugin's skills/, 'a missing plugin was passed over in silence')
    assert.doesNotMatch(output, /slash-command references resolve/, 'it claimed to have checked what it could not read')
  } finally {
    await rm(lessons, { recursive: true, force: true })
  }
})

/* Two weakenings survived the three tests above, and both are mistakes this repo has made before.
   Narrowing the file set to the numbered lessons drops RUN_OF_SHOW.md and PRESENTATION.md - 12 of
   the 41 /arm references - and the script's own comments say that exact narrowing was wrong twice.
   Narrowing the prefix class to a backtick drops 18 of the 146, including both /plugin lines.
   So this one names a command in PRESENTATION.md, with no backticks around it. */
test('the slash-command guard reads the run of show and the deck, not just the lessons', async () => {
  const plugin = await stubPlugin(['arm'])
  const lessons = await mkdtemp(join(tmpdir(), 'lessons-'))
  try {
    await writeFile(join(lessons, '00-INDEX.md'), '# Index\n\n(120 minutes across 2 lessons)\n')
    await writeFile(join(lessons, 'RUN_OF_SHOW.md'), '# stub\n')
    await writeFile(join(lessons, '13_TEAM_DAY.md'), '# L\n\nNothing to see here.\n')
    // Un-backticked, at the start of a line, in the deck - the shape a slide actually uses.
    await writeFile(join(lessons, 'PRESENTATION.md'), '# Deck\n\n/slide-only-command\n')
    const output = await run(process.execPath, ['scripts/check-course-numbers.mjs', lessons],
      { cwd: root, env: { ...process.env, AGENT_TEAM_OS: plugin } })
      .catch((error) => ({ stdout: error.stdout ?? '', stderr: error.stderr ?? '' }))
      .then((result) => `${result.stdout ?? ''}${result.stderr ?? ''}`)
    assert.match(output, /PRESENTATION\.md:3: names \/slide-only-command/,
      'a command named in the deck, without backticks, was never looked at')
  } finally {
    await rm(plugin, { recursive: true, force: true })
    await rm(lessons, { recursive: true, force: true })
  }
})
