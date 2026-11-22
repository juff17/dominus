"""log-watcher's watch_logs.py, the paths test_log_watcher.py leaves out: where the
logger.* Settings are read from and what each limit does, docker failing
outright, a kubectl log stream that keeps being refused, and the [status]
lines. docker and kubectl are fake scripts from tests/fixtures/log_watcher."""

import collections
import contextlib
import gc
import importlib.util
import io
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import warnings
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / "skills/log-watcher/scripts/watch_logs.py"
FIXTURES = HERE / "fixtures" / "log_watcher"
NOW = datetime(2026, 10, 8, 14, 0, 0, tzinfo=UTC)
REAL_SLEEP = time.sleep


def load(env):
    """A fresh watch_logs, its module-level limits read under env alone."""
    with mock.patch.dict(os.environ, env, clear=True):
        spec = importlib.util.spec_from_file_location("watch_logs", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    return module


wl = load({"AGENT_HUB_SETTINGS": "/nonexistent/agent-hub/settings.json"})


def filter_args(**kw):
    return SimpleNamespace(**dict({"match": [], "ignore": [], "only_match": False, "dedup": 120}, **kw))


class Tmp(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.out = io.StringIO()
        redirect = contextlib.redirect_stdout(self.out)
        redirect.__enter__()
        self.addCleanup(redirect.__exit__, None, None, None)

    def lines(self):
        return self.out.getvalue().splitlines()

    def settings_file(self, values, where="settings.json"):
        path = self.tmp / where
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(values))
        return path

    def fake(self, name, script):
        bin_ = self.tmp / "bin"
        bin_.mkdir(exist_ok=True)
        (bin_ / name).write_text((FIXTURES / script).read_text())
        (bin_ / name).chmod(0o755)
        return bin_


# --- Settings -------------------------------------------------------------------


class SettingsPath(Tmp):
    def test_agent_hub_settings_first(self):
        path = self.settings_file({"logger.lineChars": 100})
        m = load({"AGENT_HUB_SETTINGS": str(path), "HOME": str(self.tmp)})
        self.assertEqual((m.SETTINGS, m.MAX_LINE), (path, 100))

    def test_then_xdg_state_home_even_when_agent_hub_settings_is_empty(self):
        path = self.settings_file({"logger.lineChars": 120}, "state/agent-hub/settings.json")
        for env in ({}, {"AGENT_HUB_SETTINGS": ""}):
            m = load(dict(env, XDG_STATE_HOME=str(self.tmp / "state"), HOME=str(self.tmp)))
            self.assertEqual((m.SETTINGS, m.MAX_LINE), (path, 120), env)

    def test_then_home(self):
        path = self.settings_file({"logger.floodLimit": 9}, "home/.local/state/agent-hub/settings.json")
        m = load({"HOME": str(self.tmp / "home")})
        self.assertEqual((m.SETTINGS, m.FLOOD_LIMIT), (path, 9))

    def test_a_file_that_is_not_an_object_or_has_bools_keeps_the_defaults(self):
        for text in ("[1, 2]", "null", json.dumps({"logger.traceLines": True, "logger.floodLimit": 25.0})):
            path = self.tmp / "s.json"
            path.write_text(text)
            m = load({"AGENT_HUB_SETTINGS": str(path)})
            self.assertEqual((m.MAX_CONTINUATION, m.MAX_LINE, m.FLOOD_LIMIT), (15, 400, 25), text)

    def test_the_limits_are_read_once_as_the_module_loads(self):
        path = self.settings_file({"logger.lineChars": 100})
        m = load({"AGENT_HUB_SETTINGS": str(path)})
        path.write_text(json.dumps({"logger.lineChars": 200}))
        self.assertEqual(m.MAX_LINE, 100)


class Limits(Tmp):
    def module(self, **values):
        return load({"AGENT_HUB_SETTINGS": str(self.settings_file(values))})

    def test_line_chars_cuts_every_line_watch_lines_too(self):
        m = self.module(**{"logger.lineChars": 80})
        m.Filter(filter_args()).feed("api", "ERROR " + "x" * 200)
        m.emit("[watch] attached to " + "c" * 100)
        self.assertEqual([len(l) for l in self.lines()], [80, 80])

    def test_flood_limit_caps_one_window(self):
        m = self.module(**{"logger.floodLimit": 5})
        filt = m.Filter(filter_args())
        for word in ("alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf"):
            filt.feed("api", f"ERROR in {word}")
        self.assertEqual(len(self.lines()), 5)
        self.assertEqual(filt.flood_dropped, 2)

    def test_trace_lines_caps_the_trace_kept_with_an_error(self):
        m = self.module(**{"logger.traceLines": 2})
        filt = m.Filter(filter_args())
        for text in ("ERROR unhandled", "  at a()", "  at b()", "  at c()", "  at d()"):
            filt.feed("api", text)
        self.assertEqual(self.lines(), ["[error] api: ERROR unhandled", "    at a()", "    at b()"])

    def test_trace_lines_0_keeps_none(self):
        m = self.module(**{"logger.traceLines": 0})
        filt = m.Filter(filter_args())
        for text in ("ERROR unhandled", "  at a()"):
            filt.feed("api", text)
        self.assertEqual(self.lines(), ["[error] api: ERROR unhandled"])


class Dedup(Tmp):
    def main(self, *argv, settings=None):
        path = self.settings_file(settings or {})
        got = {}
        with mock.patch.object(wl, "SETTINGS", path), \
                mock.patch.object(sys, "argv", ["watch_logs.py", "docker", "api", *argv]), \
                mock.patch.object(wl, "run_docker", side_effect=lambda args, filt: got.update(args=args, filt=filt)):
            wl.main()
        return got["args"].dedup, got["filt"].dedup

    def test_dedup_defaults_to_settings_and_the_flag_wins(self):
        self.assertEqual(self.main(), (120, 120))
        self.assertEqual(self.main(settings={"logger.dedup": 300}), (300, 300))
        self.assertEqual(self.main("--dedup", "5", settings={"logger.dedup": 300}), (5, 5))
        self.assertEqual(self.main(settings={"logger.dedup": 4000}), (120, 120))
        self.assertEqual(self.main(settings={"logger.dedup": 0}), (0, 0))

    def test_dedup_0_reports_every_repeat(self):
        filt = wl.Filter(filter_args(dedup=0))
        for _ in range(3):
            filt.feed("api", "ERROR timeout after 5ms")
        self.assertEqual(len(self.lines()), 3)


# --- docker ---------------------------------------------------------------------


class DockerDown(Tmp):
    """docker itself failing, rather than the container missing."""

    def setUp(self):
        super().setUp()
        self.calls = self.tmp / "calls"
        self.bin = self.fake("docker", "docker_daemon_down.sh")
        p = mock.patch.dict(os.environ, {"PATH": f"{self.bin}:/usr/bin:/bin", "FAKE_CALLS": str(self.calls)})
        p.start()
        self.addCleanup(p.stop)

    DOWN = "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?"

    def test_a_dead_daemon_is_told_as_docker_failing_once_and_retried(self):
        with self.assertRaisesRegex(wl.DockerError, "Cannot connect to the Docker daemon"):
            wl.docker_state("api")
        sleeps = []

        def sleep(seconds):
            sleeps.append(seconds)
            if len(sleeps) == 2:
                raise StopIteration

        with mock.patch.object(wl.time, "sleep", sleep), self.assertRaises(StopIteration):
            wl.watch_container("api", NOW, wl.Filter(filter_args()))
        self.assertEqual(self.lines(), [f"[watch] api: docker failed, retrying: {self.DOWN}"])
        self.assertEqual(sleeps, [3, 3])
        calls = self.calls.read_text().splitlines()
        # One from the docker_state() above, two from the watch.
        self.assertEqual(len(calls), 3)
        self.assertTrue(all(c.startswith("inspect -f ") and c.endswith(" api") for c in calls))

    def test_end_to_end_the_first_line_says_docker_failed(self):
        env = {"PATH": str(self.bin), "FAKE_CALLS": str(self.calls), "AGENT_HUB_SETTINGS": "/nonexistent"}
        line, _ = self.first_line(["docker", "api"], env, sys.stdout)
        self.assertEqual(line, f"[watch] api: docker failed, retrying: {self.DOWN}")

    def first_line(self, argv, env, stream):
        proc = subprocess.Popen([sys.executable, "-u", str(SCRIPT), *argv], stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, env=env, start_new_session=True)
        stop = lambda: os.killpg(proc.pid, signal.SIGKILL)
        timer = threading.Timer(10, stop)
        timer.start()
        try:
            pipe = proc.stdout if stream is sys.stdout else proc.stderr
            lines = []
            for raw in pipe:
                lines.append(raw.rstrip("\n"))
                if stream is sys.stdout or "Error" in raw:
                    break
            alive = proc.poll() is None
        finally:
            timer.cancel()
            stop()
            proc.wait()
            proc.stdout.close()
            proc.stderr.close()
        return (lines[0] if stream is sys.stdout else lines), alive

    def test_no_docker_at_all_is_told_and_the_watch_keeps_trying(self):
        empty = self.tmp / "empty"
        empty.mkdir()
        with mock.patch.dict(os.environ, {"PATH": str(empty)}), \
                self.assertRaisesRegex(wl.DockerError, "No such file or directory: 'docker'"):
            wl.docker_state("api")
        line, alive = self.first_line(["docker", "api"], {"PATH": str(empty), "AGENT_HUB_SETTINGS": "/nonexistent"}, sys.stdout)
        self.assertTrue(alive)
        self.assertEqual(line, "[watch] api: docker failed, retrying: [Errno 2] No such file or directory: 'docker'")


# --- kubernetes -----------------------------------------------------------------


class Stop(Exception):
    pass


class KubectlRefused(Tmp):
    k8s = SimpleNamespace(context="staging", namespace="pay", selector="app=api", deployment=None, since=None)

    def setUp(self):
        super().setUp()
        self.calls = self.tmp / "calls"
        bin_ = self.fake("kubectl", "kubectl_unauthorized.sh")
        self.env = {"PATH": f"{bin_}:/usr/bin:/bin", "FAKE_CALLS": str(self.calls), "FAKE_PODS": str(FIXTURES / "pods.json")}
        for p in (mock.patch.object(wl, "now_utc", return_value=NOW), mock.patch.object(wl, "POD_POLL", 0)):
            p.start()
            self.addCleanup(p.stop)

    def run_k8s(self, reconnects, until=None, **env):
        """Run run_k8s until its given number of reconnect waits, its first
        sleep of any kind for 0, or until() holds. Returns the reconnect waits."""
        count = []

        def sleep(seconds):
            REAL_SLEEP(0.01)
            if seconds >= wl.RECONNECT_FIRST:
                count.append(seconds)
            if reconnects == 0 or len(count) == reconnects or (until and until()):
                # Lets the log reader finish before the loop is left.
                REAL_SLEEP(0.2)
                raise Stop

        # run_k8s never waits for or closes the kubectl it is in when it's
        # stopped, so its Popen is collected here, quietly.
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", ResourceWarning)
            with mock.patch.dict(os.environ, dict(self.env, **env)), mock.patch.object(wl.time, "sleep", sleep), \
                    self.assertRaises(Stop):
                wl.run_k8s(self.k8s, wl.Filter(filter_args()))
            gc.collect()
        return count

    def test_a_refused_log_stream_backs_off_and_is_told_once(self):
        waits = self.run_k8s(7)
        self.assertEqual(waits, [5, 10, 20, 40, 80, 120, 120])
        lines = self.lines()
        attached = "[watch] attached to 1 pod(s) app=api in staging/pay (since 2026-10-08T14:00:00Z)"
        self.assertEqual(lines[:2], ["[status] api-7d9f-x2k4p: CrashLoopBackOff, OOMKilled", attached])
        self.assertEqual(collections.Counter(lines), collections.Counter({
            "[status] api-7d9f-x2k4p: CrashLoopBackOff, OOMKilled": 1,
            attached: 1,
            "[watch] log stream ended (exit 1), reconnecting": 1,
            "[error] kubectl: error: You must be logged in to the server (Unauthorized)": 1,
        }))
        logs = [c for c in self.calls.read_text().splitlines() if " logs " in f" {c} "]
        self.assertEqual(len(logs), 7)
        self.assertEqual(logs[0], "--context staging -n pay logs -f -l app=api --all-containers --prefix "
                                  "--max-log-requests 50 --since-time 2026-10-08T14:00:00Z")

    def test_a_stream_that_stays_up_is_told_back(self):
        bin_ = self.fake("kubectl", "kubectl_flaky.sh")
        back = "[watch] log stream back for 1 pod(s) app=api in staging/pay"
        with mock.patch.object(wl, "STREAM_OK", 0.3):
            waits = self.run_k8s(None, PATH=f"{bin_}:/usr/bin:/bin", until=lambda: back in self.lines())
        self.assertEqual(waits, [5, 10])
        self.assertEqual(self.lines().count("[watch] log stream ended (exit 1), reconnecting"), 1)
        self.assertEqual(self.lines().count(back), 1)

    def test_a_stream_that_lasted_starts_the_backoff_over(self):
        with mock.patch.object(wl, "STREAM_OK", 0):
            self.assertEqual(self.run_k8s(3), [5, 5, 5])

    def test_a_failing_pod_list_reads_as_no_pods(self):
        # pins current behaviour: pod_states() returning None (kubectl failed)
        # is told as "no pods match", the same as an empty list.
        self.run_k8s(0, FAKE_PODS="/nonexistent/pods.json")
        self.assertEqual(self.lines()[:2], ["[status] no pods match app=api in staging/pay",
                                            "[watch] attached to 0 pod(s) app=api in staging/pay (since 2026-10-08T14:00:00Z)"])


# --- [status] -------------------------------------------------------------------


class StatusLines(Tmp):
    """Crashes and restarts are [status] lines, never [error]."""

    RUNNING = {"status": "running", "exit": "0", "restarts": 0, "oom": False}

    def watch_one(self, *states):
        sleeps = []

        def sleep(seconds):
            sleeps.append(seconds)
            if len(sleeps) == 2:
                raise StopIteration

        with mock.patch.object(wl, "docker_state", side_effect=list(states)), \
                mock.patch.object(wl, "stream"), \
                mock.patch.object(wl, "now_utc", return_value=NOW), \
                mock.patch.object(wl.time, "sleep", sleep), \
                self.assertRaises(StopIteration):
            wl.watch_container("api", NOW, wl.Filter(filter_args()))
        return [l for l in self.lines() if not l.startswith("[watch] attached")]

    def test_a_crash_is_a_status_line(self):
        # pins current behaviour (todo gaj): a crash is [status], so a watch
        # filtering on [error] misses it.
        dead = {"status": "exited", "exit": "1", "restarts": 0, "oom": False}
        self.assertEqual(self.watch_one(self.RUNNING, dead, self.RUNNING, dead),
                         ["[status] api: exited, exit code 1", "[status] api: exited, exit code 1"])

    def test_a_restarting_container(self):
        restarting = {"status": "restarting", "exit": "137", "restarts": 2, "oom": True}
        self.assertEqual(self.watch_one(self.RUNNING, restarting, self.RUNNING, restarting)[0],
                         "[status] api: restarting, exit code 137 (OOM killed)")

    def test_a_restart_docker_already_finished_is_not_told(self):
        # pins current behaviour (todo gaj): RestartCount is read but never
        # compared, so a container docker restarted before the next inspect
        # shows nothing at all.
        again = dict(self.RUNNING, restarts=1)
        self.assertEqual(self.watch_one(self.RUNNING, again, again, again), [])
        self.assertEqual(self.lines(), ["[watch] attached to api (since 2026-10-08T14:00:00Z)"] * 2)


if __name__ == "__main__":
    unittest.main()
