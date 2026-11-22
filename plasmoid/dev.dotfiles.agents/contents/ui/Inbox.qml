import QtQuick
import QtQuick.Controls as QQC
import QtQuick.Layouts
import "palette.js" as M
import "reply.js" as R

Rectangle {
    id: inbox

    property var snap: ({ counts: {}, items: [] })
    property var words: ({})
    function say(path, vars) {
        return R.say(words, path, vars)
    }
    property string message: ""
    property bool messageOk: true
    property string stale: ""
    property bool showDone: false
    // Rows whose act is still running take no keys or buttons, so a second
    // press can't answer whatever the agent shows next.
    property var busy: ({})
    property int maxHeight: 540
    property int boxWidth: 600

    signal act(string action, string id)
    signal openLink(string url)
    signal openHub()
    signal close()

    readonly property var sections: [
        { key: "you", glyph: "▲" },
        { key: "broke", glyph: "✗" },
        { key: "work", glyph: "✻" },
        { key: "watch", glyph: "◉" }
    ]
    function oneLine(s) {
        return String(s).replace(/\s+/g, " ")
    }
    function itemsOf(key) {
        return (snap.items || []).filter(i => i.section === key)
    }
    readonly property var doneItems: itemsOf("done")
    // In the order they're drawn.
    readonly property var rows: {
        const out = []
        for (const s of sections) out.push(...itemsOf(s.key))
        if (showDone) out.push(...doneItems)
        return out
    }
    // The selection follows a row's id, not its place, since any snapshot can
    // add or take rows above it and ↵, 1 2 3 and x must act on the row you
    // chose. When that row leaves, it goes to the agent's next row of the
    // same kind (the id less the time its state began), else to the row now
    // at its place; and for a moment after it moves without a key, those keys
    // do nothing, so a press meant for the old row can't land on the new one.
    property string selId: ""
    property int selAt: 0
    property double movedAt: 0
    readonly property int settleMs: 800
    function stem(id) {
        const m = /^(\w+:.+):\d+$/.exec(id)
        return m ? m[1] : id
    }
    readonly property int at: {
        if (!rows.length) return -1
        let i = rows.findIndex(x => x.id === selId)
        if (i < 0 && selId) i = rows.findIndex(x => stem(x.id) === stem(selId))
        return i >= 0 ? i : Math.min(Math.max(0, selAt), rows.length - 1)
    }
    readonly property var current: at >= 0 ? rows[at] : null
    readonly property string currentId: current ? current.id : ""
    onAtChanged: if (at >= 0) selAt = at
    onCurrentIdChanged: {
        if (currentId === selId) return
        movedAt = Date.now()
        selId = currentId
    }
    // The row at i, chosen by a key or a click. selId first, so `at` follows
    // it at once and the move isn't taken for one a snapshot made.
    function select(i) {
        if (i < 0 || i >= rows.length) return
        selId = rows[i].id
        selAt = i
        Qt.callLater(revealCurrent)
    }
    function reset() {
        selId = rows.length ? rows[0].id : ""
        selAt = 0
        movedAt = 0
        flick.contentY = 0
    }

    property Item currentRow: null
    // A pixel of slack: layouts place rows at fractions, and a row scrolled
    // flush to an edge must count as shown, or ↵ would only ever scroll.
    function shows(row) {
        const y = row.mapToItem(flick.contentItem, 0, 0).y
        return y >= flick.contentY - 1 && y + Math.min(row.height, flick.height) <= flick.contentY + flick.height + 1
    }
    function revealCurrent() {
        const row = currentRow
        if (!row) return
        const y = row.mapToItem(flick.contentItem, 0, 0).y
        const most = Math.max(0, flick.contentHeight - flick.height)
        if (y < flick.contentY) flick.contentY = Math.max(0, y)
        else if (!shows(row)) flick.contentY = Math.min(most, Math.max(0, y + Math.min(row.height, flick.height) - flick.height))
    }
    // A row out of view is scrolled in instead of acted on.
    function ready() {
        if (!current || busy[current.id] || Date.now() - movedAt < settleMs) return false
        if (!currentRow || !shows(currentRow)) {
            revealCurrent()
            return false
        }
        return true
    }

    color: M.mantle
    radius: 8
    border.width: 1
    border.color: M.surface1
    implicitWidth: boxWidth
    implicitHeight: Math.min(col.implicitHeight + 24, maxHeight)
    focus: true

    Keys.onPressed: event => {
        const k = event.key
        // A held key repeats after about half a second; acting again on the
        // same row would run it twice.
        const acts = [Qt.Key_Return, Qt.Key_Enter, Qt.Key_1, Qt.Key_2, Qt.Key_3, Qt.Key_X]
        if (event.isAutoRepeat && acts.indexOf(k) >= 0) {
            event.accepted = true
            return
        }
        if (k === Qt.Key_J || k === Qt.Key_Down) select(Math.min(rows.length - 1, at + 1))
        else if (k === Qt.Key_K || k === Qt.Key_Up) select(Math.max(0, at - 1))
        else if (k === Qt.Key_Return || k === Qt.Key_Enter) {
            if (ready()) act(current.actions[0] || "go", current.id)
        } else if (k === Qt.Key_1 || k === Qt.Key_2 || k === Qt.Key_3) {
            const a = ready() ? current.actions[k - Qt.Key_1] : ""
            if (a) act(a, current.id)
        } else if (k === Qt.Key_O && current && current.link) openLink(current.link.url)
        else if (k === Qt.Key_X) {
            if (ready()) act("dismiss", current.id)
        }
        else if (k === Qt.Key_Escape) close()
        else return
        event.accepted = true
    }

    readonly property var fills: ["allow", "post", "push", "run", "retry", "approve", "move", "again"]
    readonly property var accents: ["go", "edit", "review"]
    function lookOf(action) {
        return fills.indexOf(action) >= 0 ? "fill" : accents.indexOf(action) >= 0 ? "accent" : "plain"
    }

    component Buttons: Row {
        id: bs
        required property var item
        spacing: 5
        Repeater {
            model: bs.item.actions
            ActButton {
                required property string modelData
                required property int index
                // The action itself until the words load.
                label: inbox.say("actions." + modelData) || modelData
                look: inbox.lookOf(modelData)
                fill: M.section[bs.item.section] || M.peach
                keyHint: index < 3 ? String(index + 1) : ""
                enabled: !inbox.busy[bs.item.id]
                onClicked: inbox.act(modelData, bs.item.id)
            }
        }
        ActButton {
            visible: !!bs.item.link
            label: bs.item.link ? bs.item.link.label + " ↗" : ""
            look: "link"
            keyHint: "o"
            onClicked: inbox.openLink(bs.item.link.url)
        }
    }

    component ItemRow: Rectangle {
        id: r
        required property var item
        readonly property bool loud: item.section === "you" || item.section === "broke"
        readonly property bool selected: inbox.currentId === item.id
        readonly property bool below: !!item.preview || (item.actions || []).length > 2

        Layout.fillWidth: true
        implicitHeight: rc.implicitHeight + (below ? 10 : item.section === "work" ? 6 : 10)
        radius: 6
        color: selected ? M.surface0 : (M.tint[item.section] || "transparent")
        onSelectedChanged: if (selected) inbox.currentRow = r
        Component.onCompleted: if (selected) inbox.currentRow = r
        Component.onDestruction: if (inbox.currentRow === r) inbox.currentRow = null

        MouseArea {
            anchors.fill: parent
            onClicked: inbox.select(inbox.rows.findIndex(x => x.id === r.item.id))
        }
        ColumnLayout {
            id: rc
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            spacing: 5
            RowLayout {
                id: rl
                Layout.fillWidth: true
                Layout.leftMargin: 8
                Layout.rightMargin: 8
                spacing: 10
                Rectangle {
                    Layout.preferredWidth: 20
                    Layout.preferredHeight: 20
                    radius: 5
                    color: M.section[r.item.section]
                    Text {
                        anchors.centerIn: parent
                        text: r.item.glyph
                        color: M.crust
                        font.pixelSize: 12
                        font.bold: true
                    }
                }
                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: 0
                    Text {
                        Layout.fillWidth: true
                        text: inbox.oneLine(r.item.title)
                        textFormat: Text.PlainText
                        color: M.text
                        font.pixelSize: 13
                        font.weight: r.loud ? Font.DemiBold : Font.Normal
                        elide: Text.ElideRight
                    }
                    Text {
                        Layout.fillWidth: true
                        text: inbox.oneLine(r.item.meta)
                        textFormat: Text.PlainText
                        visible: text !== ""
                        color: M.subtext0
                        font.pixelSize: 12
                        elide: Text.ElideRight
                    }
                }
                MonoLabel {
                    Layout.alignment: Qt.AlignTop
                    text: r.item.age || ""
                    visible: text !== ""
                    font.pixelSize: 11
                }
                Buttons {
                    item: r.item
                    visible: !r.below
                }
            }
            Rectangle {
                Layout.fillWidth: true
                Layout.leftMargin: 38
                Layout.rightMargin: 8
                visible: !!r.item.preview
                implicitHeight: pv.implicitHeight + 12
                radius: 5
                color: M.crust
                Text {
                    id: pv
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    anchors.leftMargin: 8
                    anchors.rightMargin: 8
                    text: "“" + inbox.oneLine(r.item.preview || "") + "”"
                    textFormat: Text.PlainText
                    color: M.subtext1
                    font.pixelSize: 12
                    wrapMode: Text.Wrap
                    maximumLineCount: 3
                    elide: Text.ElideRight
                }
            }
            Buttons {
                item: r.item
                visible: r.below
                Layout.leftMargin: 38
            }
        }
    }

    Flickable {
        id: flick
        anchors.fill: parent
        anchors.margins: 12
        contentHeight: col.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds

        // Shown only once the rows outgrow the most height Settings allow,
        // in its own lane so it never covers a row's buttons.
        QQC.ScrollBar.vertical: QQC.ScrollBar {
            id: bar
            policy: flick.contentHeight > flick.height + 1 ? QQC.ScrollBar.AlwaysOn : QQC.ScrollBar.AlwaysOff
            padding: 0
            background: null
            contentItem: Rectangle {
                implicitWidth: 6
                radius: 3
                color: bar.pressed || bar.hovered ? M.overlay1 : M.surface1
            }
        }

        ColumnLayout {
            id: col
            width: flick.width - (bar.policy === QQC.ScrollBar.AlwaysOn ? bar.width + 6 : 0)
            spacing: 9

            RowLayout {
                Layout.fillWidth: true
                spacing: 14
                Text {
                    text: inbox.say("title")
                    color: M.text
                    font.pixelSize: 15
                    font.bold: true
                }
                Item { Layout.fillWidth: true }
                MonoLabel {
                    text: "Meta+A"
                }
                ActButton {
                    label: inbox.say("openHub") + " ↗"
                    look: "link"
                    onClicked: inbox.openHub()
                }
            }

            Text {
                Layout.fillWidth: true
                visible: inbox.stale !== ""
                text: inbox.stale
                color: M.red
                font.pixelSize: 12
                wrapMode: Text.Wrap
            }

            Repeater {
                model: inbox.sections
                ColumnLayout {
                    id: sec
                    required property var modelData
                    readonly property var items: inbox.itemsOf(modelData.key)
                    visible: items.length > 0
                    Layout.fillWidth: true
                    spacing: 3
                    RowLayout {
                        Layout.fillWidth: true
                        MonoLabel {
                            text: sec.modelData.glyph + " " + inbox.say("sections." + sec.modelData.key)
                            color: M.section[sec.modelData.key]
                            font.bold: true
                        }
                        Item { Layout.fillWidth: true }
                        MonoLabel {
                            text: sec.items.length
                        }
                    }
                    Repeater {
                        model: sec.items
                        ItemRow {
                            required property var modelData
                            item: modelData
                        }
                    }
                }
            }

            Rectangle {
                Layout.fillWidth: true
                visible: inbox.doneItems.length > 0
                implicitHeight: 30
                radius: 6
                color: M.base
                RowLayout {
                    anchors.fill: parent
                    anchors.leftMargin: 8
                    anchors.rightMargin: 4
                    spacing: 6
                    Text {
                        text: "✓ " + (inbox.say("done.count", { n: inbox.doneItems.length }) || inbox.doneItems.length)
                        color: M.green
                        font.pixelSize: 13
                        font.bold: true
                    }
                    Text {
                        text: inbox.say("done.note")
                        color: M.subtext0
                        font.pixelSize: 13
                    }
                    Item { Layout.fillWidth: true }
                    ActButton {
                        // A glyph until the words load.
                        label: inbox.say(inbox.showDone ? "done.hide" : "done.show") || (inbox.showDone ? "▾" : "▸")
                        onClicked: inbox.showDone = !inbox.showDone
                    }
                }
            }
            // Spaced like the rows in a section, not like the sections.
            ColumnLayout {
                Layout.fillWidth: true
                Layout.topMargin: -6
                visible: inbox.showDone && inbox.doneItems.length > 0
                spacing: 3
                Repeater {
                    model: inbox.showDone ? inbox.doneItems : []
                    ItemRow {
                        required property var modelData
                        item: modelData
                    }
                }
            }

            Text {
                Layout.fillWidth: true
                Layout.topMargin: 6
                Layout.bottomMargin: 6
                visible: (inbox.snap.items || []).length === 0
                horizontalAlignment: Text.AlignHCenter
                text: inbox.say("allQuiet")
                color: M.subtext0
                font.italic: true
                font.pixelSize: 13
            }

            RowLayout {
                Layout.fillWidth: true
                Text {
                    Layout.fillWidth: true
                    text: inbox.message
                    visible: text !== ""
                    color: inbox.messageOk ? M.green : M.red
                    font.pixelSize: 12
                    elide: Text.ElideRight
                }
                Item {
                    Layout.fillWidth: true
                    visible: inbox.message === ""
                }
                MonoLabel {
                    // Left out until the words load, rather than keys alone.
                    visible: !!inbox.words.keys
                    text: "j k " + inbox.say("keys.move") + " · ↵ " + inbox.say("keys.first") + " · 1 2 3 " + inbox.say("keys.buttons")
                          + " · o " + inbox.say("keys.open") + " · x " + inbox.say("keys.dismiss")
                    color: M.overlay1
                    font.pixelSize: 11
                }
            }
        }
    }
}
