// usage-probe.mjs — query the real subscription usage limits from Anthropic's
// OAuth usage endpoint (the same data the /usage screen shows).
//
// SECRET SAFETY: the OAuth token is read inside this process and used only in
// the Authorization header. It is NEVER printed. Output is limits/percentages
// only, and any token-shaped string is redacted before printing.

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const credPath = join(homedir(), '.claude', '.credentials.json');
if (!existsSync(credPath)) {
  console.log(JSON.stringify({ ok: false, reason: 'no local credentials file (keychain-based auth?)' }));
  process.exit(0);
}
const tok = JSON.parse(readFileSync(credPath, 'utf8'))?.claudeAiOauth?.accessToken;
if (!tok) {
  console.log(JSON.stringify({ ok: false, reason: 'credentials file has no accessToken' }));
  process.exit(0);
}

const redact = (s) => s.replaceAll(tok, '[REDACTED]').replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, '[REDACTED]');

try {
  const r = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: {
      Authorization: `Bearer ${tok}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'Content-Type': 'application/json',
    },
  });
  const body = await r.text();
  console.log(JSON.stringify({ ok: r.ok, status: r.status }));
  console.log(redact(body).slice(0, 2000));
} catch (e) {
  console.log(JSON.stringify({ ok: false, reason: String(e.message) }));
}
