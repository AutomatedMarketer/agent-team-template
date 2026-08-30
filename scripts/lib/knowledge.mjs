import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// Whether a specialist's knowledge file has been ANSWERED with a refusal, rather than just left
// empty. Both halves matter: the shipped templates quote "I do not sell" inside their own
// guidance paragraph, so matching the phrase alone marks every fresh clone as not in use.
//
// Kept in step with agent-cockpit's api/lib.js, which makes the same judgement for the board.
const NOT_IN_USE = /\b(?:i|we)\s+do\s+not\s+(?:sell|deal\s+with\s+customers|have\s+customers)\b/i

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

// The two specialists whose work belongs to the business rather than to the person doing the job,
// so they are the two an employee routinely switches off. ONE copy of this map, because it was
// briefly two and heading for three: check:arming had its own, the board has its own mirror, and
// the matcher had none at all - which is how a switched-off agent came to be the top-ranked answer
// to a bid coordinator's week and passed every check on the way to being proposed.
export const KNOWLEDGE = {
  sales: 'agents/sales/knowledge/offer-sheet.md',
  'customer-service': 'agents/customer-service/knowledge/faq.md'
}

export function fillMarkers(source) {
  return [...String(source ?? '').matchAll(/<!--\s*fill:\s*([a-z0-9-]+)\s*-->/g)].map((m) => m[1])
}

export function notInUse(knowledgeBody) {
  if (typeof knowledgeBody !== 'string' || !knowledgeBody) return false
  if (fillMarkers(knowledgeBody).length) return false
  return NOT_IN_USE.test(knowledgeBody)
}

// The slugs of the agents this owner has said, in their own knowledge file, do not apply to them.
// A missing file is not a refusal: a repo that never had one is not the same as a repo where
// somebody wrote "I do not sell".
export async function notInUseAgents(root = repoRoot) {
  const off = new Set()
  for (const [slug, relative] of Object.entries(KNOWLEDGE)) {
    const body = await readFile(path.join(root, relative), 'utf8').catch(() => null)
    if (notInUse(body)) off.add(slug)
  }
  return off
}
