# Proposing comments for approval

Every comment on someone else's PR goes through the user. You propose it
and they approve it in the Agents tray or the Alt+A popup, edited or as it
is. Approving posts that one comment, on its line, as the user. Never post
a comment any other way.

## Propose each comment

```bash
python3 ${CLAUDE_PLUGIN_ROOT}/skills/pr-babysit/scripts/approval.py propose comment <pr-url> \
  --session review-<KEY or branch> --path <file> --line <n> [--side RIGHT|LEFT] --body <text>
```

- **`--path`:** the file's path in the repo, as the diff names it.
- **`--line`:** a line inside the PR's diff.
  - `RIGHT` (the default) is the new file's line number: added or kept
    lines.
  - `LEFT` is the old file's: removed lines.

  A line outside the diff can't take a comment; put it on the nearest
  changed line instead.
- **`--body`:** the comment exactly as `peer-comments.md` writes it. Pass it
  as one argument, quoted.
- **`--session`:** the same value for every comment in this review.
- **How many:** at most about 15 comments. Merge duplicates and keep the
  ones that matter.
- **When it fails:** a non-zero exit prints why, for example a missing
  `--line`. Fix that comment and propose it again; don't retry it
  unchanged. A line outside the diff is only refused when the user approves
  it, as a `failed` proposal (below).

## Wait for the user

Once every comment is proposed, ask one AskUserQuestion:

- **Header**: "Comments"
- **Question**: "<n> comments are waiting in Alt+A. Done?"
- **Options**: "Done", "Stop".

Then run `approval.py list`. It prints every proposal as one JSON array; yours
are the ones with `"kind": "comment"` and your `--session`. Each has `id`,
`title` and `status`:

| `status` | Means |
| --- | --- |
| `pending` | Still waiting for the user |
| `done` | Posted (`result.message` says where) |
| `rejected` | The user turned it down |
| `failed` | GitHub or GitLab refused it, often a line outside the diff; `result.message` says why |

A failed comment stays in the tray. Fix it (move it to a changed line) and
propose it again, or leave it for the user to dismiss.

Report:

- how many you proposed;
- how many are settled;
- which are still waiting;
- any that `failed`, with their `title`.

Never re-propose a comment the user rejected.
