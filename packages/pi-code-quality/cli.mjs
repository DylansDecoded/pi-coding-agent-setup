#!/usr/bin/env node
import { resolve } from 'node:path';
import { check, report, selectedFiles, VERSION } from './core.mjs';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log(VERSION);
} else if (args[0] === '--help' || args.length === 0) {
  console.log('Usage: pi-code-quality check [--cwd DIR] [--staged | --changed] [--json] [--] FILE...\nChecks JS/TS braces and cognitive complexity. Exit 0: pass; 1: diagnostics; 2: configuration or execution error.');
} else {
  try {
    if (args.shift() !== 'check') { throw new Error('Expected check, --version, or --help.'); }
    const options = parse(args);
    const files = options.staged || options.changed ? await selectedFiles(options.cwd, options.staged) : options.files;
    if (!options.staged && !options.changed && files.length === 0) { throw new Error('Provide source files or --staged/--changed.'); }
    const result = await check(options.cwd, files, { staged: options.staged });
    console.log(options.json ? JSON.stringify(result) : report(result));
    process.exitCode = result.diagnostics.length ? 1 : 0;
  } catch (error) {
    console.error(`pi-code-quality: ${error.message}`);
    process.exitCode = 2;
  }
}

function parse(args) {
  const options = { cwd: process.cwd(), staged: false, changed: false, json: false, files: [] };
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i];
    if (value === '--') { options.files.push(...args.slice(i + 1)); break; }
    if (value === '--cwd') {
      const cwd = args[++i];
      if (!cwd || cwd.startsWith('--')) { throw new Error('--cwd requires a directory.'); }
      options.cwd = resolve(cwd);
    } else { addOption(options, value); }
  }
  if (options.staged && options.changed) { throw new Error('Use --staged or --changed, not both.'); }
  if ((options.staged || options.changed) && options.files.length) { throw new Error('File arguments cannot be combined with --staged/--changed.'); }
  return options;
}

function addOption(options, value) {
  if (value === '--staged') { options.staged = true; }
  else if (value === '--changed') { options.changed = true; }
  else if (value === '--json') { options.json = true; }
  else if (value.startsWith('-')) { throw new Error(`Unknown option: ${value}`); }
  else { options.files.push(value); }
}
