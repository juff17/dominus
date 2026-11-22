// Everything the widget shows and does goes through `ghostty-hub tray`
// (tray/tray.ts). AGENT_TRAY_HUB points it at another ghostty-hub, for
// testing.
import QtQuick
import QtQuick.Layouts
import org.kde.plasma.plasmoid
import org.kde.plasma.core as PlasmaCore
import org.kde.plasma.plasma5support as P5Support
import org.kde.taskmanager as TaskManager
import "palette.js" as M
import "reply.js" as R

PlasmoidItem {
    id: root

    readonly property var sectionKeys: ["you", "broke", "work", "watch", "done"]
    property var snap: ({ counts: {}, items: [], unseen: false, alert: false })
    // The last snapshot as text: one that says the same isn't put in `snap`,
    // since a new value rebuilds every row of the inbox, dropping a click
    // that is half done.
    property string snapText: ""
    property bool flashing: false
    property color flashColor: M.peach
    // ▲ and ✗ ids that already flashed, with when a snapshot last listed
    // each in any section: a monitor that goes to watch and comes back, or a
    // row missing from one snapshot, isn't news again. `started`: the first
    // snapshot isn't news.
    property var flashed: ({})
    readonly property int forgetMs: 60000
    property bool started: false
    property string message: ""
    property bool messageOk: true
    // By command: { kind, call } and, for an act, its row's id and whether
    // Ghostty was raised already.
    property var pending: ({})
    // Ids of rows whose act is running, or has answered but no snapshot
    // begun since has landed: the inbox ignores their keys and buttons.
    property var busy: ({})
    // Rows whose act has answered, freed by the next snapshot to begin.
    property var settling: []
    // One snapshot runs at a time, so replies can't land out of order and
    // slow cold starts can't pile up: `snapAgain` asks for another once it
    // ends, and `snapOutdated` drops its reply when an act or `seen` changed
    // what it had read. One that runs past snapGiveUpMs is given up.
    property string snapCmd: ""
    property double snapStarted: 0
    property bool snapAgain: false
    property bool snapOutdated: false
    readonly property int snapGiveUpMs: 30000
    property int failures: 0
    property string failure: ""
    property double lastGood: 0
    readonly property string stale: failures >= R.STALE_AFTER ? R.staleLine(failure, lastGood, words) : ""
    // Asked for again every wordsMs, since the tray can learn new ones
    // without plasmashell restarting.
    property var words: ({})
    property bool wordsAsked: false
    property int wordFailures: 0
    property double wordsAt: 0
    readonly property int wordsMs: 600000
    function say(path, vars) {
        return R.say(words, path, vars)
    }
    // From the last snapshot; the fallbacks stand in until the first.
    function setting(name, fallback) {
        return (snap.settings && snap.settings[name] !== undefined) ? snap.settings[name] : fallback
    }
    property int calls: 0

    readonly property string hub: "\"${AGENT_TRAY_HUB:-$HOME/.config/ghostty/bin/ghostty-hub}\""

    preferredRepresentation: compactRepresentation
    toolTipMainText: say("title")
    toolTipSubText: {
        const c = snap.counts || {}
        const said = sectionKeys.filter(k => c[k] > 0).map(k => say("counts." + k, { n: c[k] }))
        const now = said.length ? said.join(" · ") : say("nothingRunning")
        return stale ? stale + "\n" + now : now
    }

    // Each call is its own source, so two of the same command don't merge.
    function tray(kind, args, extra) {
        calls += 1
        const cmd = hub + " tray " + args + " #" + calls
        pending[cmd] = Object.assign({ kind: kind, call: calls }, extra || {})
        exec.connectSource(cmd)
        return cmd
    }
    function quote(s) {
        return "'" + String(s).replace(/'/g, "'\\''") + "'"
    }

    function handle(call, run) {
        const r = R.parse(run, words)
        const data = r.data || null
        if (call.kind === "text") gotWords(data, r.err)
        else if (call.kind === "snapshot") snapshotDone(call, data, r.err)
        else if (call.kind === "seen") snapshot(true)
        else if (call.kind === "act") acted(call, data, r.err)
    }

    function gotWords(data, err) {
        wordsAsked = false
        if (R.isWords(data)) {
            words = data
            wordsAt = Date.now()
            wordFailures = 0
            return
        }
        // Asked again on the next poll while there are none; words already
        // shown are kept and asked for again after wordsMs.
        if (R.isWords(words)) wordsAt = Date.now()
        wordFailures += 1
        if (wordFailures === R.STALE_AFTER) console.warn("agents: tray text failing: " + (err || "it printed no words"))
    }

    // `fresh` when something just changed what the tray reads (an act,
    // `seen`), so one already running is too old to show.
    function snapshot(fresh) {
        if (snapCmd) {
            snapAgain = true
            if (fresh) snapOutdated = true
            return
        }
        snapAgain = false
        snapOutdated = false
        snapStarted = Date.now()
        snapCmd = tray("snapshot", "snapshot", { frees: settling })
        settling = []
    }

    function snapshotDone(call, data, err) {
        snapCmd = ""
        if (snapOutdated) {
            // Its rows are from before the act, so the act's row stays busy
            // until the snapshot asked for below.
            settling = settling.concat(call.frees || [])
            snapAgain = true
        } else if (gotSnapshot(data, err)) {
            free(call.frees)
        } else {
            // The acted row is still on screen from the old rows, so it stays
            // busy until a snapshot that worked replaces them.
            settling = settling.concat(call.frees || [])
        }
        if (snapAgain) snapshot(false)
    }

    // A snapshot that never ends would stop the polling: give it up, as a
    // failed one, and let the next tick start another.
    function giveUpSnapshot() {
        const cmd = snapCmd
        const call = pending[cmd] || {}
        delete pending[cmd]
        exec.disconnectSource(cmd)
        console.warn("agents: snapshot given up " + JSON.stringify({ ms: Date.now() - snapStarted }))
        snapAgain = false
        snapOutdated = false
        snapshotDone(call, null, say("printedNothing"))
    }

    // Whether its rows are now the ones shown.
    function gotSnapshot(data, err) {
        if (!R.isSnapshot(data)) {
            failed(err || say("noSnapshot"))
            return false
        }
        const text = JSON.stringify(data)
        if (text !== snapText) {
            snapText = text
            snap = data
        }
        alertNew(data.items || [])
        // A button the words lack a label for: they're older than the tray
        // that sent it, so ask for them again, at most once a minute.
        if (R.missingWords(words, data.items) && Date.now() - wordsAt > 60000) wordsAt = 0
        // The tray read its rows but agentd isn't keeping them current: say
        // so as for a failed snapshot, while still showing them.
        if (typeof data.stale === "string" && data.stale !== "") {
            failed(data.stale)
            return true
        }
        failures = 0
        lastGood = Date.now()
        return true
    }

    function failed(why) {
        failure = why
        failures += 1
        if (failures === R.STALE_AFTER) console.warn("agents: tray snapshot failing: " + failure)
    }

    function startAct(action, id) {
        if (busy[id]) return
        setBusy([id], true)
        // Review and Edit open Monitors on the proposal, and the tray command returns
        // only once it closes: Ghostty comes to the front now, or the popup
        // would open behind whatever is there.
        const raised = action === "review" || action === "edit"
        if (raised) {
            raiseGhostty("")
            root.expanded = false
        }
        tray("act", "act " + action + " " + quote(id), { id: id, raised: raised })
    }

    function acted(call, data, err) {
        if (!data) {
            console.warn("agents: tray act failed: " + err)
            showMessage(say("actFailed", { err: err }), false)
        } else {
            showMessage(data.message || "", !!data.ok)
            if (data.raise && !call.raised) {
                raiseGhostty(data.layout || "")
                root.expanded = false
            }
        }
        if (call.id) settling = settling.concat([call.id])
        snapshot(true)
    }

    function setBusy(ids, on) {
        const next = Object.assign({}, busy)
        for (const id of ids) {
            if (on) next[id] = true
            else delete next[id]
        }
        busy = next
    }

    function free(ids) {
        if (ids && ids.length) setBusy(ids, false)
    }

    function showMessage(line, ok) {
        message = line
        messageOk = ok
        clearMessage.restart()
    }

    function alertNew(items) {
        const now = Date.now()
        const isLoud = it => it.section === "you" || it.section === "broke"
        const news = items.filter(it => isLoud(it) && it.new && flashed[it.id] === undefined)
        const first = !started
        started = true
        // Not Object.fromEntries: Qt's JavaScript engine lacks it.
        const kept = {}
        for (const id in flashed) if (now - flashed[id] < forgetMs) kept[id] = flashed[id]
        for (const it of items) if (isLoud(it) || kept[it.id] !== undefined) kept[it.id] = now
        flashed = kept
        if (!news.length || first || root.expanded) return
        // A ✗ outranks a ▲ for the colour; else the first new one.
        flash(news.find(it => it.section === "broke") || news[0])
        // A second copy of the widget, on another panel, gets `notified`
        // items: it flashes but doesn't pop up or play the sound again.
        const tell = news.filter(it => !it.notified)
        if (setting("desktop", false)) tell.slice(0, 3).forEach(notify)
        if (tell.some(it => it.section === "broke" ? setting("soundBroke", false) : setting("soundYou", false))) chime()
    }

    function flash(item) {
        if (flashOff.interval <= 0) return
        flashColor = M.section[item.section]
        flashing = true
        flashOff.restart()
    }

    function notify(item) {
        const broke = item.section === "broke"
        fire("notify-send -a " + quote(say("title")) + " -i " + (broke ? "dialog-error" : "dialog-information")
             + " " + quote((broke ? "✗ " : "▲ ") + item.title) + " " + quote(item.meta || ""))
    }

    function chime() {
        if (setting("quiet", true) && ghosttyActive()) return
        const file = String(setting("soundFile", ""))
        const name = String(setting("sound", "message-new-instant")).replace(/[^a-z-]/g, "")
        if (file) fire("canberra-gtk-play -f " + quote(file) + " 2>/dev/null || paplay " + quote(file))
        else fire("canberra-gtk-play -i " + name + " 2>/dev/null || paplay /usr/share/sounds/freedesktop/stereo/" + name + ".oga")
    }

    function fire(cmd) {
        calls += 1
        fireAndForget.connectSource(cmd + " #" + calls)
    }

    function ghosttyTasks() {
        const out = []
        for (let i = 0; i < tasks.count; i++) {
            const idx = tasks.index(i, 0)
            const app = String(tasks.data(idx, TaskManager.AbstractTasksModel.AppId) || "")
            if (app.toLowerCase().indexOf("ghostty") >= 0) out.push(idx)
        }
        return out
    }

    function ghosttyActive() {
        return ghosttyTasks().some(idx => tasks.data(idx, TaskManager.AbstractTasksModel.IsActive))
    }

    // Only the panel can raise a window on Wayland, so the tray command
    // switches the tab and this raises it. Without a `layout`, the Ghostty
    // window used last, which is the client tmux puts a popup in.
    function raiseGhostty(layout) {
        const found = ghosttyTasks()
        if (!found.length) return
        const named = layout ? found.find(idx => R.namesWindow(tasks.data(idx, Qt.DisplayRole), layout)) : undefined
        tasks.requestActivate(named || lastUsed(found))
    }

    function lastUsed(found) {
        // A role older Plasmas lack; then the first is as good a guess.
        const role = TaskManager.AbstractTasksModel.LastActivated
        if (role === undefined) return found[0]
        const when = idx => Number(tasks.data(idx, role)) || 0
        return found.reduce((best, idx) => (when(idx) > when(best) ? idx : best), found[0])
    }

    TaskManager.TasksModel {
        id: tasks
        filterByVirtualDesktop: false
        filterByActivity: false
        filterByScreen: false
        groupMode: TaskManager.TasksModel.GroupDisabled
    }

    P5Support.DataSource {
        id: fireAndForget
        engine: "executable"
        connectedSources: []
        onNewData: source => disconnectSource(source)
    }

    P5Support.DataSource {
        id: exec
        engine: "executable"
        connectedSources: []
        onNewData: (source, data) => {
            const call = root.pending[source]
            delete root.pending[source]
            disconnectSource(source)
            if (call) root.handle(call, data)
        }
    }

    Timer {
        interval: root.setting("pollMs", 2000)
        running: true
        repeat: true
        triggeredOnStart: true
        onTriggered: {
            if (!root.wordsAsked && (!R.isWords(root.words) || Date.now() - root.wordsAt > root.wordsMs)) {
                root.wordsAsked = true
                root.tray("text", "text")
            }
            if (root.snapCmd && Date.now() - root.snapStarted > root.snapGiveUpMs) root.giveUpSnapshot()
            root.snapshot(false)
        }
    }
    Timer {
        id: flashOff
        interval: root.setting("flashMs", 2000)
        onTriggered: root.flashing = false
    }
    Timer {
        id: clearMessage
        interval: root.setting("messageMs", 6000)
        onTriggered: root.message = ""
    }

    onExpandedChanged: {
        if (root.expanded) {
            flashing = false
            // The rows on screen, not whatever the tray holds by now: one
            // that came since the last snapshot hasn't been seen, and stays
            // news for when the inbox closes.
            const ids = (snap.items || []).map(it => quote(it.id))
            if (ids.length) tray("seen", "seen " + ids.join(" "))
            else snapshot(true)
        }
    }

    compactRepresentation: MouseArea {
        readonly property int size: Math.max(11, Math.min(15, Math.round(height * 0.42)))
        Layout.minimumWidth: chip.implicitWidth + 8
        Layout.preferredWidth: chip.implicitWidth + 8
        hoverEnabled: true
        onClicked: root.expanded = !root.expanded

        Chip {
            id: chip
            anchors.centerIn: parent
            counts: root.snap.counts || {}
            // A literal, not sectionKeys: the settings contract test reads
            // each setting's fallback here as JSON.
            shown: root.setting("count", ["you", "broke", "work", "watch", "done"])
            ring: root.snap.unseen && !root.expanded && root.setting("ring", true)
            flashing: root.flashing
            flashColor: root.flashColor
            stale: root.stale !== ""
            fontSize: parent.size
        }
    }

    fullRepresentation: Inbox {
        id: inbox
        Layout.preferredWidth: root.setting("inboxWidth", 600)
        Layout.minimumWidth: root.setting("inboxWidth", 600)
        maxHeight: root.setting("inboxHeight", 540)
        boxWidth: root.setting("inboxWidth", 600)
        // Its content's height, up to the most Settings allow, as the
        // minimum and maximum too: Plasma reopens a popup at the size it
        // saved (popupHeight), clamped only to these, so without the minimum
        // rows that came later scrolled out of view, and without the maximum
        // one tall list left it screen-high for good. Past maxHeight the
        // inbox scrolls.
        Layout.preferredHeight: implicitHeight
        Layout.minimumHeight: implicitHeight
        Layout.maximumHeight: implicitHeight
        snap: root.snap
        words: root.words
        message: root.message
        messageOk: root.messageOk
        stale: root.stale
        busy: root.busy
        onAct: (action, id) => root.startAct(action, id)
        onOpenHub: root.tray("act", "hub")
        // In the browser: only a web address, which tray.ts already checked.
        onOpenLink: url => {
            if (/^https?:\/\//.test(url)) Qt.openUrlExternally(url)
            root.expanded = false
        }
        onClose: root.expanded = false
        Connections {
            target: root
            function onExpandedChanged() {
                if (root.expanded) {
                    inbox.showDone = root.setting("foldDone", true) === false
                    inbox.reset()
                    inbox.forceActiveFocus()
                }
            }
        }
    }
}
