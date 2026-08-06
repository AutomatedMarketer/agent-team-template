// A deliberately small YAML-subset parser: flat `key: value` pairs only.
// Agent and skill frontmatter never needs more, and this keeps the repo dependency-free.
export function parseFrontmatter(source) {
  const normalised = source.replace(/\r\n/g, '\n')
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalised)
  if (!match) return { data: {}, body: normalised }
  const data = {}
  for (const line of match[1].split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!pair) continue
    data[pair[1]] = pair[2].trim().replace(/^["']|["']$/g, '')
  }
  return { data, body: normalised.slice(match[0].length) }
}
