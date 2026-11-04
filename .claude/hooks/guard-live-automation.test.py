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
with no declared backend, a send-capable backend started by tooling, and the
user's Intune container cycled by tooling — through its CLI, its unit, the
hidden arguments teams-lite's own binary routes (on the host, or behind a
`docker exec` / `kubectl exec` into the image that runs one of its own), a
transient unit, or the crate called from a cargo example — and the image or the
chart that holds the user's enrollment stopped, signalled from inside or from a
container joined to its pid namespace, a second backend exec'd into it, or its
volumes deleted.

The refusals are held to the same two halves (`check_advice`): every command a
block text recommends as the way forward must itself be allowed, and be the
spelling that works — a refusal whose own advice fails is one its reader stops
reading.

Most of them come in the SHAPES a shell gives a command — behind `timeout` or
`env -i`, inside `( … )` or `$( … )`, chained after a `pkill` — because each of
those once walked past a rule written for the bare spelling. Their ALLOW twins
are the same words as text: a commit message, a heredoc, a search, a probe.
"""

import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

HOOK = Path(__file__).with_name("guard-live-automation.sh")
# The checkout the cases run in. It is the one this file sits in — except when GUARD_TEST_PROJECT
# names another, which is how an edited COPY of the hook is tested before it replaces the live
# one. The live hook guards every command of every session in this checkout, and a syntax error
# in it exits 2, which refuses ALL of them: so a change is staged outside .claude/hooks/, tested
# there against the real checkout (whose tracked files, examples/ and packaging/ the cases need),
# and only then copied back.
PROJECT = Path(os.environ.get("GUARD_TEST_PROJECT") or HOOK.parent.parent.parent)
WEB = PROJECT / "web"

# Ad-hoc scripts, written outside the repo like the real ones were.
FIXTURES = {
    # The chart rendered to a file (and into a directory), the two-step spelling of
    # `helm template … | kubectl apply -f -` — and a manifest of something else.
    "rendered.yaml": (
        "apiVersion: apps/v1\n"
        "kind: StatefulSet\n"
        "metadata:\n"
        "  labels:\n"
        "    app.kubernetes.io/name: teams-lite\n"
        "spec:\n"
        "  template:\n"
        "    spec:\n"
        "      containers:\n"
        '        - image: "ghcr.io/theophile-wallez/teams-lite:build-0123abc"\n'
    ),
    "rendered-dir/statefulset.yaml": (
        "kind: StatefulSet\n"
        "spec:\n"
        "  template:\n"
        "    spec:\n"
        "      containers:\n"
        "        - image: ghcr.io/somefork/teams-lite:latest\n"
    ),
    "unrelated.yaml": "kind: ConfigMap\nmetadata:\n  name: grafana\ndata:\n  a: b\n",
    "helmfile.yaml": (
        "releases:\n"
        "  - name: chat\n"
        "    chart: oci://ghcr.io/theophile-wallez/charts/teams-lite\n"
    ),
    "incident-driver.ts": (
        "// The ad-hoc driver from the incident: launches a browser and types.\n"
        "import { chromium } from 'playwright-core';\n"
        "const page = await (await chromium.launch()).newPage();\n"
        "await page.keyboard.press('Enter');\n"
    ),
    # A copy of the sanctioned live driver, parked outside the repo. Its name is one the
    # allowlist knows; its contents are a browser driver like any other. The exemption is
    # for running THOSE files, never for a name.
    "join-live-copy.ts": (
        "// A copy of web/scripts/join-live.ts, moved somewhere nobody reviews.\n"
        "import { chromium } from 'playwright-core';\n"
        "const page = await (await chromium.launch()).newPage();\n"
        "await page.click('[data-testid=\"meeting-join-here\"]');\n"
    ),
    # And the same for the driver that RINGS somebody, which is the sharpest of the three.
    "call-live-copy.ts": (
        "// A copy of web/scripts/call-live.ts, moved somewhere nobody reviews.\n"
        "import { chromium } from 'playwright-core';\n"
        "const page = await (await chromium.launch()).newPage();\n"
        "await page.click('[data-testid=\"call-button\"]');\n"
    ),
    "backend-writer.ts": (
        "// Calls a write method on the real backend.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19420');\n"
        "ws.send(JSON.stringify({ method: 'send' }));\n"
    ),
    # Deleting a message is a write, and the one nothing takes back: the message
    # leaves the thread for everybody in it, on every device.
    "delete-writer.ts": (
        "// Deletes a real message through the live backend.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19420');\n"
        "ws.send(JSON.stringify({ method: 'delete' }));\n"
    ),
    # Marking a thread read is a write: the sender is shown a read receipt.
    "mark-read-writer.ts": (
        "// Marks a real conversation read through the live backend.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19420');\n"
        "ws.send(JSON.stringify({ method: 'mark_read' }));\n"
    ),
    # Clearing a MAIL's unread marker reaches nobody but the user — and nothing in
    # this app can put the marker back, so a script walking a live inbox erases what
    # the user had not read yet.
    "mail-mark-read-writer.ts": (
        "// Marks real mail read through the live backend.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19420');\n"
        "ws.send(JSON.stringify({ method: 'mail_mark_read', params: { id: 'AAMk-1' } }));\n"
    ),
    # Reading the mailbox is what the feature is for: ordinary recon.
    "mail-reader.ts": (
        "// Lists real mail through the live backend.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19420');\n"
        "ws.send(JSON.stringify({ method: 'mail_list', params: { folder: 'f' } }));\n"
    ),
    # The same write, straight to Teams — bypassing the backend's gate entirely.
    "horizon-writer.ts": (
        "// PUTs our own consumption horizon to Teams.\n"
        "await fetch(`${chat}/v1/users/ME/conversations/${id}/properties?name=consumptionhorizon`,\n"
        "  { method: 'PUT', body: JSON.stringify({ consumptionhorizon: '1;2;0' }) });\n"
    ),
    # A chat setting, straight to Teams: the pin, the mute and the hide land in every
    # Teams client the user owns, past the backend's gate and past the app's own menu.
    "chat-setting-writer.ts": (
        "// PUTs a chat's mute straight to Teams.\n"
        "await fetch(`${chat}/v1/users/ME/conversations/${id}/properties?name=alerts`,\n"
        "  { method: 'PUT', body: JSON.stringify({ alerts: 'false' }) });\n"
    ),
    # The same three settings through the backend's gated RPCs: still writes.
    "chat-pin-writer.ts": (
        "// Pins a real chat through the live backend.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19420');\n"
        "ws.send(JSON.stringify({ method: 'set_chat_pinned' }));\n"
    ),
    # Reading the conversation list — properties and all — is ordinary recon.
    "chat-setting-reader.ts": (
        "// GETs the conversation list the settings live on.\n"
        "await fetch(`${chat}/v1/users/ME/conversations?view=msnp24Equivalent`);\n"
    ),
    # Our own presence, published straight to Teams: the green dot appears for every
    # colleague, past the backend's gate and past the switch's own off state.
    "presence-publisher.ts": (
        "// Registers an endpoint reporting Available.\n"
        "await fetch('https://presence.teams.microsoft.com/v1/me/endpoints/',\n"
        "  { method: 'PUT', body: JSON.stringify({ availability: 'Available' }) });\n"
    ),
    # The same through the backend's gated RPC, which is still a write.
    "always-available-writer.ts": (
        "// Turns the user's status green through the live backend.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19420');\n"
        "ws.send(JSON.stringify({ method: 'set_always_available' }));\n"
    ),
    # A merge request approved straight through GitLab's own API: an act by the user's
    # account that everybody watching the merge request is told about, past the backend's
    # gate and past the menu that asks them first.
    "mr-approve-writer.ts": (
        "// POSTs an approval to GitLab.\n"
        "await fetch('https://gitlab.com/api/v4/projects/x%2Fy/merge_requests/42/approve',\n"
        "  { method: 'POST', headers: { 'PRIVATE-TOKEN': token } });\n"
    ),
    # Taking it back is the same write, and refused for the same reason: neither half
    # may run from tooling.
    "mr-unapprove-writer.ts": (
        "// POSTs an unapproval to GitLab.\n"
        "await fetch('https://gitlab.com/api/v4/projects/x%2Fy/merge_requests/42/unapprove',\n"
        "  { method: 'POST', headers: { 'PRIVATE-TOKEN': token } });\n"
    ),
    # The same through the backend's gated RPC, which is still a write.
    "mr-approval-rpc-writer.ts": (
        "// Approves a real merge request through the live backend.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19420');\n"
        "ws.send(JSON.stringify({ method: 'gitlab_set_approval' }));\n"
    ),
    # Reading the approval state is a read, and the menu's own question.
    "mr-approval-reader.ts": (
        "// Reads who approved a merge request through the live backend.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19420');\n"
        "ws.send(JSON.stringify({ method: 'gitlab_approvals', params: { url } }));\n"
    ),
    # THE merge: it lands somebody's branch in a shared repository and no later call takes
    # it back. There is no sandbox project to aim one at, so nothing but the user's own
    # click in the app may make it.
    "mr-merge-writer.ts": (
        "// Merges a real merge request straight through GitLab.\n"
        "await fetch('https://gitlab.com/api/v4/projects/x%2Fy/merge_requests/42/merge',\n"
        "  { method: 'PUT', headers: { 'PRIVATE-TOKEN': token } });\n"
    ),
    # A comment reaches everybody watching the merge request, under the user's name.
    "mr-comment-writer.ts": (
        "// Comments on a real merge request straight through GitLab.\n"
        "await fetch('https://gitlab.com/api/v4/projects/x%2Fy/merge_requests/42/notes',\n"
        "  { method: 'POST', body: JSON.stringify({ body: 'looks good' }) });\n"
    ),
    # Closing one is a write too, whatever the verb it rides on.
    "mr-close-writer.ts": (
        "// Closes a real merge request straight through GitLab.\n"
        "await fetch('https://gitlab.com/api/v4/projects/x%2Fy/merge_requests/42',\n"
        "  { method: 'PUT', body: JSON.stringify({ state_event: 'close' }) });\n"
    ),
    # Rewriting a comment reaches the same people, and the words that were there are gone.
    "mr-edit-writer.ts": (
        "// Rewrites a comment on a real merge request straight through GitLab.\n"
        "await fetch('https://gitlab.com/api/v4/projects/x%2Fy/merge_requests/42/notes/7',\n"
        "  { method: 'PUT', body: JSON.stringify({ body: 'rewritten' }) });\n"
    ),
    # Resolving a thread tells everybody watching that the objection is settled — and it is
    # the PAIR that makes it a write: reading that same thread is a read.
    "mr-resolve-writer.ts": (
        "// Resolves a thread on a real merge request straight through GitLab.\n"
        "const thread = 'projects/x%2Fy/merge_requests/42/discussions/ab12';\n"
        "await fetch(`https://gitlab.com/api/v4/${thread}`,\n"
        "  { method: 'PUT', body: JSON.stringify({ resolved: true }) });\n"
    ),
    # And the same six through the backend's gated RPCs, which are still writes.
    "mr-merge-rpc-writer.ts": (
        "// Merges a real merge request through the live backend.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19420');\n"
        "ws.send(JSON.stringify({ method: 'gitlab_mr_merge' }));\n"
    ),
    "mr-comment-rpc-writer.ts": (
        "// Comments on a real merge request through the live backend.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19420');\n"
        "ws.send(JSON.stringify({ method: 'gitlab_mr_comment' }));\n"
    ),
    "mr-edit-rpc-writer.ts": (
        "// Rewrites a comment on a real merge request through the live backend.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19420');\n"
        "ws.send(JSON.stringify({ method: 'gitlab_mr_edit_comment' }));\n"
    ),
    "mr-resolve-rpc-writer.ts": (
        "// Resolves a thread on a real merge request through the live backend.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19420');\n"
        "ws.send(JSON.stringify({ method: 'gitlab_mr_resolve_thread' }));\n"
    ),
    # Reading ONE thread is a read: the address alone is not the write.
    "mr-thread-reader.ts": (
        "// Reads one thread of a real merge request.\n"
        "const thread = 'projects/x%2Fy/merge_requests/42/discussions/ab12';\n"
        "await fetch(`https://gitlab.com/api/v4/${thread}`);\n"
    ),
    # Reading the PAGE is a read, all four of them: the list, the detail, the comments and
    # the pipeline. A guard that blocked those would make the surface unscreenshotable and
    # teach its next reader to phrase around it.
    "mr-page-reader.ts": (
        "// Reads the merge-request page through the live backend.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19430');\n"
        "ws.send(JSON.stringify({ method: 'gitlab_mr_list' }));\n"
        "ws.send(JSON.stringify({ method: 'gitlab_mr_detail' }));\n"
        "ws.send(JSON.stringify({ method: 'gitlab_mr_notes' }));\n"
        "ws.send(JSON.stringify({ method: 'gitlab_mr_pipeline' }));\n"
    ),
    # A Linear write is a mutation, and the key that reaches it has full write access.
    "linear-mutation-writer.ts": (
        "// Comments on a Linear issue.\n"
        "await fetch('https://api.linear.app/graphql',\n"
        "  { method: 'POST', body: JSON.stringify({ query: 'mutation { commentCreate }' }) });\n"
    ),
    # Reading a colleague's presence is what the person card shows: ordinary recon.
    "presence-reader.ts": (
        "// Reads presence for a few people.\n"
        "await fetch('https://presence.teams.microsoft.com/v1/presence/getpresence/',\n"
        "  { method: 'POST', body: JSON.stringify([{ mri: '8:orgid:x' }]) });\n"
    ),
    # Reading every member's position is how "seen by" works: ordinary recon.
    "horizon-reader.ts": (
        "// GETs the read positions of a thread.\n"
        "await fetch(`${chat}/v1/threads/${id}/consumptionhorizons`);\n"
    ),
    "backend-reader.ts": (
        "// Reads the real backend, which is allowed.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19420');\n"
        "ws.send(JSON.stringify({ method: 'conversations' }));\n"
    ),
    # The app's server relays every WebSocket to the same backend (web/server.ts),
    # so its port is a second address for the live account — same split applies.
    "relay-writer.ts": (
        "// Writes to the live backend through the app's own server.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19440');\n"
        "ws.send(JSON.stringify({ method: 'send' }));\n"
    ),
    # The user's hands-on dev pair (19421 / 19441) is just as send-capable as the
    # always-on service's, so it is guarded by the same rule.
    "dev-backend-writer.ts": (
        "// Writes to the DEV backend, which is also the real account.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19421');\n"
        "ws.send(JSON.stringify({ method: 'react' }));\n"
    ),
    "dev-relay-writer.ts": (
        "// Writes through the DEV web server's relay.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19441');\n"
        "ws.send(JSON.stringify({ method: 'edit' }));\n"
    ),
    # The RELEASED build's pair (19422 / 19442, teams-lite-app.service), which runs beside
    # the staged one on the same account and the same store. A third send-capable backend
    # is a third way to post as the user, so the same rule covers it.
    "released-backend-writer.ts": (
        "// Writes to the RELEASED build's backend, which is also the real account.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19422');\n"
        "ws.send(JSON.stringify({ method: 'send' }));\n"
    ),
    "released-relay-writer.ts": (
        "// Writes through the RELEASED build's own web server.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19442');\n"
        "ws.send(JSON.stringify({ method: 'delete' }));\n"
    ),
    # The container image's pair (19423 / 19443, packaging/docker). It runs in the host's
    # network namespace, so a script on this machine reaches it on loopback like the others.
    "image-backend-writer.ts": (
        "// Writes to the container image's backend, which is also the real account.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19423');\n"
        "ws.send(JSON.stringify({ method: 'send' }));\n"
    ),
    "image-relay-writer.ts": (
        "// Writes through the container image's own web server.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19443');\n"
        "ws.send(JSON.stringify({ method: 'react' }));\n"
    ),
    "released-backend-reader.ts": (
        "// Reads the RELEASED build's backend, which is allowed.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19422');\n"
        "ws.send(JSON.stringify({ method: 'conversations' }));\n"
    ),
    "dev-backend-reader.ts": (
        "// Reads the DEV backend, which is allowed.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19421');\n"
        "ws.send(JSON.stringify({ method: 'conversations' }));\n"
    ),
    "relay-reader.ts": (
        "// Reads through the app's own server, which is allowed.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19440');\n"
        "ws.send(JSON.stringify({ method: 'conversations' }));\n"
    ),
    # Push: subscribing decides which of the user's devices the machine notifies, so
    # it is a write to the live backend like send/edit/react (a MACHINE_METHODS entry
    # in src/bin/server.rs).
    "push-subscriber.ts": (
        "// Registers a device for push on the real backend.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19420');\n"
        "ws.send(JSON.stringify({ method: 'push_subscribe' }));\n"
    ),
    "push-tester.ts": (
        "// Buzzes the user's phone from the real backend.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19440');\n"
        "ws.send(JSON.stringify({ method: 'push_test' }));\n"
    ),
    "push-status-reader.ts": (
        "// Reads which devices are subscribed, which is allowed.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19420');\n"
        "ws.send(JSON.stringify({ method: 'push_status' }));\n"
    ),
    # Settings: writing them stores the integration credentials and can move the
    # GitLab host the stored token is pinned to, so it is a write to the live backend
    # like the push methods (a MACHINE_METHODS entry in src/bin/server.rs).
    # A SEALED chat: turning sealing off makes the next message go out in the CLEAR to a chat
    # whose reader believes it is sealed, and setting a passphrase makes every message the user
    # posts unreadable to the colleagues they are writing to. Revealing one answers with a secret.
    "seal-off-writer.ts": (
        "// Stops a chat being sealed on the real backend.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19420');\n"
        "ws.send(JSON.stringify({ method: 'seal_off', params: { conversation: '19:x@thread.v2' } }));\n"
    ),
    "seal-set-writer.ts": (
        "// Sets a chat's passphrase on the real backend.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19420');\n"
        "ws.send(JSON.stringify({ method: 'seal_set', params: { conversation: '19:x@thread.v2' } }));\n"
    ),
    "seal-reveal-writer.ts": (
        "// Reads a passphrase out of the real backend.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19420');\n"
        "ws.send(JSON.stringify({ method: 'seal_reveal', params: { conversation: '19:x@thread.v2' } }));\n"
    ),
    # Which chats are sealed is a READ: it names no key and changes nothing.
    "seal-status-reader.ts": (
        "// Asks which conversations are sealed, which is allowed.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19420');\n"
        "ws.send(JSON.stringify({ method: 'seal_status' }));\n"
    ),
    "settings-writer.ts": (
        "// Stores an integration token on the real backend.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19420');\n"
        "ws.send(JSON.stringify({ method: 'set_settings' }));\n"
    ),
    "settings-reader.ts": (
        "// Reads which integrations are configured, which is allowed.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19420');\n"
        "ws.send(JSON.stringify({ method: 'get_settings' }));\n"
    ),
    # The local agent: arming it decides where this machine answers AS the user, and
    # what a chat message may make it run (MACHINE_METHODS in src/bin/server.rs).
    "agent-armer.ts": (
        "// Arms the local agent on a real conversation.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19420');\n"
        "ws.send(JSON.stringify({ method: 'agent_set_mode' }));\n"
    ),
    "agent-tooler.ts": (
        "// Widens what a Teams message may make an agent run.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19440');\n"
        "ws.send(JSON.stringify({ method: 'agent_set_tools' }));\n"
    ),
    "agent-provider-setter.ts": (
        "// Chooses which coding agent and model a Teams message starts.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19421');\n"
        "ws.send(JSON.stringify({ method: 'agent_set_provider' }));\n"
    ),
    "agent-unrestrictor.ts": (
        "// Hands a Teams-triggered agent the user's own Claude Code config.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19421');\n"
        "ws.send(JSON.stringify({ method: 'agent_set_unrestricted', params: { unrestricted: true } }));\n"
    ),
    "agent-status-reader.ts": (
        "// Reads which conversations are armed, which is allowed.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19420');\n"
        "ws.send(JSON.stringify({ method: 'agent_status' }));\n"
    ),
    # Audio calling: a call rings a person, opens the user's own microphone, or
    # registers this machine as a device their calls ring on (OUTWARD_METHODS and
    # MACHINE_METHODS in src/bin/server.rs).
    "call-placer.ts": (
        "// Rings a real colleague from a script.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19420');\n"
        "ws.send(JSON.stringify({ method: 'call_place', params: { sdp: 'v=0' } }));\n"
    ),
    "meeting-joiner.ts": (
        "// Walks the user into a real meeting, where everybody present sees them.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19440');\n"
        "ws.send(JSON.stringify({ method: 'call_join', params: { sdp: 'v=0' } }));\n"
    ),
    "call-answerer.ts": (
        "// Opens the user's microphone to whoever is calling, through the app's relay.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19441');\n"
        "ws.send(JSON.stringify({ method: 'call_accept', params: { sdp: 'v=0' } }));\n"
    ),
    "call-registrar.ts": (
        "// Registers this machine with Teams as a device the user's calls ring on.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19421');\n"
        "ws.send(JSON.stringify({ method: 'set_calling', params: { enabled: true } }));\n"
    ),
    "call-preparer.ts": (
        "// Reserves the one call slot and asks for the relay credentials.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19420');\n"
        "ws.send(JSON.stringify({ method: 'call_prepare' }));\n"
    ),
    "call-status-reader.ts": (
        "// Reads whether this machine takes calls, which is allowed.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19420');\n"
        "ws.send(JSON.stringify({ method: 'call_status' }));\n"
    ),
    # Person overrides: writing one decides the name and the face this app puts on a
    # colleague's messages — a script that could set them could make one person's post
    # appear to come from another (MACHINE_METHODS in src/bin/server.rs).
    "person-renamer.ts": (
        "// Renames a real colleague in the user's own app.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19420');\n"
        "ws.send(JSON.stringify({ method: 'set_person_name' }));\n"
    ),
    "person-refacer.ts": (
        "// Replaces a real colleague's face, through the app's own relay.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19441');\n"
        "ws.send(JSON.stringify({ method: 'set_person_avatar' }));\n"
    ),
    # The in-app update: which build the user runs is theirs to choose, and applying one
    # replaces the binary their whole account runs through and restarts it — which would
    # also cut a live `@claude` reply in half (MACHINE_METHODS in src/bin/server.rs).
    "self-updater.ts": (
        "// Replaces the user's own teams binary and restarts their app.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19420');\n"
        "ws.send(JSON.stringify({ method: 'update_apply' }));\n"
    ),
    # Restarting the backend: the process the user's own pages talk to, and a local agent's
    # half-written reply with it (MACHINE_METHODS in src/bin/server.rs).
    "backend-restarter.ts": (
        "// Restarts the backend the user's own app is talking to.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19420');\n"
        "ws.send(JSON.stringify({ method: 'restart_backend' }));\n"
    ),
    # The CHESS ENGINE: fetching it spends the user's bandwidth on 7.3 MB and writes it to their
    # disk (MACHINE_METHODS in src/bin/server.rs). It posts to nobody, which makes it the weakest
    # entry in the list — and a side effect nobody asked for is still one.
    "engine-fetcher.ts": (
        "// Downloads the chess engine onto the user's machine.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19420');\n"
        "ws.send(JSON.stringify({ method: 'chess_engine_download' }));\n"
    ),
    # Asking whether the engine is THERE changes nothing and names no path: a read, and allowed.
    "engine-reader.ts": (
        "// Asks whether the engine is on this machine, which is allowed.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19420');\n"
        "ws.send(JSON.stringify({ method: 'chess_engine_status' }));\n"
    ),
    # The board's own SOUNDS, on the same terms: DELETING what the user's machine fetched is a side
    # effect nobody asked for (MACHINE_METHODS in src/bin/server.rs).
    "board-sound-remover.ts": (
        "// Deletes the chess board's sounds from the user's machine.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19420');\n"
        "ws.send(JSON.stringify({ method: 'chess_sound_forget' }));\n"
    ),
    # Their STATUS is an open read — and it is what fetches them, which is 64 KB a board asks for by
    # being opened. Blocking it would block reading whether a board can sound right at all.
    "board-sound-reader.ts": (
        "// Asks where the board's sounds stand, which is allowed.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19420');\n"
        "ws.send(JSON.stringify({ method: 'chess_sound_status' }));\n"
    ),
    # Asking whether a newer build exists changes nothing on the machine and is the same
    # request the backend already makes every two minutes: a read, and allowed.
    "update-checker.ts": (
        "// Asks the backend whether a release is newer, which is allowed.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19420');\n"
        "ws.send(JSON.stringify({ method: 'update_check' }));\n"
    ),
    "person-override-reader.ts": (
        "// Reads back what the user themselves chose, which is allowed.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19420');\n"
        "ws.send(JSON.stringify({ method: 'person_overrides' }));\n"
    ),
    # Custom emoji: writing the pack decides the art this app can post under the user's
    # name, so a script that could plant it could post a picture nobody asked for.
    "emoji-adder.ts": (
        "// Adds an emoji to the pack through the live backend.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19420');\n"
        "ws.send(JSON.stringify({ method: 'custom_emoji_add' }));\n"
    ),
    "emoji-importer.ts": (
        "// Imports an emoji pack through the app's relay.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19440');\n"
        "ws.send(JSON.stringify({ method: 'custom_emoji_import' }));\n"
    ),
    "emoji-reader.ts": (
        "// Reads back the user's own pack, which is allowed.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19430');\n"
        "ws.send(JSON.stringify({ method: 'custom_emoji' }));\n"
    ),
    # Serving the broker's sign-in window: one call authenticates as the user, one answers
    # with a picture of a sign-in page, one presses keys into it. A script must reach none of
    # them on a live backend — that is a password being watched, or typed.
    "signin-starter.ts": (
        "// Starts an interactive sign-in through the live backend.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19420');\n"
        "ws.send(JSON.stringify({ method: 'signin_start' }));\n"
    ),
    "signin-watcher.ts": (
        "// Asks the live app for a frame of the sign-in page.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19440');\n"
        "ws.send(JSON.stringify({ method: 'signin_frame' }));\n"
    ),
    "signin-typist.ts": (
        "// Presses a key into whatever sign-in page is open.\n"
        "const ws = new WebSocket('wss://box.taild26c06.ts.net');\n"
        "ws.send(JSON.stringify({ method: 'signin_input', char: 'a' }));\n"
    ),
    "signin-asker.ts": (
        "// Only asks how a sign-in is going, which publishes nothing.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19420');\n"
        "ws.send(JSON.stringify({ method: 'signin_status' }));\n"
    ),
    # Custom agents: a row decides what a later `@bebou` does in an opted-in thread — which
    # CLI starts, which model reads it, what instruction leads the prompt — so a script that
    # could write one could put words in the mouth of a program that answers as the user.
    "persona-writer.ts": (
        "// Writes one of the user's own custom agents through the live backend.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19420');\n"
        "ws.send(JSON.stringify({ method: 'agent_persona_save' }));\n"
    ),
    "persona-remover.ts": (
        "// Removes a custom agent through the app's relay.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19440');\n"
        "ws.send(JSON.stringify({ method: 'agent_persona_remove' }));\n"
    ),
    "persona-reader.ts": (
        "// Reads back the agents the user themselves made, which is allowed.\n"
        "const ws = new WebSocket('ws://127.0.0.1:19430');\n"
        "ws.send(JSON.stringify({ method: 'agent_status' }));\n"
    ),
    "token-thief.ts": (
        "// Fetches the write capability from the app's own server.\n"
        "const res = await fetch('http://127.0.0.1:19440/__write-token');\n"
    ),
}

# Cargo examples, written into the repo's own examples/ directory by the test (an
# example only exists there, and the hook resolves `--example NAME` to that path).
EXAMPLE_FIXTURES = {
    # Reading the broker's sign-in window is measurement — that is what
    # examples/signin_window_recon.rs is for — while typing into it or closing it is the act the
    # four signin_* RPCs are gated for, and an example reaches the window with no port, no RPC
    # and no write token in the way. Those two really were flags on the recon example once.
    "guard-test-signin-read.rs": (
        "// Reports the display, the window and one frame's size. Read-only.\n"
        "use teams_lite::xwindow::SigninWindow;\n"
        "fn main() { let w = SigninWindow::find(\":77\").unwrap().unwrap(); w.capture().unwrap(); }\n"
    ),
    "guard-test-signin-type.rs": (
        "// Types into whatever sign-in window is open, past every gate.\n"
        "use teams_lite::xwindow::{Key, SigninWindow};\n"
        "fn main() { let w = SigninWindow::find(\":77\").unwrap().unwrap();\n"
        "  w.focus().unwrap(); w.type_key(&Key::Char('a')).unwrap(); }\n"
    ),
    "guard-test-signin-close.rs": (
        "// Closes a sign-in the user may be halfway through.\n"
        "use teams_lite::xwindow::SigninWindow;\n"
        "fn main() { SigninWindow::find(\":77\").unwrap().unwrap().close().unwrap(); }\n"
    ),
    # A send whose target comes from an argument: the shape that must never run.
    "guard-test-loose-send.rs": (
        "// A probe that posts wherever it is told.\n"
        "fn main() {\n"
        "    let conversation = std::env::args().nth(1).unwrap();\n"
        "    teams_send::send_message(&http, &session, &ic3, &conversation, \"hi\");\n"
        "}\n"
    ),
    # A send pinned to a colleague's 1:1 chat.
    "guard-test-real-send.rs": (
        "const CHAT: &str = \"8:orgid:2367c029-149d-4ebd-a96c-1fe12bfc24cf\";\n"
        "fn main() { teams_send::send_message(&http, &session, &ic3, CHAT, \"hi\"); }\n"
    ),
    # The legitimate shape: pinned to the sandbox channel and nothing else.
    "guard-test-sandbox-send.rs": (
        "const SANDBOX: &str = \"19:21d2695ae8ff4e25ace9c662e5c326cb@thread.v2\";\n"
        "fn main() { teams_send::send_message(&http, &session, &ic3, SANDBOX, \"hi\"); }\n"
    ),
    # A deletion whose target comes from an argument: outward, irreversible, and
    # refused by the same rule as a loose send.
    "guard-test-loose-delete.rs": (
        "// A probe that deletes wherever it is told.\n"
        "fn main() {\n"
        "    let conversation = std::env::args().nth(1).unwrap();\n"
        "    teams_send::delete_message(&http, &session, &conversation, \"1\");\n"
        "}\n"
    ),
    # A read-state write, pinned to nothing: outward all the same, since the sender
    # is shown a receipt. Refused by the same rule as a send.
    "guard-test-horizon-write.rs": (
        "fn main() {\n"
        "    let conversation = std::env::args().nth(1).unwrap();\n"
        "    teams_readstate::set_consumption_horizon(&http, &session, &conversation, \"1\", 2);\n"
        "}\n"
    ),
    # A presence publish: it turns the user's status green for every colleague, and it
    # has no target to pin — the account IS the target — so no shape of it is allowed.
    "guard-test-presence-publish.rs": (
        "fn main() {\n"
        "    teams_presence::register_available_endpoint(&http, &session, &token, &epid);\n"
        "}\n"
    ),
    # The manual status, which the service will not even let us undo.
    "guard-test-force-availability.rs": (
        "fn main() {\n"
        "    http.put(\"https://presence.teams.microsoft.com/v1/me/forceavailability/\");\n"
        "}\n"
    ),
    # A chat-settings write whose target comes from an argument: it pins, mutes or hides
    # a chat in every Teams client the user owns, so it is refused like a loose send.
    "guard-test-chat-setting-write.rs": (
        "fn main() {\n"
        "    let conversation = std::env::args().nth(1).unwrap();\n"
        "    teams_chat_settings::set_chat_muted(&http, &session, &conversation, true);\n"
        "}\n"
    ),
    # The legitimate shape: the same write, pinned to the sandbox chat and nothing else.
    "guard-test-sandbox-chat-setting.rs": (
        "const SANDBOX: &str = \"19:21d2695ae8ff4e25ace9c662e5c326cb@thread.v2\";\n"
        "fn main() {\n"
        "    teams_chat_settings::set_chat_muted(&http, &session, SANDBOX, true);\n"
        "}\n"
    ),
    # Reading the same properties is the GET the sidebar is built on.
    "guard-test-chat-setting-read.rs": (
        "fn main() {\n"
        "    http.get(\"https://fr.ng.msg.teams.microsoft.com/v1/users/ME/conversations\");\n"
        "}\n"
    ),
    # Reading a colleague's presence is what the person card is built on.
    "guard-test-presence-read.rs": (
        "fn main() { teams_presence::fetch_presence(&http, &session, &token, &mris); }\n"
    ),
    # An approval, straight to GitLab. It cannot be pinned to a sandbox the way a send
    # can — there is no sandbox project — so no shape of it is allowed from here.
    "guard-test-mr-approve.rs": (
        "fn main() {\n"
        "    let mr = std::env::args().nth(1).unwrap();\n"
        "    http.post(format!(\"{api}/projects/x%2Fy/merge_requests/{mr}/approve\"));\n"
        "}\n"
    ),
    # The same through this crate's own write function, which is equally a write.
    "guard-test-mr-approve-crate.rs": (
        "fn main() { gitlab_approval::set(&http, &host, token, &url, true); }\n"
    ),
    # Reading a merge request — approvals included — is what the preview cards are for.
    "guard-test-mr-read.rs": (
        "fn main() {\n"
        "    http.get(format!(\"{api}/projects/x%2Fy/merge_requests/42/approvals\"));\n"
        "}\n"
    ),
    # An example that only READS needs no target at all.
    "guard-test-read-only.rs": (
        "fn main() { teams_read::history(&http, &session, \"19:whatever@thread.v2\"); }\n"
    ),
    # The Intune container, through the crate teams-lite now links: its whole lifecycle is a
    # function call from any example, with no `intune-container` on the command line for rule
    # 3b to see. One fixture per way Rust reaches a function — the full path, the module
    # imported and called through, and a grouped import of the function itself.
    "guard-test-crate-stop.rs": (
        "// Takes the user's sign-in down through the crate.\n"
        "fn main() { intune_container::ops::stop().unwrap(); }\n"
    ),
    "guard-test-crate-restart.rs": (
        "// The repair's own restart, run by hand.\n"
        "use intune_container::{backend, config::Config};\n"
        "fn main() {\n"
        "    let mut config = Config::load().unwrap();\n"
        "    backend::stop(&config).unwrap();\n"
        "    backend::start(&mut config, &headless(), false).unwrap();\n"
        "}\n"
    ),
    "guard-test-crate-grouped-import.rs": (
        "use intune_container::ops::{start, status};\n"
        "fn main() { println!(\"{:?}\", status()); start().unwrap(); }\n"
    ),
    "guard-test-crate-poweroff.rs": (
        "// Powers the container's init off, past the crate's own lock.\n"
        "fn main() {\n"
        "    let state = intune_container::runtime::load_runtime_state().unwrap().unwrap();\n"
        "    intune_container::runtime::poweroff_pid(state.leader);\n"
        "}\n"
    ),
    "guard-test-crate-rootfs.rs": (
        "// Re-pulls the container's rootfs, which needs it stopped.\n"
        "use intune_container::backend;\n"
        "fn main() { backend::update_rootfs(&mut config, true).unwrap(); }\n"
    ),
    # teams-lite's own half: the repair's transient unit, and the dispatcher that runs whichever
    # hidden subcommand it is handed — the repair among them — in the calling process.
    "guard-test-repair-unit.rs": (
        "// Asks systemd for the broker repair, past the app's button and its floor.\n"
        "#[tokio::main]\n"
        "async fn main() { teams_lite::intune::start_repair_unit().await.unwrap(); }\n"
    ),
    "guard-test-reexec.rs": (
        "use teams_lite::intune;\n"
        "fn main() {\n"
        "    let argv = [\"server\".into(), \"x\".into()];\n"
        "    std::process::exit(intune::dispatch_reexec(argv).unwrap_or(0));\n"
        "}\n"
    ),
    # …and the same act through a binary: the hidden argument handed to Command::new.
    "guard-test-reexec-spawn.rs": (
        "fn main() {\n"
        "    std::process::Command::new(\"target/release/server\")\n"
        "        .arg(\"__rootless-supervise\").status().unwrap();\n"
        "}\n"
    ),
    # Running a program INSIDE the container is the library twin of `__rootless-exec`: as root, a
    # poweroff is one argv away. And `autostart::disable` stops the container's own unit, which
    # is `intune-container autostart disable` called as a function — in both of the other ways
    # Rust reaches a function as well.
    "guard-test-crate-exec.rs": (
        "// Powers the container off from inside it, as root.\n"
        "fn main() {\n"
        "    let state = intune_container::runtime::load_runtime_state().unwrap().unwrap();\n"
        "    intune_container::runtime::exec_pid(state.leader, &[\"/bin/systemctl\", \"poweroff\"], None).unwrap();\n"
        "}\n"
    ),
    "guard-test-crate-exec-imported.rs": (
        "use intune_container::{backend, config::Config, display::DisplayInfo};\n"
        "fn main() {\n"
        "    let config = Config::load().unwrap();\n"
        "    backend::exec_foreground(&config, \"systemctl poweroff\", None, &DisplayInfo::detect()).unwrap();\n"
        "}\n"
    ),
    "guard-test-crate-autostart.rs": (
        "// Stops and removes the container's unit.\n"
        "fn main() { intune_container::autostart::disable().unwrap(); }\n"
    ),
    "guard-test-crate-autostart-grouped.rs": (
        "use intune_container::autostart::{disable, status};\n"
        "fn main() { status().unwrap(); disable().unwrap(); }\n"
    ),
    # The pinned commit's own additions: the portal opened INSIDE the running container (the
    # enrollment), the archive halves `backup|restore` stop it around, and the state file every
    # backend finds the broker through, cleared under a live container.
    "guard-test-crate-portal-headless.rs": (
        "fn main() { intune_container::ops::portal_open_headless().unwrap(); }\n"
    ),
    "guard-test-crate-restore-rootless.rs": (
        "use intune_container::backup;\n"
        "fn main() { backup::restore_rootless(Some(std::path::Path::new(\"/tmp/b.tar.gz\"))).unwrap(); }\n"
    ),
    "guard-test-crate-clear-state.rs": (
        "fn main() { intune_container::runtime::clear_runtime_state().unwrap(); }\n"
    ),
    # teams-lite's embedded half: the helper spawned (a boot is a 1.7 GB pull on a fresh volume),
    # a helper's own body called in-process, a grouped import of one, the mode-aware repair entry
    # point, and the hidden arguments handed to a binary, as a constant and as a literal.
    "guard-test-embedded-spawn.rs": (
        "use teams_lite::intune_embedded::{self, Helper};\n"
        "fn main() { intune_embedded::spawn_helper(Helper::Boot).unwrap(); }\n"
    ),
    "guard-test-embedded-main.rs": (
        "fn main() { std::process::exit(teams_lite::intune_embedded::stop_main()); }\n"
    ),
    "guard-test-embedded-grouped.rs": (
        "use teams_lite::intune_embedded::{portal_main, Helper};\n"
        "fn main() { let _ = Helper::Portal; std::process::exit(portal_main()); }\n"
    ),
    "guard-test-embedded-repair.rs": (
        "#[tokio::main]\n"
        "async fn main() { teams_lite::intune::start_repair().await.unwrap(); }\n"
    ),
    "guard-test-embedded-boot-binary.rs": (
        "use teams_lite::intune_embedded::BOOT_SUBCOMMAND;\n"
        "fn main() { std::process::Command::new(\"/usr/local/lib/teams-lite/server\").arg(BOOT_SUBCOMMAND).status().unwrap(); }\n"
    ),
    "guard-test-embedded-portal-literal.rs": (
        "fn main() { std::process::Command::new(\"server\").arg(\"__teams-lite-intune-portal\").status().unwrap(); }\n"
    ),
    # …while READING the embedded state is what the diagnostic prints: the mode, which helper
    # holds the slot, the status the greeting carries, whether the device is registered, whether
    # the portal is up, and the PURE liveness of the runtime state.
    "guard-test-embedded-read.rs": (
        "use intune_container::{backup, ops, runtime};\n"
        "use teams_lite::intune_embedded::{self, Helper};\n"
        "fn main() {\n"
        "    println!(\"{:?} {:?}\", intune_embedded::mode(), intune_embedded::helper_running());\n"
        "    println!(\"{:?}\", intune_embedded::status(false));\n"
        "    println!(\"{} {}\", backup::has_device_registration(), ops::portal_is_running());\n"
        "    let live = runtime::load_runtime_state().unwrap().map(|s| runtime::state_is_live(&s));\n"
        "    println!(\"{live:?} {:?}\", Helper::Boot.subcommand());\n"
        "}\n"
    ),
    # …while asking whether the unit is installed only reads.
    "guard-test-crate-autostart-status.rs": (
        "fn main() { intune_container::autostart::status().unwrap(); }\n"
    ),
    # READING the container is what the diagnostic is built on, and it names the crate too: the
    # runtime state, whether the leader is alive, the status report, whether it is set up, a
    # probe — and a type whose name merely STARTS with a lifecycle verb.
    "guard-test-crate-read.rs": (
        "use intune_container::{backend, ops, runtime};\n"
        "fn main() {\n"
        "    let state = runtime::load_runtime_state().unwrap();\n"
        "    let alive = state.map(|s| runtime::is_running(s.leader));\n"
        "    let _report: Option<intune_container::ops::StartReport> = None;\n"
        "    println!(\"{alive:?} {:?} {}\", ops::status(), ops::is_initialized());\n"
        "    println!(\"{}\", backend::probe(&Default::default(), \"true\"));\n"
        "}\n"
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
        # The dev pair reaches the same account as the service's.
        ("BLOCK", PROJECT, f"bun run {tmp}/dev-backend-writer.ts"),
        ("BLOCK", PROJECT, f"bun run {tmp}/dev-relay-writer.ts"),
        # Push: aiming the user's message previews at a device, or buzzing their
        # phone, is a write — through either address.
        ("BLOCK", PROJECT, f"bun run {tmp}/push-subscriber.ts"),
        ("BLOCK", PROJECT, f"bun run {tmp}/push-tester.ts"),
        ("BLOCK", PROJECT, f"bun run {tmp}/settings-writer.ts"),
        # A sealed chat: every write to it is blocked against a live port.
        ("BLOCK", PROJECT, f"bun run {tmp}/seal-off-writer.ts"),
        ("BLOCK", PROJECT, f"bun run {tmp}/seal-set-writer.ts"),
        ("BLOCK", PROJECT, f"bun run {tmp}/seal-reveal-writer.ts"),
        # The local agent: arming it, or widening what it may run, is a write.
        ("BLOCK", PROJECT, f"bun run {tmp}/agent-armer.ts"),
        ("BLOCK", PROJECT, f"bun run {tmp}/agent-tooler.ts"),
        ("BLOCK", PROJECT, f"bun run {tmp}/agent-provider-setter.ts"),
        ("BLOCK", PROJECT, f"bun run {tmp}/agent-unrestrictor.ts"),
        # Renaming or re-facing a colleague writes only to the local store, but what it
        # writes is who this app says a message is from.
        ("BLOCK", PROJECT, f"bun run {tmp}/person-renamer.ts"),
        ("BLOCK", PROJECT, f"bun run {tmp}/person-refacer.ts"),
        # Writing the emoji pack decides the art this app can post, so a script that could
        # plant it could post a picture under the user's name on the next send.
        ("BLOCK", PROJECT, f"bun run {tmp}/emoji-adder.ts"),
        ("BLOCK", PROJECT, "cargo run --example guard-test-signin-type"),
        ("BLOCK", PROJECT, "cargo run --example guard-test-signin-close"),
        ("BLOCK", PROJECT, f"bun run {tmp}/signin-starter.ts"),
        ("BLOCK", PROJECT, f"bun run {tmp}/signin-watcher.ts"),
        ("BLOCK", PROJECT, f"bun run {tmp}/signin-typist.ts"),
        ("BLOCK", PROJECT, f"bun run {tmp}/persona-writer.ts"),
        ("BLOCK", PROJECT, f"bun run {tmp}/persona-remover.ts"),
        ("BLOCK", PROJECT, f"bun run {tmp}/emoji-importer.ts"),
        ("BLOCK", PROJECT, f"bun run {tmp}/self-updater.ts"),
        ("BLOCK", PROJECT, f"bun run {tmp}/backend-restarter.ts"),
        # Fetching the chess engine spends the user's bandwidth and writes to their disk.
        ("BLOCK", PROJECT, f"bun run {tmp}/engine-fetcher.ts"),
        ("BLOCK", PROJECT, f"bun run {tmp}/board-sound-remover.ts"),
        ("BLOCK", PROJECT, f"bun run {tmp}/released-backend-writer.ts"),
        ("BLOCK", PROJECT, f"bun run {tmp}/released-relay-writer.ts"),
        ("ALLOW", PROJECT, f"bun run {tmp}/released-backend-reader.ts"),
        # A call rings a real person; registering decides whether their calls ring here.
        ("BLOCK", PROJECT, f"bun run {tmp}/call-placer.ts"),
        ("BLOCK", PROJECT, f"bun run {tmp}/call-answerer.ts"),
        ("BLOCK", PROJECT, f"bun run {tmp}/meeting-joiner.ts"),
        ("BLOCK", PROJECT, f"bun run {tmp}/call-registrar.ts"),
        ("BLOCK", PROJECT, f"bun run {tmp}/call-preparer.ts"),
        # A cargo example reaches Teams with a broker token, past every port rule.
        ("BLOCK", PROJECT, "cargo run --example guard-test-loose-send"),
        ("BLOCK", PROJECT, "cargo run --example guard-test-real-send"),
        # …including one that only moves the READ position: the sender is still shown
        # a receipt saying the user read their message.
        ("BLOCK", PROJECT, "cargo run --example guard-test-horizon-write"),
        # A deletion removes a real message for everybody, and nothing brings it back —
        # through the backend, or straight from a cargo example.
        ("BLOCK", PROJECT, f"bun run {tmp}/delete-writer.ts"),
        ("BLOCK", PROJECT, "cargo run --example guard-test-loose-delete"),
        # Marking a thread read tells the sender the user read their message.
        ("BLOCK", PROJECT, f"bun run {tmp}/mark-read-writer.ts"),
        # Marking MAIL read tells nobody — but nothing here can raise the marker again.
        ("BLOCK", PROJECT, f"bun run {tmp}/mail-mark-read-writer.ts"),
        # …and going straight to Teams bypasses every gate the RPC has.
        ("BLOCK", PROJECT, f"bun run {tmp}/horizon-writer.ts"),
        (
            "BLOCK",
            PROJECT,
            "curl -X PUT 'https://fr.ng.msg.teams.microsoft.com/v1/users/ME/"
            "conversations/19:x/properties?name=consumptionhorizon'",
        ),
        # A chat setting reaches every device the user owns: the pin re-orders their
        # sidebar, the mute silences a thread, the hide takes it out of the list. Every
        # shape is refused — the gated RPC, the property itself, a loose example, a curl.
        ("BLOCK", PROJECT, f"bun run {tmp}/chat-pin-writer.ts"),
        ("BLOCK", PROJECT, f"bun run {tmp}/chat-setting-writer.ts"),
        ("BLOCK", PROJECT, "cargo run --example guard-test-chat-setting-write"),
        (
            "BLOCK",
            PROJECT,
            "curl -X PUT 'https://fr.ng.msg.teams.microsoft.com/v1/users/ME/"
            "conversations/19:x/properties?name=ispinned'",
        ),
        # Publishing our own presence turns the green dot on for every colleague, in
        # every shape: the gated RPC, the service itself, a cargo example, a curl.
        ("BLOCK", PROJECT, f"bun run {tmp}/always-available-writer.ts"),
        ("BLOCK", PROJECT, f"bun run {tmp}/presence-publisher.ts"),
        ("BLOCK", PROJECT, "cargo run --example guard-test-presence-publish"),
        ("BLOCK", PROJECT, "cargo run --example guard-test-force-availability"),
        (
            "BLOCK",
            PROJECT,
            "curl -X PUT 'https://presence.teams.microsoft.com/v1/me/endpoints/'",
        ),
        # Approving a merge request is the ONE write this app makes to a tracker, and it
        # is the user's own click: every shape of it from tooling is refused — the gated
        # RPC, GitLab's own endpoint, its undo, a cargo example, a curl. A Linear mutation
        # is refused with them, since nothing here may write that tracker at all.
        ("BLOCK", PROJECT, f"bun run {tmp}/mr-approval-rpc-writer.ts"),
        ("BLOCK", PROJECT, f"bun run {tmp}/mr-approve-writer.ts"),
        ("BLOCK", PROJECT, f"bun run {tmp}/mr-unapprove-writer.ts"),
        ("BLOCK", PROJECT, f"bun run {tmp}/linear-mutation-writer.ts"),
        ("BLOCK", PROJECT, "cargo run --example guard-test-mr-approve"),
        ("BLOCK", PROJECT, "cargo run --example guard-test-mr-approve-crate"),
        (
            "BLOCK",
            PROJECT,
            "curl -X POST 'https://gitlab.com/api/v4/projects/x%2Fy/"
            "merge_requests/42/approve'",
        ),
        # The merge-request PAGE's six writes, in every shape: the gated RPCs, GitLab's own
        # endpoints, and a curl. The MERGE is the sharpest — it lands somebody's branch in a
        # shared repository and no later call takes it back — and there is no sandbox
        # project, so nothing but the user's own click in the app may make any of them.
        ("BLOCK", PROJECT, f"bun run {tmp}/mr-merge-writer.ts"),
        ("BLOCK", PROJECT, f"bun run {tmp}/mr-comment-writer.ts"),
        ("BLOCK", PROJECT, f"bun run {tmp}/mr-close-writer.ts"),
        ("BLOCK", PROJECT, f"bun run {tmp}/mr-edit-writer.ts"),
        ("BLOCK", PROJECT, f"bun run {tmp}/mr-resolve-writer.ts"),
        ("BLOCK", PROJECT, f"bun run {tmp}/mr-merge-rpc-writer.ts"),
        ("BLOCK", PROJECT, f"bun run {tmp}/mr-comment-rpc-writer.ts"),
        ("BLOCK", PROJECT, f"bun run {tmp}/mr-edit-rpc-writer.ts"),
        ("BLOCK", PROJECT, f"bun run {tmp}/mr-resolve-rpc-writer.ts"),
        (
            "BLOCK",
            PROJECT,
            "curl -X PUT 'https://gitlab.com/api/v4/projects/x%2Fy/merge_requests/42/merge'",
        ),
        (
            "BLOCK",
            PROJECT,
            "curl -X POST 'https://gitlab.com/api/v4/projects/x%2Fy/merge_requests/42/notes' "
            "-d 'body=looks good'",
        ),
        (
            "BLOCK",
            PROJECT,
            "curl -X PUT 'https://gitlab.com/api/v4/projects/x%2Fy/merge_requests/42' "
            "-d 'state_event=close'",
        ),
        (
            "BLOCK",
            PROJECT,
            "curl -X PUT 'https://gitlab.com/api/v4/projects/x%2Fy/merge_requests/42/notes/7' "
            "-d 'body=rewritten'",
        ),
        # A thread RESOLVED is the pair — the thread's own address and the field — in either
        # order, because a command line puts its body where it likes.
        (
            "BLOCK",
            PROJECT,
            "curl -X PUT 'https://gitlab.com/api/v4/projects/x%2Fy/merge_requests/42"
            "/discussions/ab12' -d 'resolved=true'",
        ),
        (
            "BLOCK",
            PROJECT,
            "curl -X PUT -d 'resolved=false' 'https://gitlab.com/api/v4/projects/x%2Fy"
            "/merge_requests/42/discussions/ab12'",
        ),
        # …and the same address with no field is the read it looks like.
        (
            "ALLOW",
            PROJECT,
            "curl -s 'https://gitlab.com/api/v4/projects/x%2Fy/merge_requests/42"
            "/discussions/ab12'",
        ),
        # But READING the page is ordinary work, all four reads of it — otherwise the
        # surface could not be screenshotted, and a guard that blocks that teaches its next
        # reader to phrase around it.
        ("ALLOW", PROJECT, f"bun run {tmp}/mr-page-reader.ts"),
        # Reading ONE thread included: what makes a resolution a write is the field beside the
        # address, never the address on its own.
        ("ALLOW", PROJECT, f"bun run {tmp}/mr-thread-reader.ts"),
        # And so is the recon that measures what GitLab stored on those threads, which is how
        # the diff-comment write was built at all.
        ("ALLOW", PROJECT, "cargo run --example merge_request_diff_note_recon"),
        (
            "ALLOW",
            PROJECT,
            "curl -s 'https://gitlab.com/api/v4/merge_requests?scope=all&state=opened'",
        ),
        (
            "ALLOW",
            PROJECT,
            "curl -s 'https://gitlab.com/api/v4/projects/x%2Fy/merge_requests/42/discussions'",
        ),
        # And so is searching the code that implements them.
        ("ALLOW", PROJECT, "grep -rn 'merge_requests/42/merge' src"),
        ("ALLOW", PROJECT, "grep -rn state_event src"),
        ("ALLOW", PROJECT, "cargo test --lib gitlab_mr_write"),
        # The write token is the capability itself — never ours to fetch.
        ("BLOCK", PROJECT, f"bun run {tmp}/token-thief.ts"),
        ("BLOCK", PROJECT, "curl -s http://127.0.0.1:19440/__write-token"),
        ("BLOCK", PROJECT, 'cat "$XDG_RUNTIME_DIR/teams-lite/write-token"'),
        # The always-on service: the spellings that START the send-capable backend.
        ("BLOCK", PROJECT, "systemctl --user start teams-lite-backend.service"),
        ("BLOCK", PROJECT, "systemctl --user restart teams-lite.target"),
        ("BLOCK", PROJECT, "systemctl --user enable --now teams-lite.target"),
        ("BLOCK", PROJECT, "systemctl --user stop teams-lite.target && systemctl --user start teams-lite.target"),
        ("BLOCK", PROJECT, "bin/teams-lite-service.sh start"),
        ("BLOCK", PROJECT, "bin/teams-lite-service.sh restart --web-only"),
        # `--now` skips the wait for a live @claude run, so the restart freezes the
        # reply it was writing in front of the whole thread. The user's switch, not ours.
        ("BLOCK", PROJECT, "bin/teams-lite-service.sh update --now"),
        ("BLOCK", PROJECT, "TEAMS_LITE_AGENT_WAIT=0 bin/teams-lite-service.sh update --now"),
        # The staged copy the service runs is a second path to the same binary.
        ("BLOCK", PROJECT, "$HOME/.local/share/teams-lite/service/server"),
        # And the released install's is a third: `teams` extracts the embedded backend
        # there before spawning it, so it is send-capable and needs no build at all —
        # which is exactly why an agent with nothing compiled reaches for it.
        ("BLOCK", PROJECT, "~/.cache/teams-lite/server"),
        ("BLOCK", PROJECT, "TEAMS_NO_IDLE_EXIT=1 nohup /home/claude/.cache/teams-lite/server &"),
        ("ALLOW", PROJECT, "TEAMS_LITE_READ_ONLY=1 $HOME/.cache/teams-lite/server"),
        # The backend's old ExecStart wrapper is retired from bin/, but a machine staged before
        # that keeps its copy beside the binary until the service script retires it — and
        # running that copy still starts the send-capable backend.
        ("BLOCK", PROJECT, "bash ~/.local/share/teams-lite/service/teams-lite-backend.sh"),
        ("BLOCK", PROJECT, "bash bin/teams-dev-server.sh"),
        # Handed to systemd-run, the backend is a transient unit of the user's manager — the
        # same send-capable process, outliving the shell — and read-only only when it says so.
        ("BLOCK", PROJECT, "systemd-run --user --scope target/release/server"),
        ("ALLOW", PROJECT, "systemd-run --user -E TEAMS_LITE_READ_ONLY=1 target/release/server"),
        # An environment assignment is a prefix, not a disguise: the path class holds
        # no `=`, so these spellings used to match nothing at all.
        ("BLOCK", PROJECT, "TEAMS_NO_IDLE_EXIT=1 target/release/server"),
        ("BLOCK", PROJECT, "TEAMS_LITE_PORT=19425 bin/teams-dev-server.sh"),
        ("BLOCK", PROJECT, "XDG_RUNTIME_DIR=/run/user/1000 systemctl --user start teams-lite.target"),
        ("BLOCK", PROJECT, "cd /tmp && $HOME/.local/share/teams-lite/service/teams-lite-backend.sh"),
        # `teams` is that same send-capable backend plus the real app on 19440, in one
        # word — the spellings that run it, and no read-only escape from it.
        ("BLOCK", PROJECT, "teams"),
        ("BLOCK", PROJECT, "teams --no-open"),
        ("BLOCK", PROJECT, "launcher/dist/teams --port 19450"),
        ("BLOCK", PROJECT, "./launcher/dist/teams"),
        ("BLOCK", PROJECT, "$HOME/.teams-lite/bin/teams --dev"),
        # `teams-bin` is the installed binary itself — `teams` beside it is only the
        # wrapper install.sh writes. It is the name `ps` and TEAMS_LITE_LAUNCHER_BIN
        # give, so it is the spelling an agent copies while diagnosing the live app.
        ("BLOCK", PROJECT, "~/.teams-lite/bin/teams-bin --no-open"),
        ("BLOCK", PROJECT, "nohup /home/claude/.teams-lite/bin/teams-bin --port 19440 &"),
        ("BLOCK", PROJECT, "bin/teams-launcher.sh"),
        ("BLOCK", PROJECT, "TEAMS_LITE_READ_ONLY=1 teams"),
        ("BLOCK", PROJECT, "cd launcher && bun run src/index.ts"),
        ("BLOCK", PROJECT, "bun run launcher/src/index.ts --no-open"),
        # The production web server relays to the LIVE backend by default.
        ("BLOCK", WEB, "bun run start"),
        # The retired INSTALLED repair unit restarts the Intune container, and a machine not
        # migrated yet still has it loaded: same rule, by unit name. So does the transient one
        # the backend asks for now, under a name of its own.
        ("BLOCK", PROJECT, "systemctl --user start teams-lite-broker-repair.service"),
        ("BLOCK", PROJECT, "systemctl --user start teams-lite-intune-repair.service"),
        # …and the container itself is not ours to cycle, in any spelling rule 3b knows.
        ("BLOCK", PROJECT, "intune-container stop"),
        ("BLOCK", PROJECT, "intune-container stop && intune-container start"),
        ("BLOCK", PROJECT, "$HOME/.local/bin/intune-container restart"),
        ("BLOCK", PROJECT, "intune-container -v start"),
        # Every verb of its CLI that stops, starts or rebuilds it: `update` swaps the rootfs
        # under a stopped container, `restore` writes enrollment state over one, `backup` stops
        # it for the archive, and a display attached or dropped is a restart.
        ("BLOCK", PROJECT, "intune-container update"),
        ("BLOCK", PROJECT, "intune-container update --force"),
        ("BLOCK", PROJECT, "intune-container restore"),
        ("BLOCK", PROJECT, "intune-container restore -i /tmp/enrollment-backup.tar.gz"),
        ("BLOCK", PROJECT, "intune-container backup"),
        ("BLOCK", PROJECT, "intune-container detach-display"),
        ("BLOCK", PROJECT, "intune-container login --web"),
        ("BLOCK", PROJECT, "intune-container autostart disable"),
        # Its systemd unit is the same restart spelled through systemd — and here STOP is
        # refused too, because stopping the container is taking the sign-in down.
        ("BLOCK", PROJECT, "systemctl --user restart intune-container.service"),
        ("BLOCK", PROJECT, "systemctl --user stop intune-container.service"),
        # The hidden arguments `server` routes before anything else: the repair RESTARTS the
        # container, and the crate's own two re-exec targets BOOT it and run a script inside it.
        # Refused whatever TEAMS_LITE_READ_ONLY says — none of the three is a backend it would
        # make read-only — through every program that routes them, and every prefix a shell takes.
        ("BLOCK", PROJECT, "target/release/server __teams-lite-repair-broker"),
        ("BLOCK", PROJECT, "TEAMS_LITE_READ_ONLY=1 target/release/server __teams-lite-repair-broker"),
        ("BLOCK", PROJECT, "env FOO=1 target/release/server __teams-lite-repair-broker"),
        ("BLOCK", PROJECT, "TEAMS_LITE_READ_ONLY=1 $HOME/.local/share/teams-lite/service/server __rootless-supervise"),
        ("BLOCK", PROJECT, "~/.cache/teams-lite/server __rootless-supervise --display"),
        ("BLOCK", PROJECT, "cd ~/.local/share/teams-lite/service && ./server __teams-lite-repair-broker"),
        ("BLOCK", PROJECT, 'nohup "$HOME/.local/share/teams-lite/service/server" __teams-lite-repair-broker &'),
        ("BLOCK", PROJECT, "TEAMS_LITE_READ_ONLY=1 ./server __rootless-exec 6415 0 'true' -- A=1"),
        ("BLOCK", PROJECT, "/proc/6410/exe __rootless-supervise"),
        ("BLOCK", PROJECT, "intune-container -v __rootless-supervise"),
        ("BLOCK", PROJECT, "cargo run --bin server -- __teams-lite-repair-broker"),
        ("BLOCK", PROJECT, "TEAMS_LITE_READ_ONLY=1 cargo run --release --bin server -- __rootless-supervise"),
        # The repair runs as a TRANSIENT unit of the user's manager, so asking for one is the
        # repair without the app: through systemd-run, or the very D-Bus call the backend makes.
        ("BLOCK", PROJECT, "systemd-run --user --wait target/release/server __teams-lite-repair-broker"),
        ("BLOCK", PROJECT, "TEAMS_LITE_READ_ONLY=1 systemd-run --user ~/.cache/teams-lite/server __rootless-supervise"),
        (
            "BLOCK",
            PROJECT,
            "busctl --user call org.freedesktop.systemd1 /org/freedesktop/systemd1 "
            "org.freedesktop.systemd1.Manager StartTransientUnit 'ssa(sv)a(sa(sv))' "
            "teams-lite-intune-repair.service fail 0 0",
        ),
        (
            "BLOCK",
            PROJECT,
            "gdbus call --session --dest org.freedesktop.systemd1 --object-path "
            "/org/freedesktop/systemd1 --method org.freedesktop.systemd1.Manager.StartTransientUnit x",
        ),
        (
            "BLOCK",
            PROJECT,
            "dbus-send --session --print-reply --dest=org.freedesktop.systemd1 "
            "/org/freedesktop/systemd1 org.freedesktop.systemd1.Manager.StartTransientUnit string:x",
        ),
        # Raw D-Bus is the other spelling of every systemctl verb these rules refuse: starting a
        # teams-lite unit (by its name, or by its escaped object path), and cycling the
        # container's own.
        (
            "BLOCK",
            PROJECT,
            "busctl --user call org.freedesktop.systemd1 /org/freedesktop/systemd1 "
            "org.freedesktop.systemd1.Manager StartUnit ss teams-lite-broker-repair.service replace",
        ),
        (
            "BLOCK",
            PROJECT,
            "busctl --user call org.freedesktop.systemd1 "
            "/org/freedesktop/systemd1/unit/teams_2dlite_2dbackend_2eservice "
            "org.freedesktop.systemd1.Unit Start s replace",
        ),
        (
            "BLOCK",
            PROJECT,
            "busctl --user call org.freedesktop.systemd1 /org/freedesktop/systemd1 "
            "org.freedesktop.systemd1.Manager StopUnit ss intune-container.service replace",
        ),
        # A cargo example reaches the whole lifecycle through the crate, in each of the three ways
        # Rust reaches a function that the scan follows, and the repair through teams-lite's own module.
        ("BLOCK", PROJECT, "cargo run --example guard-test-crate-stop"),
        ("BLOCK", PROJECT, "cargo run --example guard-test-crate-restart"),
        ("BLOCK", PROJECT, "cargo run --example guard-test-crate-grouped-import"),
        ("BLOCK", PROJECT, "cargo run --example guard-test-crate-poweroff"),
        ("BLOCK", PROJECT, "cargo run --example guard-test-crate-rootfs"),
        ("BLOCK", PROJECT, "cargo run --example guard-test-repair-unit"),
        ("BLOCK", PROJECT, "cargo run --example guard-test-reexec"),
        ("BLOCK", PROJECT, "cargo run --example guard-test-reexec-spawn"),
        # The two RETIRED check scripts read — until `--repair`, which a copy staged before
        # their retirement still honours: the keyring check starts the retired repair unit,
        # which restarts the container, and the bus check restarts the two send-capable
        # BACKENDS, so the socket drops under whoever is reading the app and a live @claude run
        # dies with the process. Their copies live beside the staged binary now.
        ("BLOCK", PROJECT, "$HOME/.local/share/teams-lite/service/teams-lite-broker-check.sh --repair"),
        ("BLOCK", PROJECT, "~/.local/share/teams-lite/service/teams-lite-broker-check.sh --locked --repair"),
        ("BLOCK", PROJECT, "$HOME/.local/share/teams-lite/service/teams-lite-broker-bus-check.sh --repair"),
        # The crate's in-container exec and its autostart switch, in each way Rust reaches them.
        ("BLOCK", PROJECT, "cargo run --example guard-test-crate-exec"),
        ("BLOCK", PROJECT, "cargo run --example guard-test-crate-exec-imported"),
        ("BLOCK", PROJECT, "cargo run --example guard-test-crate-autostart"),
        ("BLOCK", PROJECT, "cargo run --example guard-test-crate-autostart-grouped"),
        # A kill or a probe is cleanup, and only that COMMAND is: every one of these used to walk
        # past rules 2, 3 and 3c because a kill word appeared somewhere on the line. The first is
        # the ordinary "restart the backend" one-liner, and it started a send-capable backend.
        ("BLOCK", PROJECT, "pkill -f target/release/server; target/release/server"),
        ("BLOCK", PROJECT, "kill $(pgrep -f teams-lite) && systemd-run --user target/release/server"),
        ("BLOCK", PROJECT, "pkill -f teams-bin; ~/.teams-lite/bin/teams --no-open"),
        # …and the incident's own shape: a dev server RESTARTED without its variable.
        ("BLOCK", PROJECT, "pkill -f vite; cd web && bun run dev"),
        # `cargo run --bin server` stays matched anywhere, which is what catches a program this
        # file does not know starting the backend.
        ("BLOCK", PROJECT, "watchexec -r -- cargo run --bin server"),
        # A transient SERVICE does not inherit the shell's environment, so the variable in front
        # of systemd-run sets it for systemd-run alone and the unit comes up send-capable: only
        # `-E` (or `--setenv`) reaches it, or `--scope`, or `-E NAME` with NAME set in front —
        # and only in the systemd-run it is about, before the program.
        ("BLOCK", PROJECT, "TEAMS_LITE_READ_ONLY=1 systemd-run --user target/release/server"),
        ("BLOCK", PROJECT, "systemd-run --user --unit=probe ~/.local/share/teams-lite/service/server"),
        (
            "BLOCK",
            PROJECT,
            "TEAMS_LITE_READ_ONLY=1 systemd-run --user --unit=probe ~/.local/share/teams-lite/service/server",
        ),
        ("BLOCK", PROJECT, "systemd-run --user target/release/server -E TEAMS_LITE_READ_ONLY=1"),
        (
            "BLOCK",
            PROJECT,
            "systemd-run --user -E TEAMS_LITE_READ_ONLY=1 target/release/server; "
            "systemd-run --user target/release/server",
        ),
        ("BLOCK", PROJECT, "TEAMS_LITE_READ_ONLY=1 systemd-run --user cargo run --bin server"),
        ("BLOCK", PROJECT, "systemd-run --user bin/teams-dev-server.sh"),
        ("BLOCK", PROJECT, "systemd-run --user teams --no-open"),
        # A wrapper runs the program after it, so it is a prefix like `nohup` — `timeout N` most
        # of all, the ordinary way to watch a server start — and so is a shell with its flags.
        ("BLOCK", PROJECT, "timeout 20 target/release/server"),
        ("BLOCK", PROJECT, "timeout -s KILL 20 target/release/server"),
        ("BLOCK", PROJECT, "env -i target/release/server"),
        ("BLOCK", PROJECT, "bash -x bin/teams-dev-server.sh"),
        ("BLOCK", PROJECT, "command teams --no-open"),
        ("BLOCK", PROJECT, "timeout 60 systemctl --user start teams-lite.target"),
        ("BLOCK", PROJECT, "timeout 300 target/release/server __teams-lite-repair-broker"),
        # A subshell, a brace group and a substitution open a command position too.
        ("BLOCK", PROJECT, "(target/release/server)"),
        ("BLOCK", PROJECT, "(intune-container stop)"),
        ("BLOCK", PROJECT, "{ intune-container stop; }"),
        ("BLOCK", PROJECT, "x=$(intune-container stop)"),
        ("BLOCK", PROJECT, "echo `intune-container restart`"),
        ("BLOCK", PROJECT, "if true; then intune-container stop; fi"),
        # The container's verbs through a transient unit, a wrapper, a shell and a quoted path.
        ("BLOCK", PROJECT, "systemd-run --user intune-container stop"),
        ("BLOCK", PROJECT, "systemd-run --user --wait -- intune-container restart"),
        ("BLOCK", PROJECT, "timeout 120 intune-container stop"),
        ("BLOCK", PROJECT, "setsid intune-container stop"),
        ("BLOCK", PROJECT, "nice -n 10 intune-container restart"),
        ("BLOCK", PROJECT, "bash -c 'intune-container stop && intune-container start'"),
        ("BLOCK", PROJECT, '"$HOME/.local/bin/intune-container" stop'),
        # A verb or an argument ends at whatever ends a command, not only at whitespace.
        ("BLOCK", PROJECT, "intune-container restart; echo ok"),
        ("BLOCK", PROJECT, "intune-container stop|cat"),
        ("BLOCK", PROJECT, "intune-container stop&&echo done"),
        ("BLOCK", PROJECT, "TEAMS_LITE_READ_ONLY=1 target/release/server __rootless-supervise;true"),
        ("BLOCK", PROJECT, "bin/teams-lite-service.sh update --now; echo done"),
        # A repair cut half-way leaves no container at all, and nothing automatic starts one:
        # stopping, killing or freezing either repair unit, by systemctl or raw D-Bus, and killing
        # a process that carries a hidden argument — the repair, or the container's supervisor.
        ("BLOCK", PROJECT, "systemctl --user stop teams-lite-intune-repair.service"),
        ("BLOCK", PROJECT, "systemctl --user kill teams-lite-intune-repair.service"),
        ("BLOCK", PROJECT, "systemctl --user stop teams-lite-broker-repair.service"),
        ("BLOCK", PROJECT, "systemctl --user freeze intune-container.service"),
        (
            "BLOCK",
            PROJECT,
            "busctl --user call org.freedesktop.systemd1 /org/freedesktop/systemd1 "
            "org.freedesktop.systemd1.Manager StopUnit ss teams-lite-intune-repair.service replace",
        ),
        (
            "BLOCK",
            PROJECT,
            "busctl --user call org.freedesktop.systemd1 /org/freedesktop/systemd1 "
            "org.freedesktop.systemd1.Manager KillUnit ssi teams-lite-broker-repair.service all 15",
        ),
        (
            "BLOCK",
            PROJECT,
            "busctl --user call org.freedesktop.systemd1 "
            "/org/freedesktop/systemd1/unit/teams_2dlite_2dbroker_2drepair_2eservice "
            "org.freedesktop.systemd1.Unit Stop s replace",
        ),
        ("BLOCK", PROJECT, "pkill -f __teams-lite-repair-broker"),
        ("BLOCK", PROJECT, "kill $(pgrep -f __teams-lite-repair-broker)"),
        ("BLOCK", PROJECT, "pkill -f __rootless-supervise"),
        # The image's self-contained mode routes three more: the boot (init, an import, a start —
        # a 1.7 GB pull on a fresh volume), the stop the entrypoint's trap runs, and the portal
        # that enrolls the device. Refused run, wrapped, through cargo, as a unit and killed —
        # and whatever TEAMS_LITE_READ_ONLY says, since the stop never looks at it.
        ("BLOCK", PROJECT, "/usr/local/lib/teams-lite/server __teams-lite-intune-boot"),
        ("BLOCK", PROJECT, "TEAMS_LITE_READ_ONLY=1 /usr/local/lib/teams-lite/server __teams-lite-intune-stop"),
        ("BLOCK", PROJECT, "target/release/server __teams-lite-intune-portal"),
        ("BLOCK", PROJECT, "timeout 60 ~/.cache/teams-lite/server __teams-lite-intune-boot"),
        ("BLOCK", PROJECT, "cargo run --bin server -- __teams-lite-intune-boot"),
        ("BLOCK", PROJECT, "systemd-run --user target/release/server __teams-lite-intune-stop"),
        ("BLOCK", PROJECT, "pkill -f __teams-lite-intune-boot"),
        ("BLOCK", PROJECT, "pkill -f __teams-lite-intune-portal"),
        ("BLOCK", PROJECT, "kill $(pgrep -f __teams-lite-intune-stop)"),
        # Inside the image the binary sits behind an `exec`, which puts it at no command position
        # on this line: so a container CLI's exec reaching a hidden argument is the same act, in
        # whatever container or pod it names — and so is a `run` of the image handed one, told
        # read-only or not, and a kill exec'd into it.
        ("BLOCK", PROJECT, "docker exec teams-lite /usr/local/lib/teams-lite/server __teams-lite-intune-stop"),
        ("BLOCK", PROJECT, "docker exec -it -u teams teams-lite /usr/local/lib/teams-lite/server __teams-lite-intune-portal"),
        ("BLOCK", PROJECT, "podman exec teams-lite /usr/local/lib/teams-lite/server __teams-lite-repair-broker"),
        ("BLOCK", PROJECT, "docker container exec teams-lite pkill -f __rootless-supervise"),
        (
            "BLOCK",
            PROJECT,
            "docker compose -f packaging/docker/compose.yaml exec teams-lite "
            "/usr/local/lib/teams-lite/server __teams-lite-intune-boot",
        ),
        ("BLOCK", PROJECT, "kubectl -n teams-lite exec teams-lite-0 -- /usr/local/lib/teams-lite/server __teams-lite-intune-stop"),
        (
            "BLOCK",
            PROJECT,
            "kubectl exec -it teams-lite-0 -c teams-lite -- sh -c '/usr/local/lib/teams-lite/server __teams-lite-intune-boot'",
        ),
        ("BLOCK", PROJECT, "k3s kubectl exec pod/teams-lite-0 -- /usr/local/lib/teams-lite/server __teams-lite-intune-portal"),
        ("BLOCK", PROJECT, "oc exec teams-lite-0 -- /usr/local/lib/teams-lite/server __teams-lite-intune-boot"),
        ("BLOCK", PROJECT, "(docker exec teams-lite /usr/local/lib/teams-lite/server __teams-lite-intune-stop)"),
        ("BLOCK", PROJECT, "x=$(kubectl exec teams-lite-0 -- /usr/local/lib/teams-lite/server __teams-lite-intune-stop)"),
        (
            "BLOCK",
            PROJECT,
            "docker run --rm -e TEAMS_LITE_READ_ONLY=1 --entrypoint /usr/local/lib/teams-lite/server "
            "teams-lite:local __teams-lite-intune-stop",
        ),
        (
            "BLOCK",
            PROJECT,
            "docker compose -f packaging/docker/compose.yaml run --rm teams-lite "
            "/usr/local/lib/teams-lite/server __teams-lite-intune-boot",
        ),
        # The self-test's sanctioned shape is a THROWAWAY run: exec'd into a live install it acts
        # on that install's own volume, and it ends with the stop.
        ("BLOCK", PROJECT, "docker exec teams-lite teams-lite-intune-selftest"),
        ("BLOCK", PROJECT, "kubectl exec teams-lite-0 -- /usr/local/bin/teams-lite-intune-selftest"),
        # …and so is the image's own ENTRYPOINT. In an image built from this checkout a second copy
        # is refused by its own one-copy lock before it acts; the hook cannot see which build a
        # container runs, and in one built before that lock a second copy exits at once — its
        # launcher finds the ports taken, or prints its usage — and powers the RUNNING Intune
        # container off on its way out. `--help` is no exemption, because the stop follows any exit.
        # What is refused is RUNNING it: past a wrapper, inside a `-c` script, as a shell's script
        # operand, or sourced.
        ("BLOCK", PROJECT, "docker exec teams-lite teams-lite-container"),
        ("BLOCK", PROJECT, "docker exec teams-lite teams-lite-container --help"),
        ("BLOCK", PROJECT, "docker exec -it -u teams teams-lite /usr/local/bin/teams-lite-container"),
        ("BLOCK", PROJECT, "podman exec teams-lite teams-lite-container"),
        ("BLOCK", PROJECT, "docker compose -f packaging/docker/compose.yaml exec teams-lite teams-lite-container"),
        ("BLOCK", PROJECT, "kubectl -n teams-lite exec teams-lite-0 -- teams-lite-container"),
        ("BLOCK", PROJECT, "kubectl exec teams-lite-0 -- sh -c '/usr/local/bin/teams-lite-container --help'"),
        ("BLOCK", PROJECT, "x=$(docker exec teams-lite teams-lite-container)"),
        ("BLOCK", PROJECT, "docker exec teams-lite sh /usr/local/bin/teams-lite-container"),
        ("BLOCK", PROJECT, "docker exec teams-lite sh -c '. /usr/local/bin/teams-lite-container'"),
        ("BLOCK", PROJECT, "docker exec teams-lite timeout 60 /usr/local/bin/teams-lite-intune-selftest"),
        ("BLOCK", PROJECT, "docker exec teams-lite-ro teams-lite-intune-selftest"),
        # Rule 3c-ii: the launcher or the backend exec'd INTO a running install is a SECOND
        # send-capable backend — the exec inherits the container's environment but not the ports its
        # entrypoint chose, so it binds the default 19420 there, free, and signs in through the same
        # identity broker. With any arguments (`--help` included) and whatever an `-e` on the exec or
        # an `env` in front of the program says; through every wrapper the image's own entrypoint
        # uses to drop privileges (setpriv), and the others (runuser, su, gosu, timeout, nohup, exec,
        # sudo); inside a `-c` script, its newlines included; through compose and kubectl; and the
        # backend at its two teams-lite paths in ANY container, a bare `teams` or `server` in the
        # install's own (or one the shell computes).
        ("BLOCK", PROJECT, "docker exec -u teams teams-lite /usr/local/lib/teams-lite/server"),
        ("BLOCK", PROJECT, "docker exec -d -u teams teams-lite /usr/local/lib/teams-lite/server"),
        ("BLOCK", PROJECT, "kubectl -n teams-lite exec teams-lite-0 -- /usr/local/lib/teams-lite/server"),
        ("BLOCK", PROJECT, "docker exec -u teams teams-lite teams --no-open"),
        ("BLOCK", PROJECT, "docker exec teams-lite teams --help"),
        ("BLOCK", PROJECT, "docker exec teams-lite /usr/local/bin/teams"),
        ("BLOCK", PROJECT, "docker container exec teams-lite /usr/local/bin/teams --no-open"),
        ("BLOCK", PROJECT, "podman exec teams-lite teams"),
        (
            "BLOCK",
            PROJECT,
            "kubectl -n teams-lite exec teams-lite-0 -- setpriv --reuid=teams --regid=teams "
            "--init-groups -- teams --no-open",
        ),
        ("BLOCK", PROJECT, "docker compose -f packaging/docker/compose.yaml exec teams-lite teams --no-open"),
        ("BLOCK", PROJECT, "docker compose -f packaging/docker/compose.yaml exec -d teams-lite /usr/local/bin/teams"),
        ("BLOCK", PROJECT, "docker exec teams-lite sh -c 'cd /tmp && exec teams --no-open'"),
        ("BLOCK", PROJECT, "docker exec teams-lite sh -c 'cd /tmp\nteams --no-open'"),
        ("BLOCK", PROJECT, "docker exec teams-lite sh -c 'nohup /usr/local/lib/teams-lite/server >/dev/null 2>&1 &'"),
        # A newline ends a command in a `-c` script as a `;` does.
        ("BLOCK", PROJECT, "docker exec teams-lite sh -c 'cd /tmp\n/usr/local/lib/teams-lite/server'"),
        (
            "BLOCK",
            PROJECT,
            "docker exec teams-lite bash -lc 'exec setpriv --reuid=teams --regid=teams --init-groups -- "
            "/usr/local/lib/teams-lite/server'",
        ),
        ("BLOCK", PROJECT, "docker exec teams-lite runuser -u teams -- teams --no-open"),
        ("BLOCK", PROJECT, "docker exec teams-lite runuser teams -c /usr/local/lib/teams-lite/server"),
        ("BLOCK", PROJECT, "docker exec teams-lite su teams -c 'teams --no-open'"),
        ("BLOCK", PROJECT, "docker exec teams-lite gosu teams teams"),
        ("BLOCK", PROJECT, "docker exec teams-lite timeout 30 server"),
        ("BLOCK", PROJECT, "docker exec -w /usr/local/lib/teams-lite teams-lite ./server"),
        ("BLOCK", PROJECT, "docker exec teams-lite /proc/123/exe"),
        ("BLOCK", PROJECT, "docker exec -e TEAMS_LITE_READ_ONLY=1 teams-lite /usr/local/lib/teams-lite/server"),
        ("BLOCK", PROJECT, "docker exec teams-lite env TEAMS_LITE_READ_ONLY=1 /usr/local/lib/teams-lite/server"),
        ("BLOCK", PROJECT, "docker exec teams-lite /home/teams/.cache/teams-lite/server"),
        ("BLOCK", PROJECT, "docker exec teams-lite-ro /usr/local/lib/teams-lite/server"),
        ("BLOCK", PROJECT, "docker exec $(docker ps -q) teams"),
        ("BLOCK", PROJECT, "x=$(docker exec teams-lite teams)"),
        ("BLOCK", PROJECT, "(docker exec -u teams teams-lite /usr/local/lib/teams-lite/server)"),
        ("BLOCK", PROJECT, "sudo docker exec -u teams teams-lite teams"),
        ("BLOCK", PROJECT, "timeout 10 docker exec teams-lite teams"),
        ("BLOCK", PROJECT, "kubectl exec sts/teams-lite -- teams"),
        ("BLOCK", PROJECT, "kubectl exec tl-teams-lite-0 -c teams-lite -- /usr/local/bin/teams --no-open"),
        ("BLOCK", PROJECT, "oc exec teams-lite-0 -- teams --no-open"),
        # Rule 3d-iii: another container JOINED to the install's pid namespace is inside it — every
        # process of the install is then one of its own, as root with CAP_KILL, and what it runs
        # next (a shell, a script) is beyond this hook. So the join is refused, whatever it runs:
        # `--pid container:` on a run or a create, on docker, podman and nerdctl, a computed target,
        # and `kubectl debug --target` on the chart's pod.
        ("BLOCK", PROJECT, "docker run --rm --pid container:teams-lite busybox kill 1"),
        ("BLOCK", PROJECT, "docker run --rm --pid=container:teams-lite busybox kill -TERM 1"),
        ("BLOCK", PROJECT, "docker run --rm --pid container:teams-lite busybox pkill -f teams"),
        ("BLOCK", PROJECT, "docker run --rm --pid=container:teams-lite busybox ps"),
        ("BLOCK", PROJECT, 'docker run --rm --pid "container:teams-lite" busybox ps'),
        ("BLOCK", PROJECT, "docker run --rm -it --pid container:teams-lite alpine sh"),
        ("BLOCK", PROJECT, "docker create --pid container:teams-lite busybox"),
        ("BLOCK", PROJECT, "docker container run --pid container:teams-lite busybox"),
        ("BLOCK", PROJECT, "podman run --rm --pid=container:teams-lite alpine kill 1"),
        ("BLOCK", PROJECT, "nerdctl run --pid container:teams-lite busybox ps"),
        ("BLOCK", PROJECT, "docker run --rm --pid=container:$(docker ps -q --filter name=teams) busybox kill 1"),
        ("BLOCK", PROJECT, "sudo docker run --rm --pid container:teams-lite busybox ps"),
        ("BLOCK", PROJECT, "x=$(docker run --rm --pid container:teams-lite busybox ps)"),
        ("BLOCK", PROJECT, "kubectl debug -it teams-lite-0 --image=busybox --target=teams-lite -- kill 1"),
        # …with no command at all: the image's own (a shell, for busybox) runs inside it.
        ("BLOCK", PROJECT, "kubectl debug -it teams-lite-0 --image=busybox --target=teams-lite"),
        ("BLOCK", PROJECT, "kubectl -n teams-lite debug teams-lite-0 -it --image=busybox --target teams-lite -- ps"),
        ("BLOCK", PROJECT, "kubectl debug pod/teams-lite-0 --target=teams-lite --image=busybox"),
        ("BLOCK", PROJECT, "kubectl debug -it --image=busybox --target=teams-lite tl-teams-lite-0"),
        # Rule 3d-ii: a SIGNAL sent inside teams-lite's container is `docker stop` by other means —
        # PID 1 (tini), the entrypoint whose exit powers the Intune container off, the launcher,
        # the backend and the Intune container's own processes are all the install. By number, by
        # name, through a wrapper, inside a `-c` script (its quoted separators included), under
        # xargs, into a computed target, through compose and through kubectl — by pod, by
        # `kind/name`, under a release's prefix.
        ("BLOCK", PROJECT, "docker exec teams-lite kill 1"),
        ("BLOCK", PROJECT, "docker exec teams-lite kill -TERM 1"),
        ("BLOCK", PROJECT, "docker exec teams-lite kill -s TERM 1"),
        ("BLOCK", PROJECT, "docker exec teams-lite kill -9 -1"),
        ("BLOCK", PROJECT, "docker exec -u root teams-lite /usr/bin/kill --signal=KILL 1"),
        ("BLOCK", PROJECT, "podman exec teams-lite kill 1"),
        ("BLOCK", PROJECT, "docker container exec teams-lite kill 1"),
        ("BLOCK", PROJECT, "docker exec teams-lite sh -c 'kill -TERM 1'"),
        ("BLOCK", PROJECT, "docker exec teams-lite sh -c 'kill 23; kill 1'"),
        ("BLOCK", PROJECT, "docker exec teams-lite sh -c 'cat /run/pid | xargs kill'"),
        ("BLOCK", PROJECT, "docker exec teams-lite sh -c '\nkill 1\n'"),
        ("BLOCK", PROJECT, "docker exec teams-lite sh -c 'cat /run/pid\nkill 1'"),
        ("BLOCK", PROJECT, 'docker exec -it teams-lite bash -lc "pkill -f teams"'),
        ("BLOCK", PROJECT, "docker exec teams-lite timeout 5 kill 1"),
        ("BLOCK", PROJECT, "docker exec teams-lite killall tini"),
        ("BLOCK", PROJECT, "docker exec $(docker ps -q --filter name=teams) kill 1"),
        ("BLOCK", PROJECT, "docker exec `docker ps -q` kill -TERM 1"),
        ("BLOCK", PROJECT, "docker compose -f packaging/docker/compose.yaml exec teams-lite kill 1"),
        ("BLOCK", PROJECT, "docker compose -f packaging/docker/compose.yaml exec -T teams-lite sh -c 'kill -s TERM 1'"),
        ("BLOCK", PROJECT, "kubectl -n teams-lite exec teams-lite-0 -- kill 1"),
        ("BLOCK", PROJECT, 'kubectl exec -it teams-lite-0 -c teams-lite -- sh -c "kill -TERM 1"'),
        ("BLOCK", PROJECT, "kubectl exec pod/teams-lite-0 -- kill -s TERM 1"),
        ("BLOCK", PROJECT, "kubectl exec sts/teams-lite -- kill 1"),
        ("BLOCK", PROJECT, "kubectl exec tl-teams-lite-0 -- kill 1"),
        ("BLOCK", PROJECT, "oc exec teams-lite-0 -- kill 1"),
        ("BLOCK", PROJECT, "(docker exec teams-lite kill 1)"),
        ("BLOCK", PROJECT, "x=$(docker exec teams-lite kill 1)"),
        ("BLOCK", PROJECT, "sudo docker exec teams-lite kill 1"),
        ("BLOCK", PROJECT, "timeout 10 docker exec teams-lite kill 1"),
        # The same lifecycle from a cargo example, through the crate or teams-lite's own module.
        ("BLOCK", PROJECT, "cargo run --example guard-test-crate-portal-headless"),
        ("BLOCK", PROJECT, "cargo run --example guard-test-crate-restore-rootless"),
        ("BLOCK", PROJECT, "cargo run --example guard-test-crate-clear-state"),
        ("BLOCK", PROJECT, "cargo run --example guard-test-embedded-spawn"),
        ("BLOCK", PROJECT, "cargo run --example guard-test-embedded-main"),
        ("BLOCK", PROJECT, "cargo run --example guard-test-embedded-grouped"),
        ("BLOCK", PROJECT, "cargo run --example guard-test-embedded-repair"),
        ("BLOCK", PROJECT, "cargo run --example guard-test-embedded-boot-binary"),
        ("BLOCK", PROJECT, "cargo run --example guard-test-embedded-portal-literal"),
        # The container image's pair (19423 / 19443) is the same account on this loopback.
        ("BLOCK", PROJECT, f"bun run {tmp}/image-backend-writer.ts"),
        ("BLOCK", PROJECT, f"bun run {tmp}/image-relay-writer.ts"),
        # Rule 3d: bringing teams-lite's container image up is the `teams` command in a
        # container — through compose, named by its file, by a `cd` into its directory, or by
        # a shell already standing there, where a bare `up` finds the file on its own.
        ("BLOCK", PROJECT, "docker compose -f packaging/docker/compose.yaml up -d"),
        ("BLOCK", PROJECT, "cd packaging/docker && docker compose up -d"),
        ("BLOCK", PROJECT / "packaging" / "docker", "docker compose up -d"),
        ("BLOCK", PROJECT, "docker compose -f packaging/docker/compose.yaml up --build"),
        ("BLOCK", PROJECT, "docker-compose -f packaging/docker/compose.yaml restart"),
        ("BLOCK", PROJECT, "sudo docker compose -p teams-lite start"),
        ("BLOCK", PROJECT, "podman compose -f packaging/docker/compose.yaml up"),
        # …or the image run straight, or the container started again.
        ("BLOCK", PROJECT, "docker run --rm --pid=host --network=host teams-lite:local"),
        ("BLOCK", PROJECT, "podman run --pid=host --network=host teams-lite:local"),
        ("BLOCK", PROJECT, "docker container create --name teams-lite teams-lite:local"),
        ("BLOCK", PROJECT, "docker start teams-lite"),
        ("BLOCK", PROJECT, "docker restart teams-lite"),
        ("BLOCK", PROJECT, "timeout 60 docker run --rm teams-lite:local"),
        ("BLOCK", PROJECT, "docker stop teams-lite; docker start teams-lite"),
        # The proof has to reach the CONTAINER: a variable in front of `docker` sets it for the
        # CLI alone, a compose run with no `-e` runs the file's send-capable environment, and
        # a wrong value or a shell entrypoint proves nothing.
        ("BLOCK", PROJECT, "TEAMS_LITE_READ_ONLY=1 docker run --rm teams-lite:local"),
        ("BLOCK", PROJECT, "docker compose -f packaging/docker/compose.yaml run --rm teams-lite"),
        ("BLOCK", PROJECT, "docker run --rm -e TEAMS_LITE_READ_ONLY=0 teams-lite:local"),
        ("BLOCK", PROJECT, "docker run --rm --entrypoint sh teams-lite:local -c teams"),
        # One read-only container says nothing about a second on the same line.
        (
            "BLOCK",
            PROJECT,
            "docker run --rm -e TEAMS_LITE_READ_ONLY=1 teams-lite:local; docker run -d teams-lite:local",
        ),
        # Rule 3d, the other way: the image runs the user's Intune container now, so taking the
        # container named teams-lite DOWN signs that install out — a stop, a kill, a pause, a
        # removal, behind the engine's global flags or a wrapper — and so does a list the shell
        # computes, which this hook cannot see inside. These used to be ALLOWED as cleanup.
        ("BLOCK", PROJECT, "docker stop teams-lite"),
        ("BLOCK", PROJECT, "docker kill teams-lite"),
        ("BLOCK", PROJECT, "docker container stop -t 0 teams-lite"),
        ("BLOCK", PROJECT, "docker rm -f teams-lite"),
        ("BLOCK", PROJECT, "docker container remove teams-lite"),
        ("BLOCK", PROJECT, "podman pause teams-lite"),
        ("BLOCK", PROJECT, "docker --context default stop teams-lite"),
        ("BLOCK", PROJECT, "sudo docker kill -s KILL teams-lite"),
        ("BLOCK", PROJECT, "docker stop $(docker ps -q)"),
        ("BLOCK", PROJECT, "docker rm -f `docker ps -aq`"),
        # …and its compose project, by any compose file there, a `cd` into it, a shell already
        # standing there, or its project name.
        ("BLOCK", PROJECT, "docker compose -f packaging/docker/compose.yaml stop"),
        ("BLOCK", PROJECT, "docker compose -f packaging/docker/compose.yaml down"),
        ("BLOCK", PROJECT, "docker compose -f packaging/docker/compose.host-broker.yaml down"),
        ("BLOCK", PROJECT, "cd packaging/docker && docker compose down"),
        ("BLOCK", PROJECT / "packaging" / "docker", "docker compose down"),
        ("BLOCK", PROJECT / "packaging" / "docker", "docker compose kill"),
        ("BLOCK", PROJECT, "docker compose -p teams-lite kill"),
        ("BLOCK", PROJECT, "docker-compose -f packaging/docker/compose.yaml rm -f"),
        ("BLOCK", PROJECT, "podman compose -f packaging/docker/compose.yaml pause"),
        # IRREVERSIBLE: the volumes hold the device's enrollment and the store. `down -v`, a
        # volume of the project by name (the Intune one under any project name), `--all`, a
        # computed list, a prune of any kind that takes volumes, and podman's reset.
        ("BLOCK", PROJECT, "docker compose -f packaging/docker/compose.yaml down -v"),
        ("BLOCK", PROJECT, "docker compose -f packaging/docker/compose.yaml down --volumes"),
        ("BLOCK", PROJECT / "packaging" / "docker", "docker compose down -v"),
        ("BLOCK", PROJECT, "docker volume rm teams-lite_intune"),
        ("BLOCK", PROJECT, "docker volume rm intune"),
        ("BLOCK", PROJECT, "docker volume rm -f teams-lite_data"),
        ("BLOCK", PROJECT, "docker volume rm myproj_intune"),
        ("BLOCK", PROJECT, "docker volume rm $(docker volume ls -q)"),
        ("BLOCK", PROJECT, "podman volume rm --all"),
        ("BLOCK", PROJECT, "docker volume prune"),
        ("BLOCK", PROJECT, "docker volume prune -f --filter label=x"),
        ("BLOCK", PROJECT, "docker system prune -af --volumes"),
        ("BLOCK", PROJECT, "podman system reset"),
        # The self-test boots an Intune container on the image's data directory and STOPS it, so
        # anything mounted on that directory, above it or inside it — or another container's
        # volumes — voids the proof, read-only or not; and a compose run mounts the service's own.
        (
            "BLOCK",
            PROJECT,
            "docker run --rm --entrypoint teams-lite-intune-selftest "
            "-v teams-lite_intune:/home/teams/.local/share/intune-container teams-lite:local",
        ),
        ("BLOCK", PROJECT, "docker run --rm --entrypoint teams-lite-intune-selftest -v /x:/home/teams/.local/share/ teams-lite:local"),
        ("BLOCK", PROJECT, "docker run --rm --entrypoint teams-lite-intune-selftest -v /x:/home/teams teams-lite:local"),
        (
            "BLOCK",
            PROJECT,
            "docker run --rm --entrypoint teams-lite-intune-selftest --mount "
            "type=volume,src=teams-lite_intune,target=/home/teams/.local/share/intune-container teams-lite:local",
        ),
        (
            "BLOCK",
            PROJECT,
            "docker run --rm --entrypoint=/usr/local/bin/teams-lite-intune-selftest --volumes-from teams-lite teams-lite:local",
        ),
        (
            "BLOCK",
            PROJECT,
            "docker run --rm --entrypoint teams-lite-intune-selftest "
            "-v /x:/home/teams/.local/share/intune-container/persist:ro teams-lite:local",
        ),
        (
            "BLOCK",
            PROJECT,
            "docker run --rm -e TEAMS_LITE_READ_ONLY=1 --entrypoint teams-lite-intune-selftest "
            "-v teams-lite_intune:/home/teams/.local/share/intune-container teams-lite:local",
        ),
        (
            "BLOCK",
            PROJECT,
            "docker compose -f packaging/docker/compose.yaml run --rm --entrypoint teams-lite-intune-selftest teams-lite",
        ),
        # A proof is read as the engine reads its flags. The LAST --entrypoint is the one that
        # runs, so a proof stands only as the SOLE one — in both spellings, and whichever proof it
        # is; with --pid=host and the host's bus that second entrypoint is a send-capable backend
        # signed in as the user, with no mount anywhere.
        ("BLOCK", PROJECT, "docker run --rm --entrypoint teams-lite-intune-selftest --entrypoint teams-lite-container teams-lite:local"),
        ("BLOCK", PROJECT, "docker run --rm --entrypoint=teams-lite-intune-selftest --entrypoint=teams-lite-container teams-lite:local"),
        (
            "BLOCK",
            PROJECT,
            "docker run --rm --entrypoint teams-lite-intune-selftest --entrypoint /usr/local/lib/teams-lite/server "
            "-v teams-lite_intune:/srv teams-lite:local",
        ),
        (
            "BLOCK",
            PROJECT,
            "docker run --rm --user 1000:1000 --pid=host -e TEAMS_LITE_INTUNE_MODE=host "
            "-e TEAMS_LITE_BROKER_BUS=unix:path=/proc/6415/root/run/user/0/bus "
            "--entrypoint teams-lite-intune-selftest --entrypoint teams-lite-container teams-lite:local",
        ),
        ("BLOCK", PROJECT, "docker run --rm --entrypoint teams-lite-intune-status --entrypoint teams-lite-container teams-lite:local"),
        ("BLOCK", PROJECT, "podman run --rm --entrypoint=teams-lite-intune-status --entrypoint teams-lite-container teams-lite:local"),
        # …the LAST word on TEAMS_LITE_READ_ONLY is the one the container gets, in any spelling — a
        # bare `-e TEAMS_LITE_READ_ONLY` hands it the CLI's own value…
        ("BLOCK", PROJECT, "docker run --rm -e TEAMS_LITE_READ_ONLY=1 -e TEAMS_LITE_READ_ONLY=0 teams-lite:local"),
        ("BLOCK", PROJECT, "docker run --rm --env TEAMS_LITE_READ_ONLY=1 --env=TEAMS_LITE_READ_ONLY=0 teams-lite:local"),
        ("BLOCK", PROJECT, "docker run --rm -e TEAMS_LITE_READ_ONLY=1 -eTEAMS_LITE_READ_ONLY=0 teams-lite:local"),
        ("BLOCK", PROJECT, "docker run --rm -e TEAMS_LITE_READ_ONLY=1 -e TEAMS_LITE_READ_ONLY teams-lite:local"),
        (
            "BLOCK",
            PROJECT,
            "docker compose -f packaging/docker/compose.yaml run --rm -e TEAMS_LITE_READ_ONLY=1 "
            "-e TEAMS_LITE_READ_ONLY=0 teams-lite",
        ),
        # …and a word after the IMAGE is an argument for the image's own program, never a flag.
        ("BLOCK", PROJECT, "docker run --rm teams-lite:local -e TEAMS_LITE_READ_ONLY=1"),
        ("BLOCK", PROJECT, "docker run --rm teams-lite:local --entrypoint teams-lite-intune-status"),
        # The self-test's display :99 is an ABSTRACT socket, which belongs to the network
        # namespace: in the host's it is the user's own Intune container's, in another
        # container's that install's — docker and podman, every spelling.
        ("BLOCK", PROJECT, "docker run --rm --network host --entrypoint teams-lite-intune-selftest teams-lite:local"),
        ("BLOCK", PROJECT, "docker run --rm --network=host --entrypoint teams-lite-intune-selftest teams-lite:local"),
        ("BLOCK", PROJECT, "docker run --rm --net host --entrypoint teams-lite-intune-selftest teams-lite:local"),
        ("BLOCK", PROJECT, "docker run --rm --net=host --entrypoint teams-lite-intune-selftest teams-lite:local"),
        ("BLOCK", PROJECT, "podman run --rm --network=host --entrypoint teams-lite-intune-selftest teams-lite:local"),
        ("BLOCK", PROJECT, "podman run --rm --net host --entrypoint teams-lite-intune-selftest teams-lite:local"),
        (
            "BLOCK",
            PROJECT,
            "docker run --rm --security-opt seccomp=unconfined --security-opt systempaths=unconfined "
            '--network "host" --entrypoint teams-lite-intune-selftest ghcr.io/theophile-wallez/teams-lite:latest',
        ),
        ("BLOCK", PROJECT, "docker run --rm --network container:teams-lite --entrypoint teams-lite-intune-selftest teams-lite:local"),
        ("BLOCK", PROJECT, "podman run --rm --network ns:/proc/1/ns/net --entrypoint teams-lite-intune-selftest teams-lite:local"),
        # …nor an IPC namespace — a /dev/shm — that is not its own: its Intune container binds the
        # outer /dev, and its boot deletes every broker semaphore there that no process IT can see
        # holds — in the host's /dev/shm, a lock the user's own broker may hold that moment.
        ("BLOCK", PROJECT, "docker run --rm --ipc host --entrypoint teams-lite-intune-selftest teams-lite:local"),
        ("BLOCK", PROJECT, "docker run --rm --ipc=host --entrypoint teams-lite-intune-selftest teams-lite:local"),
        ("BLOCK", PROJECT, 'docker run --rm --ipc "host" --entrypoint teams-lite-intune-selftest teams-lite:local'),
        ("BLOCK", PROJECT, "docker run --rm --ipc container:teams-lite --entrypoint teams-lite-intune-selftest teams-lite:local"),
        ("BLOCK", PROJECT, "podman run --rm --ipc host --entrypoint teams-lite-intune-selftest teams-lite:local"),
        ("BLOCK", PROJECT, "podman run --rm --ipc=ns:/proc/1/ns/ipc --entrypoint teams-lite-intune-selftest teams-lite:local"),
        (
            "BLOCK",
            PROJECT,
            "docker run --rm --security-opt seccomp=unconfined --security-opt systempaths=unconfined "
            "--security-opt apparmor=unconfined --ipc host --entrypoint teams-lite-intune-selftest "
            "ghcr.io/theophile-wallez/teams-lite:latest",
        ),
        # The PUBLISHED image is the same image under a registry's name, by tag or by digest.
        ("BLOCK", PROJECT, "docker run --rm --pid=host --network=host ghcr.io/theophile-wallez/teams-lite:latest"),
        ("BLOCK", PROJECT, "podman run ghcr.io/theophile-wallez/teams-lite:build-0123abc"),
        ("BLOCK", PROJECT, f"docker run --rm ghcr.io/theophile-wallez/teams-lite@sha256:{'a' * 64}"),
        ("BLOCK", PROJECT, "docker run --rm localhost:5000/teams-lite"),
        # A FORK publishes the same image under its own owner (build.yml names it from the
        # repository it runs in), and its chart under its own `charts/`: neither is upstream's name.
        ("BLOCK", PROJECT, "docker run --rm ghcr.io/somefork/teams-lite:latest"),
        ("BLOCK", PROJECT, "helm install teams-lite oci://ghcr.io/somefork/charts/teams-lite"),
        # Rule 3e: the chart deployed, upgraded or rolled back — by release name, path, OCI
        # reference, package, or from the chart's own directory — is the live stack on a cluster.
        (
            "BLOCK",
            PROJECT,
            "helm install teams-lite oci://ghcr.io/theophile-wallez/charts/teams-lite -n teams-lite "
            "--set broker.intuneContainer.stateDir=/home/u/.local/share/intune-container",
        ),
        ("BLOCK", PROJECT, "helm upgrade --install teams-lite packaging/helm/teams-lite"),
        ("BLOCK", PROJECT, "helm upgrade --install me ./packaging/helm/teams-lite/"),
        ("BLOCK", PROJECT, "helm install me out/teams-lite-0.1.42.tgz"),
        ("BLOCK", PROJECT, "helm --kube-context dedibox upgrade teams-lite oci://ghcr.io/theophile-wallez/charts/teams-lite"),
        ("BLOCK", PROJECT, "helm rollback teams-lite 3"),
        ("BLOCK", PROJECT / "packaging" / "helm" / "teams-lite", "helm install me ."),
        ("BLOCK", PROJECT, "timeout 120 helm upgrade teams-lite packaging/helm/teams-lite --wait"),
        # The read-only proof is the LAST word on the value, and a flag that outranks --set voids it.
        ("BLOCK", PROJECT, "helm install teams-lite packaging/helm/teams-lite --set readOnly=true --set readOnly=false"),
        ("BLOCK", PROJECT, "helm install teams-lite packaging/helm/teams-lite --set readOnly=true,readOnly=false"),
        (
            "BLOCK",
            PROJECT,
            "helm install teams-lite packaging/helm/teams-lite --set readOnly=true --set-literal readOnly=false",
        ),
        ("BLOCK", PROJECT, "helm install teams-lite packaging/helm/teams-lite -f read-only.yaml"),
        ("BLOCK", PROJECT, "helm install teams-lite packaging/helm/teams-lite --dry-run=none"),
        # The rendered manifests applied, or a manifest named after it.
        ("BLOCK", PROJECT, "helm template teams-lite packaging/helm/teams-lite | kubectl apply -f -"),
        ("BLOCK", PROJECT, "kubectl apply -f deploy/teams-lite.yaml"),
        ("BLOCK", PROJECT, "k3s kubectl create -f teams-lite.yml"),
        # Every kubectl verb that starts or restarts the pod.
        ("BLOCK", PROJECT, "kubectl -n teams-lite scale statefulset/teams-lite --replicas=1"),
        ("BLOCK", PROJECT, "kubectl scale sts teams-lite --replicas 1"),
        ("BLOCK", PROJECT, "kubectl -n teams-lite rollout restart statefulset/teams-lite"),
        ("BLOCK", PROJECT, "kubectl rollout undo sts/teams-lite"),
        ("BLOCK", PROJECT, "kubectl -n teams-lite delete pod teams-lite-0"),
        ("BLOCK", PROJECT, "kubectl delete pods -l app.kubernetes.io/name=teams-lite"),
        ("BLOCK", PROJECT, "kubectl delete pod/teams-lite-0 --namespace=teams-lite"),
        ("BLOCK", PROJECT, "kubectl set env statefulset/teams-lite TEAMS_LITE_CALL_DEBUG=1"),
        ("BLOCK", PROJECT, "kubectl patch sts teams-lite -p '{\"spec\":{}}'"),
        ("BLOCK", PROJECT, "kubectl run tl --image=ghcr.io/theophile-wallez/teams-lite:latest"),
        (
            "BLOCK",
            PROJECT,
            "kubectl run tl --image=ghcr.io/theophile-wallez/teams-lite --env=TEAMS_LITE_READ_ONLY=1 --env=TEAMS_LITE_READ_ONLY=0",
        ),
        # A port-forward is the account's door: only onto a live loopback port the browser guard knows.
        ("BLOCK", PROJECT, "kubectl -n teams-lite port-forward svc/teams-lite 8080:19443"),
        ("BLOCK", PROJECT, "kubectl port-forward pod/teams-lite-0 :19443"),
        ("BLOCK", PROJECT, "kubectl port-forward --address 0.0.0.0 svc/teams-lite 19443:19443"),
        ("BLOCK", PROJECT, "kubectl port-forward svc/teams-lite 19443:19443 --address=127.0.0.1,192.168.1.4"),
        ("BLOCK", PROJECT, "kubectl port-forward svc/teams-lite 19443 9000:19443"),
        # Found by review, each one a real spelling that walked past the first version of 3d/3e.
        # A tag the shell fills in is still the image's tag.
        ("BLOCK", PROJECT, "docker run --rm --pid=host --network=host teams-lite:$TAG"),
        ("BLOCK", PROJECT, "docker run --rm teams-lite:${TAG:-latest}"),
        ("BLOCK", PROJECT, 'docker run --rm teams-lite:"$(git rev-parse --short HEAD)"'),
        ("BLOCK", PROJECT, "kubectl run tl --image=ghcr.io/theophile-wallez/teams-lite:$TAG"),
        # An OCI chart reference carries its version as a tag, or a digest.
        ("BLOCK", PROJECT, "helm install tl oci://ghcr.io/theophile-wallez/charts/teams-lite:0.1.42"),
        ("BLOCK", PROJECT, f"helm install tl oci://ghcr.io/theophile-wallez/charts/teams-lite@sha256:{'b' * 64}"),
        # The chart's own directory, reached by a `cd` on the same line.
        ("BLOCK", PROJECT, "cd packaging/helm/teams-lite && helm install tl . --set hostUser.uid=1000"),
        ("BLOCK", PROJECT / "packaging" / "helm", "cd teams-lite; helm upgrade --install tl ."),
        # A subshell or a substitution is a command too.
        ("BLOCK", PROJECT, "(helm install tl packaging/helm/teams-lite)"),
        ("BLOCK", PROJECT, "x=$(helm upgrade --install teams-lite oci://ghcr.io/theophile-wallez/charts/teams-lite)"),
        ("BLOCK", PROJECT, "(kubectl -n teams-lite port-forward svc/teams-lite 8080:19443 >/dev/null 2>&1 &)"),
        ("BLOCK", PROJECT, "x=$(kubectl -n teams-lite rollout restart sts/teams-lite)"),
        ("BLOCK", PROJECT, "(docker run --rm teams-lite:local)"),
        # The read-only proof is an INSTALL's: an upgrade to read-only restarts the user's client.
        ("BLOCK", PROJECT, "helm upgrade teams-lite oci://ghcr.io/theophile-wallez/charts/teams-lite --set readOnly=true"),
        (
            "BLOCK",
            PROJECT,
            "helm upgrade --install teams-lite packaging/helm/teams-lite --reuse-values --set readOnly=true",
        ),
        # Restarting every workload of its namespace restarts it.
        ("BLOCK", PROJECT, "kubectl -n teams-lite rollout restart statefulset"),
        ("BLOCK", PROJECT, "kubectl rollout restart sts -n teams-lite"),
        ("BLOCK", PROJECT, "kubectl -n teams-lite delete pods --all"),
        ("BLOCK", PROJECT, "kubectl delete pod --all -n teams-lite"),
        ("BLOCK", PROJECT, "kubectl -n teams-lite scale sts --all --replicas=1"),
        ("BLOCK", PROJECT, "kubectl -n teams-lite set env sts --all FOO=bar"),
        # A named or quoted port is the same door.
        ("BLOCK", PROJECT, "kubectl -n teams-lite port-forward svc/teams-lite 8080:web"),
        ("BLOCK", PROJECT, "kubectl port-forward pod/teams-lite-0 :web"),
        ("BLOCK", PROJECT, "kubectl port-forward svc/teams-lite '8080:19443'"),
        ("BLOCK", PROJECT, 'kubectl port-forward svc/teams-lite "8080:19443"'),
        # The image named on a `kubectl create`, and helmfile, which runs `helm upgrade --install`.
        ("BLOCK", PROJECT, "kubectl create deployment tl --image=ghcr.io/theophile-wallez/teams-lite:latest"),
        ("BLOCK", PROJECT, "helmfile -l name=teams-lite sync"),
        ("BLOCK", PROJECT, f"helmfile -f {tmp}/helmfile.yaml apply"),
        # A manifest rendered to a FILE and applied next, by file or by directory.
        ("BLOCK", PROJECT, f"kubectl apply -f {tmp}/rendered.yaml"),
        ("BLOCK", PROJECT, f"kubectl apply -f {tmp}/rendered-dir/"),
        # A second copy of the live pod, on the same claims, is the live client again.
        ("BLOCK", PROJECT, "kubectl debug teams-lite-0 -n teams-lite --copy-to=tl-debug"),
        # A kind is read in a comma list too, wherever it stands in it.
        ("BLOCK", PROJECT, "kubectl delete pod,svc teams-lite-0"),
        ("BLOCK", PROJECT, "kubectl delete svc,pod teams-lite-0"),
        # Rule 3e, the other way: in the default self-contained mode the pod runs the user's Intune
        # container, so STOPPING the release signs it out — an uninstall (under any of its helm
        # names), a scale to 0, a delete of the StatefulSet, of `all` its kinds or of its manifests.
        # These used to be ALLOWED as cleanup.
        ("BLOCK", PROJECT, "helm -n teams-lite uninstall teams-lite"),
        ("BLOCK", PROJECT, "helm uninstall teams-lite --keep-history"),
        ("BLOCK", PROJECT, "helm del teams-lite"),
        ("BLOCK", PROJECT, "kubectl -n teams-lite scale statefulset/teams-lite --replicas=0"),
        ("BLOCK", PROJECT, "kubectl -n teams-lite scale sts --all --replicas=0"),
        ("BLOCK", PROJECT, "kubectl -n teams-lite delete statefulset teams-lite"),
        ("BLOCK", PROJECT, "kubectl delete sts/teams-lite --cascade=orphan"),
        ("BLOCK", PROJECT, "kubectl -n teams-lite delete all --all"),
        ("BLOCK", PROJECT, "kubectl -n teams-lite delete sts"),
        ("BLOCK", PROJECT, f"kubectl delete -f {tmp}/rendered.yaml"),
        ("BLOCK", PROJECT, "helm template teams-lite packaging/helm/teams-lite | kubectl delete -f -"),
        # IRREVERSIBLE: the chart's claims (the store, and the device's enrollment) by name, by
        # label, or `--all` / `-A` anywhere — a read-only release's own included, since every
        # release names its claims after the chart — and ANY namespace, which takes every claim in
        # it, on whichever real cluster the kubeconfig names.
        ("BLOCK", PROJECT, "kubectl -n teams-lite delete pvc data-teams-lite-0"),
        ("BLOCK", PROJECT, "kubectl delete pvc intune-teams-lite-0 -n teams-lite"),
        ("BLOCK", PROJECT, "kubectl delete persistentvolumeclaim/data-tl-teams-lite-0"),
        ("BLOCK", PROJECT, "kubectl -n teams-lite delete pvc -l app.kubernetes.io/name=teams-lite"),
        ("BLOCK", PROJECT, "kubectl delete pvc --all -n other"),
        ("BLOCK", PROJECT, "kubectl delete pvc -A --all"),
        ("BLOCK", PROJECT, "kubectl -n teams-lite delete pvc data-teams-lite-ro-0"),
        ("BLOCK", PROJECT, "kubectl delete namespace teams-lite"),
        ("BLOCK", PROJECT, "kubectl delete ns scratch"),
        ("BLOCK", PROJECT, "kubectl delete namespaces --all"),
        ("BLOCK", PROJECT, "kubectl delete ns/teams-lite"),
        ("BLOCK", PROJECT, "x=$(kubectl delete namespace teams-lite)"),
        # --- must allow ------------------------------------------------------
        # Reading the live backend is deliberately fine, through either address.
        ("ALLOW", PROJECT, f"bun run {tmp}/backend-reader.ts"),
        ("ALLOW", PROJECT, f"bun run {tmp}/relay-reader.ts"),
        ("ALLOW", PROJECT, f"bun run {tmp}/dev-backend-reader.ts"),
        # Reading the read positions is how "seen by" works — plural GET, allowed.
        ("ALLOW", PROJECT, f"bun run {tmp}/horizon-reader.ts"),
        # Reading the real mailbox is what the mail feature is for.
        ("ALLOW", PROJECT, f"bun run {tmp}/mail-reader.ts"),
        # Reading the code that implements the write is ordinary work, like any search.
        ("ALLOW", PROJECT, 'grep -rn "name=consumptionhorizon" src'),
        ("ALLOW", PROJECT, "grep -rn set_consumption_horizon src launcher web"),
        # The chat settings: reading them is what the sidebar is built on, and an example
        # that pins the sandbox chat is the sanctioned way to exercise the write.
        ("ALLOW", PROJECT, f"bun run {tmp}/chat-setting-reader.ts"),
        ("ALLOW", PROJECT, "cargo run --example guard-test-chat-setting-read"),
        ("ALLOW", PROJECT, "cargo run --example guard-test-sandbox-chat-setting"),
        ("ALLOW", PROJECT, 'grep -rn "name=alerts" src'),
        ("ALLOW", PROJECT, "grep -rn set_chat_muted src web"),
        # The trackers: reading one is what the preview cards are built on, and asking who
        # approved a merge request is the message menu's own question.
        ("ALLOW", PROJECT, f"bun run {tmp}/mr-approval-reader.ts"),
        ("ALLOW", PROJECT, "cargo run --example guard-test-mr-read"),
        ("ALLOW", PROJECT, "grep -rn merge_requests src web"),
        ("ALLOW", PROJECT, "grep -rn gitlab_set_approval src web"),
        # Reading presence is what the person card is built on, in every shape.
        ("ALLOW", PROJECT, f"bun run {tmp}/presence-reader.ts"),
        ("ALLOW", PROJECT, "cargo run --example guard-test-presence-read"),
        # …and so is reading the code that publishes it.
        ("ALLOW", PROJECT, "grep -rn register_available_endpoint src"),
        # A TRACKED example is reviewed code, and this one only reads.
        ("ALLOW", PROJECT, "cargo run --example readstate_recon -- --conv 19:x"),
        # Which devices are subscribed is a read, like any other status question.
        ("ALLOW", PROJECT, f"bun run {tmp}/push-status-reader.ts"),
        ("ALLOW", PROJECT, f"bun run {tmp}/settings-reader.ts"),
        # Which chats are sealed names no key and changes nothing: diagnosing stays normal work.
        ("ALLOW", PROJECT, f"bun run {tmp}/seal-status-reader.ts"),
        ("ALLOW", PROJECT, "grep -rn 'seal_set' src/"),
        # …and so is which conversations the agent answers in.
        ("ALLOW", PROJECT, f"bun run {tmp}/agent-status-reader.ts"),
        # …and so is reading back the names and faces the user chose themselves.
        ("ALLOW", PROJECT, f"bun run {tmp}/person-override-reader.ts"),
        # …and so is reading back the emoji pack the user built themselves.
        ("ALLOW", PROJECT, f"bun run {tmp}/emoji-reader.ts"),
        ("ALLOW", PROJECT, "cargo run --example guard-test-signin-read"),
        ("ALLOW", PROJECT, "cargo run --example signin_window_recon"),
        ("ALLOW", PROJECT, f"bun run {tmp}/signin-asker.ts"),
        ("ALLOW", PROJECT, f"bun run {tmp}/persona-reader.ts"),
        ("ALLOW", PROJECT, f"bun run {tmp}/update-checker.ts"),
        # Asking whether the engine is there names no path and changes nothing.
        ("ALLOW", PROJECT, f"bun run {tmp}/engine-reader.ts"),
        ("ALLOW", PROJECT, f"bun run {tmp}/board-sound-reader.ts"),
        # Reading the call state names no write and reaches nobody.
        ("ALLOW", PROJECT, f"bun run {tmp}/call-status-reader.ts"),
        # An example pinned to the pre-authorized channel is the sanctioned shape,
        # and one that only reads needs no target at all.
        ("ALLOW", PROJECT, "cargo run --example guard-test-sandbox-send"),
        ("ALLOW", PROJECT, "cargo run --example guard-test-read-only"),
        ("ALLOW", PROJECT, "cargo run --example broker_token"),
        # The real probe this feature ships with must keep running.
        ("ALLOW", PROJECT, "cargo run --example agent_stream_probe"),
        # Reading the code that implements the token endpoint is ordinary work.
        ("ALLOW", PROJECT, 'grep -rn "__write-token" web/src'),
        # Commands that only NAME a file run nothing, whatever is inside it.
        ("ALLOW", PROJECT, "git add web/scripts/scroll-probe.ts"),
        ("ALLOW", PROJECT, "wc -l web/src/lib/ws-client.ts web/mock/server.ts"),
        # `bun` has to be at a command position: unanchored, those three letters matched
        # inside `stage-bundle.ts` and read as an interpreter about to serve the app.
        ("ALLOW", PROJECT, "wc -l web/scripts/stage-bundle.ts web/server.ts"),
        ("ALLOW", PROJECT, "grep -n RUNTIME_ENTRIES web/scripts/stage-bundle.ts web/server.ts"),
        ("ALLOW", PROJECT, "sed -n 1,20p web/playwright.config.ts"),
        # Tracked scripts are reviewed code, including from a subdirectory.
        ("ALLOW", WEB, "bun run scripts/scroll-probe.ts --steps 10"),
        ("ALLOW", WEB, "bun run preview -- --out /tmp/shot"),
        # The sanctioned live driver: it types in the designated sandbox chat and
        # proves that from the app's own state before every key, so it must reach the
        # shell — a guard that blocked it would leave hand-rolling as the only way.
        ("ALLOW", WEB, "bun run sandbox"),
        ("ALLOW", WEB, 'bun run sandbox -- --type "hello" --send'),
        ("ALLOW", WEB, "bun run scripts/sandbox-live.ts --local"),
        # The other sanctioned live driver: it JOINS the one meeting the user authorized
        # for testing, and re-reads the button's own `data-join-url` before it clicks. A
        # meeting join cannot be exercised on the mock or from a cargo example — the
        # answer and its acknowledgement arrive on the backend's real trouter socket — so
        # blocking this would leave hand-rolling as the only way to test the feature.
        ("ALLOW", WEB, "bun run join-live"),
        ("ALLOW", WEB, "bun run join-live -- --local --hold 45"),
        ("ALLOW", WEB, "bun run scripts/join-live.ts"),
        # The third one: it PLACES a call to the one person the user authorized, and proves
        # that target twice out of the app's own state — the composer's conversation id and
        # the call button's own — immediately before the click. A call that the service ends
        # after two seconds can be diagnosed nowhere else: the mock has no tenant, and the
        # reason arrives on frames the page receives and renders nowhere.
        ("ALLOW", WEB, "bun run call-live"),
        ("ALLOW", WEB, "bun run call-live -- --local --hold 20"),
        ("ALLOW", WEB, "bun run scripts/call-live.ts"),
        # No exemption is a licence for a driver that merely mentions them: what is
        # allowed is running THOSE files, not borrowing their names.
        ("BLOCK", WEB, f"bun run {tmp}/join-live-copy.ts"),
        ("BLOCK", WEB, f"bun run {tmp}/call-live-copy.ts"),
        ("ALLOW", WEB, "bun run dev:mock"),
        ("ALLOW", PROJECT, "TEAMS_LITE_READ_ONLY=1 cargo run --bin server"),
        ("ALLOW", PROJECT, "TEAMS_LITE_READ_ONLY=1 target/release/server"),
        # Stopping or inspecting a process is cleanup, whatever it names.
        ("ALLOW", PROJECT, "pkill -f 'target/debug/server'"),
        ("ALLOW", PROJECT, "pkill -f 'vite dev'"),
        ("ALLOW", PROJECT, 'pgrep -af "vite dev|mock/server.ts"'),
        # A probe that NAMES a browser driver drives nothing.
        ("ALLOW", PROJECT, "pgrep -af playwright"),
        ("ALLOW", PROJECT, "pkill -f chromium"),
        # …but a probe is not a licence for whatever follows it.
        ("BLOCK", PROJECT, "pkill -f chrome; node -e \"require('playwright')\""),
        # Looking at the binary is not running it — but a compound that runs it is.
        ("ALLOW", PROJECT, "ls -la target/debug/server"),
        # `-n` is bash's syntax-check mode: it parses the launcher and exits.
        ("ALLOW", PROJECT, "bash -n bin/teams-dev-server.sh"),
        ("ALLOW", PROJECT, "shellcheck bin/teams-dev-server.sh"),
        # Ordinary file work on a launcher runs nothing — the `teams` command included.
        ("ALLOW", PROJECT, "ls -la launcher/dist/teams"),
        ("ALLOW", PROJECT, "git add launcher/src/index.ts launcher/build.ts"),
        ("ALLOW", PROJECT, "grep -n backendPort launcher/src/backend.ts"),
        # A `sed` over a list of files that names both `stage-bundle.ts` and the
        # launcher's entrypoint edits text: `bun` inside a word is not an interpreter.
        ("ALLOW", PROJECT, "sed -i 's|a|b|g' web/scripts/stage-bundle.ts launcher/src/index.ts"),
        # Searching the repo runs nothing, and a regex alternation is not a pipeline:
        # the bare `|` in a pattern used to read as a command separator, which blocked
        # a search of this very repo for the launcher it documents.
        ("ALLOW", PROJECT, 'grep -rn "teams-web\\|teams --web" README.md AGENTS.md'),
        ("ALLOW", PROJECT, 'rg "intune-container stop\\|systemctl --user start teams-lite"'),
        ("ALLOW", PROJECT, "git grep -n 'target/release/server'"),
        # …but a search is not a licence for whatever follows it.
        ("BLOCK", PROJECT, "grep -rn teams README.md; teams --no-open"),
        ("BLOCK", PROJECT, "grep -rn server src && target/release/server"),
        ("ALLOW", PROJECT, "chmod +x bin/teams-launcher.sh"),
        ("ALLOW", PROJECT, "git commit -m 'feat(launcher): teams now opens the web app'"),
        # Asking a launcher what its flags are prints text and exits.
        ("ALLOW", PROJECT, "launcher/dist/teams --help"),
        ("ALLOW", PROJECT, "teams -h"),
        # …but a usage line is not a licence for what follows it.
        ("BLOCK", PROJECT, "launcher/dist/teams --help && launcher/dist/teams"),
        ("ALLOW", PROJECT, "cd launcher && bun test"),
        ("ALLOW", PROJECT, "chmod +x bin/teams-dev-server.sh"),
        ("ALLOW", PROJECT, "git add bin/teams-launcher.sh bin/teams-dev-server.sh"),
        # Removing the retired launcher and check scripts is the change that retired them, and
        # it runs none of them.
        ("ALLOW", PROJECT, "git rm bin/teams-lite-backend.sh bin/teams-lite-broker-check.sh"),
        ("ALLOW", PROJECT, "grep -n broker bin/teams-dev-server.sh"),
        ("BLOCK", PROJECT, "bash -n bin/teams-dev-server.sh && bin/teams-dev-server.sh"),
        ("BLOCK", PROJECT, "ls target/debug/server && ./target/debug/server"),
        ("BLOCK", PROJECT, "nohup target/release/server &"),
        # Prose that names the binary runs nothing: a commit message, a doc line.
        ("ALLOW", PROJECT, "git commit -m 'fix: stop blocking `ls target/debug/server`'"),
        ("ALLOW", PROJECT, "git commit -m 'chore: systemctl --user start teams-lite at boot'"),
        # …and that holds for a browser too: describing what a measurement showed, or
        # what a spec covers, drives nothing.
        ("ALLOW", PROJECT, "git commit -m 'fix(web): Chromium fell to 8 fps on 100 words'"),
        ("ALLOW", PROJECT, "git commit -q -F /tmp/msg-about-playwright.txt"),
        ("ALLOW", PROJECT, "git tag -a v1 -m 'e2e now runs under chromium'"),
        # …but a commit is not a licence for whatever follows it.
        ("BLOCK", PROJECT, "git commit -m 'wip' && node -e \"require('playwright')\""),
        ("BLOCK", PROJECT, f"git commit -m 'wip'; bun run {tmp}/incident-driver.ts"),
        # Only `git commit`/`git tag` themselves: what follows a bare `git` may be a
        # command git runs.
        ("BLOCK", PROJECT, "git -c core.editor='chromium --headless' commit"),
        # Installing and DIAGNOSING the always-on service is agent work. Starting it
        # is the user's call, so everything that only looks or stops stays allowed.
        ("ALLOW", PROJECT, "bin/teams-lite-service.sh install"),
        ("ALLOW", PROJECT, "bin/teams-lite-service.sh status"),
        # Plain `update` is how a staged commit reaches the user's phone, and it waits
        # for a live @claude run on its own.
        ("ALLOW", PROJECT, "bin/teams-lite-service.sh update"),
        # Prose naming the flag runs nothing.
        ("ALLOW", PROJECT, "git commit -m 'feat(service): wait unless --now'"),
        ("ALLOW", PROJECT, "systemctl --user status teams-lite-backend.service"),
        ("ALLOW", PROJECT, "systemctl --user cat teams-lite-backend.service"),
        ("ALLOW", PROJECT, "systemctl --user stop teams-lite.target"),
        ("ALLOW", PROJECT, "systemctl --user disable teams-lite.target"),
        ("ALLOW", PROJECT, "systemctl --user daemon-reload"),
        ("ALLOW", PROJECT, "journalctl --user -u teams-lite-backend -n 50 --no-pager"),
        ("ALLOW", PROJECT, "ls -la $HOME/.local/share/teams-lite/service/server"),
        # Looking at the released install starts nothing either — including the two
        # commands that FIND it, which is how its own command line gets read.
        ("ALLOW", PROJECT, "ls -la ~/.cache/teams-lite/server"),
        ("ALLOW", PROJECT, "pgrep -af 'cache/teams-lite/server'"),
        ("ALLOW", PROJECT, "pgrep -af teams-bin"),
        ("ALLOW", PROJECT, "ls -l ~/.teams-lite/bin/teams-bin"),
        # Diagnosing the container is the normal way to answer "why is it empty" — its own
        # read-only verbs, and the diagnostic that replaced both check scripts, which reads
        # the crate's runtime state and one keyring property and asks nothing else.
        ("ALLOW", PROJECT, "intune-container status"),
        ("ALLOW", PROJECT, "intune-container doctor"),
        ("ALLOW", PROJECT, "intune-container --help"),
        ("ALLOW", PROJECT, "intune-container autostart status"),
        ("ALLOW", PROJECT, "intune-container backup-inspect"),
        ("ALLOW", PROJECT, "cargo run --example intune_status"),
        ("ALLOW", PROJECT, "systemctl --user status intune-container.service"),
        ("ALLOW", PROJECT, "systemctl --user status teams-lite-intune-repair.service"),
        ("ALLOW", PROJECT, "journalctl --user -t teams-lite-broker-repair -n 50 --no-pager"),
        # Reading a unit's state over raw D-Bus names no method that starts anything.
        (
            "ALLOW",
            PROJECT,
            "busctl --user get-property org.freedesktop.systemd1 "
            "/org/freedesktop/systemd1/unit/teams_2dlite_2dintune_2drepair_2eservice "
            "org.freedesktop.systemd1.Unit ActiveState",
        ),
        ("ALLOW", PROJECT, "busctl --user introspect org.freedesktop.systemd1 /org/freedesktop/systemd1"),
        # An example that only READS the crate is what the diagnostic is built on.
        ("ALLOW", PROJECT, "cargo run --example guard-test-crate-read"),
        # A retired check script WITHOUT `--repair` still only reads, wherever its copy is.
        ("ALLOW", PROJECT, "$HOME/.local/share/teams-lite/service/teams-lite-broker-check.sh"),
        ("ALLOW", PROJECT, "$HOME/.local/share/teams-lite/service/teams-lite-broker-bus-check.sh"),
        # Searching for, killing or inspecting what NAMES a hidden argument runs nothing.
        ("ALLOW", PROJECT, "grep -rn __teams-lite-repair-broker src"),
        ("ALLOW", PROJECT, "rg '__rootless-supervise|__rootless-exec' src/intune.rs"),
        ("ALLOW", PROJECT, "git grep -n __teams-lite-repair-broker"),
        ("ALLOW", PROJECT, "pgrep -af __rootless-supervise"),
        ("ALLOW", PROJECT, "cargo test --lib intune"),
        ("ALLOW", PROJECT, "cargo test --bin server every_gated_method_is_named_in_the_automation_guard"),
        # Prose that names a repair runs nothing: a commit message, a doc line.
        ("ALLOW", PROJECT, "git commit -m 'feat: run broker-check.sh --repair from the timer'"),
        ("ALLOW", PROJECT, "git commit -m 'fix: broker-bus-check.sh --repair runs from the timer'"),
        ("ALLOW", PROJECT, "git commit -m 'docs: intune-container stop && start unlocks it'"),
        ("ALLOW", PROJECT, "git commit -m 'feat: route __teams-lite-repair-broker before the runtime'"),
        ("ALLOW", PROJECT, "git commit -m 'docs: target/release/server __rootless-supervise boots it'"),
        ("ALLOW", PROJECT, "git commit -m 'fix: StartTransientUnit for the repair, over busctl'"),
        # Asking whether autostart is installed only reads, through the crate too.
        ("ALLOW", PROJECT, "cargo run --example guard-test-crate-autostart-status"),
        # The systemd-run spellings that DO reach the unit: told with -E or --setenv, copied with
        # -E NAME from a variable set in front, or a scope, which inherits this shell.
        ("ALLOW", PROJECT, "systemd-run --user --setenv=TEAMS_LITE_READ_ONLY=1 --unit=probe target/release/server"),
        ("ALLOW", PROJECT, "TEAMS_LITE_READ_ONLY=1 systemd-run --user -E TEAMS_LITE_READ_ONLY target/release/server"),
        ("ALLOW", PROJECT, "TEAMS_LITE_READ_ONLY=1 systemd-run --user --scope target/release/server"),
        # Cleanup stays cleanup when it is chained to more cleanup, or to nothing that starts —
        # including a kill whose pattern names `cargo run --bin server`, which is matched anywhere.
        ("ALLOW", PROJECT, "pkill -f target/release/server && sleep 1"),
        ("ALLOW", PROJECT, "kill -9 $(pgrep -f target/release/server)"),
        ("ALLOW", PROJECT, "pkill -f 'vite dev'; pkill -f 'mock/server.ts'"),
        ("ALLOW", PROJECT, "pgrep -af 'vite dev|mock/server.ts' | head -5"),
        ("ALLOW", PROJECT, "pkill -f 'cargo run --bin server'; sleep 1"),
        ("ALLOW", PROJECT, "if pgrep -af 'vite dev' >/dev/null; then echo running; fi"),
        ("ALLOW", PROJECT, "[ -n \"$(pgrep -af 'vite dev')\" ] && echo yes"),
        ("ALLOW", PROJECT, "pgrep -af __teams-lite-repair-broker"),
        # A wrapper is a prefix for what is refused, and nothing more: what it runs decides.
        ("ALLOW", PROJECT, "timeout 600 cargo test"),
        ("ALLOW", PROJECT, "timeout 30 intune-container status"),
        ("ALLOW", PROJECT, "timeout 20 cargo run --example intune_status"),
        ("ALLOW", PROJECT, "TEAMS_LITE_READ_ONLY=1 timeout 30 target/release/server"),
        ("ALLOW", PROJECT, "timeout 20 env TEAMS_LITE_READ_ONLY=1 target/release/server"),
        ("ALLOW", PROJECT, "(cd web && bun run dev:mock)"),
        # `command -v` and `type` say where a program is, and run nothing.
        ("ALLOW", PROJECT, "command -v intune-container teams"),
        ("ALLOW", PROJECT, "type -a teams intune-container"),
        # The repair unit's state is read, and a failed one is cleared, without touching it.
        ("ALLOW", PROJECT, "systemctl --user reset-failed teams-lite-intune-repair.service"),
        # The same words as TEXT: a search, a log search, a quoted commit message whose
        # backticks, parentheses and separators are characters, and the heredoc a commit body is
        # written with. Only the executable view can tell those from the commands above.
        ("ALLOW", PROJECT, "rg '(intune-container stop)|timeout 120 intune-container stop' AGENTS.md"),
        ("ALLOW", PROJECT, "git log --oneline --grep='intune-container stop'"),
        (
            "ALLOW",
            PROJECT,
            "git commit -m 'fix(guard): refuse `(intune-container stop)` and `intune-container restart; echo ok`'",
        ),
        ("ALLOW", PROJECT, 'git commit -m "fix(guard): (systemd-run --user target/release/server) needs -E"'),
        (
            "ALLOW",
            PROJECT,
            "git commit -m \"$(cat <<'EOF'\n"
            "fix(guard): refuse `timeout 120 intune-container stop`\n"
            "\n"
            "The hook reads `(intune-container stop)`, `{ intune-container stop; }`,\n"
            "`pkill -f x; target/release/server` and `$(teams --no-open)`, and\n"
            "`systemd-run --user target/release/server` | as commands — and\n"
            "`pkill -f __teams-lite-repair-broker` too.\n"
            "EOF\n"
            ")\"",
        ),
        ("ALLOW", PROJECT, 'python3 -c "print(\'(intune-container stop)\')"'),
        # A production web server that names a read-only backend is fine.
        ("ALLOW", WEB, "TEAMS_LITE_WS_URL=ws://127.0.0.1:19430 bun run start"),
        # Rule 3d's open half: making the image, reading it, and running it told read-only.
        ("ALLOW", PROJECT, "docker compose -f packaging/docker/compose.yaml build"),
        ("ALLOW", PROJECT, "docker build -f packaging/docker/Dockerfile -t teams-lite:local ."),
        ("ALLOW", PROJECT, "docker compose -f packaging/docker/compose.yaml config"),
        ("ALLOW", PROJECT, "docker compose -f packaging/docker/compose.yaml logs -f"),
        ("ALLOW", PROJECT, "docker compose -f packaging/docker/compose.yaml ps"),
        (
            "ALLOW",
            PROJECT,
            "docker compose -f packaging/docker/compose.yaml exec teams-lite teams-lite-intune-status",
        ),
        ("ALLOW", PROJECT, "docker images teams-lite:local"),
        ("ALLOW", PROJECT, "docker logs teams-lite"),
        ("ALLOW", PROJECT, "docker inspect teams-lite"),
        # Taking down what is NOT the user's install stays cleanup: a container of another name —
        # which is why tooling's own runs give theirs one — an image, another project, a volume of
        # one's own, and a prune that takes no volume.
        ("ALLOW", PROJECT, "docker stop teams-lite-ro"),
        ("ALLOW", PROJECT, "docker rm -f tl-check"),
        ("ALLOW", PROJECT, "docker image rm teams-lite:local"),
        ("ALLOW", PROJECT, "docker rmi teams-lite:local"),
        ("ALLOW", PROJECT, "docker volume rm my-scratch-volume"),
        ("ALLOW", PROJECT, "docker volume ls"),
        ("ALLOW", PROJECT, "docker volume inspect teams-lite_intune"),
        ("ALLOW", PROJECT, "docker system prune -f"),
        ("ALLOW", PROJECT, "docker container prune -f"),
        ("ALLOW", PROJECT, "cd ~/other && docker compose down"),
        ("ALLOW", PROJECT, "cd ~/other && docker compose down -v"),
        # …and an `exec` of anything but a hidden argument is reading the container, or tidying
        # inside it — a compose `rm` exec'd in is not a compose `rm`.
        ("ALLOW", PROJECT, "docker exec teams-lite teams-lite-intune-status"),
        ("ALLOW", PROJECT, "docker exec teams-lite ls -la /home/teams/.local/share/intune-container"),
        ("ALLOW", PROJECT, "docker compose -f packaging/docker/compose.yaml exec teams-lite rm -f /tmp/scratch"),
        ("ALLOW", PROJECT, "kubectl -n teams-lite exec teams-lite-0 -- cat /proc/1/status"),
        # The entrypoint is read in the checkout, and a container that merely shares the prefix of
        # its name is another container.
        ("ALLOW", PROJECT, "cat packaging/docker/entrypoint.sh"),
        ("ALLOW", PROJECT, "docker exec teams-lite-ro ls /usr/local/bin"),
        ("ALLOW", PROJECT, "git commit -m 'docs: docker exec teams-lite teams-lite-container stops the container'"),
        # …and READING the image's own programs inside the install runs none of them: what a
        # published image really carries is checked against the checkout this way. Rules 3b and
        # 3c-ii refuse the program the exec RUNS, never a file it is handed.
        ("ALLOW", PROJECT, "docker exec teams-lite cat /usr/local/bin/teams-lite-container"),
        ("ALLOW", PROJECT, "docker exec teams-lite ls -l /usr/local/bin/teams-lite-container"),
        ("ALLOW", PROJECT, "docker exec teams-lite sha256sum /usr/local/bin/teams-lite-container"),
        ("ALLOW", PROJECT, "docker exec teams-lite grep -n trap /usr/local/bin/teams-lite-container"),
        ("ALLOW", PROJECT, "docker exec teams-lite sh -c 'grep -n take_instance_lock /usr/local/bin/teams-lite-container'"),
        ("ALLOW", PROJECT, "kubectl -n teams-lite exec teams-lite-0 -- cat /usr/local/bin/teams-lite-container"),
        ("ALLOW", PROJECT, "docker exec teams-lite cat /usr/local/bin/teams-lite-intune-selftest"),
        ("ALLOW", PROJECT, "docker exec teams-lite sha256sum /usr/local/lib/teams-lite/server /usr/local/bin/teams"),
        ("ALLOW", PROJECT, "docker exec teams-lite ls -la /home/teams/.cache/teams-lite"),
        ("ALLOW", PROJECT, "kubectl -n teams-lite exec teams-lite-0 -- ls -l /usr/local/lib/teams-lite"),
        ("ALLOW", PROJECT, "docker exec teams-lite sh -c 'command -v teams'"),
        ("ALLOW", PROJECT, "docker exec teams-lite sh -c 'echo teams'"),
        ("ALLOW", PROJECT, "docker exec teams-lite runuser teams -c id"),
        ("ALLOW", PROJECT, "docker exec -u teams teams-lite id"),
        # The read-only diagnostic is another program, by its wrapper or by the binary behind it.
        ("ALLOW", PROJECT, "docker exec teams-lite /usr/local/lib/teams-lite/intune-status"),
        ("ALLOW", PROJECT, "kubectl -n teams-lite exec teams-lite-0 -- teams-lite-intune-status"),
        # A bare `teams` or `server` in a container of ANOTHER name is somebody else's program.
        ("ALLOW", PROJECT, "docker exec teams-lite-ro teams --version"),
        ("ALLOW", PROJECT, "docker exec other-app ./server"),
        ("ALLOW", PROJECT, "kubectl exec api-0 -- server --version"),
        ("ALLOW", PROJECT, "echo docker exec teams-lite teams"),
        ("ALLOW", PROJECT, "git commit -m 'docs: docker exec teams-lite teams starts a second stack'"),
        ("ALLOW", PROJECT, "grep -rn 'docker exec -u teams teams-lite teams --no-open' AGENTS.md"),
        # Rule 3d-iii's open half: a container of ANOTHER name is somebody's own to join, the host's
        # pid namespace is not this rule's, an ephemeral container with no --target joins nothing,
        # and `docker top` lists the install's processes from the host's side with no join at all.
        ("ALLOW", PROJECT, "docker run --rm --pid container:teams-lite-ro busybox ps"),
        ("ALLOW", PROJECT, "kubectl debug -it teams-lite-ro-0 --image=busybox --target=teams-lite -- sh"),
        ("ALLOW", PROJECT, "kubectl debug node/worker-1 -it --image=busybox"),
        ("ALLOW", PROJECT, "docker top teams-lite"),
        ("ALLOW", PROJECT, "docker top teams-lite -o pid,comm"),
        ("ALLOW", PROJECT, "git commit -m 'docs: docker run --pid container:teams-lite busybox kill 1 is refused'"),
        # Rule 3d-ii's open half: looking inside sends nothing — signal 0 only asks whether PID 1
        # exists, a list of signal names is a list, and `kill` as a WORD is not a command — and a
        # container or a pod of another name (tooling's own `teams-lite-ro` included, and a pod
        # of another name in the chart's namespace) is somebody's own to signal.
        ("ALLOW", PROJECT, "docker exec teams-lite kill -0 1"),
        # …which in this image is dash's builtin: it ships no kill binary, so a direct exec of
        # `kill` finds nothing to run — the shell spelling is the one that answers.
        ("ALLOW", PROJECT, "docker exec teams-lite sh -c 'kill -0 1'"),
        ("ALLOW", PROJECT, "docker exec teams-lite kill -l"),
        ("ALLOW", PROJECT, "docker exec teams-lite kill -l 15"),
        ("ALLOW", PROJECT, "docker exec teams-lite cat /proc/1/status"),
        ("ALLOW", PROJECT, "docker exec teams-lite grep -c kill /usr/local/bin/teams-lite-intune-status"),
        ("ALLOW", PROJECT, "docker exec teams-lite sh -c 'echo kill 1'"),
        ("ALLOW", PROJECT, "docker exec teams-lite sh -c 'command -v kill'"),
        ("ALLOW", PROJECT, "docker exec teams-lite ls /proc"),
        ("ALLOW", PROJECT, "docker exec teams-lite-ro kill 1"),
        ("ALLOW", PROJECT, "docker exec other kill 1"),
        ("ALLOW", PROJECT, "kubectl -n teams-lite exec debug-shell -- kill 1"),
        ("ALLOW", PROJECT, "kubectl exec teams-lite-ro-0 -- kill 1"),
        ("ALLOW", PROJECT, "docker kill -s HUP my-scratch"),
        ("ALLOW", PROJECT, "echo docker exec teams-lite kill 1"),
        ("ALLOW", PROJECT, "git commit -m 'docs: docker exec teams-lite kill 1 is a stop'"),
        ("ALLOW", PROJECT, "grep -rn 'docker exec teams-lite kill 1' AGENTS.md"),
        ("ALLOW", PROJECT, "grep -rn __teams-lite-intune-boot src"),
        ("ALLOW", PROJECT, "pgrep -af __teams-lite-intune-boot"),
        ("ALLOW", PROJECT, "git commit -m 'docs: kubectl exec teams-lite-0 -- server __teams-lite-intune-stop is refused'"),
        ("ALLOW", PROJECT, "git commit -m 'docs: docker compose down -v deletes the enrollment'"),
        ("ALLOW", PROJECT, "grep -rn 'docker volume prune' AGENTS.md"),
        ("ALLOW", PROJECT, "cargo run --example guard-test-embedded-read"),
        # The self-test on a THROWAWAY container: nothing mounted on the Intune data directory
        # (an unrelated mount, or a tmpfs there, is nothing of the user's), local or published.
        ("ALLOW", PROJECT, "docker run --rm --entrypoint teams-lite-intune-selftest teams-lite:local"),
        (
            "ALLOW",
            PROJECT,
            "docker run --rm --security-opt seccomp=unconfined --security-opt systempaths=unconfined "
            "--entrypoint teams-lite-intune-selftest teams-lite:local",
        ),
        # The spelling every block text hands out — the self-test's own header's, the Dockerfile's
        # and compose.yaml's, with the AppArmor option a host that enforces a profile needs — on
        # one line and in the block texts' own three lines.
        (
            "ALLOW",
            PROJECT,
            "docker run --rm --security-opt seccomp=unconfined --security-opt systempaths=unconfined "
            "--security-opt apparmor=unconfined --entrypoint teams-lite-intune-selftest teams-lite:local",
        ),
        (
            "ALLOW",
            PROJECT,
            "docker run --rm --security-opt seccomp=unconfined --security-opt systempaths=unconfined \\\n"
            "    --security-opt apparmor=unconfined \\\n"
            "    --entrypoint teams-lite-intune-selftest teams-lite:local",
        ),
        (
            "ALLOW",
            PROJECT,
            "docker run --rm --entrypoint teams-lite-intune-selftest -v /tmp/scratch:/tmp/scratch "
            "ghcr.io/theophile-wallez/teams-lite:latest",
        ),
        (
            "ALLOW",
            PROJECT,
            "docker run --rm --entrypoint teams-lite-intune-selftest "
            "--tmpfs /home/teams/.local/share/intune-container teams-lite:local",
        ),
        # …on a network namespace of its OWN, by default or by name — a network merely called
        # `hostnet` is one of those — and podman's own user-mode network.
        ("ALLOW", PROJECT, "docker run --rm --network bridge --entrypoint teams-lite-intune-selftest teams-lite:local"),
        ("ALLOW", PROJECT, "docker run --rm --network hostnet --entrypoint teams-lite-intune-selftest teams-lite:local"),
        ("ALLOW", PROJECT, "podman run --rm --network=slirp4netns --entrypoint teams-lite-intune-selftest teams-lite:local"),
        # …and an IPC namespace of its own, by default or by name; another image may share the host's.
        ("ALLOW", PROJECT, "docker run --rm --ipc private --entrypoint teams-lite-intune-selftest teams-lite:local"),
        ("ALLOW", PROJECT, "docker run --rm --ipc=shareable --entrypoint teams-lite-intune-selftest teams-lite:local"),
        ("ALLOW", PROJECT, "docker run --rm --ipc host python:3.13-alpine ls /dev/shm"),
        # The self-test refuses any argument itself, so a word after the image is not a second run.
        ("ALLOW", PROJECT, "docker run --rm --entrypoint teams-lite-intune-selftest teams-lite:local --help"),
        # A read-only run with the store (it boots no Intune container), and the host-broker
        # diagnostic, which reads the host's state read-only as the host user.
        (
            "ALLOW",
            PROJECT,
            "docker run --rm --name teams-lite-ro -e TEAMS_LITE_READ_ONLY=1 "
            "-v teams-lite_data:/home/teams/.local/share/teams-lite teams-lite:local",
        ),
        (
            "ALLOW",
            PROJECT,
            "docker run --rm --pid=host --user 1000:1000 -e TEAMS_LITE_INTUNE_MODE=host "
            "--entrypoint teams-lite-intune-status "
            "-v /home/u/.local/share/intune-container:/home/teams/.local/share/intune-container:ro teams-lite:local",
        ),
        (
            "ALLOW",
            PROJECT,
            "docker run --rm -e TEAMS_LITE_READ_ONLY=1 --pid=host --network=host teams-lite:local",
        ),
        ("ALLOW", PROJECT, "docker run --rm --env=TEAMS_LITE_READ_ONLY=1 teams-lite:local"),
        # The LAST word on the value is the one that counts, so a 1 after an earlier 0 is a proof
        # (and a 0 written for the CLI in front of `docker` is nothing the container sees); and a
        # read-only run may share the host's network, because it boots no Intune container.
        ("ALLOW", PROJECT, "docker run --rm -e TEAMS_LITE_READ_ONLY=0 -e TEAMS_LITE_READ_ONLY=1 teams-lite:local"),
        ("ALLOW", PROJECT, "TEAMS_LITE_READ_ONLY=0 docker run --rm -e TEAMS_LITE_READ_ONLY=1 teams-lite:local"),
        ("ALLOW", PROJECT, "docker run --rm -e TEAMS_LITE_READ_ONLY=1 --network host teams-lite:local"),
        (
            "ALLOW",
            PROJECT,
            "docker compose -f packaging/docker/compose.yaml run --rm -e TEAMS_LITE_READ_ONLY=1 teams-lite",
        ),
        (
            "ALLOW",
            PROJECT,
            "docker run --rm --pid=host --entrypoint teams-lite-intune-status teams-lite:local",
        ),
        # Another image, or a mount from a path that merely CONTAINS the name, is not this one.
        ("ALLOW", PROJECT, "docker run --rm --pid=host python:3.13-alpine ls /proc"),
        ("ALLOW", PROJECT, "docker run --rm -v /home/u/.t3/worktrees/teams-lite/x:/x alpine ls /x"),
        ("ALLOW", PROJECT, "docker compose up -d"),
        # And prose about it runs nothing.
        ("ALLOW", PROJECT, 'git commit -m "docs: start it with docker compose up teams-lite"'),
        # The published image is pulled, inspected and run read-only like the local one; a bind
        # mount named after the project is still a mount.
        ("ALLOW", PROJECT, "docker pull ghcr.io/theophile-wallez/teams-lite:latest"),
        (
            "ALLOW",
            PROJECT,
            "docker run --rm -e TEAMS_LITE_READ_ONLY=1 --pid=host ghcr.io/theophile-wallez/teams-lite:latest",
        ),
        ("ALLOW", PROJECT, "docker run --rm -v ./teams-lite:/data alpine ls /data"),
        # Rule 3e's open half: rendering, checking, packaging, publishing and reading the chart.
        (
            "ALLOW",
            PROJECT,
            "helm template teams-lite packaging/helm/teams-lite --set broker.intuneContainer.stateDir=/x",
        ),
        ("ALLOW", PROJECT, "helm lint --strict packaging/helm/teams-lite"),
        ("ALLOW", PROJECT, "packaging/helm/check.sh"),
        ("ALLOW", PROJECT / "packaging" / "helm", "bun test"),
        ("ALLOW", PROJECT, "helm package packaging/helm/teams-lite --version 0.1.7 --app-version build-0123abc"),
        ("ALLOW", PROJECT, "helm show values oci://ghcr.io/theophile-wallez/charts/teams-lite"),
        ("ALLOW", PROJECT, "helm -n teams-lite status teams-lite"),
        ("ALLOW", PROJECT, "helm -n teams-lite history teams-lite"),
        # …a dry run, and a release that states it is read-only as the last word on the value…
        ("ALLOW", PROJECT, "helm install teams-lite packaging/helm/teams-lite --dry-run"),
        ("ALLOW", PROJECT, "helm upgrade --install teams-lite packaging/helm/teams-lite --dry-run=server"),
        ("ALLOW", PROJECT, "helm install teams-lite packaging/helm/teams-lite --set readOnly=false --set readOnly=true"),
        ("ALLOW", PROJECT, "helm install teams-lite packaging/helm/teams-lite --set hostUser.uid=1000,readOnly=true"),
        ("ALLOW", PROJECT, "helm template teams-lite packaging/helm/teams-lite | kubectl apply --dry-run=client -f -"),
        # …another chart, or a values file that merely lives under a path named after the project…
        ("ALLOW", PROJECT, "helm upgrade --install grafana grafana/grafana -f /home/u/.t3/worktrees/teams-lite/x/values.yaml"),
        # …reading the workload…
        ("ALLOW", PROJECT, "kubectl -n teams-lite get pods"),
        ("ALLOW", PROJECT, "kubectl -n teams-lite logs -f teams-lite-0"),
        ("ALLOW", PROJECT, "kubectl -n teams-lite describe statefulset teams-lite"),
        ("ALLOW", PROJECT, "kubectl -n teams-lite exec teams-lite-0 -- teams-lite-intune-status"),
        ("ALLOW", PROJECT, "kubectl -n teams-lite rollout status statefulset/teams-lite"),
        ("ALLOW", PROJECT, "kubectl -n teams-lite get pvc"),
        ("ALLOW", PROJECT, "kubectl get ns"),
        # …a stop or a delete that says it is only a rehearsal…
        ("ALLOW", PROJECT, "kubectl -n teams-lite delete pvc data-teams-lite-0 --dry-run=client"),
        ("ALLOW", PROJECT, "kubectl -n teams-lite scale statefulset/teams-lite --replicas=0 --dry-run=client"),
        ("ALLOW", PROJECT, "helm uninstall teams-lite --dry-run"),
        # …and taking down what is NOT the chart's: a release of another name (a read-only one
        # tooling installed itself), its StatefulSet, a plugin, another claim, a PersistentVolume
        # (held back by its finalizer while a claim exists), every StatefulSet of another
        # namespace, and an ephemeral debug container, which copies nothing. (One aimed with
        # `--target` at the pod's container joins its pid namespace, which is rule 3d-iii's to
        # refuse; with no target it stands in a pid namespace of its own.)
        ("ALLOW", PROJECT, "helm uninstall teams-lite-ro -n teams-lite"),
        ("ALLOW", PROJECT, "helm plugin uninstall diff"),
        ("ALLOW", PROJECT, "kubectl -n teams-lite delete statefulset teams-lite-ro"),
        ("ALLOW", PROJECT, "kubectl delete pvc my-scratch-claim -n my-scratch-namespace"),
        ("ALLOW", PROJECT, "kubectl delete pv pvc-0123"),
        ("ALLOW", PROJECT, "kubectl -n other delete sts --all"),
        ("ALLOW", PROJECT, "kubectl debug -it teams-lite-0 --image=busybox"),
        ("ALLOW", PROJECT, 'git commit -m "docs: kubectl delete namespace teams-lite deletes the PVCs"'),
        # …a namespace named after it is a place, not the workload…
        ("ALLOW", PROJECT, "kubectl -n teams-lite rollout restart deployment/other"),
        ("ALLOW", PROJECT, "kubectl --namespace=teams-lite delete pod debug-shell"),
        # …and a port-forward onto the live loopback port the browser guard knows.
        ("ALLOW", PROJECT, "kubectl -n teams-lite port-forward svc/teams-lite 19443:19443"),
        ("ALLOW", PROJECT, "kubectl port-forward pod/teams-lite-0 19443 --address 127.0.0.1"),
        ("ALLOW", PROJECT, "kubectl port-forward svc/other 8080:80"),
        ("ALLOW", PROJECT, 'git commit -m "docs: helm install teams-lite, then port-forward 8080:19443"'),
        # The other half of the review's fixes: what must stay open.
        ("ALLOW", PROJECT, "helm diff upgrade teams-lite packaging/helm/teams-lite -n teams-lite"),
        ("ALLOW", PROJECT, "helm diff rollback teams-lite 3"),
        (
            "ALLOW",
            PROJECT,
            "helm install tl packaging/helm/teams-lite --set-string image.tag=0123456 --set readOnly=true",
        ),
        ("ALLOW", PROJECT, "helm install tl packaging/helm/teams-lite --set-json readOnly=false --set readOnly=true"),
        ("ALLOW", PROJECT, "helm install teams-lite-ro oci://ghcr.io/theophile-wallez/charts/teams-lite --set readOnly=true"),
        ("ALLOW", PROJECT, "kubectl -n teams-lite port-forward svc/teams-lite 19443:web"),
        ("ALLOW", PROJECT, "kubectl -n teams-lite get pods --all"),
        ("ALLOW", PROJECT, "kubectl -n teams-lite rollout status statefulset"),
        ("ALLOW", PROJECT, "kubectl -n other rollout restart statefulset"),
        ("ALLOW", PROJECT, f"kubectl apply -f {tmp}/unrelated.yaml"),
        ("ALLOW", PROJECT, f"kubectl apply -f {tmp}/rendered.yaml --dry-run=client"),
        ("ALLOW", PROJECT, "docker run --rm -v ./teams-lite:/data alpine ls /data"),
        ("ALLOW", PROJECT, "cd packaging/helm/teams-lite && helm template tl ."),
        ("ALLOW", PROJECT, "cd ~/src/teams-lite && helm upgrade --install grafana grafana/grafana"),
        ("ALLOW", PROJECT, "helmfile -f /dev/null sync"),
    ]


# The example fixtures are written into the repo's own examples/ directory, which is SHARED:
# several agents work in one worktree at once, and each may run this file. With one name per
# fixture, a copy that finished first removed the other copy's fixtures in its `finally`, the
# hook then found no source behind `--example NAME` and allowed it — measured: the same eight
# BLOCK rows read ALLOW (308/316), nondeterministically, with nothing wrong in the hook. So
# every run writes its own copies under a suffix of its own, and points the commands at them.
RUN_SUFFIX = f"-run{os.getpid()}"


def this_runs_example(name: str) -> str:
    """`guard-test-x.rs` -> the stem this run writes it under (`guard-test-x-run1234`)."""
    return name[: -len(".rs")] + RUN_SUFFIX


def aimed_at_this_run(command: str) -> str:
    """Point every `--example NAME` naming a fixture at this run's own copy of it."""
    for name in EXAMPLE_FIXTURES:
        stem = re.escape(name[: -len(".rs")])
        command = re.sub(rf"(--example\s+){stem}(?![\w-])", rf"\g<1>{this_runs_example(name)}", command)
    return command


