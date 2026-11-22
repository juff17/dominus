import assert from 'node:assert/strict'
import { test } from 'node:test'

import { type Probe, bytes, nothingToInstall, packagesFor, parseAptShow, planFile, planOf, reviewLines } from './plan.ts'

const all = { header: true, sidePanel: true, widget: true }
const fresh: Probe = {
  apt: true,
  installed: new Set(),
  aptInfo: {
    ghostty: { version: '1.3.0~us1-0ubuntu1.1', size: 17039192, installedKiB: 30886 },
    tmux: { version: '3.6a-2ubuntu0.2', size: 517156, installedKiB: 1273 },
    jq: { version: '1.8.1-4ubuntu2', size: 72432, installedKiB: 122 },
    btop: { version: '1.4.6-2', size: 603870, installedKiB: 1762 },
  },
  yazi: false,
  claude: false,
  plugin: false,
  diagrams: false,
  chrome: false,
}
const done: Probe = { ...fresh, installed: new Set(['ghostty', 'tmux', 'jq', 'btop']), aptInfo: {}, yazi: true, claude: true, plugin: true, diagrams: true, chrome: true }

test('the hub always needs ghostty, tmux and jq; the Header adds btop', () => {
  assert.deepEqual(packagesFor(all), ['ghostty', 'tmux', 'jq', 'btop'])
  assert.deepEqual(packagesFor({ ...all, header: false }), ['ghostty', 'tmux', 'jq'])
})

test('a fresh machine needs everything; yazi, diagram-pane and Chrome only with the Side panel', () => {
  const p = planOf(all, fresh)
  assert.deepEqual(p, {
    apt: ['ghostty', 'tmux', 'jq', 'btop'],
    byHand: [],
    yazi: true,
    claude: true,
    plugin: true,
    diagrams: true,
    chromeByHand: true,
    widget: true,
  })
  const bare = planOf({ ...all, sidePanel: false }, fresh)
  assert.deepEqual([bare.yazi, bare.diagrams, bare.chromeByHand], [false, false, false])
})

test('Chrome already there needs no note; diagram-pane alone still needs approval', () => {
  const p = planOf(all, { ...done, diagrams: false })
  assert.equal(p.chromeByHand, false)
  assert.ok(!nothingToInstall(p))
  assert.equal(planFile(p), 'diagrams\nwidget on\n')
})

test('only what is missing is listed, and a machine with everything needs no approval', () => {
  const some = planOf(all, { ...fresh, installed: new Set(['ghostty', 'jq']), claude: true })
  assert.deepEqual(some.apt, ['tmux', 'btop'])
  assert.equal(some.claude, false)
  assert.ok(nothingToInstall(planOf(all, done)))
  assert.ok(!nothingToInstall(some))
})

test('without apt-get, missing packages are left to you', () => {
  const p = planOf(all, { ...fresh, apt: false })
  assert.deepEqual(p.apt, [])
  assert.deepEqual(p.byHand, ['ghostty', 'tmux', 'jq', 'btop'])
})

test('apt-cache show is read for version and sizes', () => {
  const text = 'Package: jq\nVersion: 1.8.1-4ubuntu2\nInstalled-Size: 122\nSize: 72432\nDescription: x\n'
  assert.deepEqual(parseAptShow(text), { version: '1.8.1-4ubuntu2', size: 72432, installedKiB: 122 })
  assert.equal(parseAptShow('Package: jq\n'), null)
})

test('sizes read as apt writes them', () => {
  assert.equal(bytes(512), '512 B')
  assert.equal(bytes(72432), '72 kB')
  assert.equal(bytes(17039192), '17.0 MB')
})

test('the review lists each step and totals what apt fetches', () => {
  const text = reviewLines(planOf(all, fresh), fresh).map(l => [l.text, l.dim, l.size].filter(Boolean).join(' '))
  assert.deepEqual(text, [
    'The following will be installed:',
    '',
    'System packages apt, needs sudo',
    '  ghostty 1.3.0~us1-0ubuntu1.1 17.0 MB',
    '  tmux    3.6a-2ubuntu0.2      517 kB',
    '  jq      1.8.1-4ubuntu2       72 kB',
    '  btop    1.4.6-2              604 kB   for the Header',
    'Snap',
    '  yazi file manager, for the Side panel',
    'Claude Code its own installer, from claude.ai/install.sh',
    '  claude',
    'Claude Code plugins claude plugin install',
    "  dominus the hub's skills and hooks",
    '  diagram-pane for the Side panel’s Diagrams, with mermaid-cli from npm',
    '',
    'Need to get 18.2 MB of archives. After this operation, 34.9 MB of additional disk space will be used.',
    '',
    'Diagrams render with Google Chrome: install it yourself (/usr/bin/google-chrome).',
    'Also links dominus into ~/.config/ghostty. Your own Claude settings aren’t touched.',
  ])
})

test('install.sh reads one step a line', () => {
  assert.equal(planFile(planOf(all, fresh)), 'apt ghostty tmux jq btop\nyazi\nclaude\nplugin\ndiagrams\nwidget on\n')
  assert.equal(planFile(planOf({ ...all, widget: false }, done)), 'widget off\n')
})
