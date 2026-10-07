// A pretend home folder for the status collector tests. Every credential, email and folder name
// in it is invented, and the fake tokens are assembled at run time so no file in this repo holds a
// credential shape (tests/secrets.test.mjs scans for exactly that).

import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

export const FAKE_USERNAME = 'fakeperson'
export const FAKE_HOSTNAME = 'fake-host-77'
export const FAKE_EMAIL = 'fake.person' + '@' + 'example.com'
export const FAKE_UUID = '0f0e0d0c-1111-2222-3333-444455556666'

export const fakeClaudeToken = () => 'sk-' + 'ant-' + 'oat01-' + 'x'.repeat(40)
export const fakeRefreshToken = () => 'sk-' + 'ant-' + 'ort01-' + 'y'.repeat(40)

const base64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')

// A JWT-shaped id token. The header really does start "eyJ", which is the point: the gate has to
// stop it if any part of it ever travels toward an output.
export function fakeIdToken(claims) {
  return [base64url({ alg: 'none', typ: 'JWT' }), base64url(claims), 'c2lnbmF0dXJl'].join('.')
}

export async function makeFakeHome(files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agent-status-'))
  const home = join(root, 'Users', FAKE_USERNAME)
  await mkdir(home, { recursive: true })
  for (const [relative, content] of Object.entries(files)) {
    await writeAt(home, relative, content)
  }
  return {
    root,
    home,
    identity: { username: FAKE_USERNAME, home, hostname: FAKE_HOSTNAME },
    write: (relative, content) => writeAt(home, relative, content),
    cleanup: () => rm(root, { recursive: true, force: true })
  }
}

async function writeAt(home, relative, content) {
  const target = join(home, ...relative.split('/'))
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, typeof content === 'string' ? content : JSON.stringify(content))
  return target
}

export async function setMtime(path, when) {
  const seconds = when / 1000
  await utimes(path, seconds, seconds)
}

// Records every call, answers with whatever the test hands it. Never touches the network.
export function fetchStub(respond) {
  const calls = []
  const stub = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    const answer = await respond(String(url), init)
    if (answer instanceof Error) throw answer
    const { status = 200, body = {} } = answer
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
      json: async () => JSON.parse(text)
    }
  }
  stub.calls = calls
  return stub
}

export function execStub(respond) {
  const calls = []
  const stub = async (file, args, options) => {
    calls.push({ file, args, options })
    const answer = await respond(file, args)
    if (answer instanceof Error) throw answer
    return { stdout: answer, stderr: '' }
  }
  stub.calls = calls
  return stub
}

// Catches anything a module prints while a test runs, so "never logged" is checked, not assumed.
export async function captureConsole(work) {
  const printed = []
  const original = { log: console.log, error: console.error, warn: console.warn, info: console.info }
  for (const name of Object.keys(original)) {
    console[name] = (...args) => printed.push(args.map(String).join(' '))
  }
  try {
    const result = await work()
    return { result, printed }
  } finally {
    Object.assign(console, original)
  }
}
