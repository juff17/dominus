// Escape sequences layout.conf, the rail and the tray send the hub to
// interrupt whatever it's doing. No terminal sends them for a real key press.

// Sent by Alt+N (layout.conf) and the rail's + new.
export const NEW_AGENT_KEY = '\x1b[9100~'
// Sent by Ctrl+Shift+B and Ctrl+] just before they close the open session,
// so the hub draws the board, not the list, once its pane widens.
export const PEEK_CLOSING_KEY = '\x1b[9101~'
// The tray writes the agent's id to the window's hubOpen() file first
// (tray/navigate.ts): a background agent has no tab to go to.
export const OPEN_AGENT_KEY = '\x1b[9102~'
// Sent by Alt+D (layout.conf): the open session's diagrams, or the selected card's.
export const DIAGRAMS_KEY = '\x1b[9103~'
// Closes dv's diagrams window. Not M-d itself: once Settings › Keybinds moves
// the key, a real Alt+D reaches dv too, and must not close it.
export const DIAGRAMS_CLOSE_KEY = '\x1b[9104~'
// Sent by Alt+E in the hub (layout.conf): opens the editor on the open
// session's agent, or the selected card's, from the folder agentd knows it
// by, so a background agent with no tab opens too.
export const EDITOR_KEY = '\x1b[9105~'
// Sent by Ctrl+Shift+A (layout.conf) when no session is open beside the
// list: the hub opens the last one again, else the selected agent.
export const AGENT_VIEW_KEY = '\x1b[9106~'
