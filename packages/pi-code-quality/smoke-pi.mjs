import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageDir = dirname(fileURLToPath(import.meta.url));
const managed = join(homedir(), '.pi', 'agent', 'install');
const version = (await readFile(join(managed, 'current-version'), 'utf8')).trim();
const piRoot = process.env.PI_PACKAGE_ROOT ?? join(managed, 'releases', version, 'node_modules', '@earendil-works', 'pi-coding-agent');
const load = name => import(pathToFileURL(join(piRoot, 'dist', 'core', name)).href);
const { loadExtensions } = await load('extensions/loader.js');
const { createWriteTool } = await load('tools/write.js');
const { createEditTool } = await load('tools/edit.js');
const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-quality-smoke-')));
execFileSync('git', ['init', '-q', root]);
const messages = [];
const notifications = [];
const ctx = { cwd: root, sessionManager: {}, ui: { notify: (...args) => notifications.push(args), setStatus: () => {} } };
const loaded = await loadExtensions([join(packageDir, 'extension.ts'), join(packageDir, 'extension.ts')], root);
assert.deepEqual(loaded.errors, []);
loaded.runtime.sendMessage = message => messages.push(message);
const emit = async (name, event = {}) => {
  const results = [];
  for (const extension of loaded.extensions) {
    for (const handler of extension.handlers.get(name) ?? []) { results.push(await handler({ type: name, ...event }, ctx)); }
  }
  return results.filter(Boolean);
};

try {
  await emit('session_start');
  assert.equal(notifications.length, 0);
  const writer = createWriteTool(root);
  const input = { path: 'sample.ts', content: 'export function value(ok: boolean) { if (ok) return 1; return 0; }' };
  const result = await writer.execute('write-1', input);
  const failures = await emit('tool_result', { toolName: 'write', toolCallId: 'write-1', input, ...result, isError: false });
  assert.equal(failures.length, 1, 'duplicate extension registration must not duplicate diagnostics');
  assert.equal(failures[0].isError, true);
  assert.match(failures[0].content.at(-1).text, /edit was saved/);
  assert.match(failures[0].content.at(-1).text, /curly/);
  assert.equal(await readFile(join(root, input.path), 'utf8'), input.content);
  await emit('turn_end');
  assert.equal(messages.length, 0, 'checked edits should not be reported again at turn end');

  const editor = createEditTool(root);
  const replacement = { oldText: 'if (ok) return 1;', newText: 'if (ok) { return 1; }' };
  const edit = editor.parameters.properties.edits ? { path: 'sample.ts', edits: [replacement] } : { path: 'sample.ts', ...replacement };
  const edited = await editor.execute('edit-1', edit);
  assert.deepEqual(await emit('tool_result', { toolName: 'edit', toolCallId: 'edit-1', input: edit, ...edited, isError: false }), []);
  assert.deepEqual(await emit('tool_result', { toolName: 'write', input: { path: 'missing.ts' }, content: [], isError: true }), []);
  assert.deepEqual(await emit('tool_result', { toolName: 'write', input: { path: 'notes.md' }, content: [], isError: false }), []);

  await writeFile(join(root, 'shell.ts'), input.content);
  await emit('turn_end');
  assert.equal(messages.length, 1);
  assert.match(messages[0].content, /shell or other edits/);
  await emit('turn_end');
  assert.equal(messages.length, 1, 'unchanged violations must not cause an endless continuation');
  await rm(join(root, 'shell.ts'));
  await emit('turn_end');
  assert.equal(messages.length, 1, 'deletion must not be treated as a failed edit');

  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'dist', 'generated.ts'), ' '.repeat(2 * 1024 * 1024 + 1));
  assert.deepEqual(await emit('tool_result', { toolName: 'write', input: { path: 'dist/generated.ts' }, content: [], isError: false }), []);
  await mkdir(join(root, '.pi'));
  await writeFile(join(root, '.pi', 'code-quality.json'), '{"version":1,"enabled":false}');
  await writeFile(join(root, 'disabled.ts'), ' '.repeat(2 * 1024 * 1024 + 1));
  assert.deepEqual(await emit('tool_result', { toolName: 'write', input: { path: 'disabled.ts' }, content: [], isError: false }), []);
  await writeFile(join(root, '.pi', 'code-quality.json'), '{"version":1,"enabled":true}');
  const abort = new AbortController();
  abort.abort();
  ctx.signal = abort.signal;
  const cancelled = await emit('tool_result', { toolName: 'write', input, content: [], isError: false });
  assert.equal(cancelled[0].isError, true);
  assert.match(cancelled[0].content.at(-1).text, /cancelled/);
  await emit('session_shutdown');
  assert.deepEqual(await emit('tool_result', { toolName: 'write', input, content: [], isError: false }), []);
  console.log(`Pi ${version} loader + real write/edit tools: PASS (failure, repair, duplicate load, shell edits, deletion, failed tools, non-code, shutdown)`);
} finally {
  await rm(root, { recursive: true, force: true });
}
