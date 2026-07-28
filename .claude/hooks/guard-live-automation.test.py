#!/usr/bin/env python3
"""Decision tests for `guard-live-automation.sh`.

    python3 .claude/hooks/guard-live-automation.test.py

The hook is a safety net whose whole value is that it says no to the right
commands. It also has to say *yes* to ordinary work: a guard that blocks
`git add` or `wc -l` teaches its next reader to phrase commands around it, and
that habit is what sent three real messages to two colleagues. Both halves are
pinned here, so tightening one can't quietly widen the other.

The blocking cases are the ones to keep: the incident's own command line, an
inline browser driver, a script that writes to the live backend, a dev server
with no declared backend, and a send-capable backend started by tooling.
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path

HOOK = Path(__file__).with_name("guard-live-automation.sh")
PROJECT = HOOK.parent.parent.parent
WEB = PROJECT / "web"

# Ad-hoc scripts, written outside the repo like the real ones were.
FIXTURES = {
    "incident-driver.ts": (
        "// The ad-hoc driver from the incident: launches a browser and types.\n"
        "import { chromium } from 'playwright-core';\n"
        "const page = await (await chromium.launch()).newPage();\n"
        "await page.keyboard.press('Enter');\n"
    ),
    "backend-writer.ts": (
        "// Calls a write method on the real backend.\n"
        "const ws = new WebSocket('ws://127.0.0.1:8420');\n"
        "ws.send(JSON.stringify({ method: 'send' }));\n"
    ),
    "backend-reader.ts": (
        "// Reads the real backend, which is allowed.\n"
        "const ws = new WebSocket('ws://127.0.0.1:8420');\n"
        "ws.send(JSON.stringify({ method: 'conversations' }));\n"
    ),
    # The app's server relays every WebSocket to the same backend (web/server.ts),
    # so its port is a second address for the live account — same split applies.
    "relay-writer.ts": (
        "// Writes to the live backend through the app's own server.\n"
        "const ws = new WebSocket('ws://127.0.0.1:4321');\n"
        "ws.send(JSON.stringify({ method: 'send' }));\n"
    ),
    "relay-reader.ts": (
        "// Reads through the app's own server, which is allowed.\n"
        "const ws = new WebSocket('ws://127.0.0.1:4321');\n"
        "ws.send(JSON.stringify({ method: 'conversations' }));\n"
    ),
    "token-thief.ts": (
        "// Fetches the write capability from the app's own server.\n"
        "const res = await fetch('http://127.0.0.1:4321/__write-token');\n"
    ),
}


def cases(tmp: Path):
    """(expected, cwd, command) — cwd is the directory the shell would run in."""
    return [
        # --- must block ------------------------------------------------------
        ("BLOCK", PROJECT, f"bun run {tmp}/incident-driver.ts"),
        ("BLOCK", PROJECT, f"bun run {tmp}/backend-writer.ts"),
        ("BLOCK", PROJECT, f"git add x.ts && bun run {tmp}/incident-driver.ts"),
        ("BLOCK", PROJECT, "node -e \"const {chromium} = require('playwright')\""),
        ("BLOCK", WEB, "vite dev"),
        ("BLOCK", PROJECT, "cargo run --bin server"),
        ("BLOCK", PROJECT, "curl -X POST https://graph.microsoft.com/v1.0/me/sendMail"),
        # The app server relays to the same backend, so writing through it is writing.
        ("BLOCK", PROJECT, f"bun run {tmp}/relay-writer.ts"),
        # The write token is the capability itself — never ours to fetch.
        ("BLOCK", PROJECT, f"bun run {tmp}/token-thief.ts"),
        ("BLOCK", PROJECT, "curl -s http://127.0.0.1:4321/__write-token"),
        ("BLOCK", PROJECT, 'cat "$XDG_RUNTIME_DIR/teams-lite/write-token"'),
        # --- must allow ------------------------------------------------------
        # Reading the live backend is deliberately fine, through either address.
        ("ALLOW", PROJECT, f"bun run {tmp}/backend-reader.ts"),
        ("ALLOW", PROJECT, f"bun run {tmp}/relay-reader.ts"),
        # Reading the code that implements the token endpoint is ordinary work.
        ("ALLOW", PROJECT, 'grep -rn "__write-token" web/src'),
        # Commands that only NAME a file run nothing, whatever is inside it.
        ("ALLOW", PROJECT, "git add web/scripts/scroll-probe.ts"),
        ("ALLOW", PROJECT, "wc -l web/src/lib/ws-client.ts web/mock/server.ts"),
        ("ALLOW", PROJECT, "sed -n 1,20p web/playwright.config.ts"),
        # Tracked scripts are reviewed code, including from a subdirectory.
        ("ALLOW", WEB, "bun run scripts/scroll-probe.ts --steps 10"),
        ("ALLOW", WEB, "bun run preview -- --out /tmp/shot"),
        ("ALLOW", WEB, "bun run dev:mock"),
        ("ALLOW", PROJECT, "TEAMS_LITE_READ_ONLY=1 cargo run --bin server"),
        # Stopping or inspecting a process is cleanup, whatever it names.
        ("ALLOW", PROJECT, "pkill -f 'target/debug/server'"),
        ("ALLOW", PROJECT, "pkill -f 'vite dev'"),
        ("ALLOW", PROJECT, 'pgrep -af "vite dev|mock/server.ts"'),
        # Looking at the binary is not running it — but a compound that runs it is.
        ("ALLOW", PROJECT, "ls -la target/debug/server"),
        ("BLOCK", PROJECT, "ls target/debug/server && ./target/debug/server"),
        ("BLOCK", PROJECT, "nohup target/release/server &"),
        # Prose that names the binary runs nothing: a commit message, a doc line.
        ("ALLOW", PROJECT, "git commit -m 'fix: stop blocking `ls target/debug/server`'"),
    ]


def main() -> int:
    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)
        for name, body in FIXTURES.items():
            (tmp / name).write_text(body)

        failures = 0
        for expected, cwd, command in cases(tmp):
            proc = subprocess.run(
                [str(HOOK)],
                input=json.dumps({"tool_input": {"command": command}}),
                capture_output=True,
                text=True,
                cwd=cwd,
                env={"CLAUDE_PROJECT_DIR": str(PROJECT), "HOME": str(Path.home()), "PATH": "/usr/bin:/bin"},
            )
            got = "ALLOW" if proc.returncode == 0 else "BLOCK"
            ok = got == expected
            failures += 0 if ok else 1
            print(f"{'ok  ' if ok else 'FAIL'} {got:5} (want {expected}) <- {command}")

    total = len(cases(Path("/tmp")))
    print(f"\n{total - failures}/{total} as expected")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
