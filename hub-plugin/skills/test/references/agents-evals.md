# Agent testing

When the change reaches an agent, prove its real behaviour. Existing evals
come first. New test files cover only what the evals and unit tests miss.

## Does it reach an agent?

It does when the diff touches prompt text or prompt blocks, a tool's schema
or description, model or sampling config, or code whose output goes into a
prompt (context builders, retrieved data, formatting).

## How much to test

| Situation | What runs |
| --- | --- |
| The change reaches a prompt and evals exist | The evals, on the base branch and on this branch, compared |
| The evals cover the changed behaviour well | The evals, plus a few real runs of the ticket's case |
| The evals miss the changed behaviour | The evals, plus new scenario files for the gap, run many times with different data |
| No evals | New scenario files for the ticket's behaviour, run many times. Say in a sentence or two what the evals are missing |
| The change doesn't reach an agent | Nothing. This track is skipped |

## Rules

- Map the coverage first: eval cases, unit tests and fixtures. New scenarios
  don't repeat them.
- Test real behaviour: the app running, real inputs and its real output, not
  mocks.
- Run each new scenario enough times to see its variance. Three runs suit a
  small wording change, and more suit a change to how the agent decides,
  unless the user's instructions say otherwise. Report the pass rate, not
  one run.
- Write missing test files in the repo's eval format when it has one,
  otherwise in the run folder. Offer to commit them, as `backend.md` does
  with its script.
- Run evals with the repo's own command, from its README, `package.json` or
  Makefile. For a Claude Code plugin, that's `claude plugin eval`. For the
  base run, use a second worktree of `origin/<base>`, never this one.

## Regression gate

Compare the branch with the base, per eval and overall. A drastic drop stops
the run: more than 5 points overall, or a case that passed every base run
now failing. The user's instructions can set other limits.

With `--fix`, try to fix it and run again. If the fix needs the user's call,
ask with AskUserQuestion, giving the scores before and after. Options: "I'll
look", "Keep fixing", "Stop". With `--feedback`, report the drop and stop
this track.

The proof is screenshots of the eval output (`terminal-capture.md`), the base
then the branch.
