# Live tail: Docker and kubectl

Watch logs as they are written, from local Docker or a Kubernetes cluster.
`scripts/watch_logs.py` streams, filters, de-duplicates and rate limits the
logs, and reconnects when containers restart or pods roll. It runs under the
**Monitor** tool so only the lines worth acting on reach the conversation.
Never tail raw logs with Bash in the main thread.

## 1. Find the log source

### Local (Docker)

1. In the repo, run `docker compose ps --format '{{.Name}}\t{{.Service}}\t{{.State}}'`.
   With no compose file, run `docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}'`
   and match container names or images against the repo name.
2. Pick the container(s) for the service. Include workers or sidecars built
   from the same repo. Skip databases, caches and other dependencies unless
   the user asks for them.
3. Nothing running: tell the user and stop. Do not start containers.

### Other environments (Kubernetes)

1. **Context**: `kubectl config get-contexts -o name`. Pick the one whose name
   matches the environment. If none or several match, ask. Always pass
   `--context`. Never run `kubectl config use-context`.
2. **Namespace and deployment**: look in the repo first (Helm values, k8s or
   kustomize manifests, CI deploy jobs). Otherwise search the cluster:
   `kubectl --context CTX get deploy -A | grep -i <repo-name>`. Still unclear: ask.
3. Pass `--deployment NAME`. The script reads the deployment's label selector,
   so every pod is watched, not one. Use `-l SELECTOR` for statefulsets, jobs
   and other non-deployments.

Read commands only (`get`, `logs`, `describe`). Never change anything in a
cluster.

`kubectl logs` only reaches pods that exist now. For anything that happened
before the current pods started, or across many services, use Elastic
([elastic.md](elastic.md)).

## 2. Build the filters

- **Default**: the script's built-in error set (error, exception, traceback,
  fatal, panic, failed, timeout, OOM, HTTP 5xx, `level=error`, and similar)
  plus container and pod status changes (exits, restarts, CrashLoopBackOff).
- **User instructions**: turn each thing they want into a `--match` regex. If
  they want *only* that, add `--only-match`. Status changes are always reported.
- **Noise**: if a known harmless line keeps matching, add `--ignore` for it.
- **Change markers**: if `git status` shows changes or the branch is ahead of
  its base, run `python3 <skill-dir>/scripts/change_markers.py -C <repo>`.
  It prints the fixed text of each log message the branch adds. Keep markers
  from the service's runtime code (drop tests, scripts, migrations, tooling)
  and add each as `--match '<regex>'`. Keep the list so you can report which
  ones were hit. If the branch adds no log lines, say so; do not invent markers.
  Only use markers where the branch's code is running (usually local). Ask
  before assuming a remote environment has the branch deployed.

Quote every regex in single quotes.

## 3. Start the monitor

```
Monitor(
  command: "python3 -u <skill-dir>/scripts/watch_logs.py docker api worker --match 'order synced to ledger'",
  description: "errors in api, worker (local docker)",
  timeout_ms: 1800000,
)
```

Kubernetes:

```
python3 -u <skill-dir>/scripts/watch_logs.py k8s --context staging-eu -n payments \
  --deployment payments-api --since 10m
```

- `--since 10m` (or an RFC3339 time) also reports recent lines. Use it when the
  user asks about something that already happened; otherwise start from now.
- `--dedup SECONDS` sets how long a repeated message stays quiet (default 120).
- Make the `description` specific: service, environment, what is watched.
- The first event is `[watch] attached to ...`. If it does not arrive, or the
  script exits, read the monitor output and fix the command.

Tell the user in 2 or 3 bullets: what is watched, where, and which patterns
(including change markers).

## 4. Handle events

| Prefix | Meaning |
|--------|---------|
| `[watch]` | Attach, reconnect, or flood notice; `docker failed, retrying`, `cannot reach <context> ..., retrying` or `log stream ended` when docker or kubectl itself fails |
| `[status]` | Container or pod state change |
| `[error]` | Default error pattern matched |
| `[match]` | A `--match` pattern (user request or change marker) matched |
| `[repeat]` | An already reported message repeated N times |
| `[unwatched]` | The user stopped this watch from Monitors (`x`) and the script exited. A watcher killed that way first exits with no event; the re-arm brings this line. Do not re-arm: give the watch summary and stop |
| indented line | Stack trace lines that followed the error above |

- **New error or status change**: tell the user in one or two bullets. If it
  plausibly comes from this repo, grep for the message, and say where it is
  and whether it touches the branch's changes. Do not fix anything unless asked.
- **Change marker hit**: note it once. Track which markers are still unhit.
- **Watcher failing** (`[watch] ... docker failed`, `cannot reach` or `log stream ended`):
  nothing is being watched until it recovers. Tell the user once with the
  reason; the script keeps retrying and says `attached` or `log stream back`
  when it works again.
- **Repeats and floods**: summarize; do not relay each one. If flood notices
  keep coming, re-arm with a tighter filter (`--ignore`) and say so.
- Write down the UTC time of each notable event. Links and reports need them.

## 5. Keep it running

- Monitor stops after 30 minutes. On expiry, re-arm the same command with
  `--since <expiry time, RFC3339>` so no lines are lost. Keep re-arming until
  the user says stop or the watcher prints `[unwatched]`.
