#!/usr/bin/env python3
"""Approvals for test: the tester's evidence goes to the Jira ticket as one
comment only once the user approves it in the Alt+A popup or the Agents tray,
edited or as it is. It always asks.

  approval.py propose jira <ticket-url> --session S --body TEXT [--image FILE]...
  approval.py approve <id> [--body-file FILE]
  approval.py reject <id>
  approval.py dismiss <id>
  approval.py list

The hub's own Jira token only reads, so approving doesn't post: it hands the
approved text back (status `handed`), and the tester posts exactly that
through the tracker's MCP. The store, the locking and the command line are
agent_hub.approvals', shared with pr-babysit's and review's approval.py.
"""

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "lib" / "py"))
from agent_hub import approvals as A

KINDS = ("jira",)
# A Jira ticket's key, from its link.
TICKET = re.compile(r"/browse/([A-Z][A-Z0-9_]*-\d+)")


def ticket_info(url):
    """The ticket where a PR would be, so the tray and the store read it the
    same way."""
    m = TICKET.search(url)
    if not m:
        raise SystemExit(f"Not a Jira ticket link: {url}")
    return {"key": f"jira:{m.group(1)}", "url": url, "number": m.group(1), "forge": "jira", "repo": m.group(1), "ref": ""}


def build(args):
    if args.body is None:
        raise SystemExit("A Jira comment needs --body")
    pr = ticket_info(args.url)
    images = [str(Path(i).expanduser().resolve()) for i in args.image or []]
    gone = [i for i in images if not Path(i).is_file()]
    if gone:
        raise SystemExit(f"No such screenshot: {', '.join(gone)}")
    p = A.new(args.kind, args.session, pr, Path(__file__).resolve())
    p["body"], p["images"] = args.body, images
    n = len(images)
    p["title"] = f"Comment on {pr['number']}" + (f" with {n} screenshot{'s' if n != 1 else ''}" if n else "")
    p["key"] = "jira"
    p["where"] = pr["repo"]
    return p


def propose(args):
    p = build(args)
    A.replace_older(p)
    A.save(p)
    A.LOGGER.info("proposed", id=p["id"], kind=p["kind"], mode="ask", pr=p["pr"]["key"])
    A.emit("proposed", f"{p['id']} {p['title']}: waiting for approval in Alt+A and the Agents tray")
    return 0


def approve(pid, body=None):
    # Settled before anything runs: the tester posts it.
    def before(p):
        return A.finish(p, "handed", True, f"Approved: the tester posts it to {p['pr']['number']}")

    return A.approve(pid, lambda p: "", body=body, editable=KINDS, before=before)


def propose_args(pr):
    pr.add_argument("--body", help="the comment, exactly as it will be posted")
    pr.add_argument("--image", action="append", help="a screenshot the comment carries, in order")


def main(argv=None):
    return A.cli(argv, __doc__, KINDS, propose_args, propose, lambda pid, body, args: approve(pid, body))


if __name__ == "__main__":
    sys.exit(main())
