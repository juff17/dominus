# Mode: fixes allowed (`--fix`)

You may change code, but only in the ticket branch's worktree.

- **Commits:** fix as local commits on the ticket's branch, one small commit
  per fix or per group of related fixes, in the repo's commit style.
- **Tests:** after each fix, re-run the tests and lint it touches before the
  next step.
- **Never push**, open an MR or rewrite history. The user decides when it
  leaves the machine.
- **Standards:** follow `${CLAUDE_PLUGIN_ROOT}/references/standards.md` where
  the repo has no pattern of its own.
- **What review fixes:** bugs, [should-fix] and [nit] findings, standards, and
  comment cleanup.
- **What test fixes:** bugs found while testing, and no-brainer UI fixes
  (`design-escalation.md`).
- **Ask instead of fixing** when a fix is a design question, changes
  behaviour the ticket doesn't ask for, or needs the user's call. Ask with
  AskUserQuestion.
- **Report:** list what you fixed with each commit's sha, and what you left
  and why.
