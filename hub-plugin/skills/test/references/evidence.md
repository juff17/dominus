# Evidence and the Jira comment

Every run keeps a record of what was tested and how. Only a run where every
track passes is posted to the ticket, as one Jira comment.

## The run folder

`~/.local/state/agent-hub/runs/<KEY>/test-<YYYYmmdd-HHMMSS>/`, outside the
repo. With no ticket, `<KEY>` is the branch name.

| File | Holds |
| --- | --- |
| `plan.md` | The cases, written before running: source (criterion, checklist, state sequence), steps, expected |
| `report.md` | Verdict, branch@sha, env, one row per case: pass/fail, what was fixed, evidence links |
| `screens/NN-*.png` | Frontend screenshots, in flow order |
| `terminal/NN-*.png` | Backend and eval output screenshots, in order (with the `.ansi` they came from) |
| `http/NN-*.http` | Each request (secrets blanked) and its response |
| `commands.log` | Every command run, its exit code and how long it took |
| `fixes.md` | What the tester changed and why, with commit shas |

- **Write as you go:** a run cut short still shows what was tested.
- **Secrets:** blanked in every file.
- **`report.md` first line:** the verdict, `PASS` or `FAIL`, with the counts
  (`PASS 23/23`, `FAIL 19/23`).

## The Jira comment

Only when every track passes, and nothing is open in `design-escalation.md`.

1. **Draft it:**
   - two or three lines of summary: what was tested, on which commit, the
     result;
   - the screenshots in order, each with a caption;
   - for backend and eval runs, every page of the terminal screenshots;
   - one line per fix made during testing, with its commit.
2. **Ask first.** Show the draft with AskUserQuestion:
   - **Header**: "Jira"
   - **Question**: the comment's text and the list of screenshots.
   - **Options**: "Post it", "Not yet".
3. **Post on "Post it"**, through the Atlassian MCP's add-comment tool, on
   the ticket. One comment per session: a hook allows exactly one, so send
   it whole.
   - **Screenshots:** attach them with the MCP's attachment tool if it has
     one.
   - **No attachment tool:** post the comment without the images. Say in it
     that the screenshots are in the run report. Tell the user the run
     folder's path, so they can attach them by hand.
4. **On "Not yet":** leave it. The report says it wasn't posted.

`--feedback` never posts to Jira. Its findings go in `report.md`, and on a
PR they go out as proposed comments through approvals.
