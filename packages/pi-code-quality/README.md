# pi-code-quality

Runs local JavaScript and TypeScript maintainability checks after Pi saves an edit. A failed check is returned to the model as a tool error with file, line, rule, and fix guidance. The edit stays on disk. Shell changes inside a Git repository are checked at the end of the turn, using content hashes and Git revisions instead of parsing shell commands.

The checks use ESLint `curly: all` and SonarJS `cognitive-complexity: 15`. They catch the recurring SonarQube S121 and S3776 patterns. They are an early warning layer, not a replacement for the project's linter, tests, or server-side SonarQube profile. Inline ESLint disable comments cannot suppress these checks. Existing violations in a touched file are reported too.

## Install

Requires Node 22.16 or newer, npm, Git, and Pi 1.3 or newer. From this repository:

```sh
bash packages/pi-code-quality/install.sh
```

The installer creates an immutable package release under `${XDG_DATA_HOME:-~/.local/share}/pi-code-quality/releases/`, updates its `current` symlink, adds `~/.local/bin/pi-code-quality`, and registers the package with `pi install`. Existing Pi settings and other extensions are preserved. Start a new session or use `/reload`. The release's `INSTALL.json` records the source commit and package SHA-256. When installing a source archive without Git metadata, provide `--source-commit <full-sha>`.

The installer does not install this entire setup repository or copy its other extensions. To uninstall, run `pi remove ~/.local/share/pi-code-quality/current`, then remove the package's CLI symlink. Older releases remain available for rollback.

## Check from any coding agent

```sh
pi-code-quality check --cwd /path/to/repo src/example.ts
pi-code-quality check --cwd /path/to/repo --staged
pi-code-quality check --cwd /path/to/repo --changed --json
pi-code-quality --version
```

Exit codes: `0` means no diagnostics (or explicitly disabled configuration); `1` means lint findings; `2` means invalid configuration, missing file, or checker failure. Disabled configuration is reported explicitly. `--staged` reads Git index content, so it handles partially staged files. `--changed` checks tracked changes and untracked files against HEAD. Filenames with spaces are supported. Use `--` before explicit filenames that start with a dash.

## Project configuration

The globally installed extension runs with defaults in all projects. An optional `.pi/code-quality.json` at the Git root changes those defaults, including when Pi starts in a nested directory:

```json
{
  "version": 1,
  "enabled": true,
  "cognitiveComplexity": 15,
  "ignore": ["dbt/target/**", "dbt/dbt_packages/**"]
}
```

Unknown keys, invalid JSON, unsupported versions, or invalid values fail visibly. `cognitiveComplexity` accepts integers from 1 to 100. `ignore` adds Node glob patterns to built-in exclusions for dependencies, build output, coverage, minified files, and declaration files. An empty array preserves those defaults. `enabled: false` disables the checks explicitly.

For a non-Git directory, write/edit checks use that directory's `.pi/code-quality.json`; shell change discovery is unavailable. Files larger than 2 MiB fail verification instead of consuming unbounded memory. Each Pi lint process has a 15-second timeout and is cancelled on session shutdown. The extension is read-only and never autofixes or rolls back code. Duplicate loading within one Pi session is suppressed. Python files are not checked by this package.

## Verify

```sh
cd packages/pi-code-quality
npm ci --ignore-scripts
npm test
npm run check
node smoke-pi.mjs
```

The smoke check loads the extension through the installed Pi loader and exercises real Pi write/edit tools without sending source to an LLM. Set `PI_PACKAGE_ROOT` if Pi is installed outside the managed `~/.pi/agent/install/releases` layout. TypeScript 6.0.3 is pinned because the installed TypeScript-ESLint parser supports TypeScript below 6.1; it parses source syntax without replacing the project's TypeScript compiler.

Rule references: [ESLint braces](https://eslint.org/docs/latest/rules/curly), [SonarJS](https://github.com/SonarSource/SonarJS), [Pi extensions](https://pi.dev/docs/latest/extensions).
