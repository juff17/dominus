"""agent_hub.log, the Python side of docs/logging.md: the same line as the
Node and shell loggers, to the same files."""

import json
import os
import sys
import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib" / "py"))
from agent_hub import log


def fields_of(line):
    return json.loads(line[line.index(" {") + 1:])


class Log(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        env = mock.patch.dict(os.environ, {"AGENT_HUB_LOG_DIR": str(self.dir)})
        env.start()
        self.addCleanup(env.stop)
        for var in ("AGENT_HUB_DEBUG", "AGENT_HUB_LOG_LEVEL", "CLAUDE_CODE_SESSION_ID"):
            os.environ.pop(var, None)
        log._writes.clear()

    def lines(self, component):
        return (self.dir / f"{component}.log").read_text().strip().split("\n")

    def test_under_claude_every_line_carries_its_session_unless_it_names_one(self):
        with mock.patch.dict(os.environ, {"CLAUDE_CODE_SESSION_ID": "claude-1"}):
            log.logger("c").info("ran", id="p1")
            log.logger("c").child(claude_session="other").info("ran")
        self.assertEqual([fields_of(x) for x in self.lines("c")],
                         [{"id": "p1", "claude_session": "claude-1"}, {"claude_session": "other"}])

    def test_a_line_matches_the_node_logger(self):
        when = datetime(2026, 11, 9, 21, 14, 3, 120000, tzinfo=UTC)
        self.assertEqual(log.format_line("info", "tray", "approval ran", {"id": "p1", "ok": False, "ms": 312}, when),
                         '2026-11-09T21:14:03.120Z INFO tray: approval ran {"id":"p1","ok":false,"ms":312}')
        self.assertTrue(log.format_line("warn", "x", "m", None, when).endswith(" WARN x: m {}"))

    def test_an_exception_becomes_err_and_type_and_none_is_left_out(self):
        try:
            raise ValueError("nope")
        except ValueError as e:
            fields = fields_of(log.format_line("error", "x", "boom", {"e": e, "gone": None}))
        self.assertEqual((fields["err"], fields["errType"]), ("nope", "ValueError"))
        self.assertIn("ValueError: nope", fields["stack"])
        self.assertNotIn("gone", fields)

    def test_values_json_cannot_write_are_written_as_text(self):
        self.assertEqual(fields_of(log.format_line("info", "x", "m", {"path": Path("/a")}))["path"], "/a")

    def test_info_and_up_are_written_and_debug_only_when_asked(self):
        lg = log.logger("watch_pr")
        lg.debug("hidden")
        lg.info("shown", a=1)
        lg.error("bad", err="x")
        self.assertEqual([line.split(" ", 1)[1].split(" {")[0] for line in self.lines("watch_pr")],
                         ["INFO watch_pr: shown", "ERROR watch_pr: bad"])
        os.environ["AGENT_HUB_DEBUG"] = "1"
        self.assertTrue(lg.enabled("debug"))
        lg.debug("now shown")
        self.assertTrue(self.lines("watch_pr")[-1].endswith("DEBUG watch_pr: now shown {}"))

    def test_log_level_raises_the_bar(self):
        os.environ["AGENT_HUB_LOG_LEVEL"] = "warn"
        lg = log.logger("x")
        lg.info("quiet")
        lg.warning("loud")
        self.assertEqual(len(self.lines("x")), 1)

    def test_a_child_and_base_fields_go_on_every_line(self):
        log.logger("x", pr="gh#1").child(session="s1").info("polled", n=2)
        self.assertEqual(fields_of(self.lines("x")[0]), {"pr": "gh#1", "session": "s1", "n": 2})

    def test_a_span_logs_its_end_and_a_failure_then_reraises(self):
        os.environ["AGENT_HUB_DEBUG"] = "1"
        lg = log.logger("x")
        with lg.span("poll", pr="a"):
            pass
        with self.assertRaises(RuntimeError), lg.span("push", id="b"):
            raise RuntimeError("refused")
        got = [line.split(" ", 1)[1] for line in self.lines("x")]
        self.assertEqual(got[0], 'DEBUG x: poll start {"pr":"a"}')
        self.assertRegex(got[1], r'^INFO x: poll done \{"pr":"a","ms":\d+\}$')
        self.assertEqual(got[2], 'DEBUG x: push start {"id":"b"}')
        failed = fields_of(got[3])
        self.assertTrue(got[3].startswith("ERROR x: push failed "))
        self.assertEqual((failed["id"], failed["err"], failed["errType"]), ("b", "refused", "RuntimeError"))

    def test_a_big_log_moves_to_dot_1(self):
        (self.dir / "big.log").write_text("x" * (log.MAX_BYTES + 1))
        log.logger("big").info("after")
        self.assertEqual((self.dir / "big.log.1").stat().st_size, log.MAX_BYTES + 1)
        self.assertEqual(len(self.lines("big")), 1)

    def test_a_log_that_cannot_be_written_is_dropped(self):
        (self.dir / "blocker").write_text("")
        os.environ["AGENT_HUB_LOG_DIR"] = str(self.dir / "blocker" / "logs")
        log.logger("x").error("lost")


if __name__ == "__main__":
    unittest.main()
