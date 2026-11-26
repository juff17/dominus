# Comments to another engineer

A person reads each comment on their own PR, so keep it as short as it can
be. A paragraph is the most any comment gets.

## Rules

- **One point per comment**, on the line it's about.
- **Lead with the problem, then the fix.** No greetings, praise padding or
  hedging.
- **Fewest words** that still make sense to someone who hasn't seen the
  review.
- **Code:** a code block only when the fix is a few lines.
- **Tags:** `[nit]` for style, code quality, standards and not following
  existing patterns. A comment with no tag means it should change before
  merge. The review's own ranks (`[blocking]`, `[should-fix]`) stay in the
  report and never go in a comment.
- Phrase a real question as a question.
- **Link** the existing helper or pattern instead of explaining it.
- **Never paste** a whole rewrite, a list of every occurrence, or your
  reasoning.
- When the PR has many nits, send the three that matter most.

## Examples

| Situation | Comment |
| --- | --- |
| Bug, ordering | The toast shows before `save()` resolves, so a failed save still says "Saved". Move it after the `await`. |
| Bug, state machine | Cancel during upload sets `idle`, but the pending upload still sets `done` when it finishes. Ignore results once cancelled (snippet below). |
| Missing error path | A 404 here throws inside the effect and leaves the spinner on. Catch it and show the empty state. |
| Tenant leak | `GET /invoices/:id` loads by id alone, so any signed-in user can read another org's invoice. Scope it with `forOrg(session.orgId)`. |
| Ids from input | `orgId` comes from the request body, so a caller can write into another org. Take it from the session. |
| Concurrency | Two parallel requests both read `count = 4` and write 5. Use an atomic increment or a row lock. |
| Duplicate delivery | The webhook isn't idempotent: a retry charges twice. Check `event.id` before handling it. |
| Question, intent unclear | Is retrying 5xx here intended? The client already retries 3 times, so this can send 9 requests. |
| Question, scope | Should archived projects show here? The old list hid them. |
| Missing types | `payload` is `any`, so the `status` typo on line 42 compiles. Type it as `OrderEvent`. |
| Tests | No test covers the cancel path this adds. A test for cancel-then-complete would catch the bug above. |
| [nit] enum | [nit] Use `Car.Ferrari` rather than `'ferrari'`. |
| [nit] existing pattern | [nit] `formatDate` in `utils/dates.ts` already does this. |
| [nit] prompt repeats schema | [nit] The prompt lists the tool's params again; they'll drift from the zod schema. Let the schema describe them. |

With a code block, kept small:

````markdown
Cancel sets `idle`, but the in-flight upload still sets `done`. Ignore it once cancelled:

```ts
if (state.status !== 'uploading') return
```
````
