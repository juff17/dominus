#!/usr/bin/env bash
# Runs every test suite in the repo. Each suite still runs when an earlier one fails,
# and the exit code is non-zero if any did.
#   ./test.sh            all suites
#   ./test.sh ghostty    just these: ghostty, contract, hub, mods
set -uo pipefail

cd "$(dirname "$0")" || exit 1
# A git hook exports GIT_DIR and friends, which would point tests that run git
# in a temp folder back at this repo.
mapfile -t git_vars < <(git rev-parse --local-env-vars)
unset "${git_vars[@]}"
ROOT=$PWD
# shellcheck disable=SC2046
unset $(git rev-parse --local-env-vars)
# A git hook gets whatever node is on PATH, often the system's, which can't run
# TypeScript. Then fnm's newest install of .node-version goes first.
if [[ $(node -p 'process.features.typescript' 2>/dev/null) != @(strip|transform) ]]; then
  fnm_node=$(ls -d "${FNM_DIR:-$HOME/.local/share/fnm}/node-versions/v$(cat .node-version)".*/installation/bin 2>/dev/null | sort -V | tail -1)
  [ -n "$fnm_node" ] && PATH="$fnm_node:$PATH"
fi
# Run from Claude, every log line and state file would carry its session.
unset CLAUDE_CODE_SESSION_ID
GHOSTTY=ghostty
# Code under test logs (docs/logging.md); keep that out of your real logs.
AGENT_HUB_LOG_DIR=$(mktemp -d "${TMPDIR:-/tmp}/agent-hub-test-logs.XXXXXX")
export AGENT_HUB_LOG_DIR
trap 'rm -rf "$AGENT_HUB_LOG_DIR"' EXIT

# Node expands the quoted glob itself, through every folder.
# The install walkthrough's unit tests run with them: same runner, same Node.
suite_ghostty() { node --test "$GHOSTTY/**/*.test.ts" "install/**/*.test.ts"; }
# The files different parts (Node, Python, shell, QML) must agree on.
suite_contract() { node --test --test-concurrency=4 "$ROOT"/tests/contract/*.test.mjs; }
# The hub's own Claude Code plugin: its skills' scripts and agent_hub.
suite_hub() { (cd hub-plugin && python3 -m unittest discover -s tests); }
suite_mods() {
  # The diagram-pane mod is tested by Claude Code's own runner; skip it quietly where it isn't installed.
  if ! command -v claude >/dev/null; then
    echo "skip: claude CLI not found"
    return 0
  fi
  (cd "$ROOT/diagram-plugin" && claude plugin test .)
}

suites=("$@")
[ ${#suites[@]} -eq 0 ] && suites=(ghostty contract hub mods)

failed=()
for suite in "${suites[@]}"; do
  case $suite in
    ghostty | contract | hub | mods) ;;
    *) echo "unknown suite: $suite (ghostty, contract, hub, mods)" >&2; exit 2 ;;
  esac
  echo "== $suite"
  "suite_$suite" || failed+=("$suite")
done

if [ ${#failed[@]} -gt 0 ]; then
  echo "FAILED: ${failed[*]}" >&2
  exit 1
fi
echo "all passed: ${suites[*]}"
