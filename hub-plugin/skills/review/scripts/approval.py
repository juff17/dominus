#!/usr/bin/env python3
"""Approvals for review: each comment the reviewer drafts on someone else's
PR is posted, on its line, only once the user approves it in the Alt+A popup
or the Agents tray, edited or as it is. It always asks.

  approval.py propose comment <pr-url> --session S --path FILE --line N [--side RIGHT|LEFT] --body TEXT
  approval.py approve <id> [--body-file FILE]
  approval.py reject <id>
  approval.py dismiss <id>
  approval.py list

The store, the locking, the time limit and the command line are
agent_hub.approvals', shared with pr-babysit's and test's approval.py.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "lib" / "py"))
from agent_hub import approvals as A
from agent_hub import forge as hub_forge

KINDS = ("comment",)


def build(args):
    if not args.path or not args.line or args.body is None:
        raise SystemExit("A comment needs --path, --line and --body")
    if args.line < 1:
        raise SystemExit("--line is a line number in the file, from 1")
    side = (args.side or "RIGHT").upper()
    if side not in ("RIGHT", "LEFT"):
        raise SystemExit("--side is RIGHT (the new file) or LEFT (the old one)")
    pr = A.pr_info(args.url)
    p = A.new(args.kind, args.session, pr, Path(__file__).resolve())
    forge, number = A.parse_url(args.url)
    # Pinned to the head the reviewer read, so the comment lands on the line
    # it was written about.
    p["comment"] = {"path": args.path, "line": args.line, "side": side, "sha": A.head_now(forge, number)}
    p["body"] = args.body
    p["title"] = f"Comment on {args.path}:{args.line}"
    p["key"] = f"comment:{side}:{args.path}:{args.line}"
    p["where"] = f"{pr['repo']} {pr['ref']}"
    return p


def propose(args):
    p = build(args)
    A.replace_older(p)
    A.save(p)
    A.LOGGER.info("proposed", id=p["id"], kind=p["kind"], mode="ask", pr=p["pr"]["key"])
    A.emit("proposed", f"{p['id']} {p['title']}: waiting for approval in Alt+A and the Agents tray")
    return 0


def run_comment(p):
    """One review comment on one line of the PR's diff, as the user."""
    forge, number = A.parse_url(p["pr"]["url"])
    c, body = p["comment"], p["body"]
    if isinstance(forge, hub_forge.GitHub):
        A.api(forge, f"repos/{forge.project}/pulls/{number}/comments", "POST",
              {"body": body, "commit_id": c["sha"], "path": c["path"], "side": c["side"]}, {"line": c["line"]})
    else:
        refs = forge.api(f"{forge.proj()}/merge_requests/{number}").get("diff_refs") or {}
        if not refs.get("head_sha"):
            raise RuntimeError("GitLab gave no diff refs for the MR; nothing was posted")
        line = "new_line" if c["side"] == "RIGHT" else "old_line"
        A.api(forge, f"{forge.proj()}/merge_requests/{number}/discussions", "POST",
              {"body": body, "position[position_type]": "text", "position[base_sha]": refs["base_sha"],
               "position[start_sha]": refs["start_sha"], "position[head_sha]": refs["head_sha"],
               "position[new_path]": c["path"], "position[old_path]": c["path"]},
              {f"position[{line}]": c["line"]})
    return f"Posted the comment on {c['path']}:{c['line']}"


def approve(pid, body=None):
    return A.approve(pid, run_comment, body=body, editable=KINDS)


def propose_args(pr):
    pr.add_argument("--path", help="the file, as the diff names it")
    pr.add_argument("--line", type=int, help="the line in that file the comment is on")
    pr.add_argument("--side", help="RIGHT, the new file (the default), or LEFT, the old one")
    pr.add_argument("--body", help="the comment, exactly as it will be posted")


def main(argv=None):
    return A.cli(argv, __doc__, KINDS, propose_args, propose, lambda pid, body, args: approve(pid, body))


if __name__ == "__main__":
    sys.exit(main())
