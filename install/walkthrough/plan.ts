// What install.sh has to install for the parts you chose, worked out from
// what the machine already has (probe.ts), and the review that lists it the
// way apt does before anything runs. No side effects: probe.ts looks, and
// install.sh does.

export type Choices = {
  // Settings › Layout: btop across the top, and the side panel (Alt+V).
  header: boolean
  sidePanel: boolean
  // The KDE panel widget; it can only be on under Plasma 6.
  widget: boolean
  // Agents the hub starts run in Claude Code's sandbox, which needs SANDBOX.
  sandbox: boolean
}

// apt-cache show's fields for a package's candidate version.
export type AptInfo = { version: string; size: number; installedKiB: number }

export type Probe = {
  // apt-get is on this machine (Debian, Ubuntu).
  apt: boolean
  // Debian packages already installed.
  installed: ReadonlySet<string>
  // apt-cache show for each package that isn't; missing when apt doesn't know it.
  aptInfo: Readonly<Record<string, AptInfo | undefined>>
  yazi: boolean
  claude: boolean
  // The dominus plugin is installed, at user scope.
  plugin: boolean
  // The diagram-pane plugin is installed, at user scope, with its npm packages.
  diagrams: boolean
  // Google Chrome, which diagram-pane renders with, is at /usr/bin/google-chrome.
  chrome: boolean
  // Which of TOOLKITS are installed, at user scope.
  toolkits: readonly string[]
}

export type Plan = {
  // Debian packages to install, in the order the review lists them.
  apt: string[]
  // Ones apt-get isn't here to install: shown, but left to you.
  byHand: string[]
  yazi: boolean
  claude: boolean
  plugin: boolean
  // The Side panel's Diagrams: diagram-pane's npm packages, then the plugin.
  diagrams: boolean
  // Diagrams need Chrome, which apt can't install: shown, but left to you.
  chromeByHand: boolean
  widget: boolean
  // TOOLKITS ids to install.
  toolkits: string[]
}

// Agent Hub's own: Ghostty and tmux for its windows, jq for its hooks.
export const ALWAYS = ['ghostty', 'tmux', 'jq']
// Claude Code's sandbox, which the agents the hub starts to write code run in.
export const SANDBOX = ['bubblewrap', 'socat']
// The Header runs btop.
export const HEADER = ['btop']

// Anthropic's own plugins the hub's skills call rather than copy: the
// reviewer's general pass and the tester's browser.
export const TOOLKITS = [
  { id: 'pr-review-toolkit@claude-plugins-official', name: 'pr-review-toolkit', why: 'the reviewer’s general pass' },
  { id: 'playwright@claude-plugins-official', name: 'playwright', why: 'the tester’s browser' },
] as const

export const packagesFor = (c: Choices): string[] => [...ALWAYS, ...(c.sandbox ? SANDBOX : []), ...(c.header ? HEADER : [])]

export function planOf(c: Choices, probe: Probe): Plan {
  const missing = packagesFor(c).filter(p => !probe.installed.has(p))
  return {
    apt: probe.apt ? missing : [],
    byHand: probe.apt ? [] : missing,
    yazi: c.sidePanel && !probe.yazi,
    claude: !probe.claude,
    plugin: !probe.plugin,
    diagrams: c.sidePanel && !probe.diagrams,
    chromeByHand: c.sidePanel && !probe.chrome,
    widget: c.widget,
    toolkits: TOOLKITS.filter(k => !probe.toolkits.includes(k.id)).map(k => k.id),
  }
}

// Nothing to install, so there's nothing to approve: install.sh only links.
export const nothingToInstall = (p: Plan): boolean => !p.apt.length && !p.yazi && !p.claude && !p.plugin && !p.diagrams && !p.toolkits.length

// One package's paragraph of `apt-cache show --no-all-versions`.
export function parseAptShow(text: string): AptInfo | null {
  const field = (name: string) => new RegExp(`^${name}: (.+)$`, 'm').exec(text)?.[1]?.trim()
  const version = field('Version')
  const size = Number(field('Size'))
  const installedKiB = Number(field('Installed-Size'))
  if (!version || !Number.isFinite(size) || !Number.isFinite(installedKiB)) return null
  return { version, size, installedKiB }
}

