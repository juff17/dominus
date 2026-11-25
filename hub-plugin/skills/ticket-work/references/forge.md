# Opening the MR or PR

Only after the user picks "Open an MR". Run everything from the worktree.

## The branch

The branch name holds the ticket key as the tracker writes it
(`ENG-412-retry-failed-payouts`), so Jira's development panel links the
branch, its commits and the MR or PR to the ticket, when the site has the
GitHub or GitLab app for Jira. Put the key in the MR or PR title too.

## Push and open

1. Push: `git push -u origin <branch>`.
2. Open it against the default branch, with the host the remote names:

   ```bash
   # GitHub
   gh pr create --base <default> --head <branch> --title "ENG-412: <summary>" --body-file <file>
   # GitLab
   glab mr create --source-branch <branch> --target-branch <default> --title "ENG-412: <summary>" --description '<description>' --yes
   ```

   The body says what changed, how it was tested, and links the ticket.
   Follow the repo's MR or PR template when it has one
   (`.github/pull_request_template.md`, `.gitlab/merge_request_templates/`).
3. Give the user the link the command prints. If they want it watched, they
   can start `/dominus:pr-babysit <link>`; don't start it yourself.

Don't move the ticket after opening it. If the site's automation moves it
when the MR opens, that's fine; leave it.

## Logins

`gh` and `glab` are already logged in for the hub, one login per host. If a
call fails on auth, tell the user to run `gh auth login --hostname <host>`
or `glab auth login --hostname <host>` in a terminal, and wait. Never run
those yourself, nor `gh auth status` or `gh auth token`.

## Without the CLI

If `gh` or `glab` isn't installed, and a GitHub or GitLab MCP server is
connected, push with git and open the PR or MR with that server's tool. With
neither, push and give the user the host's link for a new MR or PR on that
branch.
