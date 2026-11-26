# Frontend testing

Walk the ticket's workflow in the running app, then go past it the way a UI
QA tester would. Take screenshots all along. Only a clean run's screenshots
go to Jira.

## The browser

| Use | Tools | When |
| --- | --- | --- |
| Playwright | `mcp__plugin_playwright_playwright__*` (plugin `playwright@claude-plugins-official`) | First choice |
| Claude in Chrome | `mcp__claude-in-chrome__*` (test sessions start with `--chrome`) | When Playwright isn't available |

Look for both with ToolSearch. Call them as installed; never copy them.
Neither available → ask with AskUserQuestion: "Neither Playwright nor Claude
in Chrome is connected. Install the playwright plugin (the dominus install
script adds it) or connect Chrome, then start a new session." Options: "I've
connected one", "Stop".

## Workflow

1. **Walk the flow.** Go through the ticket's flow end to end. Take a
   screenshot at each step, and one of each component the change adds or
   touches. Save them to `screens/NN-<step>.png` in the run folder.
2. **Checklist.** Run `ui-qa-checklist.md` on every screen in the flow.
3. **Figma.** If the ticket links a Figma frame and the Figma MCP is
   connected, compare each screen with its frame: layout, spacing, type,
   colours, states. If the ticket links Figma but the MCP isn't connected,
   say so in the report and go on.
4. **Failures.** Read the console and the failed network requests after
   each step; an error there is a failure too. For each failure, decide
   with `design-escalation.md`: fix it, or ask.
5. **Re-run.** After any fix, re-run from step 1 so the screenshots show the
   fixed app.
6. **Clean run.** Pick the screenshots that show the flow working, in
   order, with a caption each, for `evidence.md`.

- Screenshot what matters: the component, or the viewport at that step.
  Don't take a full page every time.
- Use real interactions (click, type, resize). Don't set state with
  `evaluate`, except to throttle the network or resize.
- **Never post** a screenshot of a failing or broken screen.