// apt's way: powers of 1000, one decimal from MB up.
export function bytes(n: number): string {
  if (n < 1000) return `${n} B`
  if (n < 1e6) return `${Math.round(n / 1e3)} kB`
  if (n < 1e9) return `${(n / 1e6).toFixed(1)} MB`
  return `${(n / 1e9).toFixed(1)} GB`
}

// The review's lines, each with how it's drawn; walkthrough.ts colours them.
export type Line = { text: string; dim?: string; size?: string; tone?: 'head' | 'dim' }

export function reviewLines(p: Plan, probe: Pick<Probe, 'aptInfo'>): Line[] {
  const lines: Line[] = [{ text: 'The following will be installed:' }, { text: '' }]
  if (p.apt.length) {
    lines.push({ text: 'System packages', dim: 'apt, needs sudo', tone: 'head' })
    const width = Math.max(...p.apt.map(n => n.length))
    const vwidth = Math.max(...p.apt.map(n => probe.aptInfo[n]?.version.length ?? 0))
    for (const name of p.apt) {
      const info = probe.aptInfo[name]
      const why = HEADER.includes(name) ? 'for the Header' : SANDBOX.includes(name) ? 'for the agent sandbox' : ''
      lines.push({
        text: `  ${name.padEnd(width)}`,
        dim: info ? info.version.padEnd(vwidth) : 'version unknown',
        size: [info ? bytes(info.size) : '', why].filter(Boolean).join('   '),
      })
    }
  }
  if (p.yazi) lines.push({ text: 'Snap', tone: 'head' }, { text: '  yazi', dim: 'file manager, for the Side panel' })
  if (p.claude)
    lines.push({ text: 'Claude Code', dim: 'its own installer, from claude.ai/install.sh', tone: 'head' }, { text: '  claude' })
  if (p.plugin || p.diagrams || p.toolkits.length) lines.push({ text: 'Claude Code plugins', dim: 'claude plugin install', tone: 'head' })
  if (p.plugin) lines.push({ text: '  dominus', dim: "the hub's skills and hooks" })
  if (p.diagrams) lines.push({ text: '  diagram-pane', dim: 'for the Side panel’s Diagrams, with mermaid-cli from npm' })
  for (const k of TOOLKITS.filter(k => p.toolkits.includes(k.id))) lines.push({ text: `  ${k.name}`, dim: `from claude-plugins-official, for ${k.why}` })
  const known = p.apt.map(n => probe.aptInfo[n]).filter(i => i !== undefined)
  if (known.length) {
    const get = known.reduce((n, i) => n + i.size, 0)
    const disk = known.reduce((n, i) => n + i.installedKiB * 1024, 0)
    lines.push(
      { text: '' },
      { text: `Need to get ${bytes(get)} of archives. After this operation, ${bytes(disk)} of additional disk space will be used.` },
    )
  }
  if (p.byHand.length)
    lines.push({ text: '' }, { text: `Install these yourself first (apt-get isn't here): ${p.byHand.join(', ')}`, tone: 'dim' })
  if (p.chromeByHand) lines.push({ text: '' }, { text: 'Diagrams render with Google Chrome: install it yourself (/usr/bin/google-chrome).', tone: 'dim' })
  if (!known.length && !p.byHand.length && !p.chromeByHand) lines.push({ text: '' })
  lines.push({ text: 'Also links dominus into ~/.config/ghostty. Your own Claude settings aren’t touched.', tone: 'dim' })
  return lines
}

// What install.sh reads: one step a line, `apt` with its packages.
export function planFile(p: Plan): string {
  const steps = [
    p.apt.length ? `apt ${p.apt.join(' ')}` : '',
    p.yazi ? 'yazi' : '',
    p.claude ? 'claude' : '',
    p.plugin ? 'plugin' : '',
    p.diagrams ? 'diagrams' : '',
    ...p.toolkits.map(id => `toolkit ${id}`),
    `widget ${p.widget ? 'on' : 'off'}`,
  ]
  return `${steps.filter(Boolean).join('\n')}\n`
}
