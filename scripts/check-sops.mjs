// Checks a folder of lesson SOPs against the Level 2 acceptance criteria, section 6.
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const root = process.argv[2]
if (!root) { console.log('usage: node scripts/check-sops.mjs <folder>'); process.exit(2) }

const CRITERIA = [
  { id: 'L1', what: 'opens with an analogy',        test: (b) => /## 🧠 The big idea/.test(b) },
  { id: 'L2', what: 'states what you finish with',  test: (b) => /## 📌 What this lesson gives you/.test(b) },
  { id: 'L3', what: 'has an easy way',              test: (b) => /easy way/i.test(b) },
  { id: 'L4', what: 'has a manual way',             test: (b) => /manual way/i.test(b) },
  { id: 'L5', what: 'finished-when checklist',      test: (b) => /You've finished this lesson when/.test(b) && /- ☐/.test(b) },
  { id: 'L6', what: 'troubleshooting table',        test: (b) => /## 🔧 Troubleshooting/.test(b) && /What you saw \| What to do/.test(b) },
  { id: 'L7', what: 'under the hood',               test: (b) => /## 🔬 Under the hood/.test(b) },
  { id: 'L8', what: 'declares a duration',          test: (b) => /\*\*Duration:\*\*/.test(b) }
]

const files = (await readdir(root)).filter((f) => /^\d\d_.+\.md$/.test(f)).sort()
let failures = 0
console.log(`${files.length} lesson SOPs\n`)
for (const file of files) {
  const body = await readFile(path.join(root, file), 'utf8')
  const missing = CRITERIA.filter((c) => !c.test(body)).map((c) => `${c.id} (${c.what})`)
  const words = body.split(/\s+/).length
  if (missing.length) { failures += 1; console.log(`FAIL ${file}  ${words} words\n     missing: ${missing.join(', ')}`) }
  else console.log(`ok   ${file}  ${words} words`)
}
console.log(failures ? `\n${failures} SOP(s) incomplete` : `\nall ${files.length} SOPs carry L1-L8`)
process.exit(failures ? 1 : 0)
