// Reading what `ghostty-hub tray` printed, apart from the QML so a test can
// run it.
.pragma library

// Snapshots that may fail in a row before the widget says it's out of date,
// so one slow cold start doesn't flicker it.
var STALE_AFTER = 3

// The words come from `tray text` (text.json's widget section). These few
// stand in until they load, and for good if the tray command can't run.
var FALLBACK = {
    title: "Agents",
    openHub: "Open hub",
    nothingRunning: "Nothing running",
    allQuiet: "All quiet. No agent is running.",
    actFailed: "The tray command failed: {err}",
    stale: "Not updating: {err}",
    staleSince: "Not updating since {time}: {err}",
    exited: "it exited with {code}",
    printedNothing: "it printed nothing",
    noSnapshot: "it printed no snapshot"
}

function lookup(from, path) {
    let at = from
    for (const part of path.split(".")) {
        if (!at || typeof at !== "object" || !(part in at)) return undefined
        at = at[part]
    }
    return at
}

// The string at a dotted path, as text.ts's t() gives it: `{name}` filled
// from vars, and `{ one, other }` picked by vars.n. One the words don't
// have, and FALLBACK doesn't either, is empty rather than a path on screen.
function say(words, path, vars) {
    let v = lookup(words, path)
    if (v === undefined) v = lookup(FALLBACK, path)
    if (v && typeof v === "object" && "other" in v) v = vars && vars.n === 1 && "one" in v ? v.one : v.other
    if (typeof v !== "string") return ""
    return v.replace(/\{(\w+)\}/g, (all, name) => (vars && name in vars ? String(vars[name]) : all))
}

function isWords(data) {
    return !!data && typeof data.title === "string" && !!data.actions
}

// `run` is as Plasma's executable engine hands it over: { stdout, stderr,
// "exit code" }.
function parse(run, words) {
    const out = String(run.stdout || "").trim()
    try {
        const data = JSON.parse(out)
        if (data && typeof data === "object") return { data: data }
    } catch (e) {
        // Not JSON: what it printed instead is said below.
    }
    const err = why(run.stderr)
    const code = run["exit code"]
    return { err: err || out.split("\n").pop() || (code ? say(words, "exited", { code: code }) : say(words, "printedNothing")) }
}

// The line of stderr that says what went wrong. When tray.ts throws, Node
// prints the source line, a caret, the error, its stack and then its own
// version, so the last line is "Node.js v22…": the error's own line is the
// one to show, else the last that isn't a stack frame or Node's furniture.
function why(stderr) {
    const lines = String(stderr || "")
        .split("\n")
        .map(l => l.trim())
        .filter(l => l !== "" && !/^Node\.js v\d/.test(l) && !/^\^+$/.test(l))
    // "Error: …" itself too, not only "TypeError: …": Node can print more
    // after the stack, such as an error's { code } or a require stack.
    const error = lines.find(l => /^(?:[A-Z]\w*)?(?:Error|Exception)\b/.test(l))
    return error || lines.filter(l => !/^at /.test(l)).pop() || ""
}

// Whether a snapshot names a button the words have no label for: the tray
// learnt a new action after the widget fetched its words, which are then
// fetched again.
function missingWords(words, items) {
    if (!isWords(words)) return false
    return (items || []).some(it => (it.actions || []).some(a => typeof words.actions[a] !== "string"))
}

// Whether a window title names `name` as a whole word, so "layout-1" doesn't
// match the window of "layout-10".
function namesWindow(title, name) {
    if (!name) return false
    const quoted = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    return new RegExp("(^|[^\\w-])" + quoted + "($|[^\\w-])").test(String(title || ""))
}

function isSnapshot(data) {
    return !!data && Array.isArray(data.items) && !!data.counts
}

function staleLine(err, lastGood, words) {
    if (!lastGood) return say(words, "stale", { err: err })
    return say(words, "staleSince", { time: new Date(lastGood).toTimeString().slice(0, 5), err: err })
}
