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
        # The always-on service: every spelling that STARTS the send-capable backend.
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
        ("BLOCK", PROJECT, "bin/teams-lite-backend.sh"),
        ("BLOCK", PROJECT, "bash bin/teams-dev-server.sh"),
        # An environment assignment is a prefix, not a disguise: the path class holds
        # no `=`, so these spellings used to match nothing at all.
        ("BLOCK", PROJECT, "TEAMS_NO_IDLE_EXIT=1 target/release/server"),
        ("BLOCK", PROJECT, "TEAMS_LITE_PORT=19425 bin/teams-lite-backend.sh"),
        ("BLOCK", PROJECT, "XDG_RUNTIME_DIR=/run/user/1000 systemctl --user start teams-lite.target"),
        ("BLOCK", PROJECT, "cd /tmp && $HOME/.local/share/teams-lite/service/teams-lite-backend.sh"),
        # `teams` is that same send-capable backend plus the real app on 19440, in one
        # word — every spelling that runs it, and no read-only escape from it.
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
        # The repair unit restarts the Intune container: same rule, by unit name.
        ("BLOCK", PROJECT, "systemctl --user start teams-lite-broker-repair.service"),
        # …and the container itself is not ours to cycle, whatever the spelling.
        ("BLOCK", PROJECT, "intune-container stop"),
        ("BLOCK", PROJECT, "intune-container stop && intune-container start"),
        ("BLOCK", PROJECT, "$HOME/.local/bin/intune-container restart"),
        ("BLOCK", PROJECT, "intune-container -v start"),
        # The check script is a read of the keyring — until `--repair`, which starts
        # the repair unit and therefore restarts the container.
        ("BLOCK", PROJECT, "bin/teams-lite-broker-check.sh --repair"),
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
        ("ALLOW", PROJECT, "shellcheck bin/teams-lite-backend.sh"),
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
        ("ALLOW", PROJECT, "chmod +x bin/teams-lite-backend.sh"),
        ("ALLOW", PROJECT, "git add bin/teams-lite-backend.sh bin/teams-dev-server.sh"),
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
        # Diagnosing the container is the normal way to answer "why is it empty".
        ("ALLOW", PROJECT, "intune-container status"),
        ("ALLOW", PROJECT, "intune-container doctor"),
        ("ALLOW", PROJECT, "bin/teams-lite-broker-check.sh"),
        # Prose that names a repair runs nothing: a commit message, a doc line.
        ("ALLOW", PROJECT, "git commit -m 'feat: run broker-check.sh --repair from the timer'"),
        ("ALLOW", PROJECT, "git commit -m 'docs: intune-container stop && start unlocks it'"),
        # A production web server that names a read-only backend is fine.
        ("ALLOW", WEB, "TEAMS_LITE_WS_URL=ws://127.0.0.1:19430 bun run start"),
    ]


def main() -> int:
    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)
        for name, body in FIXTURES.items():
            (tmp / name).write_text(body)
        # The example fixtures have to live where cargo would find them, so they are
        # written into examples/ and removed again in the `finally` below.
        written_examples = []
        for name, body in EXAMPLE_FIXTURES.items():
            path = PROJECT / "examples" / name
            path.write_text(body)
            written_examples.append(path)

        failures = 0
        try:
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
        finally:
            for path in written_examples:
                path.unlink(missing_ok=True)

    total = len(cases(Path("/tmp")))
    print(f"\n{total - failures}/{total} as expected")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
