# Jira through the Atlassian MCP server

## The server

The Atlassian Rovo MCP server, at `https://mcp.atlassian.com/v2/mcp` over
HTTP, signed in with OAuth through `/mcp`:

```bash
claude mcp add --transport http atlassian https://mcp.atlassian.com/v2/mcp
```

The old `https://mcp.atlassian.com/v1/sse` endpoint is being retired. If the
user's server still points there (`claude mcp get <name>` shows the URL),
tell them to remove it and add the `/v2/mcp` one instead.

In a session the tools are named `mcp__<server>__<tool>`, where `<server>`
is whatever the user called it, usually `atlassian`. Match on the part after
the last `__`.

## Tools

Most tools take a `cloudId`. Pass the hand-off's `Site` URL; if a call
refuses it, get the cloud id from `getAccessibleAtlassianResources`.

| Tool | Use it for |
|------|------------|
| `getJiraIssue` | Reading the ticket (step 2), and reading it back after the assign and the move |
| `editJiraIssue` | Setting the assignee, and nothing else (step 3) |
| `transitionJiraIssue` | The one move (step 4) |
| `searchJiraIssuesUsingJql` | Finding the ticket when the user named it in words, not by key |
| `atlassianUserInfo` | Who the signed-in user is, when there's no Assign to line |

Two more are deferred: they aren't in the tool list until you look them up.
Call `discover` to find the tool and its input schema, then run it through
`executeRead` with its name and arguments, as `discover` describes.

| Deferred tool | Use it for |
|---------------|------------|
| `listJiraIssueTransitions` | The ticket's transitions from its status now (step 4) |
| `lookupJiraAccountId` | An account id from a name or email, if the user asks to assign someone else |

## Reading the ticket

`getJiraIssue` with `issueIdOrKey` gives the fields step 2 needs:
`summary`, `description`, `status` (its `id`, `name` and
`statusCategory.key`), `assignee.accountId`, `project.key`, `components`,
`labels` and `issuelinks`.

`statusCategory.key` is one of:

| Key | Category |
|-----|----------|
| `new` | To do. Only a ticket here is moved |
| `indeterminate` | In progress, in review, and other started states |
| `done` | Done. Step 2 asks before going on |

## Assigning

There is no assign tool. Set the assignee through `editJiraIssue`:

```json
{ "cloudId": "<site>", "issueIdOrKey": "ENG-412", "fields": { "assignee": { "accountId": "<Assign to id>" } } }
```

This shape isn't confirmed for every site, so read the ticket back with
`getJiraIssue` and check that `assignee.accountId` is the Assign to id.

## Moving

A move takes a transition id, not a status name. List the transitions with
`listJiraIssueTransitions`. Each has an `id`, a `name` and a `to` status with
its own `id`, `name` and `statusCategory`. Pick the transition whose `to.id`
is one of the Started column's status ids, then:

```json
{ "cloudId": "<site>", "issueIdOrKey": "ENG-412", "transition": { "id": "<transition id>" } }
```

A transition whose `fields` mark one as `required: true` needs those filled
in: ask the user rather than make up values. Read the status back with
`getJiraIssue` after the move.

The ticket-guard hook allows one `transitionJiraIssue` per session the hub
started (a failed one doesn't count) and denies any `editJiraIssue` that sets
more than the assignee, including through `executeWrite`.

## Links

A ticket's link is `https://<site>.atlassian.net/browse/<KEY>`. A key is the
project key, a dash and a number (`ENG-412`); the project key is the part
before the dash.
