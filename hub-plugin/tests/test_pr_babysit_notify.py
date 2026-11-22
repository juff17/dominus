"""pr-babysit's notify.sh: the note it leaves in
$XDG_RUNTIME_DIR/agent-hub/notes for the Agents tray (ghostty's
tray/tray.mjs readNotes reads *.json there and needs a numeric `at`), and
what happens when jq is missing or fails."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from babysit_harness import SCRIPTS, load_watch_pr

NOTIFY = SCRIPTS / "notify.sh"
BASH = shutil.which("bash")


class Notify(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.notes = self.tmp / "run" / "agent-hub" / "notes"

    def run_notify(self, *args, path=None, **env):
        base = {"PATH": path or os.environ["PATH"], "HOME": str(self.tmp), "XDG_RUNTIME_DIR": str(self.tmp / "run")}
        base.update(env)
        return subprocess.run([BASH, str(NOTIFY), *args], capture_output=True, text=True, env=base, timeout=30)

    def files(self):
        return sorted(p.name for p in self.notes.iterdir())

    def test_a_note_has_the_fields_the_tray_reads(self):
        before = int(time.time() * 1000)
        r = self.run_notify("gad #91", 'CI failed: "unit"\nsee the log', CLAUDE_CODE_SESSION_ID="abc-123", TMUX_PANE="%3",
                            TMUX="/run/user/1000/tmux-1000/ghostty,42,0")
        after = int(time.time() * 1000)
        self.assertEqual((r.returncode, r.stdout, r.stderr), (0, "", ""))
        names = self.files()
        self.assertEqual(len(names), 1)
        self.assertRegex(names[0], r"^\d{19}-\d+\.json$", "nanoseconds-pid, no dot file left behind")
        note = json.loads((self.notes / names[0]).read_text())
        self.assertEqual(set(note), {"title", "message", "session", "pane", "tmux", "at"})
        self.assertEqual({k: v for k, v in note.items() if k != "at"},
                         {"title": "gad #91", "message": 'CI failed: "unit"\nsee the log', "session": "abc-123", "pane": "%3",
                          "tmux": "/run/user/1000/tmux-1000/ghostty,42,0"})
        self.assertIsInstance(note["at"], int)
        self.assertTrue(before <= note["at"] <= after, (before, note["at"], after))
        self.assertEqual(int(names[0].split("-")[0]) // 1_000_000, note["at"], "the name and `at` are the same moment")

    def test_at_does_not_come_from_date(self):
        # uutils date prints %N without its leading zeros, which put `at` up
        # to a second off; a date that can only say whole seconds proves the
        # milliseconds come from elsewhere.
        bin_ = self.tools_without_jq()
        (bin_ / "jq").symlink_to(shutil.which("jq"))
        (bin_ / "date").unlink()
        (bin_ / "date").write_text("#!/bin/sh\necho 1700000000\n")
        (bin_ / "date").chmod(0o755)
        before = int(time.time() * 1000)
        self.assertEqual(self.run_notify("t", "m", path=str(bin_)).returncode, 0)
        note = json.loads((self.notes / self.files()[0]).read_text())
        self.assertTrue(before <= note["at"] <= int(time.time() * 1000), (before, note["at"]))

    def test_defaults(self):
        self.assertEqual(self.run_notify().returncode, 0)
        note = json.loads((self.notes / self.files()[0]).read_text())
        self.assertEqual({k: v for k, v in note.items() if k != "at"},
                         {"title": "PR babysit", "message": "Needs your attention", "session": "", "pane": "", "tmux": ""})

    def test_each_call_is_its_own_note(self):
        self.run_notify("a", "1")
        self.run_notify("b", "2")
        self.assertEqual(len(self.files()), 2)

    def test_the_watchers_tray_note_has_the_same_fields(self):
        w = load_watch_pr()
        with mock.patch.dict(os.environ, {"XDG_RUNTIME_DIR": str(self.tmp / "run")}):
            w.tray_note("t", "m")
        self.run_notify("t", "m")
        notes = [json.loads((self.notes / n).read_text()) for n in self.files()]
        self.assertEqual(set(notes[0]), set(notes[1]))

    def tools_without_jq(self):
        bin_ = self.tmp / "bin"
        bin_.mkdir()
        for tool in ("date", "mkdir", "mv", "rm", "readlink"):
            (bin_ / tool).symlink_to(shutil.which(tool))
        return bin_

    def logs(self):
        log = self.tmp / ".local" / "state" / "agent-hub" / "logs" / "notify.log"
        return log.read_text() if log.exists() else ""

    def test_without_jq_no_note_is_left_and_it_fails(self):
        # The tray skips a note it can't parse, so an empty one would never
        # show and never be cleaned up.
        r = self.run_notify("gad #91", "CI failed", path=str(self.tools_without_jq()))
        self.assertEqual((r.returncode, r.stdout), (1, ""))
        self.assertIn("the tray note wasn't written: jq failed (exit 127)", r.stderr)
        self.assertEqual(self.files(), [])
        self.assertRegex(self.logs(), r' ERROR notify: tray note failed \{"exit":127,"title":"gad #91"\}\n$')

    def test_a_failing_jq_leaves_nothing_half_written(self):
        bin_ = self.tools_without_jq()
        (bin_ / "jq").write_text("#!/bin/sh\necho 'jq: error: bad' >&2\nprintf '{\"tit'\nexit 5\n")
        (bin_ / "jq").chmod(0o755)
        r = self.run_notify("t", "m", path=str(bin_))
        self.assertEqual(r.returncode, 1)
        self.assertIn("(exit 5)", r.stderr)
        self.assertEqual(self.files(), [])

    def test_a_written_note_is_logged(self):
        self.run_notify("gad #91", "CI failed")
        self.assertRegex(self.logs(), r' INFO notify: tray note written \{"title":"gad #91"\}\n$')

if __name__ == "__main__":
    unittest.main()
