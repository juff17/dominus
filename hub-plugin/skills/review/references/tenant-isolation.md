# Tenant isolation

Check every data access the diff adds or changes for leaks across tenants:
can user A in org A reach user B's or org B's data? This lives only in
review; the test skill doesn't cover it.

Find how the repo scopes data first: a tenant middleware, a scoped query
helper, row-level security, an `org_id` on every table. Then check each
access path against it.

| Check | Flag when |
| --- | --- |
| Scoped queries | A read, list, search, update or delete isn't filtered by the caller's org and user from the session |
| Ids from input | An org, user or tenant id in the body, query, path or a header can override the session's |
| By-id access | A fetch, update or delete by id doesn't check that the resource belongs to the caller's org. It must return 403/404 and none of B's data |
| Lists, search, counts, exports | Results, aggregates or joins can include another org's rows |
| Jobs, webhooks, caches | Background work drops the tenant, or a cache key leaves it out |

- **Severity:** every finding is [blocking]. Give the access path, file:line,
  and how user A in org A reaches B's data.
- **`--fix`:** add the missing scope or check, using the repo's own scoping
  helper, plus a test for the A-reads-B case.
- **`--feedback`:** one comment per access path.
- **Multi-tenant check:** a repo with no tenants or orgs skips this pass.
  Say so in one line of the report.
