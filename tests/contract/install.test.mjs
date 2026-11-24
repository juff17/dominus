// Contract: install.sh runs the walkthrough first and installs only what it
// approved, in order, with one sudo. Every command that would change the
// machine (sudo, apt-get, snap, curl, claude, npm) is a stub that records its
// arguments; dpkg-query and apt-cache are stubs too, so the plan doesn't
// depend on what this machine has. The links go into the sandbox's home.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { REPO, sandbox } from '../harness.mjs'

const STUBS = {
  sudo: '[ "$1" = -v ] || "$@"',
  'apt-get': ':',
  snap: '[ "$1" = list ] && exit 1; :',
  curl: 'echo "echo claude installer ran >> \\"$LOG\\""',
  // Nothing installed; apt knows each package.
  'dpkg-query': ':',
  'apt-cache': 'printf "Package: %s\\nVersion: 1.0\\nInstalled-Size: 100\\nSize: 2000\\n" "$3"',
  claude: 'case "$*" in *"list --json"*) echo "[]" ;; esac',
  plasmashell: 'echo "plasmashell 6.4.0"',
  // diagram-pane's packages: where they go, and that puppeteer's Chrome isn't fetched.
  npm: 'echo "npm ran in $(pwd) skip=$PUPPETEER_SKIP_DOWNLOAD" >> "$LOG"',
}

// Claude Code's installer, as the curl stub hands it to bash: it leaves a
// claude in ~/.local/bin, which isn't on PATH.
const CLAUDE_INSTALLER = `mkdir -p "$HOME/.local/bin"
printf '#!/bin/sh\\necho "claude $*" >> "$LOG"\\ncase "$*" in *"list --json"*) echo "[]" ;; esac\\n' > "$HOME/.local/bin/claude"
chmod +x "$HOME/.local/bin/claude"`

function install(args, { claude = true, more = {} } = {}) {
  const box = sandbox('install')
  const bin = join(box.root, 'stub-bin')
  const stubs = { ...(claude ? STUBS : { ...STUBS, claude: undefined, curl: `cat <<'EOF'\n${CLAUDE_INSTALLER}\nEOF` }), ...more }
  for (const [name, body] of Object.entries(stubs)) {
    if (body === undefined) continue
    const path = box.write(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "$LOG"\n${body}\n`)
    chmodSync(path, 0o755)
  }
  const log = join(box.root, 'calls.log')
  // No real yazi, Claude or apt on the way: the stubs, node, and the system's basics.
  const env = { ...box.env, LOG: log, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` }
  const r = spawnSync('bash', [join(REPO, 'install.sh'), ...args], { env, encoding: 'utf8', timeout: 60_000, stdin: 'ignore' })
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []
  return { r, calls, box }
}

// The calls that change the machine; the rest only look.
const changes = calls => calls.filter(c => /^(sudo|apt-get|snap install|curl|npm ci|claude plugin (install|update|marketplace add))\b/.test(c))

test('without a terminal or --yes, it shows the review and installs nothing', () => {
  const { r, calls, box } = install([])
  try {
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /The following will be installed:/)
    assert.match(r.stdout, /Run \.\/install\.sh in a terminal to approve this, or pass --yes\./)
    assert.deepEqual(changes(calls), [])
    assert.ok(!existsSync(join(box.home, '.config', 'ghostty')), 'nothing linked')
  } finally {
    box.cleanup()
  }
})

test('approved, it installs what is missing in order, with one sudo, then links and adds the plugin', () => {
  const { r, calls, box } = install(['--yes'])
  try {
    assert.equal(r.status, 0, r.stderr + r.stdout)
    assert.deepEqual(changes(calls), [
      'sudo -v',
      'sudo apt-get install -y ghostty tmux jq btop',
      'apt-get install -y ghostty tmux jq btop',
      'sudo snap install yazi --classic',
      'snap install yazi --classic',
      `claude plugin marketplace add ${REPO}`,
      'claude plugin install dominus@dominus --scope user',
      'npm ci --omit=dev --no-audit --no-fund',
      'claude plugin install diagram-pane@dominus --scope user',
    ])
    assert.ok(calls.includes(`npm ran in ${join(REPO, 'diagram-plugin')} skip=1`), calls.join('\n'))
    const surface = join(box.home, '.config', 'ghostty', 'bin', 'ghostty-surface')
    assert.equal(readlinkSync(surface), join(REPO, 'ghostty', 'bin', 'ghostty-surface'))
    const widget = join(box.home, '.local', 'share', 'plasma', 'plasmoids', 'dev.dotfiles.agents')
    assert.ok(lstatSync(widget).isSymbolicLink(), 'Plasma 6, so the widget is linked')
    assert.match(r.stdout, /Need to get 8 kB of archives/)
  } finally {
    box.cleanup()
  }
})

test('on a machine without Claude Code, its installer runs first and the plugin uses the claude it left', () => {
  const { r, calls, box } = install(['--yes'], { claude: false })
  try {
    assert.equal(r.status, 0, r.stderr + r.stdout)
    assert.match(r.stdout, /its own installer, from claude\.ai\/install\.sh/)
    const after = changes(calls).slice(changes(calls).indexOf('curl -fsSL https://claude.ai/install.sh'))
    assert.deepEqual(after, [
      'curl -fsSL https://claude.ai/install.sh',
      `claude plugin marketplace add ${REPO}`,
      'claude plugin install dominus@dominus --scope user',
      'npm ci --omit=dev --no-audit --no-fund',
      'claude plugin install diagram-pane@dominus --scope user',
    ])
  } finally {
    box.cleanup()
  }
})

test('the walkthrough’s npm ci keeps the dev tools, since it replaces node_modules whole', () => {
  const script = readFileSync(join(REPO, 'install.sh'), 'utf8')
  const body = script.slice(script.indexOf('ensure_prompts() {'), script.indexOf('\n}\n', script.indexOf('ensure_prompts() {')))
  assert.match(body, /npm ci /)
  assert.doesNotMatch(body, /--omit=dev|--production/)
})

test('a plugin installed already is updated, since Claude Code runs a copy made when it was installed', () => {
  const listed = 'case "$*" in "plugin list --json") echo \'[{"id":"dominus@dominus","scope":"user"}]\' ;; *"list --json"*) echo "[]" ;; esac'
  const { r, calls, box } = install(['--yes'], { more: { claude: listed } })
  try {
    assert.equal(r.status, 0, r.stderr + r.stdout)
    const plugin = changes(calls).filter(c => c.startsWith('claude plugin') && !c.includes('diagram-pane'))
    assert.deepEqual(plugin, [`claude plugin marketplace add ${REPO}`, 'claude plugin update dominus@dominus --scope user'])
  } finally {
    box.cleanup()
  }
})

test('--links only links: no questions, sudo or installers', () => {
  const { r, calls, box } = install(['--links'])
  try {
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(changes(calls), [])
    assert.ok(existsSync(join(box.home, '.config', 'ghostty', 'config.ghostty')))
  } finally {
    box.cleanup()
  }
})

test('an unknown argument, or a target without --links, is refused', () => {
  const a = install(['ghostty'])
  const b = spawnSync('bash', [join(REPO, 'install.sh')], { env: { ...a.box.env, DOMINUS_TARGET: a.box.root }, encoding: 'utf8' })
  try {
    assert.equal(a.r.status, 1)
    assert.match(a.r.stderr, /unknown argument: ghostty/)
    assert.equal(b.status, 1)
    assert.match(b.stderr, /DOMINUS_TARGET only goes with --links/)
  } finally {
    a.box.cleanup()
  }
})
