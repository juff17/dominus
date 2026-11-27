# Comment cleanup

A comment says why the code is the way it is: a constraint, a workaround, or
an invariant that isn't obvious. Anything else is noise that goes stale.

| Comment | Do |
| --- | --- |
| Restates the code (`// increment i`, `// call the API`) | Remove it |
| Narrates the change (`// added for the new flow`, `// now uses X instead of Y`) | Remove it |
| Names the ticket or PR (`// ENG-412`, `// per review`) | Remove it. Git keeps that |
| Says why | Keep it, and tighten it if it rambles |
| No longer matches the code | Make it true, or remove it |
| Commented-out code | Remove it |
| A TODO with no owner or reason | Ask about it, or remove it |

Look only at comments in lines the diff adds or changes, and at comments the
diff makes wrong. Docstrings on public APIs stay, trimmed to what a caller
needs.

With `--fix`, apply it all as one commit after the other fixes. With
`--feedback`, write one [nit] comment per cluster of noise, never one per
line, and leave it out when the PR has bigger problems.
