# pr-review-toolkit: the general pass

The general review is Anthropic's pr-review-toolkit plugin
(`pr-review-toolkit@claude-plugins-official`). The setup install script
installs it. Call it as installed; never copy or re-create its agents or
their prompts.

## Check it's installed

Look for its skill, `pr-review-toolkit:review-pr`, in your skill list, and
for its agents (`pr-review-toolkit:code-reviewer` and the others) in the
Agent tool's types. If neither is there, stop and ask with AskUserQuestion:

- **Header**: "Toolkit"
- **Question**: "pr-review-toolkit isn't installed. Run the dominus install
  script again, or `claude plugin install pr-review-toolkit@claude-plugins-official --scope user`
  in a terminal, then start a new session."
- **Options**: "I've installed it", "Stop".

On "I've installed it", look once more. If it's still missing, say that a
plugin installed mid-session loads only in a new session, and stop.

## Call it

Run the `pr-review-toolkit:review-pr` skill on the diff from step 1, with
every aspect. Tell it the base, the files changed, and to use the repo's
CLAUDE.md and `${CLAUDE_PLUGIN_ROOT}/references/standards.md` as the
project guidelines. Take its findings as input to step 6. Don't post or
fix anything from inside it.

With `--feedback`, skip `code-simplifier`: it changes code.

## Reused vs added

| Area | Source | What we add |
| --- | --- | --- |
| Bugs, project guidelines | `code-reviewer` | Point it at CLAUDE.md and `standards.md` |
| Comment accuracy and rot | `comment-analyzer` | `--fix`: fix as `comments.md` says, instead of reporting |
| Error handling | `silent-failure-hunter` | Nothing |
| Type design, missing types | `type-design-analyzer` | The enum rule from `standards.md` |
| Test coverage | `pr-test-analyzer` | Gaps go to the test skill, not written here |
| Simplification | `code-simplifier` | `--fix` only, after the review's fixes |
| Our coding standards | `standards.md` | Whole file |
| Implicit state machine | `state-machine.md` | Whole file |
| Tenant isolation | `tenant-isolation.md` | Whole file |
| Peer comments + approvals | `peer-comments.md`, `approvals.md` | Whole files |
