"""Shared by the test_pr_babysit_* files: a sandbox with fake `gh` and `glab`
on PATH (tests/fixtures/pr_babysit/fake_forge.py), temp XDG and HOME
folders, and fresh copies of the scripts. Nothing reaches the network, the
real CLIs, or the user's approvals, notes, cache or settings."""

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent / "skills/pr-babysit/scripts"
FIXTURES = HERE / "fixtures" / "pr_babysit"
FAKE_FORGE = FIXTURES / "fake_forge.py"

GH_SHA = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0"
GL_SHA = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c"
GH_URL = "https://github.com/u/gad/pull/91"
GL_URL = "https://gitlab.com/grp/sub/gad/-/merge_requests/91"
GL_PROJ = "projects/grp%2Fsub%2Fgad"

# Module-level paths in the scripts (SETTINGS, agent_hub.approvals.ROOT) are read as they
# load, so they load against paths that don't exist; tests patch them anyway.
NOWHERE = {"AGENT_HUB_SETTINGS": "/nonexistent/agent-hub/settings.json",
           "XDG_RUNTIME_DIR": "/nonexistent/run", "XDG_CACHE_HOME": "/nonexistent/cache",
           "XDG_STATE_HOME": "/nonexistent/state"}


def load(name, path, env=None, clear=False):
    """A fresh copy of the script at path, loaded under env (NOWHERE unless
    given), with only env when clear."""
    with mock.patch.dict(os.environ, NOWHERE if env is None else env, clear=clear):
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    return module


def load_watch_pr():
    return load("watch_pr", SCRIPTS / "watch_pr.py")


def fixture(name):
    return json.loads((FIXTURES / name).read_text())


class Sandbox:
    def __init__(self, testcase):
        tmp = tempfile.TemporaryDirectory()
        testcase.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.bin = self.root / "bin"
        self.tools = self.root / "tools"
        for d in ("bin", "tools", "home", "run", "cache", "state"):
            (self.root / d).mkdir()
        fake = f"#!{sys.executable} -I\n" + FAKE_FORGE.read_text()
        for cli in ("gh", "glab"):
            (self.bin / cli).write_text(fake)
            (self.bin / cli).chmod(0o755)
        # Only git, so the real gh, glab or docker in /usr/bin are never found.
        (self.tools / "git").symlink_to(shutil.which("git"))
        self.log = self.root / "calls.jsonl"
        self.routes_file = self.root / "routes.json"
        self.settings = self.root / "settings.json"
        self.run_dir = self.root / "run"
        self.cache = self.root / "cache"

    def routes(self, routes):
        self.routes_file.write_text(json.dumps(routes))

    def calls(self):
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def paths(self):
        return [(c["cli"], c["method"], c["path"]) for c in self.calls()]

    def reset_calls(self):
        self.log.unlink(missing_ok=True)

    def env(self, **extra):
        env = {
            "PATH": f"{self.bin}:{self.tools}",
            "HOME": str(self.root / "home"),
            "LANG": "C.UTF-8",
            "XDG_RUNTIME_DIR": str(self.run_dir),
            "XDG_CACHE_HOME": str(self.cache),
            "XDG_STATE_HOME": str(self.root / "state"),
            "AGENT_HUB_SETTINGS": str(self.settings),
            "FAKE_LOG": str(self.log),
            "FAKE_ROUTES": str(self.routes_file),
            "GIT_CONFIG_NOSYSTEM": "1",
        }
        env.update(extra)
        return {k: v for k, v in env.items() if v is not None}

    def patch_env(self, testcase, **extra):
        """Swap the whole of os.environ for the sandbox's, for in-process tests."""
        p = mock.patch.dict(os.environ, self.env(**extra), clear=True)
        p.start()
        testcase.addCleanup(p.stop)
        # The approvals store's paths are read once per process, by
        # agent_hub.approvals, so its ROOT is from whichever test imported it
        # first, possibly the user's real folder.
        store = load_watch_pr().approval_module().A
        folder = self.run_dir / "agent-hub" / "approvals"
        for name, value in (("ROOT", folder), ("LOG", folder / "log.jsonl")):
            q = mock.patch.object(store, name, value)
            q.start()
            testcase.addCleanup(q.stop)

    def clone(self, *remotes):
        self.clones = getattr(self, "clones", 0) + 1
        path = self.root / f"clone{self.clones}"
        path.mkdir()
        env = self.env()
        subprocess.run(["git", "init", "-q", str(path)], check=True, env=env)
        for name, url in remotes:
            subprocess.run(["git", "-C", str(path), "remote", "add", name, url], check=True, env=env)
        return path

    def run_script(self, script, *argv, env=None, timeout=60):
        return subprocess.run([sys.executable, str(SCRIPTS / script), *argv], capture_output=True,
                              text=True, env=env or self.env(), timeout=timeout)
