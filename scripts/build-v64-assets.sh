#!/usr/bin/env bash
# Rebuild the seven v64 engine artifacts that LumiBoot serves, from the pinned
# upstream revision plus the patches listed in scripts/v64-assets.lock.json,
# then install and verify them in apps/web/public/v64/.
#
# Run this inside the Linux environment that has node, java (closure compiler)
# and the Rust wasm32 toolchain, for example:
#
#   wsl -d Ubuntu -e bash scripts/build-v64-assets.sh
#
# Requirements: git, make, node, java, cargo/rustup with the wasm32-unknown-unknown
# target, python3, coreutils. Nothing is committed: the clone lives in a scratch
# directory and only apps/web/public/v64/ (git-ignored) is written in the repo.
#
# Environment:
#   V64_BUILD_DIR   scratch clone location (default: ${TMPDIR:-/tmp}/lumiboot-v64-build)
#   V64_ASSET_DIR   install destination (default: <repo>/apps/web/public/v64)
#   V64_REPO_URL    upstream clone URL (default: https://github.com/speedyHKjournalist/v64)
#   JOBS            make parallelism (default: 1, the value the lock was produced with)
#   SKIP_INSTALL=1  build and verify only, do not copy into apps/web/public/v64/
#
# Idempotent: an existing clone is fetched, hard-reset to the pinned revision and
# cleaned, so leftover edits from an older attempt can never leak into the output.
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
LOCK_FILE="$REPO_ROOT/scripts/v64-assets.lock.json"
BUILD_DIR=${V64_BUILD_DIR:-${TMPDIR:-/tmp}/lumiboot-v64-build}
ASSET_DIR=${V64_ASSET_DIR:-$REPO_ROOT/apps/web/public/v64}
REPO_URL=${V64_REPO_URL:-https://github.com/speedyHKjournalist/v64}
JOBS=${JOBS:-1}
TARGETS=(
  build/v86.wasm
  build/v86-fallback.wasm
  build/v86-parallel.wasm
  build/libv86.mjs
  build/cpu-worker.js
  build/vcpu-worker.js
  build/v86-usb.js
)

die() {
  printf 'build-v64-assets: %s\n' "$*" >&2
  exit 1
}

for tool in git make node sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || die "missing required tool: $tool"
done

# rustup installs the wasm toolchain outside the default PATH of a non-login shell.
if [ -d "$HOME/.cargo/bin" ]; then
  case ":$PATH:" in
    *":$HOME/.cargo/bin:"*) ;;
    *) export PATH="$HOME/.cargo/bin:$PATH" ;;
  esac
fi
command -v cargo >/dev/null 2>&1 || die "cargo not found (rustup with wasm32-unknown-unknown is required)"

[ -f "$LOCK_FILE" ] || die "lock file not found: $LOCK_FILE"

