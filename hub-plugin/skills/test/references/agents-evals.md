# Agent testing

When the change reaches an agent, prove its real-world behaviour over many
runs. Existing evals come first. New test files cover only what the evals
and unit tests don't.

## Does it reach an agent?

Yes when the diff touches any of these:

- prompt text or prompt blocks;
- a tool's schema or description;
- model or sampling config;
- code whose output is injected into a prompt (context builders,
  retrieved data, formatting).

## How much to test

| Situation | What runs |
| --- | --- |
| The change reaches a prompt and evals exist | The evals must run: on the base branch and on this branch, compared |
| The evals cover the changed behaviour well | The evals, plus a few real runs of the ticket's case |
| The evals miss the changed behaviour | The evals, plus new scenario files for the gap, run many times |
| No evals | New scenario files for the ticket's behaviour, run many times; propose adding them as evals |
| The change doesn't reach an agent | This track is skipped |

## Rules

- **Map coverage first:** eval cases, unit tests, fixtures. New scenarios
  must not repeat them.
- **Real behaviour:** the app running, real inputs, its real output; no
  mocks.
- **Repeat runs:** run each scenario 5 times, unless the user's `test.md`
  says otherwise. Report the pass rate, not one run.
- **Test files:** write missing ones in the repo's eval format when it has
  one. Otherwise put them in the run folder. Offer to commit them, as
  `backend.md` does with its script.
- **Running evals:** use the repo's own eval command (its README,
  `package.json`, Makefile).
  - For a Claude Code plugin, that's `claude plugin eval`, with its trigger
    evals and suites.
  - For the base run, use a second worktree of `origin/<base>`. Never check
    the base out in this worktree.

## Regression gate

- **Compare** the branch with the base, per eval and overall.
- **A drastic drop stops the run:** more than 5 points overall, or any case
  that passed every base run now failing. The user's `test.md` can set
  other limits.
- **`--fix`:** try to fix it and re-run. If the fix needs the user's call,
  ask with AskUserQuestion, giving the before and after scores. Options:
  "I'll look", "Keep fixing", "Stop".
- **`--feedback`:** report the drop and stop this track.
- **Proof:** screenshots of the eval output (`terminal-capture.md`), base
  and branch, one after the other.