# WHAT A REFUSAL RECOMMENDS is held to the same two halves. A block text that hands the reader a
# way forward which itself fails — or which this hook refuses — is a guard whose reader learns to
# stop reading it. Two shipped that way: the self-test without `--security-opt
# apparmor=unconfined`, which a host enforcing an AppArmor profile refuses `mount` for, and
# `docker exec teams-lite kill -0 1`, which finds no `kill` in an image that ships none. So each
# case is a command the hook refuses, the commands its refusal must recommend — each of which must
# itself be ALLOWED — and the words it must no longer say.
SELFTEST_SPELLING = (
    "docker run --rm --security-opt seccomp=unconfined --security-opt systempaths=unconfined "
    "--security-opt apparmor=unconfined --entrypoint teams-lite-intune-selftest teams-lite:local"
)


def advice_cases():
    return [
        (
            "docker run --rm --entrypoint teams-lite-intune-selftest "
            "-v teams-lite_intune:/home/teams/.local/share/intune-container teams-lite:local",
            [SELFTEST_SPELLING],
            [],
        ),
        ("docker run --rm --network host --entrypoint teams-lite-intune-selftest teams-lite:local", [SELFTEST_SPELLING], []),
        ("docker run --rm --ipc host --entrypoint teams-lite-intune-selftest teams-lite:local", [SELFTEST_SPELLING], []),
        ("docker run --rm teams-lite:local", [SELFTEST_SPELLING], []),
        (
            "docker exec teams-lite kill 1",
            ["docker top teams-lite", "docker exec teams-lite cat /proc/1/status"],
            ["docker exec teams-lite kill -0"],
        ),
        (
            "docker run --rm --pid container:teams-lite busybox ps",
            ["docker top teams-lite", "docker exec teams-lite cat /proc/1/status", "docker exec teams-lite ls /proc"],
            [],
        ),
        (
            "docker exec -u teams teams-lite /usr/local/lib/teams-lite/server",
            ["docker exec teams-lite sha256sum /usr/local/lib/teams-lite/server /usr/local/bin/teams"],
            [],
        ),
        (
            "docker exec teams-lite teams-lite-container",
            ["docker exec teams-lite sha256sum /usr/local/bin/teams-lite-container"],
            # The entrypoint's own lock refuses a second copy before it acts: a refusal saying the
            # copy "exits at once … and stops the container" says two things that cannot both be true.
            ["exits at once, even for --help, and stops"],
        ),
    ]


