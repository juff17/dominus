# Backend testing

Write a script that makes real API calls to the app running locally, run it
until every case passes, then screenshot its output as proof.

## Workflow

1. **Find the running app.** `docker compose ps`; if it isn't up, start it
   as the repo says (SKILL.md step 4). Take the base URL and health route
   from the compose ports, the env and the routes.
2. **Authenticate like a client.** Log in through the API with the test
   account (SKILL.md step 5). Keep the token in a shell or script variable;
   never echo it.
3. **Write the script** for the endpoints the diff adds or changes, using
   the cases below.
   - Save it in the run folder as `api-test.sh` (curl + jq) or
     `api_test.py`, whichever the repo's tooling makes easier.
   - Print one line per case: `✓`/`✗`, case name, method, path, status,
     and a trimmed body.
   - End with a pass count.
4. **Run it.** Save each request and response to `http/NN-<case>.http`,
   secrets blanked.
5. **Fix or record.** A failure is a bug to fix (`--fix`) or a finding
   (`--feedback`). Re-run until every case passes.
6. **Capture** the passing run's output as screenshots
   (`terminal-capture.md`).
7. **Offer to commit the script.** Once it passes, offer to add it to the
   repo where its tests live, as a separate commit. Ask with
   AskUserQuestion; options "Commit it", "Keep it in the run folder".

## Cases per changed endpoint

| Case | Checks |
| --- | --- |
| Happy path | Status, response shape, the values the ticket asks for |
| Side effects | A follow-up GET or DB read shows the write landed |
| Validation | Missing and bad fields give a 4xx with a useful message |
| Auth, only when the diff changes auth (login, tokens, sessions, roles or permissions, auth middleware or guards) | No token → 401; another user's resource → 403/404 |
| Concurrent requests, only when they could surface a bug: the change writes shared state (counters, balances, stock, status moves), checks then writes, enforces uniqueness, or takes a lock, queue or cache. Skip it for plain reads and writes scoped to one caller's own new row | Many requests at once (10 parallel creates or updates on one resource, two users at once): no 5xx, no lost or duplicate writes, and the final state matches one valid order |
| Not found and conflicts | An unknown id, a duplicate create, a stale update |
| Repeat and order | The same request twice (idempotency); events out of order, from review's state machine |
| Limits | Pagination edges, empty lists, large payloads |

- **Real calls only:** no mocks, against the app as it runs.
- **Test data:** make your own, and clean it up at the end of the script
  where the API allows.
- **Shared environments:** never run against one unless the user's
  `test.md` names it.
