// The prompt that has Claude file a message typed into the Todo pane (a in
// Todo): the todo skill writes the title, category and note from it.
// `command` runs the skill; `cli` is the ghostty-todo to use when it isn't
// the installed one the skill names (a worktree's copy); `pictures` is the
// images line, when the message has any.
export type Filing = { command: string; id: string; where: string; cli?: string; pictures?: string; message: string }

export function todoFiler({ command, id, where, cli, pictures, message }: Filing): string {
  const run = cli ? ` Run ghostty-todo as ${cli}.` : ''
  const shown = pictures ? ` ${pictures} Keep each [Image #n] in the title or note, where the message has it.` : ''
  return `${command} File this todo from the Todo pane as filing ${id}. It was typed in ${where}.${run}${shown} The message: ${message}`
}
