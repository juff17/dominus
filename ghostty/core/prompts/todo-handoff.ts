// What the hub tells an agent a todo is handed to (w in Todo), before the
// todo itself. `about` is its category, repo and branch, in words.
export type Handoff = { id: string; about: string; worktree: boolean; merge: 'ask' | 'never' }

export function todoHandoff({ id, about, worktree, merge }: Handoff): string[] {
  const lines = [`Work on todo ${id} from my todo list, ${about}.`]
  if (worktree) {
    // The id keeps two agents on similar titles from sharing a worktree.
    lines.push(`End the worktree's name with the todo's id, ${id}.`)
    // Merging is the user's call, and the worktree may still hold work the
    // user wants, so the agent asks before doing either.
    lines.push(
      merge === 'never'
        ? 'When the work is ready, commit it in the worktree and tell me; never merge it, I merge it myself. Never remove the worktree.'
        : "When the work is ready, commit it in the worktree and ask me whether to merge it; never merge unasked. After it's merged, ask me whether to remove the worktree; never remove it unasked.",
    )
  }
  lines.push(`Once it's finished, mark it done: ~/.config/ghostty/bin/ghostty-todo done ${id}`)
  return lines
}
