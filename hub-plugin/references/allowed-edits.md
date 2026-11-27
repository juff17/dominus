# Mode: fixes allowed (`--fix`)

You may change code, but only in the branch's worktree.

- Commit each fix, or each group of related fixes, on the branch in the
  repo's commit style.
- After each fix, re-run the tests and lint it touches.
- Never push, open an MR or rewrite history. The user decides when the
  work leaves the machine.
- Where the repo has no pattern of its own, follow
  `${CLAUDE_PLUGIN_ROOT}/references/standards.md`.
- Ask with AskUserQuestion instead of fixing when the fix is a design
  question, changes behaviour the ticket doesn't ask for, or needs the
  user's call.
- In the report, list each fix with its commit sha, and what you left and
  why.
