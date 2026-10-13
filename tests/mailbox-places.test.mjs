import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultPlaces, checkPlaces } from '../scripts/lib/mailbox/places.mjs'

/* Four places on the computer, and they must not overlap. The code is pinned by hand and never changes under a run;
   the work copy is reset to the team repo before every order; the state folder holds what must survive (what has been
   claimed, the allowlist, the counts); the secrets file stays out of both clones, which other people push to. A
   runner whose state folder is inside the work copy would have its allowlist wiped by the first reset - or, worse,
   rewritten by a push. */

async function root() {
  const dir = await mkdtemp(join(tmpdir(), 'mailbox-places-'))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

const siblings = (dir) => ({
  stateDir: join(dir, 'state'),
  codeDir: join(dir, 'code'),
  workDir: join(dir, 'work'),
  envFile: join(dir, 'config', 'env')
})

test('the usual places are under the person\'s home, in four separate folders', () => {
  const home = join(tmpdir(), 'home-of-someone')
  assert.deepEqual(defaultPlaces(home), {
    stateDir: join(home, '.local', 'state', 'agent-mailbox'),
    codeDir: join(home, '.local', 'share', 'agent-mailbox', 'runner-code'),
    workDir: join(home, '.local', 'share', 'agent-mailbox', 'work'),
    envFile: join(home, '.config', 'agent-mailbox', 'env')
  })
})

test('the usual places do not overlap, and none is made yet', async () => {
  const home = await root()
  try {
    assert.deepEqual(await checkPlaces(defaultPlaces(home.dir)), { ok: true })
  } finally {
    await home.cleanup()
  }
})

test('four places that are apart are fine, whether or not they exist yet, and a name that starts like another is not inside it', async () => {
  const dir = await root()
  try {
    const places = siblings(dir.dir)
    assert.deepEqual(await checkPlaces(places), { ok: true })
    await Promise.all([places.stateDir, places.codeDir, places.workDir].map((place) => mkdir(place)))
    assert.deepEqual(await checkPlaces(places), { ok: true })
    assert.deepEqual(await checkPlaces({ ...places, workDir: join(dir.dir, 'work2'), stateDir: join(dir.dir, 'work-state') }), { ok: true })
    assert.deepEqual(await checkPlaces({ ...places, envFile: join(places.stateDir, 'env') }), { ok: true }, 'the secrets file may sit in the state folder')
  } finally {
    await dir.cleanup()
  }
})

const OVERLAPS = [
  ['state is code', (p) => ({ ...p, stateDir: p.codeDir }), 'state-inside-code'],
  ['state is inside code', (p) => ({ ...p, stateDir: join(p.codeDir, 'state') }), 'state-inside-code'],
  ['state is work', (p) => ({ ...p, stateDir: p.workDir }), 'state-inside-work'],
  ['state is inside work', (p) => ({ ...p, stateDir: join(p.workDir, '.state') }), 'state-inside-work'],
  ['code is inside state', (p) => ({ ...p, codeDir: join(p.stateDir, 'code') }), 'code-inside-state'],
  ['work is inside state', (p) => ({ ...p, workDir: join(p.stateDir, 'work') }), 'work-inside-state'],
  ['work is inside code', (p) => ({ ...p, workDir: join(p.codeDir, 'work') }), 'work-inside-code'],
  ['code is inside work', (p) => ({ ...p, codeDir: join(p.workDir, 'code') }), 'code-inside-work'],
  ['code is work', (p) => ({ ...p, workDir: p.codeDir }), 'work-inside-code'],
  ['the secrets file is in the code', (p) => ({ ...p, envFile: join(p.codeDir, 'env') }), 'env-inside-code'],
  ['the secrets file is in the work copy', (p) => ({ ...p, envFile: join(p.workDir, 'sub', 'env') }), 'env-inside-work']
]

for (const [name, change, why] of OVERLAPS) {
  test(`overlap, the runner will not start: ${name}`, async () => {
    const dir = await root()
    try {
      const places = change(siblings(dir.dir))
      assert.deepEqual(await checkPlaces(places), { ok: false, why })
      for (const place of [places.stateDir, places.codeDir, places.workDir]) await mkdir(place, { recursive: true })
      assert.deepEqual(await checkPlaces(places), { ok: false, why }, 'the same when the folders exist')
    } finally {
      await dir.cleanup()
    }
  })
}

test('a folder reached through a link counts as where it really is', async () => {
  const dir = await root()
  try {
    const places = siblings(dir.dir)
    await mkdir(places.workDir)
    await mkdir(join(places.workDir, 'inner'))
    try {
      await symlink(join(places.workDir, 'inner'), places.stateDir, 'junction')
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') return
      throw error
    }
    assert.deepEqual(await checkPlaces(places), { ok: false, why: 'state-inside-work' })
  } finally {
    await dir.cleanup()
  }
})

test('on a system that ignores case in file names, a folder in other capitals is the same folder', async (t) => {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return t.skip('this system tells capitals apart')
  const dir = await root()
  try {
    const places = siblings(dir.dir)
    assert.deepEqual(await checkPlaces({ ...places, stateDir: places.workDir.toUpperCase() }), { ok: false, why: 'state-inside-work' })
  } finally {
    await dir.cleanup()
  }
})

test('every place must be a full path', async () => {
  const dir = await root()
  try {
    const places = siblings(dir.dir)
    for (const name of Object.keys(places)) {
      for (const bad of ['', 'relative/path', '.', '~/state', undefined, null, 7, {}]) {
        assert.deepEqual(await checkPlaces({ ...places, [name]: bad }), { ok: false, why: 'path' }, `${name}: ${String(bad)}`)
      }
    }
  } finally {
    await dir.cleanup()
  }
})
