"""pr-babysit's watch_pr.py end to end: `python3 watch_pr.py <url> --once`
against a fake gh/glab on PATH serving tests/fixtures/pr_babysit, the exact
lines it prints, the API calls one poll costs, the per-PR lock, preflight,
and URL and remote parsing."""

import contextlib
import io
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from babysit_harness import (
    GH_SHA,
    GH_URL,
    GL_PROJ,
    GL_SHA,
    GL_URL,
    Sandbox,
    fixture,
    load_watch_pr,
)

w = load_watch_pr()

GH = "repos/u/gad"


class Cli(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox(self)
        self.box.patch_env(self)

    def watch(self, url, *argv, clone=None, **env):
        env.setdefault("GITHUB_TOKEN", "dummy")
        env.setdefault("GITLAB_TOKEN", "dummy")
        cwd = clone or self.box.clone(("origin", "git@github.com:u/gad.git" if "github" in url else "git@gitlab.com:grp/sub/gad.git"))
        r = self.box.run_script("watch_pr.py", url, "-C", str(cwd), *argv, env=self.box.env(**env))
        return r.returncode, r.stdout.splitlines(), r.stderr


class GitHubOnce(Cli):
    def setUp(self):
        super().setUp()
        self.routes = fixture("github_pr.json")
        self.box.routes(self.routes)

    def test_one_poll_prints_every_open_event(self):
        code, lines, err = self.watch(GH_URL, "--once")
        self.assertEqual((code, err), (0, ""))
        pr, run = GH_URL, "https://github.com/u/gad/actions/runs"
        tail = " | CI ✗ · QA ⏳ · Deploy ⏸ · ci/jenkins ✗ · coverage ⏳ · license/cla ✓"
        self.assertEqual(lines, [
            f'[watch] attached {pr} "Add pagination to the list endpoint", branch feat/pagination -> main, '
            f"head {GH_SHA}, remote origin, 7 open comment(s), polling every 60s",
            "[behind] feat/pagination is 3 commit(s) behind main, and the host requires a rebase before merge",
            f"[failed] CI / unit id=102 {run}/1/job/102{tail}",
            f"[manual] Deploy / staging id=105 {run}/3/job/105{tail}",
            f"[failed] ci/jenkins id=status:ci/jenkins https://jenkins.example.com/job/9{tail}",
            f"[manual] workflow Fork CI (action required) id=run:900 {run}/900{tail}",
            f"[review] @bob approved {pr}#pullrequestreview-7001",
            f"[review] @carol changes requested {pr}#pullrequestreview-7002",
            f'[comment] @alice on src/api/list.py:42: "This loads every row before slicing. Use LIMIT/OFFSET." '
            f"id=rc:2001 {pr}#discussion_r2001",
            f'[comment] @coderabbitai[bot] on README.md: "Consider documenting the page size." id=rc:2004 {pr}#discussion_r2004',
            f'[comment] @ghost on README.md: "deleted user" id=rc:2005 {pr}#discussion_r2005',
            f'[comment] @github-actions[bot]: "Coverage: 81%" id=ic:5001 {pr}#issuecomment-5001',
            f'[comment] @carol: "Can this land before Friday?" id=ic:5002 {pr}#issuecomment-5002',
            f'[comment] @carol on review summary: "Please add tests for page 2." id=rv:7002 {pr}#pullrequestreview-7002',
            f'[comment] @erin on review summary: "Superseded." id=rv:7004 {pr}#pullrequestreview-7004',
        ])

    def test_one_github_poll_costs_nine_calls(self):
        # A refactor must not add calls: user, then the eight of a snapshot.
        self.watch(GH_URL, "--once")
        self.assertEqual(self.box.paths(), [
            ("gh", "GET", "user"),
            ("gh", "GET", f"{GH}/pulls/91"),
            ("gh", "GET", f"{GH}/compare/main...{GH_SHA}"),
            ("gh", "GET", f"{GH}/commits/{GH_SHA}/check-runs?per_page=100&page=1"),
            ("gh", "GET", f"{GH}/commits/{GH_SHA}/status"),
            ("gh", "GET", f"{GH}/actions/runs?head_sha={GH_SHA}&per_page=100"),
            ("gh", "GET", "graphql"),
            ("gh", "GET", f"{GH}/issues/91/comments?per_page=100&page=1"),
            ("gh", "GET", f"{GH}/pulls/91/reviews?per_page=100&page=1"),
        ])

    def test_a_merged_pr_costs_two_calls_and_ends(self):
        self.routes[f"{GH}/pulls/91"].update(merged=True, state="closed")
        self.box.routes(self.routes)
        code, lines, _ = self.watch(GH_URL, "--once")
        self.assertEqual(code, 0)
        self.assertEqual(lines[1:], [f"[merged] {GH_URL}"])
        self.assertIn(", 0 open comment(s),", lines[0])
        self.assertEqual(len(self.box.calls()), 2)

    def test_a_session_saves_state_and_notes_in_the_cache(self):
        self.routes[f"{GH}/pulls/91"].update(merged=False, state="closed")
        self.box.routes(self.routes)
        code, lines, _ = self.watch(GH_URL, "--session", "s1", "--interval", "15")
        self.assertEqual(code, 0)
        self.assertEqual([l.split()[0] for l in lines], ["[watch]", "[settings]", "[closed]"])
        cache = self.box.cache / "pr-babysit"
        self.assertEqual(sorted(p.name for p in cache.iterdir()),
                         ["github.com_u_gad_91.lock", "github.com_u_gad_91.s1.json", "github.com_u_gad_91.s1.notes.json"])
        self.assertEqual(json.loads((cache / "github.com_u_gad_91.s1.notes.json").read_text()),
                         {"branch": "feat/pagination", "remote": "origin"})
        self.assertEqual(json.loads((cache / "github.com_u_gad_91.s1.json").read_text())["sha"], GH_SHA)

    def test_another_session_holding_the_lock_is_busy(self):
        base = w.pr_base(w.GitHub("github.com", "u/gad"), 91)
        self.assertEqual(base, self.box.cache / "pr-babysit" / "github.com_u_gad_91")
        held = w.take_lock(base)
        self.addCleanup(held.close)
        code, lines, _ = self.watch(GH_URL, "--session", "s2")
        self.assertEqual((code, lines), (2, [f"[busy] {GH_URL} is already being babysat by another session"]))
        self.assertEqual(self.box.calls(), [], "no API call before the lock")
        # --once takes no lock.
        code, lines, _ = self.watch(GH_URL, "--once")
        self.assertEqual(code, 0)

    def test_a_refused_token_is_auth(self):
        self.routes["user"] = {"_exit": 1, "_stderr": "HTTP 401: Bad credentials (https://api.github.com/user)"}
        self.box.routes(self.routes)
        code, lines, _ = self.watch(GH_URL, "--once")
        self.assertEqual((code, lines), (2, ["[auth] gh isn't logged in to github.com, or its token lacks a permission this needs. Run `gh auth login --hostname github.com` in a terminal (the README's Tokens section lists the permissions), then try again (HTTP 401: Bad credentials (https://api.github.com/user))"]))

    def test_an_unreachable_host_is_setup(self):
        self.routes["user"] = {"_exit": 1, "_stderr": "error connecting to api.github.com\ncheck your internet connection"}
        self.box.routes(self.routes)
        code, lines, _ = self.watch(GH_URL, "--once")
        self.assertEqual((code, lines), (2, ["[setup] cannot reach github.com through gh: check your internet connection"]))

    def test_a_token_refused_mid_poll_is_auth(self):
        self.routes[f"{GH}/pulls/91"] = {"_exit": 1, "_stderr": "gh: Bad credentials (HTTP 401)"}
        self.box.routes(self.routes)
        code, lines, _ = self.watch(GH_URL, "--session", "s1")
        self.assertEqual((code, lines), (2, ["[auth] gh isn't logged in to github.com, or its token lacks a permission this needs. Run `gh auth login --hostname github.com` in a terminal (the README's Tokens section lists the permissions), then try again (gh: Bad credentials (HTTP 401))"]))

    def poll_failures(self):
        log = self.box.root / "state" / "agent-hub" / "logs" / "watch_pr.log"
        return [json.loads(l[l.index("{"):]) for l in log.read_text().splitlines() if " WARN watch_pr: poll failed " in l]

    def test_unexpected_api_shapes_are_failed_polls_not_a_crash(self):
        # A JSON null where an object was, a null user, and GraphQL's
        # {"data": null, "errors": [...]} that comes with exit 0.
        for name, change, err_type in (
                ("null body", lambda r: r.__setitem__(f"{GH}/commits/{GH_SHA}/status", None), "AttributeError"),
                ("null user", lambda r: r[f"{GH}/issues/91/comments"][0].__setitem__("user", None), "TypeError"),
                ("graphql errors", lambda r: r.__setitem__("graphql", {"data": None, "errors": [{"message": "x"}]}), "TypeError")):
            routes = fixture("github_pr.json")
            change(routes)
            self.box.routes(routes)
            code, lines, err = self.watch(GH_URL, "--once")
            self.assertEqual((code, err), (0, ""), name)
            self.assertEqual([l.split()[0] for l in lines], [], name)
            self.assertEqual(self.poll_failures()[-1]["errType"], err_type, name)

    def test_once_with_a_missing_key_prints_nothing_and_exits_0(self):
        # pins current behaviour: a KeyError is a failed poll, and --once
        # returns after any failed poll without saying so.
        del self.routes[f"{GH}/pulls/91"]["head"]
        self.box.routes(self.routes)
        self.assertEqual(self.watch(GH_URL, "--once"), (0, [], ""))


class GitLabOnce(Cli):
    def setUp(self):
        super().setUp()
        self.box.routes(fixture("gitlab_mr.json"))

    def test_one_poll_prints_every_open_event(self):
        code, lines, err = self.watch(GL_URL, "--once", "--stuck-after", "30")
        self.assertEqual((code, err), (0, ""))
        mr, jobs = GL_URL, "https://gitlab.com/grp/sub/gad/-/jobs"
        tail = " | build ✓ · test ⏳ · deploy ⏸ · post · qa ⏳"
        self.assertEqual(lines, [
            f'[watch] attached {mr} "Add pagination to the list endpoint", branch feat/pagination -> main, '
            f"head {GL_SHA}, remote origin, 3 open comment(s), polling every 60s",
            "[behind] feat/pagination is 4 commit(s) behind main, and the host requires a rebase before merge",
            f"[failed] lint (stage test) (allowed to fail) id=12 {jobs}/12{tail}",
            f"[stuck] e2e (stage test) has waited 40 min for a runner id=14 {jobs}/14{tail}",
            f"[manual] deploy:staging (stage deploy) id=15 {jobs}/15{tail}",
            f"[review] @bob approved {mr}",
            f'[comment] @alice on src/api/list.py:42: "This loads every row before slicing." id=note:301 {mr}#note_301',
            f'[comment] @carol: "Can this land before Friday?" id=note:305 {mr}#note_305',
            f'[comment] @dave on README.md: "Document the page size." id=note:306 {mr}#note_306',
        ])

    def test_stuck_after_from_settings(self):
        self.box.settings.write_text(json.dumps({"prBabysit.stuckAfter": 45}))
        _, lines, _ = self.watch(GL_URL, "--once")
        self.assertFalse([l for l in lines if l.startswith("[stuck]")])

    def test_one_gitlab_poll_costs_six_calls(self):
        self.watch(GL_URL, "--once")
        self.assertEqual(self.box.paths(), [
            ("glab", "GET", "user"),
            ("glab", "GET", f"{GL_PROJ}/merge_requests/91?include_diverged_commits_count=true"),
            ("glab", "GET", f"{GL_PROJ}/pipelines/555/jobs?per_page=100&page=1"),
            ("glab", "GET", f"{GL_PROJ}/pipelines/555/bridges?per_page=100&page=1"),
            ("glab", "GET", f"{GL_PROJ}/merge_requests/91/discussions?per_page=100&page=1"),
            ("glab", "GET", f"{GL_PROJ}/merge_requests/91/approvals"),
        ])
        self.assertEqual(self.box.calls()[0]["argv"], ["api", "--hostname", "gitlab.com", "user"])


class Preflight(Cli):
    def test_no_cli_on_path(self):
        code, lines, _ = self.watch(GH_URL, "--once", PATH=str(self.box.tools))
        self.assertEqual((code, lines), (2, ["[setup] gh is not installed. Install it, then start the watcher again."]))
        code, lines, _ = self.watch(GL_URL, "--once", PATH=str(self.box.tools))
        self.assertEqual(lines, ["[setup] glab is not installed. Install it, then start the watcher again."])

    def test_no_token_in_the_environment_still_calls_the_cli_whose_own_login_may_answer(self):
        _, lines, _ = self.watch(GH_URL, "--once", GITHUB_TOKEN="", GH_TOKEN="", GITLAB_TOKEN="")
        # Past preflight: the fake gh has no routes, so the first call fails.
        self.assertEqual(lines, ["[setup] cannot reach github.com through gh: HTTP 404: Not Found (fake: no route for user)"])

    def test_gh_with_no_login_is_auth_and_says_how_to_log_in(self):
        self.box.routes({"user": {"_exit": 4, "_stderr": "To get started with GitHub CLI, please run:  gh auth login"}})
        code, lines, _ = self.watch("https://github.example.com/u/gad/pull/91", "--once",
                                    clone=self.box.clone(("ghe", "git@github.example.com:u/gad.git")))
        self.assertEqual(code, 2)
        self.assertEqual(len(lines), 1, lines)
        self.assertTrue(lines[0].startswith("[auth] gh isn't logged in to github.example.com, "), lines[0])
        self.assertIn("Run `gh auth login --hostname github.example.com` in a terminal", lines[0])

    def test_no_remote_for_the_pr(self):
        clone = self.box.clone(("origin", "git@github.com:someone/else.git"))
        code, lines, _ = self.watch(GH_URL, "--once", clone=clone, PATH=str(self.box.tools))
        # Checked before gh is looked for.
        self.assertEqual((code, lines), (2, [f"[setup] {clone} has no git remote for github.com/u/gad. "
                                             "Run from a clone of that repo, or pass -C <path>."]))

    def test_not_a_git_repo(self):
        plain = self.box.root / "plain"
        plain.mkdir()
        code, lines, _ = self.watch(GH_URL, "--once", clone=plain)
        self.assertEqual(code, 2)
        self.assertTrue(lines[0].startswith(f"[setup] {plain} has no git remote"), lines)

    def test_not_a_pr_url(self):
        for url in ("https://github.com/u/gad/pulls", "https://gitlab.com/a/b/merge_requests/1", "not a url"):
            code, lines, _ = self.watch(url, "--once")
            self.assertEqual((code, lines), (2, [f"[setup] not a PR or MR URL: {url}"]), url)

    def test_session_is_required_without_once(self):
        code, _, err = self.watch(GH_URL)
        self.assertEqual(code, 2)
        self.assertIn("--session is required unless --once", err)


class ParseUrl(unittest.TestCase):
    def parsed(self, url):
        forge, number = w.parse_url(url)
        return type(forge).__name__, forge.host, forge.project, number

    def test_github_and_enterprise(self):
        self.assertEqual(self.parsed("https://github.com/u/gad/pull/91"), ("GitHub", "github.com", "u/gad", 91))
        self.assertEqual(self.parsed("https://github.com/u/gad/pull/91/files#diff-1"), ("GitHub", "github.com", "u/gad", 91))
        self.assertEqual(self.parsed("https://GitHub.Example.com/org/repo/pull/7/"), ("GitHub", "github.example.com", "org/repo", 7))

    def test_gitlab_subgroups_and_ports(self):
        self.assertEqual(self.parsed("https://gitlab.com/a/b/c/-/merge_requests/12/diffs"), ("GitLab", "gitlab.com", "a/b/c", 12))
        # The port goes to glab's --hostname; the scheme's default one is left out.
        self.assertEqual(self.parsed("https://gitlab.internal:8443/x/y/-/merge_requests/3"), ("GitLab", "gitlab.internal:8443", "x/y", 3))
        self.assertEqual(self.parsed("https://gitlab.internal:443/x/y/-/merge_requests/3"), ("GitLab", "gitlab.internal", "x/y", 3))

    def test_a_port_is_used_in_the_api_calls_and_not_when_matching_remotes(self):
        forge, _ = w.parse_url("https://gitlab.internal:8443/x/y/-/merge_requests/3")
        with mock.patch.object(w.hub_forge, "run", return_value="[]") as run:
            forge.api("user")
        self.assertEqual(run.call_args.args[0][:4], ["glab", "api", "--hostname", "gitlab.internal:8443"])
        with mock.patch.object(w, "run", return_value="origin\tgit@gitlab.internal:x/y.git (fetch)\n"):
            self.assertEqual(w.find_remote(forge, "."), "origin")

    def test_a_bad_port_is_not_a_pr_url(self):
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(SystemExit):
            w.parse_url("https://gitlab.internal:99999/x/y/-/merge_requests/3")

    def test_the_path_decides_the_forge_not_the_host(self):
        self.assertEqual(self.parsed("https://gitlab.com/u/gad/pull/4")[0], "GitHub")


class ParseRemote(unittest.TestCase):
    def test_remote_forms(self):
        for url, want in (("git@github.com:u/gad.git", ("github.com", "u/gad")),
                          ("github.com:u/gad", ("github.com", "u/gad")),
                          ("https://github.com/u/gad.git", ("github.com", "u/gad")),
                          ("https://github.com/u/gad/", ("github.com", "u/gad")),
                          ("ssh://git@github.com/u/gad", ("github.com", "u/gad")),
                          ("ssh://git@gitlab.com:2222/grp/sub/gad.git", ("gitlab.com", "grp/sub/gad")),
                          ("https://gitlab.example.com:8443/grp/gad", ("gitlab.example.com", "grp/gad")),
                          ("https://user:token@host.com/x/y", ("host.com", "x/y")),
                          ("  git@GitHub.com:U/Gad.git  \n", ("GitHub.com", "U/Gad")),
                          ("/local/path/repo", ("", "")),
                          ("file:///x/y", ("", "")),
                          # scp form has no port: a numeric group is the path.
                          ("git@gitlab.com:42/proj.git", ("gitlab.com", "42/proj")),
                          ("gitlab.com:42/proj", ("gitlab.com", "42/proj")),
                          ("ssh://git@gitlab.com:42/grp/proj.git", ("gitlab.com", "grp/proj"))):
            self.assertEqual(w.parse_remote(url), want, url)


class FindRemote(Cli):
    def test_the_remote_pointing_at_the_pr_repo_wins_case_insensitively(self):
        clone = self.box.clone(("origin", "git@github.com:me/gad.git"), ("upstream", "https://GitHub.com/U/Gad.git"))
        self.assertEqual(w.find_remote(w.GitHub("github.com", "u/gad"), str(clone)), "upstream")
        self.assertIsNone(w.find_remote(w.GitHub("github.com", "other/gad"), str(clone)))

    def test_no_repo_or_no_folder_is_none(self):
        self.assertIsNone(w.find_remote(w.GitHub("github.com", "u/gad"), str(self.box.root)))
        self.assertIsNone(w.find_remote(w.GitHub("github.com", "u/gad"), str(self.box.root / "missing")))


if __name__ == "__main__":
    unittest.main()
