// A fake Claude for the self-test. The self-test asks Claude to try nine things in a fixed order (see selftest.mjs) and reads the
// transcript to see what became of each. This one does what a Claude that is confined as it should be would do: it tries every step,
// and is refused each one that reaches outside its own folder. Options make it misbehave, so a test can see the self-test notice:
//   through     steps (3-7, outside) that are let through, really reading or writing the file
//   skip        steps that are never tried
//   unanswered  steps that are tried and never answered
//   refuseInside  its own folder is refused too (the allow rules are broken, so a refusal elsewhere would prove nothing)
//   when(args)  whether the misbehaviour applies to this run (the web run has its own list of tools)
//   say(steps, cwd)  one more line the assistant says (to put a secret into what it says)
//   initTools(args)  the tools it says it has, when that is not the usual list
//   before(cwd, steps, args)  something to do or check before it starts (what is planted, where)
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const said = (content) => ({ type: 'assistant', message: { content: [{ type: 'text', text: content }] } })
const used = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } })
const answered = (id, content, isError) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } })

// The text in backticks on numbered line `step` of the prompt: a full path for steps 3 to 7, a name in its own folder for 8 and 9.
export function stepsOf(prompt) {
  const steps = {}
  for (let step = 3; step <= 9; step += 1) steps[step] = new RegExp(`^${step}\\. [^\`\\n]*\`([^\`]+)\``, 'm').exec(prompt)?.[1] ?? null
  return steps
}

const STEPS = [[3, 'Read'], [4, 'Read'], [5, 'Read'], [6, 'Write'], [7, 'Write'], [8, 'Read'], [9, 'Write']]

export function confinedClaude(w, { when = () => true, through = [], skip = [], unanswered = [], refuseInside = false, say = null, before = null, initTools = null } = {}) {
  return async (cwd, args) => {
    const steps = stepsOf(args[1])
    await before?.(cwd, steps, args)
    const misbehaves = when(args)
    const events = [initTools ? { ...w.INIT, tools: initTools(args) } : w.INIT]
    for (const [step, tool] of STEPS) {
      const inside = step >= 8
      if (misbehaves && skip.includes(step)) continue
      const id = `t${step}`
      events.push(used(id, tool, { file_path: steps[step] }))
      if (misbehaves && unanswered.includes(step)) continue
      const lets = inside ? !refuseInside : misbehaves && through.includes(step)
      if (!lets) {
        events.push(answered(id, `Permission to use ${tool} has been denied.`, true))
        continue
      }
      const target = inside ? join(cwd, steps[step]) : steps[step]
      if (tool === 'Read') {
        events.push(answered(id, [{ type: 'text', text: `1\t${(await readFile(target, 'utf8')).trim()}` }], false))
      } else {
        await writeFile(target, 'done')
        events.push(answered(id, `File created successfully at: ${steps[step]}`, false))
      }
    }
    if (say) events.push(said(await say(steps, cwd)))
    events.push(said('Went through all nine steps.'), w.RESULT)
    return events
  }
}
