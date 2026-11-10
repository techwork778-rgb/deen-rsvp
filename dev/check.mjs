// Syntax check for both deploy files: node dev/check.mjs
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';

const code = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
new Script(code, { filename: 'Code.gs' });
const html = readFileSync(new URL('../apps-script/Index.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
scripts.forEach((s, i) => new Script(s, { filename: `Index.html script ${i + 1}` }));
const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const used = [...new Set([...scripts.join('\n').matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]))];
const missing = used.filter((id) => !ids.has(id));
console.log(`Code.gs ok, ${scripts.length} inline script(s) ok, ${used.length} element ids used` + (missing.length ? `, MISSING: ${missing.join(', ')}` : ', none missing'));
if (missing.length) process.exit(1);
