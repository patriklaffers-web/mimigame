// Bundles index.html + the JS modules into one self-contained HTML file
// that can be opened directly (double-click) without a web server.
import { readFileSync, writeFileSync } from 'node:fs';
const strip = (src) => src
  .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*$/gm, '')
  .replace(/^export\s+(?=(const|function|class|let)\b)/gm, '');
const js = ['spike.js', 'programs.js', 'app.js'].map((f) => `// ---- ${f}\n${strip(readFileSync(f, 'utf8'))}`).join('\n');
const html = readFileSync('index.html', 'utf8')
  .replace('<script type="module" src="app.js"></script>', () => `<script type="module">\n${js}\n</script>`);
writeFileSync('spike-car-remote.html', html);
console.log('wrote spike-car-remote.html', html.length, 'bytes');
