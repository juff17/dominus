# Logging

Every part of the agent hub (the hub, the tray, agentd, the viewer modes, the
popups, the bin scripts and the Claude skill scripts that feed them) logs the
same way, to files you can search with `grep` and `jq`. The owner's global
`CLAUDE.md` (its Logging section, kept in the jstack repo as
`config/CLAUDE.md`) has the rules in short; this page is how they apply here.

## The line

```
2026-11-09T21:14:03.120Z INFO tray: approval ran {"id":"1794-retry","kind":"retry","ok":false,"exit":1,"ms":312}
```

`<UTC time> <LEVEL> <component>: <message> <json>`, one event per line:

- **time**: UTC, ISO 8601 with milliseconds.
- **LEVEL**: `DEBUG`, `INFO`, `WARN` or `ERROR`.
- **component**: which program wrote it, the same as the log file's name
  (`hub`, `tray`, `agentd`, `todo`, `diff`, `approvals`, `watch_pr`, …).
- **message**: fixed text saying what happened. No values and no `{`.
- **json**: one object with every value, always last on the line. `{}` when
  there's nothing to add.

### Field names

Use these for the same thing everywhere:

| Key | What |
|---|---|
| `ms` | how long it took, in milliseconds |
| `ok` | whether it worked |
| `err` | the error's message |
| `stack` | the error's stack, at `error` level |
| `exit` | a process's exit code |
| `cmd` | an argv, as an array |
| `id` | the agent, proposal, todo or job acted on |
| `pid` | a process id |
| `path` | a file or folder |
| `key` | a setting or key binding |
| `claude_session` | the Claude session the program runs under (`$CLAUDE_CODE_SESSION_ID`), added to every line by all three loggers when it's set; named as in proposals, notes and watch state files, which record it too |

Anything else is camelCase.

## Levels

| Level | When | Example |
|---|---|---|
| `error` | Something failed that the user will notice | an approval didn't run, a view crashed |
| `warn` | Something failed but fell back or will retry | a settings file didn't parse, an API call will be retried |
| `info` | An action or a change of state | an agent started, a monitor stopped, a push was approved |
| `debug` | Detail, off by default | each tick, each poll, the start of every operation |

Logs at `info` and above are always written. `debug` is written only when
`AGENT_HUB_DEBUG=1`, or `AGENT_HUB_LOG_LEVEL=debug`, is set for the program.
`AGENT_HUB_LOG_LEVEL` can also raise the bar (`warn`, `error`).

## Entry and exit

Wrap operations worth tracing in a span. It logs the start at `debug`, the
end at `info` (or the level you give) with `ms`, and a failure at `error`
with `err` and `stack`, then rethrows:

```js
await log.span('approval run', { id: p.id, kind: p.kind }, () => runApproval(p, args))
```

On paths that run every second or more often (agentd's tick, the tray's
snapshot, the hub's redraw, a watcher's poll), use `level: 'debug'` so the
span costs one comparison when debug is off.

## Where logs go

`$XDG_STATE_HOME/agent-hub/logs/<component>.log` (`~/.local/state/…`), or
`$AGENT_HUB_LOG_DIR` when set. A file past 1 MB is renamed to
`<component>.log.1`, replacing the one before, so each component keeps at
most about 2 MB.

Logs never go to stdout or stderr: the TUIs draw on the terminal, a watcher's
stdout lines become Monitor events in Claude's conversation, a hook's output
goes into Claude's context, and the tray reads the tray command's stdout as
JSON. A logger that can't write its file stays quiet rather than break the
program.

## The loggers

| Language | Module | Use |
|---|---|---|
| Node | `ghostty/core/log.ts` | `const log = logger('tray'); log.info('approval ran', { id, ok, ms })` |
| Python | `hub-plugin/lib/py/agent_hub/log.py` | `log = logger("watch_pr"); log.warning("poll failed", err=e)` |
| Bash | `ghostty/bin/lib/log.sh` | `ah_log warn tray "poll failed" exit "$?"` |

All three write the same line, so a test in each language checks the format.

## Reading them

```bash
tail -f ~/.local/state/agent-hub/logs/*.log                  # everything, live
grep -h ' ERROR ' ~/.local/state/agent-hub/logs/*.log         # every error
grep -h 'approval ran' ~/.local/state/agent-hub/logs/tray.log | sed 's/^[^{]*//' | jq 'select(.ok == false)'
```

## Never log

Tokens, environment values, auth headers, or the body of a file that may hold
secrets. Log that something was missing (`{"var":"GITHUB_TOKEN","set":false}`),
never its value.
