import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { changedFiles, check, configuration, fingerprint, selectedFiles, snapshot } from './core.mjs';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'cli.mjs');
const good = 'export function example(value: boolean): number { if (value) { return 1; } return 0; }\n';
const bad = 'export function example(value: boolean): number { if (value) return 1; return 0; }\n';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-code-quality-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  await mkdir(join(root, '.pi'));
  await mkdir(join(root, 'src'));
  return realpath(root);
}

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
}

function invoke(root, ...args) {
  return spawnSync(process.execPath, [cli, 'check', '--cwd', root, ...args], { encoding: 'utf8' });
}

test('braces fail before the fix, pass after it, and ignore inline suppressions', async t => {
  const root = await fixture(t);
  const file = join(root, 'src', 'sample.ts');
  await writeFile(file, bad);
  const failure = invoke(root, file);
  assert.equal(failure.status, 1);
  assert.match(failure.stdout, /curly/);
  await writeFile(file, '/* eslint-disable curly */\n' + bad);
  assert.equal(invoke(root, file).status, 1);
  await writeFile(file, good);
  assert.equal(invoke(root, file).status, 0);
});

test('SonarJS computes cognitive complexity with the configured threshold from nested cwd', async t => {
  const root = await fixture(t);
  await writeFile(join(root, '.pi', 'code-quality.json'), JSON.stringify({ version: 1, cognitiveComplexity: 2, ignore: [] }));
  const file = join(root, 'src', 'complex.ts');
  await writeFile(file, 'function nested(a: boolean, b: boolean) { if (a) { if (b) { return 1; } } return 0; }');
  const result = await check(join(root, 'src'), ['complex.ts']);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].rule, 'sonarjs/cognitive-complexity');
  assert.match(result.diagnostics[0].message, /from 3 to the 2 allowed/);
});

test('configuration errors fail closed and disabled configuration is explicit', async t => {
  const root = await fixture(t);
  const path = join(root, '.pi', 'code-quality.json');
  const file = join(root, 'src', 'sample.ts');
  await writeFile(file, bad);
  for (const value of ['{', '{"version":1,"unknown":true}', '{"version":2}', '{"version":1,"ignore":"x"}', '{"version":1,"cognitiveComplexity":0}']) {
    await writeFile(path, value);
    assert.equal(invoke(root, file).status, 2, value);
  }
  await writeFile(path, '{"version":1,"enabled":false}');
  const result = invoke(root, file);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /disabled/);
});

test('generated files remain ignored with an empty ignore array and source paths with spaces work', async t => {
  const root = await fixture(t);
  await writeFile(join(root, '.pi', 'code-quality.json'), '{"version":1,"ignore":[]}');
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'dist', 'generated.ts'), bad);
  await writeFile(join(root, 'src', 'with spaces.ts'), good);
  const result = await check(root, ['dist/generated.ts', 'src/with spaces.ts', 'README.md']);
  assert.equal(result.checked, 1);
  assert.deepEqual(result.diagnostics, []);
  assert.equal((await configuration(join(root, 'src'))).root, root);
});

test('staged checks use index content for partially staged files', async t => {
  const root = await fixture(t);
  const path = join(root, 'src', 'partial.ts');
  await writeFile(path, bad);
  git(root, 'add', 'src/partial.ts');
  await writeFile(path, good);
  assert.equal(invoke(root, '--staged').status, 1);
  assert.equal(invoke(root, path).status, 0);
  git(root, 'add', 'src/partial.ts');
  await writeFile(path, bad);
  assert.equal(invoke(root, '--staged').status, 0);
  assert.equal(invoke(root, path).status, 1);
});

test('snapshots detect shell writes and ignore unchanged dirty files and deletions', async t => {
  const root = await fixture(t);
  const path = join(root, 'src', 'dirty.ts');
  await writeFile(path, good);
  const before = await snapshot(root);
  assert.deepEqual(await changedFiles(before, await snapshot(root)), []);
  await writeFile(path, bad);
  const after = await snapshot(root);
  assert.deepEqual(await changedFiles(before, after), [path]);
  await rm(path);
  assert.deepEqual(await changedFiles(after, await snapshot(root)), []);
});

test('snapshot detects files changed and committed within a shell command', async t => {
  const root = await fixture(t);
  const file = join(root, 'src', 'sample.ts');
  await writeFile(file, good);
  git(root, 'add', 'src/sample.ts');
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial');
  const before = await snapshot(root);
  await writeFile(file, bad);
  git(root, 'add', 'src/sample.ts');
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'changed');
  assert.deepEqual(await changedFiles(before, await snapshot(root)), [file]);
});

test('missing source, parse errors, options and cancelled Git operations are observable', async t => {
  const root = await fixture(t);
  assert.equal(invoke(root, 'missing.ts').status, 2);
  assert.equal(invoke(root, '--bad-flag').status, 2);
  assert.equal(invoke(root, '--staged', '--changed').status, 2);
  await writeFile(join(root, 'src', 'invalid.ts'), 'export function {');
  assert.equal(invoke(root, 'src/invalid.ts').status, 1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => selectedFiles(root, false, controller.signal), /abort/i);
  assert.deepEqual(await selectedFiles(root, true), []);
  assert.equal((await readFile(join(root, 'src', 'invalid.ts'), 'utf8')), 'export function {');
});

test('uppercase source extensions are checked and oversized source fails visibly', async t => {
  const root = await fixture(t);
  const file = join(root, 'src', 'sample.TS');
  await writeFile(file, bad);
  assert.equal(invoke(root, file).status, 1);
  await writeFile(file, ' '.repeat(2 * 1024 * 1024 + 1));
  const result = invoke(root, file);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /2 MiB/);
  await assert.rejects(() => snapshot(root), /2 MiB/);
});

test('initial commit made through shell cannot hide newly created source', async t => {
  const root = await fixture(t);
  const before = await snapshot(root);
  const file = join(root, 'src', 'sample.ts');
  await writeFile(file, bad);
  git(root, 'add', 'src/sample.ts');
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial');
  assert.deepEqual(await changedFiles(before, await snapshot(root)), [file]);
});

test('source-shaped FIFOs are rejected before reading', async t => {
  const root = await fixture(t);
  const fifo = join(root, 'pipe.ts');
  execFileSync('mkfifo', [fifo]);
  await assert.rejects(() => fingerprint(fifo), /regular source file/);
  assert.equal(invoke(root, fifo).status, 2);
});
