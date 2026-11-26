# Mode: feedback only (`--feedback`)

Change no code. Make no commits, branches or worktree edits, and never
push.

- **Review:** draft comments for the PR's author
  (`skills/review/references/peer-comments.md`) and propose each one through
  approvals (`skills/review/references/approvals.md`). Nothing is posted
  until the user approves it.
- **Test:** write the findings report in the run folder
  (`skills/test/references/evidence.md`). When the target is a PR, propose
  the findings as PR comments through approvals, the same way review does.
  Post nothing to Jira.
- Scripts and screenshots you need for testing go in the run folder, never
  in the repo.
- If something can only be checked by changing code, say so in the report
  rather than changing it.