def run_hook(command: str, cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [str(HOOK)],
        input=json.dumps({"tool_input": {"command": command}}),
        capture_output=True,
        text=True,
        cwd=cwd,
        env={"CLAUDE_PROJECT_DIR": str(PROJECT), "HOME": str(Path.home()), "PATH": "/usr/bin:/bin"},
    )


def flattened(text: str) -> str:
    """A block text as one line: its `\\` continuations joined, its whitespace runs single."""
    return re.sub(r"\s+", " ", text.replace("\\\n", " "))


def check_advice() -> int:
    failures = 0
    for trigger, recommended, retired in advice_cases():
        proc = run_hook(trigger, PROJECT)
        message = flattened(proc.stderr)
        problems = [] if proc.returncode != 0 else ["the trigger itself was allowed"]
        problems += [f"does not recommend `{c}`" for c in recommended if c not in message]
        problems += [f"still says `{w}`" for w in retired if w in message]
        problems += [f"recommends `{c}`, which it refuses" for c in recommended if run_hook(c, PROJECT).returncode != 0]
        failures += 1 if problems else 0
        print(f"{'FAIL' if problems else 'ok  '} advice <- {trigger}{'' if not problems else ': ' + '; '.join(problems)}")
    return failures


def main() -> int:
    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)
        for name, body in FIXTURES.items():
            (tmp / name).parent.mkdir(parents=True, exist_ok=True)
            (tmp / name).write_text(body)
        # The example fixtures have to live where cargo would find them, so they are
        # written into examples/ and removed again in the `finally` below.
        written_examples = []
        for name, body in EXAMPLE_FIXTURES.items():
            path = PROJECT / "examples" / f"{this_runs_example(name)}.rs"
            path.write_text(body)
            written_examples.append(path)

        failures = 0
        try:
            for expected, cwd, command in cases(tmp):
                proc = run_hook(aimed_at_this_run(command), cwd)
                got = "ALLOW" if proc.returncode == 0 else "BLOCK"
                ok = got == expected
                failures += 0 if ok else 1
                print(f"{'ok  ' if ok else 'FAIL'} {got:5} (want {expected}) <- {command}")
        finally:
            for path in written_examples:
                path.unlink(missing_ok=True)

    advice_failures = check_advice()
    total = len(cases(Path("/tmp")))
    print(f"\n{total - failures}/{total} as expected")
    advice_total = len(advice_cases())
    print(f"{advice_total - advice_failures}/{advice_total} refusals recommend what works")
    return 1 if failures or advice_failures else 0


if __name__ == "__main__":
    sys.exit(main())
