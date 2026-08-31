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

// The refusal has to be found in the owner's OWN WORDS, not in the instructions that show them
// what to write. Both files open with a paragraph that quotes the sentence as an example, wrapped
// in markdown emphasis and quotation marks:
//
//     *"I do not sell - I work for this business and the selling is <name>'s job"*
//
// "No fill markers left" is not enough on its own, and that is where this broke: it separates a
// FRESH file from an answered one, and the case that bites is an ANSWERED one. A business owner
// who answers every question and leaves the instructions in place - nothing tells them to delete
// it - satisfied both halves, and the board marked their sales AND customer-service agents "Not in
// use". Exactly backwards, on two of eight agents, on the screen they look at every day.
//
// Strip that example and what is left is what the owner wrote. What identifies it is not its
// punctuation but the `<name>` still sitting inside it: an unfilled placeholder, the same family
// of thing as a `<!-- fill: -->` marker, and this function already refuses to judge a file that
// still has one of those. Anybody who answered has a real name in there, or no name at all.
//
// Two earlier attempts got this wrong in the same direction, so the reasoning is worth keeping:
//
//   - Splitting the file at its first `## ` heading broke two ways at once. Demote the headings to
//     `###`, indent one by a space, or paste a fenced block, and the false positive came straight
//     back; write the refusal above the first heading and it stopped being seen at all.
//   - Stripping ANY `*"..."*` span broke the other way. The guidance shows the sentence in that
//     exact punctuation as "something like" what to write, so a person who copies the format and
//     changes the words - a fair reading - had their real refusal thrown away.
//
// Both failures came from inferring intent out of shape. The placeholder is content, and it is
// the thing that is only ever true of text nobody has answered yet.
//
// The lasting guard is not this regex either. It is the test that fills in the REAL shipped files
// and checks they read as in use. Reword the guidance so its example no longer carries `<name>`
// and that test fails - which is the moment to come back here.
const QUOTED_EXAMPLE = /\*"[\s\S]*?"\*/g
const UNFILLED_NAME = /<name>/i

export function ownWords(knowledgeBody) {
  return String(knowledgeBody ?? '').replace(QUOTED_EXAMPLE, (span) =>
    UNFILLED_NAME.test(span) ? ' ' : span
  )
}

export function notInUse(knowledgeBody) {
  if (typeof knowledgeBody !== 'string' || !knowledgeBody) return false
  if (fillMarkers(knowledgeBody).length) return false
  return NOT_IN_USE.test(ownWords(knowledgeBody))
}

// A knowledge file is in one of exactly two good states, and a test that demands the first one
// fails every repo that reached the second.
//
//   SHIPPED   - still carries fill markers, so /onboard and /audit can see what is blank
//   ANSWERED  - the markers are gone and there is prose under a heading
//
// Both files ship with instructions telling the owner to "delete the rest of the file's markers,
// and you are done". The test asserting the markers are present therefore contradicted the file's
// own text, and passed only because the TEMPLATE's copy is never the one that gets answered. In a
// student's repo it failed permanently from the moment they followed lesson 9 or 10 - under a
// README that says "If this fails, the clone is broken".
export function answered(body) {
  const text = String(body ?? '')
  if (fillMarkers(text).length) return false
  return text
    .split('\n')
    .some((line) => {
      const trimmed = line.trim()
      return trimmed.length > 0 && !trimmed.startsWith('#')
    })
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
