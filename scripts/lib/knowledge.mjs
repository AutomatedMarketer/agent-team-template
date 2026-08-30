// Whether a specialist's knowledge file has been ANSWERED with a refusal, rather than just left
// empty. Both halves matter: the shipped templates quote "I do not sell" inside their own
// guidance paragraph, so matching the phrase alone marks every fresh clone as not in use.
//
// Kept in step with agent-cockpit's api/lib.js, which makes the same judgement for the board.
const NOT_IN_USE = /\b(?:i|we)\s+do\s+not\s+(?:sell|deal\s+with\s+customers|have\s+customers)\b/i

export function fillMarkers(source) {
  return [...String(source ?? '').matchAll(/<!--\s*fill:\s*([a-z0-9-]+)\s*-->/g)].map((m) => m[1])
}

export function notInUse(knowledgeBody) {
  if (typeof knowledgeBody !== 'string' || !knowledgeBody) return false
  if (fillMarkers(knowledgeBody).length) return false
  return NOT_IN_USE.test(knowledgeBody)
}
