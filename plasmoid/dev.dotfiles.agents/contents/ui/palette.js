// Verdigris, the hub's palette (tui/palette.ts), so the tray reads as part of it.
.pragma library

var crust = "#0a0b0b"
var mantle = "#101212"
var base = "#161818"
var surface0 = "#262b2a"
var surface1 = "#373d3c"
var overlay0 = "#61706c"
var overlay1 = "#738f87"
var subtext0 = "#a2bdb5"
var subtext1 = "#bed3cc"
var text = "#d9e9e3"
var patina = "#5fcca9"
var blue = "#86afe2"
var peach = "#ffa04d"
var red = "#f2647e"
var green = "#a6e35f"
var mauve = "#bb9ee2"
var rose = "#d98bc4"

// The theme colour, ACCENT in the hub's tui/palette.ts: the outlines and links
// that open something. tests/contract/colours.test.mjs holds it equal.
var accent = patina

// Each section's colour, as on the hub's board and rail.
var section = { you: peach, broke: red, work: blue, watch: rose, done: green }
// The faint wash behind rows that need you, #AARRGGBB at about 8%.
var tint = { you: "#14ffa04d", broke: "#14f2647e" }

var mono = "JetBrains Mono"
