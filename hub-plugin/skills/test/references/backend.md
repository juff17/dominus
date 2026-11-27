# Backend testing

Write a script that makes real API calls to the app running locally, run it
until every case passes, then screenshot its output as proof.

## Workflow

1. Find the running app with `docker compose ps`, or start it as SKILL.md's
   "Boot the app" says. Take the base URL and health route from the compose
   ports, the env and the routes.
2. Log in through the API like a client would, with the test account. Keep
   the token in a script variable, and never echo it.
3. Write the script for the endpoints the diff adds or changes, with only
   the cases below that the change calls for. Save it in the run folder as
   `api-test.sh` (curl and jq) or `api_test.py`, whichever suits the repo.
   It prints one line per case (`✓` or `✗`, the case, method, path, status
   and a trimmed body) and ends with a pass count.
4. Run it, saving each request and response to `http/NN-<case>.http` with
   secrets blanked.
5. With `--fix`, fix each failure and run it again until every case passes.
   With `--feedback`, record the failures.
6. Capture the passing run's output as screenshots (`terminal-capture.md`).
7. Offer to commit the script to the repo, where its tests live, as a
   separate commit. Ask with AskUserQuestion. Options: "Commit it", "Keep it
   in the run folder".

## Cases

| Case | When | Checks |
| --- | --- | --- |
| Happy path | Always | Status, response shape, and the values the ticket asks for |
| Side effects | The endpoint writes | A follow-up GET or DB read shows the write landed |
| Validation | The endpoint takes input | Missing and bad fields get a 4xx with a useful message |
| Auth | The diff changes auth: login, tokens, sessions, roles or permissions, auth middleware or guards | No token gets 401, and another user's resource gets 403 or 404 |
| Concurrent requests | The change writes shared state (counters, balances, stock, status changes), checks then writes, enforces uniqueness, or takes a lock, queue or cache | 10 parallel creates or updates on one resource, or two users at once. No 5xx, no lost or duplicate writes, and the final state matches one valid order |
| Not found and conflicts | The endpoint takes an id or creates something unique | An unknown id, a duplicate create, a stale update |
| Repeat | The endpoint must be idempotent, like a webhook or a payment | The same request twice has one effect |
| Limits | The endpoint pages or takes large input | Pagination edges, empty lists, large payloads |

Use real calls against the app as it runs, never mocks. Make your own test
data, and clean it up at the end of the script where the API allows. Never
run against a shared environment unless the user's instructions name it.
