# Coding standards

Shared by ticket-work (when building), review (when reviewing) and test
(when fixing). Read it from `${CLAUDE_PLUGIN_ROOT}/references/standards.md`;
never copy it.

The repo comes first. Its CLAUDE.md, linter and formatter config, and the
patterns it already uses win over anything here. These rules apply where the
repo has none, or where a change breaks its own patterns. In a review each is
a [nit] unless it causes a bug.

| Rule | Flag when | Prefer |
| --- | --- | --- |
| Follow existing patterns | New code solves a solved problem differently: its own logger, its own fetch wrapper, new naming | The existing helper or pattern, linked in the comment |
| Real enums, not strings | A closed set is passed or compared as bare strings: `car === 'ferrari'`, `status: string` | `Car.Ferrari`, typed as `Car` |
| Prompts in reusable blocks | The same sentences appear in two prompts, or one prompt mixes shared rules with its own | One block per shared rule, composed where it's used |
| MD vs inline prompts | A very large system prompt is a string in code, or a short, frequent prompt is its own MD file | Large system prompt → `.md` file; small, frequent prompt → inline template with injected values |
| Tool schema has one source | A prompt re-lists a tool's params, types or allowed values | The tool's schema describes itself; the prompt says when to use the tool |
| Options live in the schema | Allowed values or defaults are explained in prose, or checked by hand | `z.enum([...])`, `.describe()`, `.default()`; pydantic `Literal`/`Enum`, `Field(description=...)` |

## The enum rule

A closed set of values gets a name and a type. The compiler then catches
typos, and every use can be found by searching for the name.

```ts
// Flag
if (car === 'ferrari') { ... }
function price(car: string) { ... }

// Prefer
enum Car { Ferrari = 'ferrari', Porsche = 'porsche' }
if (car === Car.Ferrari) { ... }
function price(car: Car) { ... }
```

```python
class Car(StrEnum):
    FERRARI = "ferrari"
    PORSCHE = "porsche"

if car is Car.FERRARI: ...
```

- **No `enum` allowed** (TypeScript's `erasableSyntaxOnly`, as in dominus):
  use a const object, which keeps the same call sites:
  `const Car = { Ferrari: 'ferrari' } as const; type Car = (typeof Car)[keyof typeof Car]`.
- **Union types:** a union alone (`type Car = 'ferrari' | 'porsche'`) still
  means string literals at the call sites. Flag it only where the repo already
  uses enums.
- **Tool schemas:** build `z.enum` / `Literal` from the same enum, so there's
  one list.
- **Use judgement:** this is a default, not a hard rule. Skip the flag where an
  enum adds ceremony without catching anything:
  - a value used in one place;
  - a throwaway script or test fixture;
  - a string that's really open, such as user input or an external API's
    free-form field.

## Prompts and tool schemas

```ts
// Flag: the prompt repeats the schema, which drifts
const prompt = `Call search with query (string, required) and limit (1-50, default 10).`

// Prefer: the schema says it once; the prompt says when
const search = z.object({
  query: z.string().describe('Words to search for'),
  limit: z.number().int().min(1).max(50).default(10),
})
const prompt = `${SHARED.citeSources}\nSearch before answering questions about orders.`
```

- A sentence that two prompts share is one block, imported by both.
- A prompt holds its own instructions; values are injected into it, never
  pasted in by hand.
- Pydantic: `Field(description=...)`, and `Literal[...]` or an `Enum`, never
  "one of a, b, c" written in a prompt.
