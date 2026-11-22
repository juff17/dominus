// Times are offsets back from `now`, a few seconds past a whole unit, so the
// ages the rows show ("2m", "3h", "1d") hold for the length of a test.
const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const SLACK = 5000

export function todos({ now = Date.now(), alpha, beta, gamma, home, filing = false }) {
  const at = (root, repo, extra = {}) => ({ root, repo, cwd: root, worktree: '', branch: 'main', ...extra })
  const ago = ms => now - ms - SLACK
  const items = [
    {
      id: 'a1b', title: 'Crash when saving an empty file', cat: 'bug', type: 'research', by: 'claude', pane: '%1',
      note: 'Seen in the editor pane after a fresh clone; the stack trace points at the writer.',
      created: ago(2 * MIN), done: null, ...at(alpha, 'alpha'),
    },
    { id: 'b2c', title: 'Login button misaligned on narrow screens', cat: 'bug', type: 'action', by: 'you', note: '', created: ago(3 * HOUR), done: null, ...at(beta, 'beta') },
    { id: 'c3d', title: 'Add a dark mode toggle to the settings page', cat: 'feature', by: 'you', note: '', created: ago(1 * DAY), done: null, ...at(alpha, 'alpha') },
    {
      id: 'd4e', title: 'Follow up on the review comments', cat: 'follow-up', type: 'review', by: 'claude', pane: '%99',
      note: 'Two threads are still open.\nOne asks for a test.',
      handoff: { name: 'follow-up-on-the-review-d4e', where: 'bg', pane: '', at: ago(10 * MIN) },
      created: ago(5 * MIN), done: null, ...at(gamma, 'gamma'),
    },
    { id: 'e5f', title: 'Document the install steps', cat: 'docs', type: 'chore', by: 'claude', pane: '%42', session: 'sess-123', note: '', created: ago(2 * DAY), done: null, ...at(beta, 'beta') },
    { id: 'f6g', title: 'Should we drop Node 18?', cat: 'question', type: 'decide', by: 'claude', pane: '%5', note: '', created: ago(4 * HOUR), done: null, ...at(alpha, 'alpha') },
    { id: 'g7h', title: 'Buy more coffee', cat: 'other', by: 'you', note: '', created: ago(30 * MIN), done: null, root: home, repo: 'none', cwd: home, worktree: '', branch: '' },
    // Done a second ago: under "done today" unless the test starts in the
    // first second after midnight UTC.
    { id: 'h8i', title: 'Ship version one', cat: 'feature', by: 'you', note: '', created: ago(3 * DAY), done: now - 1000, ...at(alpha, 'alpha') },
    {
      id: 'i9j', title: 'rename the sidebar thing', cat: 'follow-up', by: 'claude', note: '', created: ago(1 * MIN), done: null,
      filing: { started: ago(1 * MIN), error: 'claude exited with code 1: rate limited' }, ...at(alpha, 'alpha'),
    },
  ]
  // No pid: dropping it would otherwise signal that process.
  if (filing) items.push({ id: 'j0k', title: 'look into the flaky deploy job', cat: 'follow-up', by: 'claude', note: '', created: ago(0), done: null, filing: { started: now - 2000 }, ...at(beta, 'beta') })
  return { v: 1, items }
}
