#!/usr/bin/env node
// A gh or glab that answers from the JSON beside it, never the network, for
// the Monitors popup's tests:
//   fake-forge.mjs gh   api graphql …          gh-graphql.json
//   fake-forge.mjs gh   api --hostname h <path> gh/<path, / as _>.json
//   fake-forge.mjs glab api --hostname h <path> glab/<path, / as _>.json
// The query is left out of the name, except that the MR lists are named for
// their scope (merge_requests_mine.json, merge_requests_review.json), a
// pipelines list of tags ends _tags, and runs by commit end _pr. A call
// with -X POST (playing a job, approving a deployment) answers {}. A time
// written "@-3d" (m, h, d) is that long before now. FAKE_FORGE_DOWN=gh,glab makes those fail as not logged in;
// FAKE_FORGE_CALLS names a file each call's argv is added to, one JSON line;
// FAKE_FORGE_MANY=n adds n more PRs of gh's to the list, for a long one.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const [cli, ...args] = process.argv.slice(2)

if (process.env.FAKE_FORGE_CALLS) appendFileSync(process.env.FAKE_FORGE_CALLS, `${JSON.stringify([cli, ...args])}\n`)

if ((process.env.FAKE_FORGE_DOWN ?? '').split(',').includes(cli)) {
  process.stderr.write(cli === 'gh' ? 'To get started with GitHub CLI, please run:  gh auth login\n' : 'glab: 401 Unauthorized\n')
  process.exit(1)
}

const UNIT = { m: 60e3, h: 3600e3, d: 86400e3 }
const times = text => text.replace(/"@-(\d+)([mhd])"/g, (_, n, u) => JSON.stringify(new Date(Date.now() - Number(n) * UNIT[u]).toISOString()))

if (args.includes('-X')) {
  process.stdout.write('{}')
  process.exit(0)
}

function file() {
  if (cli === 'gh' && args.includes('graphql')) return 'gh-graphql.json'
  const path = args.at(-1) ?? ''
  const [base, query = ''] = path.split('?')
  if (cli === 'glab' && base === 'merge_requests') return /scope=created_by_me/.test(query) ? 'glab/merge_requests_mine.json' : 'glab/merge_requests_review.json'
  const more = /scope=tags/.test(query) ? '_tags' : /head_sha=/.test(query) ? '_pr' : ''
  return `${cli === 'gh' ? 'gh' : 'glab'}/${base.replaceAll('/', '_')}${more}.json`
}

const name = file()
if (!name || !existsSync(join(HERE, name))) {
  process.stderr.write(`${cli}: 404 Not Found\n`)
  process.exit(1)
}
let body = times(readFileSync(join(HERE, name), 'utf8'))
const many = Number(process.env.FAKE_FORGE_MANY ?? 0)
if (cli === 'gh' && many) {
  const json = JSON.parse(body)
  const first = json.data.mine.nodes[0]
  for (let i = 0; i < many; i++)
    json.data.mine.nodes.push({ ...first, number: 200 + i, title: `Change ${i}`, url: `https://github.com/jl/many/pull/${200 + i}`, repository: { nameWithOwner: 'jl/many' }, createdAt: new Date(Date.now() - (60 + i) * 86400e3).toISOString() })
  body = JSON.stringify(json)
}
process.stdout.write(body)
