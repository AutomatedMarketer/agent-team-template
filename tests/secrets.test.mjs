import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { read, repoRoot, allTextFiles } from './helpers/repo.mjs'

const SECRET_SHAPES = [
  /sk-ant-[A-Za-z0-9-]{10,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /AIza[0-9A-Za-z_-]{30,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/
]

test('.gitignore excludes .env before anything else', async () => {
  const gitignore = await read('.gitignore')
  assert.match(gitignore, /^\.env$/m, '.gitignore must contain a bare `.env` line')
  assert.match(gitignore, /^\.env\.\*$/m, '.gitignore must contain `.env.*`')
  assert.match(gitignore, /^!\.env\.example$/m, '.gitignore must re-include `.env.example`')
})

test('.env never appears in git history', () => {
  const tracked = execFileSync('git', ['log', '--all', '--pretty=format:', '--name-only'], {
    cwd: repoRoot,
    encoding: 'utf8'
  })
  const offenders = tracked
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line === '.env' || /^\.env\.(?!example)/.test(line))
  assert.deepEqual([...new Set(offenders)], [], 'a .env file was committed at some point')
})

test('.env.example holds names, never values', async () => {
  const example = await read('.env.example')
  for (const line of example.split('\n')) {
    if (!line.includes('=') || line.trim().startsWith('#')) continue
    const value = line.slice(line.indexOf('=') + 1).trim()
    assert.equal(value, '', `\`${line.trim()}\` must have an empty value`)
  }
})

test('no file in the working tree contains a credential shape', async () => {
  const findings = []
  for (const file of await allTextFiles()) {
    if (file === 'tests/secrets.test.mjs') continue
    const body = await read(file)
    for (const shape of SECRET_SHAPES) {
      if (shape.test(body)) findings.push(`${file} matched ${shape}`)
    }
  }
  assert.deepEqual(findings, [], findings.join('\n'))
})
