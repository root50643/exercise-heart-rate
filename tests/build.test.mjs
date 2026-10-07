import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { buildSite } from '../scripts/build.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
async function fixture(t) {
  const tempRoot = await realpath(tmpdir());
  const root = await mkdtemp(join(tempRoot, 'exercise-heart-rate-build-'));
  t.after(async () => {
    // Only remove the exact temporary fixture created by this test.
    assert.equal(dirname(resolve(root)), tempRoot);
    assert.ok(basename(root).startsWith('exercise-heart-rate-build-'));
    await rm(root, { recursive: true, force: true });
  });
  for (const name of ['index.html', '運動心率.html', 'exercise-machine.jpg', 'assets']) {
    await cp(join(projectRoot, name), join(root, name), { recursive: true });
  }
  return root;
}
async function filenames(folder, prefix = '') {
  const result = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) result.push(...await filenames(join(folder, entry.name), `${name}/`));
    else result.push(name);
  }
  return result.sort();
}

test('public build includes only runtime assets and vendor license, and replaces stale output', async (t) => {
  const root = await fixture(t);
  for (const name of ['test-results/real-heart-rate.csv', 'tests/private.test.mjs', '.env', 'README.md', 'assets/debug.json', 'assets/notes.md', 'assets/.private/token.js']) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), 'DO NOT PUBLISH');
  }
  const files = await buildSite(root);
  assert.deepEqual(await filenames(join(root, 'dist')), files);
  for (const name of ['index.html', '運動心率.html', 'exercise-machine.jpg', 'assets/app.js', 'assets/style.css', 'assets/vendor/chart.umd.min.js', 'assets/vendor/Chart.js-LICENSE.md', '.nojekyll']) {
    assert.ok(files.includes(name), `Missing public file: ${name}`);
  }
  assert.ok(files.every((name) => ['index.html', '運動心率.html', 'exercise-machine.jpg', '.nojekyll'].includes(name)
    || /^assets\/(?!.*(?:^|\/)\.)[^]+\.(?:js|css)$/.test(name)
    || /^assets\/.*license.*\.md$/i.test(name)));
  assert.ok(!files.some((name) => /(?:debug|private|notes|test-results|README|\.env)/.test(name)));
  assert.equal(await readFile(join(root, 'dist', 'index.html'), 'utf8'), await readFile(join(root, 'index.html'), 'utf8'));
  await writeFile(join(root, 'dist', 'stale-private.csv'), 'DO NOT KEEP');
  assert.deepEqual(await buildSite(root), files);
  assert.deepEqual(await filenames(join(root, 'dist')), files);
  assert.equal(await readFile(join(root, '.env'), 'utf8'), 'DO NOT PUBLISH');
});

test('deployed HTML and modules resolve inside a GitHub Pages project subpath', async (t) => {
  const root = await fixture(t);
  const files = await buildSite(root);
  const base = new URL('https://example.github.io/exercise-heart-rate/');
  const validate = (reference, parent = new URL('index.html', base)) => {
    if (/^(?:data:|#)/.test(reference)) return;
    assert.ok(reference.startsWith('./') || reference.startsWith('../'), `Expected relative asset: ${reference}`);
    const target = new URL(reference, parent);
    assert.equal(target.origin, base.origin);
    assert.ok(target.pathname.startsWith(base.pathname), `Escaped Pages subpath: ${target.href}`);
    const name = decodeURIComponent(target.pathname.slice(base.pathname.length));
    assert.ok(files.includes(name), `Missing dependency: ${name}`);
  };
  const html = await readFile(join(root, 'dist', 'index.html'), 'utf8');
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) validate(match[1]);
  for (const name of files.filter((name) => name.endsWith('.js') && !name.includes('/vendor/'))) {
    const source = await readFile(join(root, 'dist', ...name.split('/')), 'utf8');
    for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) validate(match[1], new URL(name, base));
    for (const match of source.matchAll(/\bimage\.src\s*=\s*['"]([^'"]+)['"]/g)) validate(match[1]);
  }
  const legacy = await readFile(join(root, 'dist', '運動心率.html'), 'utf8');
  const script = legacy.match(/<script>([\s\S]*?)<\/script>/)[1];
  for (const folder of ['https://example.github.io/', base.href]) {
    const current = new URL('運動心率.html?demo=1#historySection', folder);
    let redirected;
    runInNewContext(script, { URL, location: { href: current.href, search: current.search, hash: current.hash, replace: (url) => { redirected = url; } } });
    assert.equal(redirected, new URL('index.html?demo=1#historySection', folder).href);
  }
});

test('build refuses a linked dist directory and preserves its target', async (t) => {
  const root = await fixture(t);
  const target = join(root, 'private-target');
  await mkdir(target);
  await writeFile(join(target, 'sentinel.txt'), 'KEEP');
  await symlink(target, join(root, 'dist'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(buildSite(root), /dist must be a real directory/);
  assert.equal(await readFile(join(target, 'sentinel.txt'), 'utf8'), 'KEEP');
});