- To stop: TaskStop on the monitor, then a short report
  ([reporting.md](reporting.md), "Watch summary").
- If the user changes what to watch, stop the monitor and start a new one.

## Started from the Monitors popup

The prompt is `/log-watcher watch` followed by `Environment:`, `Source:`,
`Folder:`, `Level:`, `For:` and `Watch for:` lines (SKILL.md shows it).
Follow steps 1 to 5 above with these changes, and ask nothing at any point.

1. **Note the start time** (UTC) and the end time, start plus `For` (`30m`,
   `2h`, `1h30m`; a bare number is minutes).
2. **Source.**
   - `docker`: local Docker for the repo in `Folder` (step 1, Local).
   - `kubernetes`: the context is the one in
     `kubectl config get-contexts -o name` named `Environment` exactly, else
     the one that has it as a whole `-`-separated part (`eu` matches
     `prod-eu` and `eu-west`, not `europe`). If none matches, or several do
     with no exact one, say so in one line, naming the ones that matched,
     and stop: picking one could watch the wrong cluster.
   - `elastic`: poll Elastic, as "Elastic watch" below says, in place of
     steps 3 and 5 here. With no Elastic tools in the session, say so in one
     line and stop.
3. **Namespace and workloads** (`kubernetes`), from the repo in `Folder` as
   step 1 says: Helm values, k8s or kustomize manifests, CI deploy jobs.
   Read only.
   - Let `Watch for` pick the workloads: a worker, a consumer, an API, a
     cron job it names or clearly means.
   - When it names none, or none match, watch every workload the repo
     deploys in that namespace, one monitor each.
   - With nothing in the repo, look in the cluster:
     `kubectl --context <ctx> get deploy -A | grep -i <repo name>`. Still
     nothing: say so in one line and stop.
4. **Filters** (step 2), set by `Level`:
   - `error`: the built-in error set alone.
   - `warn`: add `--match '(?i)\bwarn(ing)?\b|level=warn|"level":\s*"warn'`.
   - `info`: also add `--match '(?i)\binfo\b|level=info|"level":\s*"info'`
     and tell the user it will be busy; the de-duplication and flood limits
     still apply.
   - Turn what `Watch for` names (messages, endpoints, error names, job
     names) into extra `--match` patterns. Add change markers only when
     `Source` is `docker`.
5. **Start the monitor** (step 3) with `timeout_ms` the smaller of 30 minutes
   and the time left. Tell the user in 2 or 3 bullets what is watched,
   where, and until when (UTC).
6. **Unreachable context.** Off the VPN or with an expired login, the
   script prints `[watch] cannot reach <ctx>: <reason>, retrying` (before
   it attaches) or `[watch] log stream ended ... reconnecting` (after), and
   keeps trying on its own. Say it once in one line, with the reason. Don't
   end the watch, don't switch context, and don't repeat it while the
   reason stays the same. If the monitor exits instead, re-arm it the same
   way after a minute, quietly, until the end time.
7. **Re-arm** on expiry as in step 5 above, while time is left. After
   `[unwatched]`, don't: end as step 8 says.
8. **At the end time**: TaskStop every monitor, then the watch summary
   ([reporting.md](reporting.md), "Watch summary"). Say what `Watch for`
   asked about first: seen or not, when, how often. Mention any time the
   context or Elastic was unreachable, so a quiet stretch isn't read as all
   clear.

### Elastic watch

Elastic can't stream, so the watch is a query every 5 minutes over the time
since the last one.

1. **Find the logs** as [elastic.md](elastic.md) section 3 says: the index,
   the service filter for the repo in `Folder`, and the environment field
   holding `Environment` (`STATS count = COUNT(*) BY <env field>` over the
   last hour must show it). Nothing for this service in that environment:
   say so in one line and stop.
2. **Arm a clock** under Monitor, with `timeout_ms` as in step 5:
   `while sleep 300; do date -u +%Y-%m-%dT%H:%M:%SZ; done`. Each line it
   prints is a check.
3. **Each check** queries from the last check (the start time, the first
   time) to one minute before now, as logs reach Elastic late:

   ```esql
   FROM <index>
   | WHERE <service filter> AND <env field> == "<Environment>"
     AND @timestamp >= "<from>" AND @timestamp < "<to>"
     AND (log.level IN (<levels>) OR <Watch for terms>)
   | STATS count = COUNT(*), first = MIN(@timestamp), last = MAX(@timestamp)
       BY log.level, error.type, error.message
   | SORT count DESC
   | LIMIT 20
   ```

   `<levels>` follows `Level` (`error`; `warn` adds `warn`; `info` adds
   `info`), in the case the field uses. `<Watch for terms>` are what it
   names, as `message LIKE "*<term>*"`.
4. **Report** only what is new since earlier checks, as step 4 above does
   for events: one or two bullets, the source in the repo when you find it.
   A quiet check says nothing.
5. **Elastic unreachable** (an MCP error): say it once with the reason, keep
   checking, and cover the missed time in the next check that works.
6. **Re-arm** the clock on expiry while time is left, then end as step 8
   says.
