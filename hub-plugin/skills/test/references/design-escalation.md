# Fix it, or ask design

Some UI problems are clear fixes. Others need design to decide, and only the
user can reach design.

| Level | Examples | `--fix` | `--feedback` |
| --- | --- | --- | --- |
| Clear fix | Misaligned padding, text overflow, a missing ellipsis, the wrong token colour against Figma, z-index, broken scroll | Fix it, and note it in `fixes.md` | Report it |
| Judgement | Spacing differs from Figma for no clear reason, or empty-state copy is missing | Fix it only when the fix matches Figma or an existing pattern in the app. Otherwise ask | Report it |
| Needs design | A flow change, a new component, a state with no design (error, empty, loading), or behaviour Figma doesn't show | Stop and ask | Report it as needing design |

To ask, use AskUserQuestion:

- Header: "Design"
- Question: name the screen, what's unclear, and that design must confirm
  it, with the screenshot's path
- Options: "I'll ask design, skip it for now", "Do it this way" (the user
  types how), "Stop"

On "I'll ask design, skip it for now", record it as open in the report, and
don't post to Jira until it's settled.

Never invent a component, a flow or copy that the ticket and Figma don't
give.
