#!/usr/bin/env bash
set -euo pipefail

package_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source_commit=""
source_dirty="null"
if [[ $# -gt 0 ]]; then
  if [[ $# -ne 2 || "$1" != "--source-commit" || ! "$2" =~ ^[0-9a-f]{40}$ ]]; then
    printf 'Usage: bash install.sh [--source-commit FULL_GIT_SHA]\n' >&2
    exit 2
  fi
  source_commit=$2
elif git -C "$package_dir" rev-parse --show-toplevel >/dev/null 2>&1; then
  source_commit=$(git -C "$package_dir" rev-parse HEAD)
  source_dirty=false
  if [[ -n "$(git -C "$package_dir" status --porcelain -- .)" ]]; then
    source_dirty=true
  fi
fi
for tool in node npm pi tar; do
  command -v "$tool" >/dev/null || { printf 'Required command is missing: %s\n' "$tool" >&2; exit 1; }
done
node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if (major<22 || (major===22 && minor<16)) { throw new Error("Node 22.16 or newer is required"); }'
install_root="${XDG_DATA_HOME:-$HOME/.local/share}/pi-code-quality"
cli_link="$HOME/.local/bin/pi-code-quality"
if [[ -e "$cli_link" || -L "$cli_link" ]]; then
  if [[ ! -L "$cli_link" || "$(readlink "$cli_link")" != "$install_root/current/cli.mjs" ]]; then
    printf 'Refusing to replace unrelated CLI: %s\n' "$cli_link" >&2
    exit 1
  fi
fi
temp_dir=$(mktemp -d)
trap 'rm -rf "$temp_dir"' EXIT
(cd "$package_dir" && npm pack --ignore-scripts --pack-destination "$temp_dir" --json > "$temp_dir/pack.json")
archive_name=$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))[0].filename)' "$temp_dir/pack.json")
archive="$temp_dir/$archive_name"
checksum=$(node -e 'console.log(require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(process.argv[1])).digest("hex"))' "$archive")
version=$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).version' "$package_dir/package.json")
release="$install_root/releases/$version-${checksum:0:12}"
mkdir -p "$release" "$HOME/.local/bin"
tar -xzf "$archive" -C "$release" --strip-components=1
(cd "$release" && npm ci --omit=dev --ignore-scripts)
chmod +x "$release/cli.mjs"
node "$release/cli.mjs" --version
node - "$release" "$source_commit" "$checksum" "$source_dirty" <<'NODE'
const fs = require('node:fs');
const [release, sourceCommit, archiveSha256, sourceDirty] = process.argv.slice(2);
fs.writeFileSync(release + '/INSTALL.json', JSON.stringify({ sourceCommit: sourceCommit || null, sourceDirty: JSON.parse(sourceDirty), archiveSha256, installedAt: new Date().toISOString() }, null, 2) + '\n');
NODE
if [[ -e "$install_root/current" && ! -L "$install_root/current" ]]; then
  printf 'Refusing to replace unrelated directory: %s\n' "$install_root/current" >&2
  exit 1
fi
ln -sfn "$release" "$install_root/current"
ln -sfn "$install_root/current/cli.mjs" "$cli_link"
pi install "$install_root/current"
printf 'Installed pi-code-quality %s at %s\nArchive SHA-256: %s\nSource commit: %s\nStart a new Pi session or run /reload.\n' "$version" "$release" "$checksum" "${source_commit:-unversioned source}"
