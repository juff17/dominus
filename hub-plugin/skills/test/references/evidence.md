# Evidence and the Jira comment

Every run keeps a record of what was tested and how. A run with a ticket
where every track passes proposes one Jira comment with the proof.

## The run folder

`~/.local/state/agent-hub/runs/<KEY>/test-<YYYYmmdd-HHMMSS>/`, outside the
repo. With no ticket, `<KEY>` is the branch name.

| File | Holds |
| --- | --- |
| `plan.md` | The cases, written before running, each with where it came from, its steps and the expected result |
| `report.md` | The verdict, branch@sha, env, and one row per case with pass or fail, what was fixed, and links to its evidence |
| `screens/NN-*.png` | Frontend screenshots, in flow order |
| `terminal/NN-*.png` | Backend and eval output screenshots in order, beside the `.ansi` they came from |
| `http/NN-*.http` | Each request, secrets blanked, and its response |
| `commands.log` | Every command run, its exit code and how long it took |
| `fixes.md` | What you changed and why, with commit shas |

Write as you go, so a run cut short still shows what was tested. Blank
secrets in every file. The first line of `report.md` is the verdict with
the counts: `PASS 23/23`, `FAIL 19/23`, or `BLOCKED 4/23: the app won't
boot`.

## The Jira comment

Propose it only when there's a ticket, every track passes, and nothing is
open in `design-escalation.md`. With no ticket, the summary stays in the
chat. With `--feedback`, nothing goes to Jira and the findings stay in
`report.md` and the chat.

1. Draft it: two or three lines on what was tested, on which commit, and the
   result, then the screenshots in order with a caption each, every page of
   the terminal screenshots for backend and eval runs, and one line per fix
   with its commit.
2. Propose it for approval. It shows in the Agents tray and Alt+A, where the
   user posts, edits or rejects it.

   ```bash
   python3 ${CLAUDE_PLUGIN_ROOT}/skills/test/scripts/approval.py propose jira <ticket link> \
     --session test-<KEY> --body <the comment> [--image <screenshot>]...
   ```

   Pass `--image` once per screenshot, in the order the comment names them.
3. Ask one AskUserQuestion: header "Jira", question "The Jira comment for
   <KEY> is waiting in Alt+A. Done?", options "Done", "Stop". Then run
   `approval.py list` and find your proposal (`"kind": "jira"` and your
   `--session`) by its `status`.

   | `status` | Do |
   | --- | --- |
   | `handed` | The user approved it. Post its `body` exactly as it is now, which may include their edits, through the Atlassian MCP's add-comment tool. Then run `approval.py dismiss <id>` |
   | `rejected` | Don't post it, and say so in the report |
   | `pending` | It's still waiting. Say so in the report and leave it |

Never post a comment the user didn't approve, or any text but the approved
`body`. You can post one comment, so send it whole. Attach the screenshots
with the MCP's attachment tool if it has one. If it doesn't, post the
comment without them, say in it that the screenshots are in the run report,
and give the user the run folder's path so they can attach them by hand.
