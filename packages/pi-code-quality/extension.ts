import { dirname, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { changedFiles, fingerprint, report, snapshot, supported, VERSION } from './core.mjs';

const cli = resolve(dirname(fileURLToPath(import.meta.url)), 'cli.mjs');
const ownersKey = Symbol.for('pi-code-quality.session-owners');
const shared = globalThis as typeof globalThis & { [ownersKey]?: WeakSet<object> };
const owners = shared[ownersKey] ??= new WeakSet();

export default function codeQuality(pi: ExtensionAPI) {
  let active = false;
  let controller = new AbortController();
  let previous: Awaited<ReturnType<typeof snapshot>> | undefined;

  async function run(ctx: ExtensionContext, files: string[]) {
    const signal = ctx.signal ? AbortSignal.any([controller.signal, ctx.signal]) : controller.signal;
    const result = await pi.exec(process.execPath, [cli, 'check', '--cwd', ctx.cwd, '--json', '--', ...files], {
      cwd: ctx.cwd, signal, timeout: 15000,
    });
    if (result.killed) { throw new Error('Lint process timed out or was cancelled.'); }
    if (result.code !== 0 && result.code !== 1) {
      throw new Error([result.stdout, result.stderr].filter(Boolean).join('\n').trim() || `Checker exited with status ${result.code}.`);
    }
    const checked = JSON.parse(result.stdout);
    return { failed: result.code !== 0, checked: checked.checked, text: report(checked) };
  }

  pi.on('session_start', async (_event, ctx) => {
    if (owners.has(ctx.sessionManager)) { return; }
    owners.add(ctx.sessionManager);
    active = true;
    controller = new AbortController();
    try { previous = await snapshot(ctx.cwd, controller.signal); }
    catch (error) { ctx.ui.notify(`pi-code-quality startup check failed: ${String(error)}`, 'error'); }
    ctx.ui.setStatus('code-quality', `quality ${VERSION}`);
  });

  pi.on('tool_result', async (event, ctx) => {
    if (!active || event.isError || !['edit', 'write'].includes(event.toolName)) { return; }
    const path = event.input.path;
    if (typeof path !== 'string' || !supported(path)) { return; }
    try {
      const file = await realpath(resolve(ctx.cwd, path));
      const result = await run(ctx, [file]);
      if (previous && result.checked > 0) { previous.files[file] = await fingerprint(file, controller.signal); }
      if (!result.failed) { return; }
      return { isError: true, content: [...event.content, { type: 'text' as const, text: `The edit was saved. Local code-quality checks failed; fix these diagnostics before continuing.\n${result.text}` }] };
    } catch (error) {
      return { isError: true, content: [...event.content, { type: 'text' as const, text: `The edit was saved, but local code-quality verification failed: ${String(error)}` }] };
    }
  });

  pi.on('turn_end', async (_event, ctx) => {
    if (!active) { return; }
    try {
      const current = await snapshot(ctx.cwd, controller.signal);
      const files = previous ? await changedFiles(previous, current, controller.signal) : Object.keys(current.files);
      previous = current;
      if (!files.length) { return; }
      const result = await run(ctx, files);
      if (result.failed) {
        pi.sendMessage({ customType: 'code-quality', display: true, content: `File changes remain saved. Local code-quality checks failed after shell or other edits.\n${result.text}` }, { deliverAs: 'followUp', triggerTurn: true });
      }
    } catch (error) {
      pi.sendMessage({ customType: 'code-quality', display: true, content: `Local code-quality verification failed: ${String(error)}` }, { deliverAs: 'nextTurn' });
      ctx.ui.notify('Code-quality verification failed. See the transcript.', 'error');
    }
  });

  pi.on('session_shutdown', (_event, ctx) => {
    if (!active) { return; }
    controller.abort();
    owners.delete(ctx.sessionManager);
    active = false;
    previous = undefined;
    ctx.ui.setStatus('code-quality', undefined);
  });
}
