# Proposing comments for approval

Every comment on someone else's PR goes through the user. You propose it,
and they approve it in the Agents tray or Alt+A, edited or as it is.
Approving posts that one comment, on its line, as the user. Never post a
comment any other way.

## Read what's already there

Before drafting, read the PR's existing comments and review threads:

- GitHub: `gh api repos/<owner>/<repo>/pulls/<n>/comments`, then `.../pulls/<n>/reviews` and `.../issues/<n>/comments`
- GitLab: `glab api projects/<id>/merge_requests/<iid>/discussions`

Then run `approval.py list` and look for comments already proposed on this
PR (`"kind": "comment"` with this PR's `pr.url`).

Leave out any finding that someone already raised, whether another reviewer,
the author, or an earlier review of yours. Never propose again a comment the
user rejected before (`"status": "rejected"`). If a thread is still open and
the code didn't address it, that's the author's to answer, not a new
comment.

## Propose each comment

```bash
python3 ${CLAUDE_PLUGIN_ROOT}/skills/review/scripts/approval.py propose comment <pr-url> \
  --session review-<KEY or branch> --path <file> --line <n> [--side RIGHT|LEFT] --body <text>
```

- `--path` is the file's path in the repo, as the diff names it.
- `--line` is a line inside the PR's diff. `RIGHT`, the default, counts lines
  in the new file (added or kept lines). `LEFT` counts lines in the old file
  (removed lines). A line outside the diff can't take a comment, so put it on
  the nearest changed line.
- `--body` is the comment exactly as `peer-comments.md` writes it, passed as
  one quoted argument.
- `--session` is the same for every comment in this review.

Propose at most about 15, the ones that matter, with duplicates merged. A
non-zero exit says why it failed, for example a missing `--line`. Fix the
comment and propose it again rather than retrying it unchanged.

## Wait for the user

Once every comment is proposed, ask one AskUserQuestion:

- Header: "Comments"
- Question: "<n> comments are waiting in Alt+A. Done?"
- Options: "Done", "Stop"

Then run `approval.py list` again. It prints every proposal as one JSON
array. Yours have `"kind": "comment"` and your `--session`, each with an
`id`, a `title` and a `status`.

| `status` | Means |
| --- | --- |
| `pending` | Still waiting for the user |
| `done` | Posted, and `result.message` says where |
| `rejected` | The user turned it down |
| `failed` | GitHub or GitLab refused it, often for a line outside the diff. `result.message` says why |

A failed comment stays in the tray. Move it to a changed line and propose it
again, or leave it for the user to dismiss.

In the report, say how many you proposed, how many were posted or rejected,
which are still waiting, and any that failed.
