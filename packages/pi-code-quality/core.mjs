import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, matchesGlob, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

export const VERSION = '0.1.0';
const run = promisify(execFile);
const EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const DEFAULT_IGNORE = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/.next/**', '**/coverage/**', '**/*.min.js', '**/*.d.ts'];
const LIMIT = 2 * 1024 * 1024;

export async function git(cwd, args, signal) {
  return (await run('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 5000, maxBuffer: 8 * LIMIT, signal })).stdout;
}

export function supported(path) {
  return EXTENSIONS.has(extname(path).toLowerCase());
}

export async function projectRoot(cwd, signal) {
  try {
    return (await git(cwd, ['rev-parse', '--show-toplevel'], signal)).trim();
  } catch (error) {
    if (error.code === 128 && error.stderr?.includes('not a git repository')) {
      return realpath(cwd);
    }
    throw error;
  }
}

function validateConfig(config, path) {
  const keys = new Set(['version', 'enabled', 'cognitiveComplexity', 'ignore']);
  if (!config || Array.isArray(config) || typeof config !== 'object' || Object.keys(config).some(key => !keys.has(key))) {
    throw new Error(`Invalid code-quality configuration: ${path}`);
  }
  if (config.version !== 1 || (config.enabled !== undefined && typeof config.enabled !== 'boolean')) {
    throw new Error(`Expected version: 1 and boolean enabled in ${path}`);
  }
  if (config.cognitiveComplexity !== undefined && (!Number.isInteger(config.cognitiveComplexity) || config.cognitiveComplexity < 1 || config.cognitiveComplexity > 100)) {
    throw new Error(`cognitiveComplexity must be an integer from 1 to 100 in ${path}`);
  }
  if (config.ignore !== undefined && (!Array.isArray(config.ignore) || config.ignore.length > 1000 || config.ignore.some(value => typeof value !== 'string'))) {
    throw new Error(`ignore must be an array of glob strings in ${path}`);
  }
  return config;
}

export async function configuration(cwd, signal) {
  const root = await projectRoot(cwd, signal);
  const path = join(root, '.pi', 'code-quality.json');
  let config = {};
  try {
    config = validateConfig(JSON.parse(await readFile(path, 'utf8')), path);
  } catch (error) {
    if (error.code !== 'ENOENT') { throw error; }
  }
  return { root, enabled: true, cognitiveComplexity: 15, ...config, ignore: [...DEFAULT_IGNORE, ...(config.ignore ?? [])] };
}

function included(file, config) {
  const path = relative(config.root, file).split('\\').join('/');
  return supported(file) && !config.ignore.some(pattern => matchesGlob(path, pattern));
}

async function readSource(file, config, staged, signal) {
  if (staged) {
    const path = relative(config.root, file).split('\\').join('/');
    if (path.startsWith('../') || isAbsolute(path)) { throw new Error(`Staged file is outside the repository: ${file}`); }
    const content = await git(config.root, ['show', `:${path}`], signal);
    if (Buffer.byteLength(content) > LIMIT) { throw new Error(`File exceeds the 2 MiB lint limit: ${file}`); }
    return content;
  }
  const info = await stat(file);
  if (!info.isFile() || info.size > LIMIT) { throw new Error(`Expected a regular source file of at most 2 MiB: ${file}`); }
  return readFile(file, { encoding: 'utf8', signal });
}

export async function selectedFiles(cwd, staged, signal) {
  const root = await projectRoot(cwd, signal);
  if (staged) {
    return (await git(root, ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], signal)).split('\0').filter(Boolean).map(file => resolve(root, file));
  }
  const tracked = await git(root, ['diff', '--name-only', '--diff-filter=ACMR', '-z', 'HEAD'], signal).catch(async error => {
    if (error.code === 128 && /bad revision|ambiguous argument/.test(error.stderr)) {
      return git(root, ['ls-files', '--cached', '-z'], signal);
    }
    throw error;
  });
  const untracked = await git(root, ['ls-files', '--others', '--exclude-standard', '-z'], signal);
  return [...new Set((tracked + untracked).split('\0').filter(Boolean))].map(file => resolve(root, file));
}

export async function check(cwd, files, { staged = false, signal } = {}) {
  const config = await configuration(cwd, signal);
  if (!config.enabled) { return { version: VERSION, enabled: false, checked: 0, diagnostics: [] }; }
  const canonicalCwd = await realpath(cwd);
  const [{ ESLint }, parser, sonar] = await Promise.all([import('eslint'), import('@typescript-eslint/parser'), import('eslint-plugin-sonarjs')]);
  const linter = new ESLint({
    cwd: config.root,
    overrideConfigFile: true,
    ignore: false,
    overrideConfig: [{
      files: ['**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}'],
      languageOptions: { parser: parser.default, parserOptions: { ecmaFeatures: { jsx: true } } },
      linterOptions: { noInlineConfig: true },
      plugins: { sonarjs: sonar.default },
      rules: { curly: ['error', 'all'], 'sonarjs/cognitive-complexity': ['error', config.cognitiveComplexity] },
    }],
  });
  const diagnostics = [];
  let checked = 0;
  for (const requested of [...new Set(files.map(file => resolve(canonicalCwd, file)))]) {
    signal?.throwIfAborted();
    if (!supported(requested)) { continue; }
    const file = staged ? requested : await realpath(requested);
    if (!included(file, config)) { continue; }
    const content = await readSource(file, config, staged, signal);
    // Use a virtual path inside the configured root, including for an absolute edit outside it.
    const virtual = join(config.root, `__pi_quality__.${extname(file).slice(1).toLowerCase()}`);
    const results = await linter.lintText(content, { filePath: virtual });
    checked += 1;
    for (const message of results[0].messages) {
      if (message.severity === 2) {
        diagnostics.push({ file, line: message.line ?? 1, column: message.column ?? 1, rule: message.ruleId ?? 'parse-error', message: message.message });
      }
    }
  }
  return { version: VERSION, enabled: true, checked, diagnostics };
}

export function report(result) {
  if (!result.enabled) { return 'pi-code-quality: disabled by project configuration.'; }
  if (!result.diagnostics.length) { return `pi-code-quality ${VERSION}: ${result.checked} source file(s) passed.`; }
  const lines = result.diagnostics.slice(0, 30).map(item => `${item.file}:${item.line}:${item.column} ${item.rule}: ${item.message}`);
  if (result.diagnostics.length > 30) { lines.push(`${result.diagnostics.length - 30} additional diagnostics; run the CLI with --json for all results.`); }
  return [`pi-code-quality: ${result.diagnostics.length} failure(s) in ${result.checked} source file(s).`, ...lines].join('\n');
}

async function revision(root, signal) {
  try {
    return (await git(root, ['rev-parse', '--verify', 'HEAD'], signal)).trim();
  } catch (error) {
    if (error.code !== 128) { throw error; }
    const message = String(error.stderr);
    if (message.includes('not a git repository')) { return false; }
    if (!message.includes('Needed a single revision')) { throw error; }
    return null;
  }
}

export async function snapshot(cwd, signal) {
  const config = await configuration(cwd, signal);
  const state = { root: config.root, head: null, files: {} };
  if (!config.enabled) { return state; }
  const head = await revision(config.root, signal);
  if (head === false) { return state; }
  state.head = head;
  for (const file of await selectedFiles(config.root, false, signal)) {
    if (included(file, config)) {
      try { state.files[file] = await fingerprint(file, signal); }
      catch (error) { if (error.code !== 'ENOENT') { throw error; } }
    }
  }
  return state;
}

export async function fingerprint(file, signal) {
  const info = await stat(file);
  if (!info.isFile() || info.size > LIMIT) { throw new Error(`Expected a regular source file of at most 2 MiB: ${file}`); }
  return createHash('sha256').update(await readFile(file, { signal })).digest('hex');
}

export async function changedFiles(before, after, signal) {
  const changed = Object.keys(after.files).filter(file => before.files[file] !== after.files[file]);
  if (after.head && before.head !== after.head) {
    const args = before.head ? ['diff', '--name-only', '--diff-filter=ACMR', '-z', before.head, after.head] : ['ls-tree', '-r', '--name-only', '-z', after.head];
    const committed = (await git(after.root, args, signal)).split('\0').filter(Boolean);
    changed.push(...committed.map(file => resolve(after.root, file)).filter(supported));
  }
  return [...new Set(changed)];
}
