#!/usr/bin/env bash
# prune-worktree-artifacts.sh — delete the heavy, regenerable build artifacts of a
# git worktree (Rust `target/`, a real `node_modules/`, bundler output, test reports…).
#
# It is what /ship runs on a worktree it KEEPS (a ~/.t3/worktrees one, for example):
# the merge and the push already stand, so the build cache is dead weight, and twenty
# kept worktrees held 52 GB of `target/` alone until the disk filled up.
#
# Usage:
#   prune-worktree-artifacts.sh [--dry-run] [--verbose] [<worktree>...]
#
# With no path it prunes the current directory. Four rails keep it safe:
#   1. It refuses the PRIMARY checkout (git-common-dir == git-dir), so the tree the
#      user works in and the always-on service builds from is never touched.
#   2. It removes a directory only when git IGNORES it. An untracked directory that
#      the project does not ignore is somebody's work, not an artifact.
#   3. It never follows a symlink, so a borrowed `node_modules` link stays intact and
#      the install it points at is never deleted.
#   4. It refuses a worktree that a build or a server is running in, because deleting
#      the output under a live process breaks it.
set -uo pipefail

# Directory names that a build produces and a build can produce again.
ARTIFACT_NAMES=(
  target node_modules
  dist build .output .nitro .tanstack .vinxi .next .turbo .svelte-kit
  .vite .parcel-cache .cache .angular
  coverage test-results playwright-report blob-report .playwright
  .venv __pycache__ .pytest_cache .mypy_cache .ruff_cache .tox
  .gradle .dart_tool
)
# Deep enough for web/dist and launcher/node_modules, shallow enough to stay quick.
MAX_DEPTH=4
# A command with its working directory inside the worktree that must stop the prune.
BUSY_COMMANDS='^(cargo|rustc|bun|bunx|node|npm|npx|pnpm|yarn|deno|vite|tsc|esbuild|webpack|rollup|turbo|next|gradle|mvn|make|cmake|ninja|go|python[0-9.]*|uv|poetry|playwright)$'
# An MCP server runs the same interpreters and sits in the worktree for the whole
# session without building anything, so it must not read as a busy build.
IDLE_MARKER='mcp'

dry_run=0
verbose=0
paths=()

for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) dry_run=1 ;;
    --verbose|-v) verbose=1 ;;
    -h|--help)
      sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*)
      echo "prune: unknown option: $arg" >&2
      exit 2
      ;;
    *) paths+=("$arg") ;;
  esac
done
[[ ${#paths[@]} -eq 0 ]] && paths=("$PWD")

human() { # kibibytes -> human
  awk -v k="$1" 'BEGIN {
    split("KiB MiB GiB TiB", u, " "); i = 1
    while (k >= 1024 && i < 4) { k /= 1024; i++ }
    printf (k < 10 && i > 1) ? "%.1f %s\n" : "%.0f %s\n", k, u[i]
  }'
}

# Names a process that would break if its own build output disappeared, or nothing.
busy_process() {
  local root="$1" pid cwd cmdline cmd
  for entry in /proc/[0-9]*; do
    pid="${entry#/proc/}"
    cwd=$(readlink "$entry/cwd" 2>/dev/null) || continue
    [[ "$cwd" == "$root" || "$cwd" == "$root"/* ]] || continue
    cmdline=$(tr '\0' ' ' < "$entry/cmdline" 2>/dev/null)
    [[ "$cmdline" == *"$IDLE_MARKER"* ]] && continue
    cmd="${cmdline%% *}"
    cmd="${cmd##*/}"
    [[ "$cmd" =~ $BUSY_COMMANDS ]] || continue
    echo "$cmd (pid $pid)"
    return 0
  done
  return 1
}

total_freed=0
total_removed=0
status=0

for path in "${paths[@]}"; do
  if ! root=$(git -C "$path" rev-parse --show-toplevel 2>/dev/null); then
    echo "prune: not a git worktree, skipped: $path" >&2
    status=1
    continue
  fi
  root=$(cd "$root" && pwd -P)

  git_dir=$(git -C "$root" rev-parse --absolute-git-dir)
  common_dir=$(cd "$root" && cd "$(git rev-parse --git-common-dir)" && pwd -P)
  if [[ "$git_dir" == "$common_dir" ]]; then
    echo "prune: refusing the primary checkout: $root" >&2
    status=1
    continue
  fi
  if [[ "$root" == "/" || "$root" == "$HOME" ]]; then
    echo "prune: refusing: $root" >&2
    status=1
    continue
  fi

  if busy=$(busy_process "$root"); then
    echo "prune: $busy is running in $root, skipped" >&2
    status=1
    continue
  fi

  # find … -name a -o -name b … , pruned on a match so it never descends into one.
  expr=()
  for name in "${ARTIFACT_NAMES[@]}"; do
    [[ ${#expr[@]} -gt 0 ]] && expr+=(-o)
    expr+=(-name "$name")
  done

  freed=0
  removed=0
  while IFS= read -r -d '' dir; do
    git -C "$root" check-ignore -q -- "$dir" || continue
    size=$(du -sk "$dir" 2>/dev/null | cut -f1)
    size=${size:-0}
    if [[ $dry_run -eq 0 ]] && ! rm -rf -- "$dir"; then
      echo "prune: could not remove $dir" >&2
      status=1
      continue
    fi
    freed=$((freed + size))
    removed=$((removed + 1))
    [[ $verbose -eq 1 ]] && echo "  $(human "$size")	${dir#"$root"/}"
  done < <(find "$root" -mindepth 1 -maxdepth "$MAX_DEPTH" -name .git -prune -o \
    -type d \( "${expr[@]}" \) -prune -print0 2>/dev/null)

  total_freed=$((total_freed + freed))
  total_removed=$((total_removed + removed))
  printf '%s %s in %d %s: %s\n' \
    "$([[ $dry_run -eq 1 ]] && echo 'would free' || echo 'freed')" \
    "$(human "$freed")" "$removed" \
    "$([[ $removed -eq 1 ]] && echo directory || echo directories)" "$root"
done

if [[ ${#paths[@]} -gt 1 ]]; then
  printf 'total: %s %s in %d directories\n' \
    "$([[ $dry_run -eq 1 ]] && echo 'would free' || echo 'freed')" \
    "$(human "$total_freed")" "$total_removed"
fi
exit $status
