import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { chromium } = process.env.PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href)
  : await import('playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const server = fork(fileURLToPath(new URL('./static-server.mjs', import.meta.url)), [
  '--root', 'dist', '--base', '/exercise-heart-rate/', '--port', '8002',
], { cwd: root, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
let serverOutput = '';
server.stdout.on('data', chunk => { serverOutput += chunk; });
server.stderr.on('data', chunk => { serverOutput += chunk; });
let browser;
let passed = 0;
const check = message => { passed++; console.log(`PASS ${message}`); };

async function stopServer() {
  if (server.exitCode !== null || server.signalCode !== null) return;
  await new Promise(resolve => {
    const force = setTimeout(() => server.kill('SIGKILL'), 3000);
    server.once('exit', () => { clearTimeout(force); resolve(); });
    server.kill('SIGTERM');
  });
}

try {
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Test server startup timed out. ${serverOutput}`)), 10000);
    const onError = error => { clearTimeout(timer); reject(error); };
    server.once('error', onError);
    server.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`Test server exited with code ${code}. ${serverOutput}`));
    });
    server.on('message', message => {
      if (message.ready) { clearTimeout(timer); resolve(message.url); }
    });
  });
  const baseUrl = new URL(base);
  browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_BROWSER_PATH ? { executablePath: process.env.PLAYWRIGHT_BROWSER_PATH } : {}),
  });
  const context = await browser.newContext();
  // A missing BLE adapter must not prevent the deployed demo or local recording.
  await context.addInitScript(() => Object.defineProperty(navigator, 'bluetooth', { value: undefined, configurable: true }));
  const seen = new Set();
  const errors = [];
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === baseUrl.origin && url.pathname.startsWith(baseUrl.pathname)) return route.continue();
    errors.push(`Unexpected asset URL: ${url.href}`);
    return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    const url = new URL(response.url());
    seen.add(url.pathname.slice(baseUrl.pathname.length));
    if (!response.ok()) errors.push(`HTTP ${response.status()}: ${response.url()}`);
  });
  page.on('requestfailed', request => errors.push(`Request failed: ${request.url()}`));
  await page.clock.install();
  await page.goto(base);
  await page.waitForSelector('body[data-ready="true"]');
  await page.waitForFunction(() => document.getElementById('placeholder-0').hidden);
  assert.equal(await page.locator('.device-card').count(), 4);
  assert.equal(await page.locator('#chartError').isVisible(), false);
  for (const asset of ['assets/style.css', 'assets/vendor/chart.umd.min.js', 'assets/app.js',
    'assets/ble.js', 'assets/core.js', 'assets/storage.js', 'exercise-machine.jpg']) {
    assert.ok(seen.has(asset), `Missing project-relative asset: ${asset}`);
  }
  check('Built site renders four machines, modules, image and chart under a project subpath');

  await page.locator('#demoModeBtn').click();
  await page.waitForFunction(() => document.getElementById('liveCount').textContent === '4');
  await page.locator('#maxhr-0').fill('190');
  await page.locator('#maxhr-0').dispatchEvent('change');
  await page.locator('#record-0').click();
  await page.waitForFunction(() => document.getElementById('recordLabel-0').textContent === '停止紀錄');
  await page.clock.runFor(3100);
  await page.waitForFunction(() => /已存 [3-9]\d* 筆/.test(document.getElementById('recordStatus-0').textContent));
  await page.locator('#record-0').click();
  await page.waitForFunction(() => document.getElementById('recordLabel-0').textContent === '開始紀錄');
  await page.waitForFunction(() => document.getElementById('historyList').textContent.includes('已完成'));
  const session = await page.locator('[data-session]').first().getAttribute('data-session');
  assert.ok(session);
  assert.equal(await page.locator('#liveCount').textContent(), '4');
  await page.reload();
  await page.waitForSelector('body[data-ready="true"]');
  assert.equal(await page.locator('#historyCount').textContent(), '1');
  assert.equal(await page.locator('[data-session]').first().getAttribute('data-session'), session);
  assert.match(await page.locator('#historyList').textContent(), /模擬/);
  assert.match(await page.locator('#historyList').textContent(), /已完成/);
  assert.equal(await page.locator('#maxhr-0').inputValue(), '190');
  await page.locator('[data-session]').first().click();
  await page.waitForSelector('#detailDialog[open]');
  assert.equal(await page.locator('#historyChartError').isVisible(), false);
  await page.locator('#detailDialog .close-dialog').click();
  check('Deployed demo records locally; history, chart and settings survive reload');

  const legacy = new URL('運動心率.html?from=legacy#historySection', base);
  await page.goto(legacy.href);
  await page.waitForURL(new URL('index.html?from=legacy#historySection', base).href);
  await page.waitForSelector('body[data-ready="true"]');
  assert.equal(await page.locator('#historyCount').textContent(), '1');
  check('Chinese entry redirects within the project and preserves query, hash and local records');

  for (const path of ['tests/', 'tests/browser.mjs', 'server.mjs', 'server.py', 'README.md', 'package.json']) {
    assert.equal((await fetch(new URL(path, base))).status, 404, `Unexpected published development file: ${path}`);
  }
  assert.equal((await fetch(new URL('/assets/app.js', base))).status, 404);
  assert.equal((await fetch(new URL('assets/', base))).status, 404);
  check('Deployment excludes test/server/documentation files and has no root-path fallback or directory listing');
  assert.deepEqual(errors, []);
  console.log(`\n${passed} GitHub Pages deployment checks passed.`);
} finally {
  try { await browser?.close(); }
  finally { await stopServer(); }
}
