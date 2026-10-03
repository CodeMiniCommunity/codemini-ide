// Runs every *.e2e.js in this folder against the app served from the repo root.
//   npm run test:e2e              all suites
//   npm run test:e2e -- preloader only suites whose file name contains "preloader"
// The suites expect the app on http://localhost:8765, so this serves it there.
// Requires Playwright (npm install && npx playwright install chromium).
const path = require('path');
const { spawn } = require('child_process');
const { createServer } = require('./lib/static-server');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 8765;
const filter = process.argv[2];
const suites = require('fs').readdirSync(__dirname).filter(f => f.endsWith('.e2e.js') && (!filter || f.includes(filter))).sort();

if (!suites.length) { console.error('No e2e suites matched.'); process.exit(2); }

const server = createServer(ROOT);
server.listen(PORT, async () => {
  const results = [];
  for (const file of suites) {
    console.log(`\n=== ${file} ===`);
    const code = await new Promise(resolve => {
      const p = spawn(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit', cwd: ROOT });
      p.on('exit', c => resolve(c === null ? 1 : c));
    });
    results.push([file, code]);
  }
  server.close();
  console.log('\n--- e2e summary ---');
  for (const [f, c] of results) console.log(`${c === 0 ? 'PASS' : 'FAIL'}  ${f}`);
  process.exit(results.every(([, c]) => c === 0) ? 0 : 1);
});
server.on('error', e => { console.error(`Cannot listen on port ${PORT}: ${e.message}`); process.exit(2); });
