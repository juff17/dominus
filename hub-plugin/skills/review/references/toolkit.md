# pr-review-toolkit

The general review is Anthropic's pr-review-toolkit plugin
(`pr-review-toolkit@claude-plugins-official`). Call it as installed. Never
copy or re-create its agents or their prompts.

## Check it's installed

Look for its skill, `pr-review-toolkit:review-pr`, in your skill list, and
for its agents (`pr-review-toolkit:code-reviewer` and the others) among the
Agent tool's types. If neither is there, ask with AskUserQuestion:

- Header: "Toolkit"
- Question: "pr-review-toolkit isn't installed. Run the dominus install
  script again, or `claude plugin install pr-review-toolkit@claude-plugins-official --scope user`
  in a terminal, then start a new session."
- Options: "I've installed it", "Stop"

On "I've installed it", look once more. If it's still missing, say that a
plugin installed mid-session only loads in a new session, and stop.

## Call it

Run the `pr-review-toolkit:review-pr` skill on the diff. Tell it the base,
the files changed, and to use the repo's CLAUDE.md and
`${CLAUDE_PLUGIN_ROOT}/references/standards.md` as the project's guidelines.
Take its findings into step 6. Don't post or fix anything from inside it.

With `--feedback`, skip its `code-simplifier`, which changes code.
