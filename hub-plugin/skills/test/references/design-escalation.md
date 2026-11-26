# Fix it, or ask design

Some UI problems are clear fixes. Others need design to decide, and only the
user can contact design.

| Level | Examples | `--fix` | `--feedback` |
| --- | --- | --- | --- |
| No-brainer | Misaligned padding, text overflow, a missing ellipsis, the wrong token colour vs Figma, z-index, broken scroll | Fix it and note it in `fixes.md` | Report it |
| Judgement | Spacing differs from Figma with no clear reason; missing empty-state copy | Fix only when the fix matches Figma or an existing pattern in the app; else ask | Report it |
| Needs design | Flow changes, new components, a state with no design (error, empty, loading), behaviour Figma doesn't show | Stop and ask | Report it as needing design |

**Asking** uses AskUserQuestion, which puts the session in Needs you:

- **Header**: "Design"
- **Question**: names the screen, what's unclear, and that design must
  confirm it. Attach the screenshot's path.
- **Options**:
  - "I'll ask design; skip it for now": record it as open in the report,
    and don't post to Jira until it's settled;
  - "Do it this way" (the user types how);
  - "Stop".

Never invent a component, a flow or copy that the ticket and Figma don't
give.
