"""A fake `gh` / `glab` for approval.py, as in hub-plugin/tests/
test_pr_babysit_approval.py: logs each call's argv to $FAKE_LOG and answers
`api <path>` from the JSON map in $FAKE_REPLIES ("fail" fails the call)."""
import json
import os
import sys

args = sys.argv[1:]
with open(os.environ["FAKE_LOG"], "a") as f:
    f.write(json.dumps(args) + "\n")
path = next(a for a in args[1:] if not a.startswith("-") and a not in ("api", "POST", "GET") and "/" in a)
replies = json.load(open(os.environ["FAKE_REPLIES"])) if os.path.exists(os.environ["FAKE_REPLIES"]) else {}
r = replies.get(path, {})
if r == "fail":
    print("HTTP 422: Unprocessable", file=sys.stderr)
    sys.exit(1)
print(json.dumps(r))
