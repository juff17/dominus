// `look`: "fill" (an answer, in `fill`), "blue" (an outline, to open
// something), "link" (blue text alone) or "plain" (a grey outline).
import QtQuick
import "mocha.js" as M

Rectangle {
    id: b
    property string label
    property string look: "plain"
    property color fill: M.peach
    property string keyHint: ""
    signal clicked()

    readonly property color ink: look === "fill" ? M.crust : look === "blue" || look === "link" ? M.blue : M.subtext1
    implicitWidth: br.implicitWidth + 16
    implicitHeight: 24
    radius: 6
    // Off while its row's last act is still running.
    opacity: enabled ? 1 : 0.4
    color: look === "fill" ? (ma.containsMouse ? Qt.lighter(fill, 1.1) : fill) : ma.containsMouse ? M.surface0 : "transparent"
    border.width: look === "fill" || look === "link" ? 0 : 1
    border.color: look === "blue" ? M.blue : M.surface1

    Row {
        id: br
        anchors.centerIn: parent
        spacing: 6
        Text {
            text: b.label
            textFormat: Text.PlainText
            color: b.ink
            font.pixelSize: 12
            font.weight: b.look === "plain" ? Font.Medium : Font.DemiBold
        }
        MonoLabel {
            text: b.keyHint
            visible: b.keyHint !== ""
            color: b.ink
            opacity: 0.65
            font.pixelSize: 11
        }
    }
    MouseArea {
        id: ma
        anchors.fill: parent
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor
        onClicked: b.clicked()
    }
}
