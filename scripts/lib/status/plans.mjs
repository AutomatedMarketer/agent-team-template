// Plan names: "Max 20x", "Pro". Each comes from a closed list, so whatever a sign-in file holds,
// the only thing that can reach the usage file is one of the names below - an unknown plan is
// "not recognised", never echoed back.

import { join } from 'node:path'
import { isPlainObject, readJson } from './util.mjs'
import { codexHomeDir } from './codex-limits.mjs'

const notRecognised = { status: 'unavailable', why: 'plan not recognised' }

const CLAUDE_PLANS = { pro: 'Pro', team: 'Team', enterprise: 'Enterprise', free: 'Free' }

// account: { subscriptionType, rateLimitTier } from the Claude sign-in, or null if there is none.
export function claudePlan(account) {
  if (!isPlainObject(account)) return { status: 'not found' }
  const type = typeof account.subscriptionType === 'string' ? account.subscriptionType.trim().toLowerCase() : ''
  if (!type) return { status: 'not found' }
  if (type === 'max') {
    const tier = typeof account.rateLimitTier === 'string' ? account.rateLimitTier.toLowerCase() : ''
    if (/(^|_)max_20x$/.test(tier)) return { status: 'found', name: 'Max 20x' }
    if (/(^|_)max_5x$/.test(tier)) return { status: 'found', name: 'Max 5x' }
    // Max with a tier nobody has seen yet is still Max; the multiplier is the part left unsaid.
    return { status: 'found', name: 'Max' }
  }
  if (Object.hasOwn(CLAUDE_PLANS, type)) return { status: 'found', name: CLAUDE_PLANS[type] }
  return { ...notRecognised }
}

const CODEX_PLANS = {
  free: 'Free',
  go: 'Go',
  plus: 'Plus',
  pro: 'Pro',
  team: 'Team',
  business: 'Business',
  enterprise: 'Enterprise',
  edu: 'Edu'
}

export function codexPlanName(planType) {
  const word = typeof planType === 'string' ? planType.trim().toLowerCase() : ''
  if (!word) return { status: 'not found' }
  return Object.hasOwn(CODEX_PLANS, word) ? { status: 'found', name: CODEX_PLANS[word] } : { ...notRecognised }
}

// The id token also carries the person's email and name. It is decoded in memory, the plan word
// is looked up, and the rest is dropped on the floor - no other claim is ever read out of it.
function planWordFromIdToken(idToken) {
  const parts = idToken.split('.')
  if (parts.length !== 3) return { broken: true }
  let claims
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    return { broken: true }
  }
  if (!isPlainObject(claims)) return { broken: true }
  const auth = claims['https://api.openai.com/auth']
  const word = isPlainObject(auth) && auth.chatgpt_plan_type !== undefined ? auth.chatgpt_plan_type : claims.chatgpt_plan_type
  return { word }
}

// deps: { home, env }
export async function collectCodexPlan(deps) {
  const file = await readJson(join(codexHomeDir(deps), 'auth.json'))
  if (file.state === 'missing') return { status: 'not found' }
  if (file.state === 'broken' || !isPlainObject(file.value)) return { status: 'unavailable', why: 'sign-in not understood' }
  const idToken = file.value.tokens?.id_token
  // An API-key setup has no ChatGPT plan at all.
  if (typeof idToken !== 'string' || !idToken) return { status: 'not found' }
  const { broken, word } = planWordFromIdToken(idToken)
  if (broken) return { status: 'unavailable', why: 'sign-in not understood' }
  return codexPlanName(word)
}
