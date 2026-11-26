#!/usr/bin/env python3
"""A fake `gh` / `glab` for approval.py's tests (test_pr_babysit_approval.py,
and tests/contract/python-node.test.mjs): logs each call's argv to $FAKE_LOG
and answers `api <path>` from the JSON map in $FAKE_REPLIES, by "POST <path>"
or "GET <path>" first, then <path>. "fail" fails the call; "forbidden" fails
it as a token without the permission would. fake_forge.py is the richer one,
which the watcher tests use."""
import json
import os
import sys

args = sys.argv[1:]
with open(os.environ["FAKE_LOG"], "a") as f:
    f.write(json.dumps(args) + "\n")
path = next(a for a in args[1:] if not a.startswith("-") and a not in ("api", "POST", "GET") and "/" in a)
replies = json.load(open(os.environ["FAKE_REPLIES"])) if os.path.exists(os.environ["FAKE_REPLIES"]) else {}
r = replies.get(("POST " if "POST" in args else "GET ") + path, replies.get(path, {}))
if r == "fail":
    print("HTTP 422: Unprocessable", file=sys.stderr)
    sys.exit(1)
if r == "forbidden":
    print("gh: Resource not accessible by personal access token (HTTP 403)", file=sys.stderr)
    sys.exit(1)
print(json.dumps(r))
