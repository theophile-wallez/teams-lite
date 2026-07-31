#!/usr/bin/env python3
"""Decision tests for `sync-service-to-master.sh`.

    python3 .claude/hooks/sync-service-to-master.test.py

The hook rebuilds and restarts the user's live Teams client, so what it *declines*
to do matters more than what it does. Each case builds a throwaway git checkout, a
throwaway staged artifact, and a fake `systemctl` and `teams-lite-service.sh`, then
asserts whether the update ran — the stub records the call, so "did it act?" is a
file on disk rather than a reading of the script.

Pinned here, in order of what they protect:

  * a stopped service is never started, through the hook OR through `--run`
    directly — the backend is send-capable, so bringing it up is the user's call;
  * a dirty or off-master checkout is never staged, because `update` builds the
    tree as it stands and one uncommitted edit would reach the user's phone;
  * an artifact already on HEAD is left alone, so ordinary git work costs nothing;
  * and the update DOES run when master moved with the service up — a guard that
    never acts is the same bug as no guard at all.
"""

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HOOK = Path(__file__).with_name("sync-service-to-master.sh")

SERVICE_STUB = """#!/bin/sh
# Stands in for bin/teams-lite-service.sh: records the call instead of building.
echo "$@" >>"$MARKER"
"""

SYSTEMCTL_STUB = """#!/bin/sh
# Stands in for systemctl. is-active answers with $UNIT_STATE; nothing else is used.
[ "$2" = is-active ] && { echo "$UNIT_STATE"; [ "$UNIT_STATE" = active ]; exit $?; }
exit 0
"""


def git(cwd: Path, *args: str) -> None:
    subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
             "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"},
    )


def make_checkout(root: Path, branch: str, dirty: bool) -> str:
    """A checkout that looks enough like the real one: a bin/ script and a commit."""
    (root / "bin").mkdir(parents=True)
    stub = root / "bin" / "teams-lite-service.sh"
    stub.write_text(SERVICE_STUB)
    stub.chmod(0o755)
    git(root, "init", "-q", "-b", "master")
    git(root, "add", "-A")
    git(root, "commit", "-qm", "initial")
    if branch != "master":
        git(root, "switch", "-qc", branch)
    if dirty:
        (root / "uncommitted.txt").write_text("work in progress\n")
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=root, capture_output=True, text=True, check=True
    ).stdout.strip()


def run_case(
    tmp: Path,
    *,
    command: str,
    staged: str | None,
    branch: str = "master",
    dirty: bool = False,
    unit_state: str = "active",
    direct_run: bool = False,
) -> tuple[bool, str]:
    """Returns (the update ran, the message shown to the session)."""
    checkout = tmp / "checkout"
    service_dir = tmp / "staged"
    bin_dir = tmp / "fakebin"
    marker = tmp / "marker"
    service_dir.mkdir()
    bin_dir.mkdir()

    head = make_checkout(checkout, branch, dirty)
    # `staged=None` means "stage the current HEAD" — the artifact is already current.
    commit = head if staged is None else staged
    (service_dir / "VERSION").write_text(f"commit={commit}\n")

    systemctl = bin_dir / "systemctl"
    systemctl.write_text(SYSTEMCTL_STUB)
    systemctl.chmod(0o755)

    env = {
        "PATH": f"{bin_dir}:/usr/bin:/bin",
        "HOME": str(tmp / "home"),
        "TMPDIR": str(tmp),
        "XDG_STATE_HOME": str(tmp / "state"),
        "TEAMS_LITE_SERVICE_DIR": str(service_dir),
        "UNIT_STATE": unit_state,
        "MARKER": str(marker),
    }
    argv = [str(HOOK), "--run", str(checkout)] if direct_run else [str(HOOK)]
    proc = subprocess.run(
        argv,
        input=json.dumps({"tool_input": {"command": command}}),
        capture_output=True,
        text=True,
        cwd=checkout,
        env=env,
    )
    assert proc.returncode == 0, f"the hook must never fail a tool call: {proc.stderr}"

    # The update is detached, so give the background job a moment to reach the stub.
    for _ in range(100):
        if marker.exists():
            break
        time.sleep(0.05)

    message = ""
    if proc.stdout.strip():
        message = json.loads(proc.stdout).get("systemMessage", "")
    return marker.exists(), message


# (name, wants the update, kwargs)
CASES = [
    (
        "master moved and the service is up -> update",
        True,
        dict(command="git push origin master", staged="0" * 40),
    ),
    (
        "the artifact is already on HEAD -> no-op",
        False,
        dict(command="git commit -m x", staged=None),
    ),
    (
        "no git command -> no-op",
        False,
        dict(command="bun run test", staged="0" * 40),
    ),
    (
        "the service is stopped -> never started",
        False,
        dict(command="git push origin master", staged="0" * 40, unit_state="inactive"),
    ),
    (
        "the service is stopped, --run called directly -> never started",
        False,
        dict(command="", staged="0" * 40, unit_state="inactive", direct_run=True),
    ),
    (
        "the checkout is dirty -> refuse to stage a work in progress",
        False,
        dict(command="git push origin master", staged="0" * 40, dirty=True),
    ),
    (
        "the checkout is on a task branch -> refuse to stage it",
        False,
        dict(command="git push origin master", staged="0" * 40, branch="feat/x"),
    ),
    (
        "a dirty checkout, --run called directly -> still refuses",
        False,
        dict(command="", staged="0" * 40, dirty=True, direct_run=True),
    ),
]


def main() -> int:
    failures = 0
    for name, wants_update, kwargs in CASES:
        with tempfile.TemporaryDirectory() as raw:
            ran, message = run_case(Path(raw), **kwargs)
        ok = ran == wants_update
        failures += 0 if ok else 1
        verdict = "updated" if ran else "left alone"
        print(f"{'ok  ' if ok else 'FAIL'} {verdict:11} {name}")
        if message:
            print(f"       message: {message}")

    print(f"\n{len(CASES) - failures}/{len(CASES)} as expected")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
