// Inlines src/ into one self-contained page, built twice:
//   apps-script/Index.html  pasted into Apps Script (talks to the server through google.script.run)
//   site/index.html         hosted on GitHub Pages (talks to the Apps Script web app over fetch)
//   dev/site-local.html     the hosted page wired to the local dev server, for testing
// Run: node build.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOGO } from './src/logo.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(root, p), 'utf8');
const { apiUrl } = JSON.parse(read('deploy.json'));

const d = [...LOGO.parts.map((p) => p.d), ...LOGO.dots.map((p) => p.d), LOGO.properties.d].join('');
const symbol = `<symbol id="deen-logo" viewBox="0 -2 1016 458"><path fill="currentColor" fill-rule="evenodd" d="${d}"/></symbol>`;

const js = ['src/app-core.js', 'src/app-sand.js', 'src/app-board.js', 'src/app-views.js'].map(read).join('\n');
if (/<\/script/i.test(js)) throw new Error('app code contains </script>');
if (!js.includes("'__API_URL__'")) throw new Error('API_URL placeholder missing from app-core.js');

function page(api) {
  const app = `(function () {\n${js.replace("'__API_URL__'", () => JSON.stringify(api))}\n})();`;
  return read('src/index.html')
    .replace('/*STYLES*/', () => read('src/styles.css'))
    .replace('<!--LOGO_SYMBOL-->', () => symbol)
    .replace('/*APP*/', () => app);
}

mkdirSync(join(root, 'site'), { recursive: true });
const outputs = [['apps-script/Index.html', ''], ['site/index.html', apiUrl], ['dev/site-local.html', '/__exec']];
for (const [file, api] of outputs) {
  const html = page(api);
  writeFileSync(join(root, file), html);
  console.log(`${file.padEnd(22)} ${(html.length / 1024).toFixed(1)} KB  ${api ? 'API ' + api.slice(0, 60) : 'google.script.run'}`);
}
