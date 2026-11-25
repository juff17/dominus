// Sentences more than one kind of agent gets. Each agent's prompt puts its
// own together from these and its own file beside this one.

// A skill like ticket-implement makes its own worktree, and EnterWorktree
// can't nest one in another, so the agent leaves that to the skill.
export const OWN_WORKTREE =
  'Before anything else, make your own worktree with the EnterWorktree tool and do all the work in it. Name it for the task in a few kebab-case words, starting with the ticket key (like ENG-123) when the task gives a ticket. If a skill you run makes its own worktree, let it do so instead.'

// Excluded commands match only when nothing is chained to them, and the
// sandbox's placeholders at the worktree root make git add -A fail.
// Throwaway scripts stay out of what gets staged.
export const SANDBOX =
  "Your shell commands run in a sandbox. Run gh, glab, docker and git fetch, pull and push as single commands, with nothing chained, piped or redirected, or they run without the user's login and network. Stage with git add -u or by folder: git add -A and git add . fail here. Write any script you make only to try something out in your scratchpad directory, never in the repo, so it isn't committed."

// `list` names each image, like "[Image #1] is /path/a.png". One line: a tab
// agent's command is typed into a shell, where a newline would run it early.
export const images = (list: string): string => `The prompt has images attached: ${list}. Read each one with the Read tool before you start.`
