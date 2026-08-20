import test from 'node:test'
import assert from 'node:assert/strict'
import { exists } from './helpers/repo.mjs'

const REQUIRED_PATHS = [
  'CLAUDE.md',
  '.gitattributes',
  '.gitignore',
  '.env.example',
  'package.json',
  '.claude/settings.json',
  '.claude/agents',
  '.claude/skills',
  '.claude/rules',
  'shared',
  'shared/standards/prompt-blocks',
  'skills/README.md',
  'agents',
  'runs',
  'runs/README.md',
  'runs/heartbeat',
  'scripts/lib',
  'workflows',
  'workflows/README.md',
  'tiles',
  'tiles/catalogue.json',
  'tiles.yml',
  'runtimes.yml',
  'connections/register.yml',
  'connections/README.md',
  'connections/recipes/README.md',
  '.claude/skills/connect/SKILL.md',
  'inbox',
  'tasks',
  'tasks/README.md',
  '.claude/skills/sync/SKILL.md'
]

test('every required path exists', async () => {
  const missing = []
  for (const target of REQUIRED_PATHS) {
    if (!(await exists(target))) missing.push(target)
  }
  assert.deepEqual(missing, [], `missing: ${missing.join(', ')}`)
})
