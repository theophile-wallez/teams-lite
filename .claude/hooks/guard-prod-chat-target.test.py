#!/usr/bin/env python3
"""Decision tests for `guard-prod-chat-target.sh`.

    python3 .claude/hooks/guard-prod-chat-target.test.py

The hook decides one thing: may this browser MCP call activate a control in the
page? Its answer depends on where the browser was last sent, so the tests are
SEQUENCES — navigate, then type — each in its own session id, with the state
directory pointed at a temporary folder.

Both halves are pinned, like the Bash guard's. Blocking a click on the user's live
app is the point; allowing a screenshot of it, and every input on the mock, is just
as much the point — a guard that blocks ordinary work teaches its next reader to
phrase around it, and that habit is what sent three messages to two colleagues.
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path

HOOK = Path(__file__).with_name("guard-prod-chat-target.sh")
PROJECT = HOOK.parent.parent.parent

PLAY = "mcp__playwright__browser_"
PREV = "mcp__t3-code__preview_"

# The always-on service's tailnet front, and the sandbox chat on it.
SANDBOX_URL = (
    "https://theophile-remote.taild26c06.ts.net:8443"
    "/c/19%3A21d2695ae8ff4e25ace9c662e5c326cb%40thread.v2"
)


def steps():
    """(session, expected, tool, tool_input) — run in order, per session."""
    return [
        # --- the live app: look all you like ---------------------------------
        ("look", "ALLOW", f"{PLAY}navigate", {"url": SANDBOX_URL}),
        ("look", "ALLOW", f"{PLAY}snapshot", {}),
        ("look", "ALLOW", f"{PLAY}take_screenshot", {"filename": "/tmp/a.png"}),
        ("look", "ALLOW", f"{PLAY}console_messages", {}),
        ("look", "ALLOW", f"{PLAY}network_requests", {}),
        ("look", "ALLOW", f"{PLAY}hover", {"element": "a message", "ref": "e1"}),
        # --- …but never type in it, whichever chat it claims to be on --------
        ("send", "ALLOW", f"{PLAY}navigate", {"url": SANDBOX_URL}),
        ("send", "BLOCK", f"{PLAY}type", {"element": "composer", "ref": "e2", "text": "hi"}),
        ("send", "BLOCK", f"{PLAY}press_key", {"key": "Enter"}),
        ("send", "BLOCK", f"{PLAY}click", {"element": "Send", "ref": "e3"}),
        ("send", "BLOCK", f"{PLAY}fill_form", {"fields": []}),
        ("send", "BLOCK", f"{PLAY}evaluate", {"function": "() => 1"}),
        ("send", "BLOCK", f"{PLAY}run_code_unsafe", {"code": "1"}),
        ("send", "BLOCK", f"{PLAY}file_upload", {"paths": ["/tmp/a.png"]}),
        # `network_requests` lists what the page already did; `network_request` issues
        # one — at a live front, that is a request to the user's own backend.
        ("send", "BLOCK", f"{PLAY}network_request", {"url": "/api", "method": "POST"}),
        # A tool neither server has today must arrive blocked, not pre-approved.
        ("send", "BLOCK", f"{PLAY}future_gadget", {}),
        # The backend's own port, and the user's dev pair, are the same account.
        ("backend", "ALLOW", f"{PLAY}navigate", {"url": "http://127.0.0.1:19420/"}),
        ("backend", "BLOCK", f"{PLAY}click", {"element": "x", "ref": "e1"}),
        ("devpair", "ALLOW", f"{PLAY}navigate", {"url": "http://localhost:19441/"}),
        ("devpair", "BLOCK", f"{PLAY}type", {"element": "composer", "ref": "e1", "text": "hi"}),
        # A tailnet name is a live front whatever port it is served on.
        ("tailnet", "ALLOW", f"{PLAY}navigate", {"url": "https://theophile-remote.taild26c06.ts.net/"}),
        ("tailnet", "BLOCK", f"{PLAY}press_key", {"key": "Enter"}),
        # --- the mock is what typing is for ---------------------------------
        ("mock", "ALLOW", f"{PLAY}navigate", {"url": "http://127.0.0.1:19446/"}),
        ("mock", "ALLOW", f"{PLAY}type", {"element": "composer", "ref": "e1", "text": "hi"}),
        ("mock", "ALLOW", f"{PLAY}press_key", {"key": "Enter"}),
        # …as is any other site: this guard is about the user's account, not the web.
        ("docs", "ALLOW", f"{PLAY}navigate", {"url": "https://example.com/docs"}),
        ("docs", "ALLOW", f"{PLAY}click", {"element": "next", "ref": "e1"}),
        # --- an undeclared page is unproven, and unproven means live ---------
        ("blind", "BLOCK", f"{PLAY}type", {"element": "composer", "ref": "e1", "text": "hi"}),
        ("blind", "ALLOW", f"{PLAY}snapshot", {}),
        ("blind", "ALLOW", f"{PLAY}navigate", {"url": "http://127.0.0.1:19446/"}),
        ("blind", "ALLOW", f"{PLAY}type", {"element": "composer", "ref": "e1", "text": "hi"}),
        # --- leaving the live app has to be declared, not implied -----------
        # Back and tab-switch land on a page whose address this hook never sees, so
        # once anything live has been opened they count as live until a navigate says
        # otherwise.
        ("wander", "ALLOW", f"{PLAY}navigate", {"url": SANDBOX_URL}),
        ("wander", "ALLOW", f"{PLAY}navigate", {"url": "http://127.0.0.1:19446/"}),
        ("wander", "ALLOW", f"{PLAY}navigate_back", {}),
        ("wander", "BLOCK", f"{PLAY}type", {"element": "composer", "ref": "e1", "text": "hi"}),
        ("wander", "ALLOW", f"{PLAY}navigate", {"url": "http://127.0.0.1:19446/"}),
        ("wander", "ALLOW", f"{PLAY}type", {"element": "composer", "ref": "e1", "text": "hi"}),
        ("tabs", "ALLOW", f"{PLAY}navigate", {"url": SANDBOX_URL}),
        ("tabs", "ALLOW", f"{PLAY}tabs", {"action": "select", "index": 1}),
        ("tabs", "BLOCK", f"{PLAY}click", {"element": "Send", "ref": "e1"}),
        # A back on a session that never saw the live app is harmless.
        ("backonly", "ALLOW", f"{PLAY}navigate", {"url": "http://127.0.0.1:19446/"}),
        ("backonly", "ALLOW", f"{PLAY}navigate_back", {}),
        ("backonly", "ALLOW", f"{PLAY}type", {"element": "composer", "ref": "e1", "text": "hi"}),
        # --- the other browser server, same rules ---------------------------
        ("t3live", "ALLOW", f"{PREV}open", {"url": SANDBOX_URL}),
        ("t3live", "ALLOW", f"{PREV}snapshot", {}),
        ("t3live", "BLOCK", f"{PREV}type", {"ref": "e1", "text": "hi"}),
        ("t3live", "BLOCK", f"{PREV}press", {"key": "Enter"}),
        ("t3live", "BLOCK", f"{PREV}evaluate", {"function": "() => 1"}),
        ("t3live", "ALLOW", f"{PREV}scroll", {"direction": "down"}),
        ("t3live", "ALLOW", f"{PREV}status", {}),
        ("t3live", "ALLOW", f"{PREV}wait_for", {"text": "hello"}),
        # A bare port names the app server without spelling a host.
        ("t3port", "ALLOW", f"{PREV}navigate", {"target": {"kind": "environment-port", "port": 19440}}),
        ("t3port", "BLOCK", f"{PREV}click", {"ref": "e1"}),
        ("t3mock", "ALLOW", f"{PREV}navigate", {"target": {"kind": "environment-port", "port": 19446}}),
        ("t3mock", "ALLOW", f"{PREV}click", {"ref": "e1"}),
        # --- tools this hook has no opinion about ---------------------------
        ("other", "ALLOW", "Bash", {"command": "ls"}),
        ("other", "ALLOW", "Read", {"file_path": "/tmp/x"}),
    ]


def main() -> int:
    with tempfile.TemporaryDirectory() as raw:
        env = {
            "CLAUDE_PROJECT_DIR": str(PROJECT),
            "HOME": str(Path.home()),
            "PATH": "/usr/bin:/bin",
            "XDG_RUNTIME_DIR": raw,
        }
        failures = 0
        for session, expected, tool, tool_input in steps():
            proc = subprocess.run(
                [str(HOOK)],
                input=json.dumps(
                    {"session_id": f"test-{session}", "tool_name": tool, "tool_input": tool_input}
                ),
                capture_output=True,
                text=True,
                cwd=PROJECT,
                env=env,
            )
            got = "ALLOW" if proc.returncode == 0 else "BLOCK"
            ok = got == expected
            failures += 0 if ok else 1
            shown = json.dumps(tool_input)
            if len(shown) > 60:
                shown = shown[:57] + "…"
            print(f"{'ok  ' if ok else 'FAIL'} {got:5} (want {expected}) <- [{session}] {tool} {shown}")

    total = len(steps())
    print(f"\n{total - failures}/{total} as expected")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
