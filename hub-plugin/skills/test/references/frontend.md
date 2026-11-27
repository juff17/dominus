# Frontend testing

Walk the ticket's flow in the running app, then check what a UI QA tester
would for what the change touched. Take screenshots as you go. Only a clean
run's screenshots go to Jira.

## The browser

| Use | Tools | When |
| --- | --- | --- |
| Playwright | `mcp__plugin_playwright_playwright__*`, from the plugin `playwright@claude-plugins-official` | First choice |
| Claude in Chrome | `mcp__claude-in-chrome__*`, since test sessions start with `--chrome`. Read the `chrome-browser` skill first when it's listed | When Playwright isn't there |

Find both with ToolSearch, and call them as installed. If neither is there,
ask with AskUserQuestion: "Neither Playwright nor Claude in Chrome is
connected. Install the playwright plugin (the dominus install script adds
it) or connect Chrome, then start a new session." Options: "I've connected
one", "Stop".

## Workflow

1. Walk the ticket's flow end to end. Screenshot each step, and each
   component the change adds or touches, to `screens/NN-<step>.png` in the
   run folder. Shoot the component or the viewport, not a full page every
   time.
2. Run the checks from `ui-qa-checklist.md` that fit what the change
   touched.
3. If the ticket links a Figma frame and the Figma MCP is connected, compare
   each changed screen with its frame for layout, spacing, type, colour and
   states. If the MCP isn't connected, say so in the report and go on.
4. After each step, read the console and the failed network requests. An
   error there is a failure too. Decide each failure with
   `design-escalation.md`.
5. After any fix, walk the flow again, so the screenshots show the fixed
   app.
6. From the clean run, pick the screenshots that show the flow working, in
   order, each with a caption, for `evidence.md`.

Use real interactions: click, type, resize. Don't set state with `evaluate`,
except to throttle the network or resize. Never post a screenshot of a
failing or broken screen.
