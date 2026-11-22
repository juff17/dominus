"""agent_hub.stops: a watcher the user stopped from Monitors, re-armed by its
session, says so and exits instead of watching again. The hub's side
(markStopped writing stop-requests/) is in ghostty/agents/client.test.ts."""

import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "lib" / "py"))
from agent_hub import stops

SKILLS = ROOT / "skills"
PR = SKILLS / "pr-babysit/scripts/watch_pr.py"
PIPE = SKILLS / "pipeline-watch/scripts/watch_pipeline.py"
LOGS = SKILLS / "log-watcher/scripts/watch_logs.py"
PR_ARGS = ["https://github.com/o/app/pull/2", "-C", "/nowhere", "--session", "20261112-081746"]


class Log:
    def __init__(self):
        self.lines = []

    def info(self, msg, **fields):
        self.lines.append(("info", msg, fields))

    def warning(self, msg, **fields):
        self.lines.append(("warning", msg, fields))


class Base(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.requests = self.root / "run" / "agent-hub" / "stop-requests"
        self.requests.mkdir(parents=True)

    def request(self, name, command, age=0):
        path = self.requests / name
        path.write_text(command)
        if age:
            then = time.time() - age
            os.utime(path, (then, then))
        return path


class Runs(unittest.TestCase):
    def test_the_command_the_session_ran_matches_the_argv_python_gets(self):
        cmd = f"python3 -u {PR} {' '.join(PR_ARGS)}"
        self.assertTrue(stops.runs(cmd, [str(PR), *PR_ARGS]))

    def test_quoting_and_a_trailing_pipe_still_match(self):
        self.assertTrue(stops.runs("python3 'watch_logs.py' docker 'my app' | head", ["/x/watch_logs.py", "docker", "my app"]))

    def test_another_target_or_script_does_not(self):
        self.assertFalse(stops.runs("python3 watch_pr.py https://h/o/a/pull/3", ["watch_pr.py", "https://h/o/a/pull/2"]))
        self.assertFalse(stops.runs("python3 watch_pipeline.py https://h/o/a/pull/2", ["watch_pr.py", "https://h/o/a/pull/2"]))
        self.assertFalse(stops.runs("python3 'unclosed", ["watch_pr.py"]))


class StoppedByUser(Base):
    def setUp(self):
        super().setUp()
        env = mock.patch.dict(os.environ, {"XDG_RUNTIME_DIR": str(self.root / "run"), "CLAUDE_CODE_SESSION_ID": "s1"})
        env.start()
        self.addCleanup(env.stop)
        self.log = Log()

    def test_a_request_for_this_watch_is_taken_once(self):
        path = self.request("s1.t1", "python3 -u watch_pr.py https://h/o/a/pull/2 --session x")
        argv = ["/skills/watch_pr.py", "https://h/o/a/pull/2", "--session", "x"]
        self.assertTrue(stops.stopped_by_user(argv, self.log))
        self.assertFalse(path.exists())
        self.assertFalse(stops.stopped_by_user(argv, self.log), "a start the user asks for later runs")
        self.assertEqual([(lvl, msg) for lvl, msg, _ in self.log.lines], [("info", "watch not restarted")])

    def test_other_sessions_and_other_watches_are_left_alone(self):
        theirs = self.request("s2.t1", "python3 watch_pr.py https://h/o/a/pull/2")
        other = self.request("s1.t2", "python3 watch_pr.py https://h/o/a/pull/9")
        self.assertFalse(stops.stopped_by_user(["watch_pr.py", "https://h/o/a/pull/2"], self.log))
        self.assertTrue(theirs.exists())
        self.assertTrue(other.exists())

    def test_an_old_request_is_dropped_without_stopping_the_watch(self):
        old = self.request("s1.t1", "python3 watch_pr.py https://h/o/a/pull/2", age=stops.MAX_AGE + 60)
        self.assertFalse(stops.stopped_by_user(["watch_pr.py", "https://h/o/a/pull/2"], self.log))
        self.assertFalse(old.exists())

    def test_outside_a_claude_session_or_with_no_folder_nothing_is_stopped(self):
        self.request("s1.t1", "python3 watch_pr.py u")
        with mock.patch.dict(os.environ, {"CLAUDE_CODE_SESSION_ID": ""}):
            self.assertFalse(stops.stopped_by_user(["watch_pr.py", "u"], self.log))
        with mock.patch.dict(os.environ, {"XDG_RUNTIME_DIR": str(self.root / "none")}):
            self.assertFalse(stops.stopped_by_user(["watch_pr.py", "u"], self.log))
        self.assertEqual(self.log.lines, [])


class Watchers(Base):
    """Each watcher, re-armed after the user stopped it, prints [unwatched]
    and exits 0 before it touches a forge, docker or kubectl."""

    def run_script(self, script, argv):
        env = {"PATH": os.environ["PATH"], "HOME": str(self.root), "XDG_RUNTIME_DIR": str(self.root / "run"),
               "XDG_CACHE_HOME": str(self.root / "cache"), "XDG_STATE_HOME": str(self.root / "state"),
               "AGENT_HUB_LOG_DIR": str(self.root / "logs"), "AGENT_HUB_SETTINGS": str(self.root / "none.json"),
               "CLAUDE_CODE_SESSION_ID": "s1"}
        return subprocess.run([sys.executable, "-u", str(script), *argv], capture_output=True, text=True,
                              env=env, timeout=30)

    def check(self, script, argv):
        path = self.request("s1.t1", f"python3 -u {script} {' '.join(argv)}")
        r = self.run_script(script, argv)
        self.assertEqual((r.returncode, r.stdout), (0, "[unwatched] stopped by the user from Monitors; do not re-arm\n"), r.stderr)
        self.assertFalse(path.exists())

    def test_watch_pr(self):
        self.check(PR, PR_ARGS)
        again = self.run_script(PR, PR_ARGS)
        self.assertEqual(again.returncode, 2, "the next start watches: here it finds no clone")
        self.assertTrue(again.stdout.startswith("[setup] "), again.stdout)

    def test_watch_pipeline(self):
        self.check(PIPE, ["https://github.com/o/app/actions/runs/7001", "--session", "p1"])

    def test_watch_logs(self):
        self.check(LOGS, ["docker", "api"])


if __name__ == "__main__":
    unittest.main()
