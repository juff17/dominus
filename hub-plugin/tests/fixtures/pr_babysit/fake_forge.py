"""Stands in for `gh` and `glab`: logs each call as one JSON line to
$FAKE_LOG and answers from the routes JSON file in $FAKE_ROUTES.

A route is keyed by "METHOD path" or just "path", where path is the API path
as passed on the command line, query string included. GraphQL calls are keyed
"graphql", or "graphql?after=CURSOR" for a later page, and a thread's later
comments "graphql?id=THREAD&after=CURSOR". A page-1 path
(...per_page=100&page=1) falls back to the path without the paging, and a
later page with no route of its own is an empty list.

A route's value is printed as JSON, except a dict with:
  "_exit"/"_stderr"  fail with that exit code and message
  "_raw"             print this text as is ("" is an empty body)
An unrouted GET fails with HTTP 404; an unrouted POST prints nothing.
"""

import json
import os
import re
import sys

cli = os.path.basename(sys.argv[0])
args = sys.argv[1:]
rest = args[1:] if args[:1] == ["api"] else args
method, path, fields, i = "GET", None, {}, 0
while i < len(rest):
    a = rest[i]
    if a in ("--hostname", "-X", "--method"):
        if a != "--hostname":
            method = rest[i + 1]
        i += 2
        continue
    if a in ("-f", "-F", "--raw-field", "--field"):
        k, _, v = rest[i + 1].partition("=")
        fields[k] = v
        i += 2
        continue
    if path is None:
        path = a
    i += 1
if path == "graphql":
    query = "&".join(f"{k}={fields[k]}" for k in ("id", "after") if fields.get(k))
    path += f"?{query}" if query else ""

with open(os.environ["FAKE_LOG"], "a") as f:
    f.write(json.dumps({"cli": cli, "method": method, "path": path, "argv": args}) + "\n")

routes_file = os.environ.get("FAKE_ROUTES", "")
routes = json.load(open(routes_file)) if routes_file and os.path.exists(routes_file) else {}

MISSING = object()
r = MISSING
for key in (f"{method} {path}", path):
    if key in routes:
        r = routes[key]
        break
if r is MISSING and path:
    m = re.match(r"(.*?)[?&]per_page=100&page=(\d+)$", path)
    if m and m.group(2) == "1":
        r = routes.get(f"{method} {m.group(1)}", routes.get(m.group(1), MISSING))
    elif m:
        r = []

if r is MISSING:
    if method == "GET":
        print(f"HTTP 404: Not Found (fake: no route for {path})", file=sys.stderr)
        sys.exit(1)
    sys.exit(0)
if isinstance(r, dict) and "_exit" in r:
    print(r.get("_stderr", ""), file=sys.stderr)
    sys.exit(r["_exit"])
if isinstance(r, dict) and "_raw" in r:
    sys.stdout.write(r["_raw"])
    sys.exit(0)
print(json.dumps(r))
