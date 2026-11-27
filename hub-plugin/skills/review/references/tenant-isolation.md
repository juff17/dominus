# Tenant isolation

Check every data access the diff adds or changes. Can user A in org A reach
user B's data, or org B's?

First find how the repo scopes data, such as a tenant middleware, a scoped
query helper, row-level security, or an `org_id` on every table. Then check
each access path against it. A repo with no tenants or orgs skips this, and
the report says so in one line.

| Check | Flag when |
| --- | --- |
| Scoped queries | A read, list, search, update or delete isn't filtered by the caller's org and user from the session |
| Ids from input | An org, user or tenant id in the body, query, path or a header can override the session's |
| By-id access | A fetch, update or delete by id doesn't check the resource belongs to the caller's org. It must return 403 or 404, and none of B's data |
| Lists, search, counts, exports | Results, aggregates or joins can include another org's rows |
| Jobs, webhooks, caches | Background work drops the tenant, or a cache key leaves it out |

Every finding here is [blocking]. Give the access path, file:line, and how
user A reaches B's data.

With `--fix`, add the missing scope or check with the repo's own scoping
helper, plus a test for A reading B. With `--feedback`, write one comment
per access path.