# The plan (revision + ordered patch list) is read from the lock so this script
# and the verifier can never disagree about what was built.
mapfile -t PLAN_ROWS < <(node -e '
  const lock = require(process.argv[1]);
  if (!lock.revision || !lock.repository || !Array.isArray(lock.build && lock.build.patches)) {
    console.error("build-v64-assets: lock is missing revision, repository or build.patches");
    process.exit(1);
  }
  console.log(lock.repository);
  console.log(lock.revision);
  for (const patch of lock.build.patches) console.log(patch);
' "$LOCK_FILE") || die "could not read the build plan from $LOCK_FILE"

LOCK_REPOSITORY=${PLAN_ROWS[0]}
REVISION=${PLAN_ROWS[1]}
PATCHES=("${PLAN_ROWS[@]:2}")
[ "${#PATCHES[@]}" -gt 0 ] || die "lock lists no patches"

printf '== v64 build plan ==\n'
printf '  repository : %s\n  revision   : %s\n  build dir  : %s\n  install    : %s\n' \
  "$LOCK_REPOSITORY" "$REVISION" "$BUILD_DIR" "$ASSET_DIR"
for patch in "${PATCHES[@]}"; do
  printf '  patch      : %s\n' "$patch"
done

# --- 1. Clean clone at the pinned revision --------------------------------
# core.autocrlf=false is mandatory: the repository ships Unix line endings in
# executable scripts, and a CRLF checkout makes node fail with
# "node\r: Permission denied".
mkdir -p "$BUILD_DIR"
CLONE="$BUILD_DIR/v64"
if [ -d "$CLONE/.git" ]; then
  printf '\n== refreshing existing clone ==\n'
  git -C "$CLONE" -c core.autocrlf=false remote set-url origin "$LOCK_REPOSITORY"
  git -C "$CLONE" -c core.autocrlf=false fetch --quiet --tags --force origin
else
  printf '\n== cloning %s ==\n' "$LOCK_REPOSITORY"
  rm -rf "$CLONE"
  git -c core.autocrlf=false clone --filter=blob:none --quiet "$LOCK_REPOSITORY" "$CLONE"
fi
git -C "$CLONE" -c core.autocrlf=false checkout --quiet --force "$REVISION"
git -C "$CLONE" -c core.autocrlf=false reset --quiet --hard "$REVISION"
git -C "$CLONE" -c core.autocrlf=false clean -qfdx
HEAD_REVISION=$(git -C "$CLONE" rev-parse HEAD)
[ "$HEAD_REVISION" = "$REVISION" ] || die "HEAD is $HEAD_REVISION, expected $REVISION"
printf '  HEAD       : %s\n' "$HEAD_REVISION"

# --- 2. Patches, in lock order --------------------------------------------
printf '\n== applying %d patch(es) ==\n' "${#PATCHES[@]}"
for patch in "${PATCHES[@]}"; do
  patch_path="$REPO_ROOT/$patch"
  [ -f "$patch_path" ] || die "patch not found: $patch_path"
  git -C "$CLONE" -c core.autocrlf=false apply --check --verbose "$patch_path" \
    || die "patch does not apply cleanly: $patch"
  git -C "$CLONE" -c core.autocrlf=false apply --verbose "$patch_path"
  printf '  applied    : %s\n' "$patch"
done

# --- 3. Build the seven artifacts ------------------------------------------
printf '\n== make -j%s (%d targets) ==\n' "$JOBS" "${#TARGETS[@]}"
make -C "$CLONE" -j"$JOBS" "${TARGETS[@]}"
for target in "${TARGETS[@]}"; do
  [ -s "$CLONE/$target" ] || die "make produced nothing for $target"
done

# --- 4. Verify against the lock, then install -----------------------------
verify() {
  local dir=$1
  local expected name size sha actual_size actual_sha
  expected=$(node -e '
    const lock = require(process.argv[1]);
    for (const name of process.argv.slice(2)) {
      const asset = lock.assets[name];
      if (!asset) { console.error("no lock entry for " + name); process.exit(1); }
      console.log(name + " " + asset.size + " " + asset.sha256);
    }
  ' "$LOCK_FILE" "${TARGETS[@]##*/}") || die "could not read expected sizes from the lock"
  while read -r name size sha; do
    [ -f "$dir/$name" ] || die "missing output: $dir/$name"
    actual_size=$(stat -c %s "$dir/$name")
    actual_sha=$(sha256sum "$dir/$name" | cut -d' ' -f1)
    if [ "$actual_size" != "$size" ] || [ "$actual_sha" != "$sha" ]; then
      die "mismatch for $name: got $actual_size B / $actual_sha, lock says $size B / $sha (a non-reproducible build must be investigated, never silenced by editing the lock)"
    fi
    printf '  ok         : %-24s %10s B  %s\n' "$name" "$actual_size" "$actual_sha"
  done <<<"$expected"
}

printf '\n== verifying build output against the lock ==\n'
verify "$CLONE/build"

if [ "${SKIP_INSTALL:-0}" = "1" ]; then
  printf '\n== SKIP_INSTALL=1: artifacts left in %s ==\n' "$CLONE/build"
  exit 0
fi

printf '\n== installing into %s ==\n' "$ASSET_DIR"
mkdir -p "$ASSET_DIR"
for target in "${TARGETS[@]}"; do
  cp -f "$CLONE/$target" "$ASSET_DIR/${target##*/}"
done

printf '\n== verifying installed artifacts ==\n'
verify "$ASSET_DIR"

printf '\nv64 %s assets rebuilt, installed and verified.\n' "$REVISION"
