# Comment cleanup

A comment says why the code is the way it is: a constraint, a workaround, an
invariant that isn't obvious. Anything else is noise that goes stale.

| Comment | Do |
| --- | --- |
| Restates the code (`// increment i`, `// call the API`) | Remove |
| Narrates the change (`// added for the new flow`, `// now uses X instead of Y`) | Remove |
| Names the ticket or PR (`// ENG-412`, `// per review`) | Remove; that's git's job |
| Says why (a constraint, a workaround, an invariant) | Keep; tighten it if it rambles |
| No longer matches the code | Fix it to say what's true, or remove it |
| Commented-out code | Remove |
| A TODO with no owner or reason | Ask, or remove it |

- Only comments in lines the diff adds or changes, plus a comment the diff
  makes wrong.
- Docstrings on public APIs stay; trim them to what a caller needs.
- **`--fix`:** apply it all as one commit, after the other fixes.
- **`--feedback`:** one [nit] comment per cluster of noise, never one per
  line. Leave it out when the PR has bigger problems.
