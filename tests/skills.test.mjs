import test from 'node:test'
import assert from 'node:assert/strict'
import { read, listDir } from './helpers/repo.mjs'
import { parseFrontmatter } from '../scripts/lib/frontmatter.mjs'
import { auditText } from '../scripts/prompt-audit.mjs'
import { SCHEMA_ID } from '../scripts/lib/run-log.mjs'

const skillNames = async () =>
  (await listDir('.claude/skills')).filter((entry) => !entry.startsWith('.'))

test('every skill folder has a SKILL.md with name and description frontmatter', async () => {
  const skills = await skillNames()
  assert.ok(skills.includes('run-log'), 'the run-log skill is missing')
  for (const skill of skills) {
    const { data } = parseFrontmatter(await read(`.claude/skills/${skill}/SKILL.md`))
    assert.equal(data.name, skill, `${skill}/SKILL.md frontmatter name must match the folder`)
    assert.ok((data.description ?? '').length > 20, `${skill} needs a real description`)
  }
})

test('the run-log skill teaches the current schema and the no-colon filename', async () => {
  const skill = await read('.claude/skills/run-log/SKILL.md')
  assert.match(skill, new RegExp(SCHEMA_ID.replace('/', '\\/')))
  assert.match(skill, /CLAUDE_CODE_REMOTE_SESSION_ID/)
  assert.match(skill, /runs\/\d{4}-\d{2}\/|runs\/<YYYY-MM>\//)
  assert.match(skill, /same commit/i, 'the skill must say the artifact and log ship together')
})

test('every skill passes the prompt audit', async () => {
  for (const skill of await skillNames()) {
    const findings = auditText(await read(`.claude/skills/${skill}/SKILL.md`))
    assert.deepEqual(findings, [], `${skill}: ${JSON.stringify(findings)}`)
  }
})

test('no skill hands a student a shell-specific command', async () => {
  // Most students are on Windows, where PowerShell is the default shell. `date -u`,
  // `echo "$VAR"` and friends fail there. Three walkthrough logs hit this.
  const bashOnly = [
    /^\s*date\s+-u\b/m,
    /^\s*echo\s+"\$[A-Z_]+"/m,
    /^\s*export\s+[A-Z_]+=/m
  ]
  for (const skill of await skillNames()) {
    const body = await read(`.claude/skills/${skill}/SKILL.md`)
    for (const pattern of bashOnly) {
      assert.doesNotMatch(body, pattern, `${skill}/SKILL.md uses a command that fails in PowerShell`)
    }
  }
})

test('the run-log skill points at the cross-platform facts command', async () => {
  const skill = await read('.claude/skills/run-log/SKILL.md')
  assert.match(skill, /node scripts\/run-facts\.mjs/)
})
