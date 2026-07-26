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
        # --- must allow ------------------------------------------------------
        # Reading the live backend is deliberately fine.
        ("ALLOW", PROJECT, f"bun run {tmp}/backend-reader.ts"),
        # Commands that only NAME a file run nothing, whatever is inside it.
        ("ALLOW", PROJECT, "git add web/scripts/scroll-probe.ts"),
        ("ALLOW", PROJECT, "wc -l web/src/lib/ws-client.ts web/mock/server.ts"),
        ("ALLOW", PROJECT, "sed -n 1,20p web/playwright.config.ts"),
        # Tracked scripts are reviewed code, including from a subdirectory.
        ("ALLOW", WEB, "bun run scripts/scroll-probe.ts --steps 10"),
        ("ALLOW", WEB, "bun run preview -- --out /tmp/shot"),
        ("ALLOW", WEB, "bun run dev:mock"),
        ("ALLOW", PROJECT, "TEAMS_LITE_READ_ONLY=1 cargo run --bin server"),
        ("ALLOW", PROJECT, "pkill -f 'target/debug/server'"),
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
