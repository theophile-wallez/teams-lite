import {
  test,
  expect,
  fetchCapturedSends,
  gotoApp,
  openConversationNamed,
  setApprovalControl,
} from "./helpers";
import type { Page } from "@playwright/test";

// A message that names a MERGE REQUEST grows two rows in its ⋯ menu, and they are not the
// same kind of thing at all:
//
//   - **Review <ref> with <agent>** drafts a request pointing one of this machine's agent
//     CLIs at the merge request, and sends nothing — the composer's own agent tag, reached
//     from the message (see web/src/lib/merge-request.ts and lib/agent-answer.ts).
//   - **Approve <ref>** is the ONE action in this app that writes to a tracker
//     (AGENTS.md § The trackers). So it wears GitLab's own mark, it asks twice, it reports
//     its outcome in the menu the user clicked in, and the row it leaves behind REVOKES —
//     which is why the write is offered at all.
//
// Everything happens in the "Merge Request Review" thread, which the mock has the user
// opted in (`seedMergeRequestReview`), and against the mock's own approval state — no
// GitLab, no token, nothing leaving the machine.
test.describe.serial("a merge request in a message", () => {
  const editable = '[data-testid="composer-rich"] .tiptap-message';
  const chip = `${editable} [data-testid="agent-tag"]`;
  const reviewRow = '[data-testid="action-review-with"]';
  const approveRow = '[data-testid="action-approve-mr"]';
  const confirmRow = '[data-testid="action-approve-mr-confirm"]';

  /** Open the review thread with an empty composer. The mock persists drafts, so
   *  whatever an earlier test left here is still in front of the caret. */
  async function openThread(page: Page) {
    await gotoApp(page);
    await openConversationNamed(page, "Merge Request Review");
    await page.locator(editable).click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await expect(page.locator(editable)).toHaveText("");
  }

  /** Open the ⋯ menu of the message at `index` (0 = the open !44, 1 = the merged !42). */
  async function openMessageMenu(page: Page, index = 0) {
    const bubble = page.locator('[data-testid="message"]').nth(index);
    await expect(bubble).toBeVisible();
    await bubble.hover();
    await bubble.locator('[data-testid="message-actions"]').click();
    await expect(page.locator('[data-testid="action-reply"]')).toBeVisible();
    return bubble;
  }

  test.afterEach(async ({ page }) => {
    // One mock process serves the whole run: an approval left on, or a refusal left
    // armed, would decide what the next spec sees.
    await setApprovalControl(page, { clear: true });
  });

  test("offers a review row per agent, naming the merge request and wearing its mark", async ({
    page,
  }) => {
    await openThread(page);
    await openMessageMenu(page);
    // The mock holds `claude` and not `opencode`, so exactly one row — the same list the
    // composer offers, which is the thread's own opt-in and nothing this menu may widen.
    await expect(page.locator(reviewRow)).toHaveCount(1);
    await expect(page.locator(reviewRow)).toHaveAttribute("data-agent", "claude");
    await expect(page.locator(reviewRow)).toContainText("Review !44 with Claude");
    await expect(page.locator(`${reviewRow} [data-testid="claude-logo"]`)).toHaveCount(1);
  });

  test("the review row drafts a reply naming the merge request, and sends nothing", async ({
    page,
  }) => {
    await openThread(page);
    const before = (await fetchCapturedSends(page)).length;
    await openMessageMenu(page);
    await page.locator(reviewRow).click();

    // The tag leads the draft; the request names the merge request in full, because a
    // reference alone means nothing outside the project and the URL is what the agent
    // needs to go and read it.
    await expect(page.locator(chip)).toHaveAttribute("data-agent", "claude");
    await expect(page.locator(editable)).toContainText("Review this merge request: !44");
    await expect(page.locator(editable)).toContainText(
      "https://gitlab.com/acme/webapp/-/merge_requests/44",
    );
    await expect(page.locator('[data-testid="reply-banner"]')).toBeVisible();
    // Nothing left the machine: the send is the user's own Enter.
    expect((await fetchCapturedSends(page)).length).toBe(before);
  });

  test("a half-written draft stays the request", async ({ page }) => {
    await openThread(page);
    await page.locator(editable).click();
    await page.keyboard.type("does the migration run twice?");
    await openMessageMenu(page);
    await page.locator(reviewRow).click();

    // Whose words go out never depends on the row: only the tag is added, at the front.
    await expect(page.locator(chip)).toHaveCount(1);
    await expect(page.locator(editable)).toContainText("does the migration run twice?");
    await expect(page.locator(editable)).not.toContainText("Review this merge request");
  });

  test("approving asks twice, then reports the outcome in the menu", async ({ page }) => {
    await openThread(page);
    await openMessageMenu(page);

    // The row wears GitLab's own mark, because it acts on GitLab under the user's account.
    const approve = page.locator(approveRow);
    await expect(approve).toBeVisible();
    await expect(approve).toContainText("Approve !44");
    await expect(page.locator(`${approveRow} [data-testid="gitlab-logo"]`)).toHaveCount(1);

    // The first select ARMS; it does not write. The menu stays open and says what the
    // second click costs.
    await approve.click();
    await expect(page.locator(confirmRow)).toContainText("Approve on GitLab");
    // The menu is HELD open — its other rows are still there — because this is where the
    // answer is going to be reported.
    await expect(page.locator('[data-testid="action-reply"]')).toBeVisible();
    await expect(page.locator('[data-testid="approval-note"]')).toContainText(
      "Everybody watching !44 is told",
    );

    // The second select writes, and the outcome is reported HERE — an outward action that
    // fails must never be left looking like it worked, and a menu that closed on the click
    // would take the answer with it.
    await page.locator(confirmRow).click();
    const outcome = page.locator('[data-testid="approval-outcome"]');
    await expect(outcome).toBeVisible();
    await expect(outcome).toContainText("You approved !44");
    // The status line carries it too, for whoever reads a screenshot.
    await expect(page.locator('[data-testid="status-bar"]')).toContainText("Approved !44");
  });

  test("an approval given here is REVOKED from the same row", async ({ page }) => {
    await openThread(page);
    await openMessageMenu(page);
    await page.locator(approveRow).click();
    await page.locator(confirmRow).click();
    await expect(page.locator('[data-testid="approval-outcome"]')).toBeVisible();
    // Away from the menu through the MOUSE: an open menu is modal, so it is the only
    // layer taking pointer events, and Escape is read by the app as "leave this
    // conversation" (see delete-message.spec.ts for the same pair of reasons).
    await page.mouse.click(5, 5);
    await expect(page.locator('[data-testid="action-reply"]')).toHaveCount(0);
    await expect(page.locator("body")).not.toHaveCSS("pointer-events", "none");

    // Reopened, the row is the UNDO — read back from GitLab's own state, not remembered
    // from the click. A write whose off switch cannot undo its on switch would not be in
    // this app at all.
    await openMessageMenu(page);
    const revoke = page.locator(approveRow);
    await expect(revoke).toContainText("Revoke approval of !44");
    await expect(revoke).toHaveAttribute("data-approved", "true");
    await revoke.click();
    await expect(page.locator(confirmRow)).toContainText("Revoke on GitLab");
    await page.locator(confirmRow).click();
    await expect(page.locator('[data-testid="approval-outcome"]')).toContainText(
      "Your approval of !44 is gone",
    );
  });

  test("a refused approval says why, at the row that asked for it", async ({ page }) => {
    await setApprovalControl(page, {
      refuse: "GitLab refused: this account may not approve that merge request",
    });
    await openThread(page);
    await openMessageMenu(page);
    await page.locator(approveRow).click();
    await page.locator(confirmRow).click();

    // GitLab's own sentence, in the menu, in the destructive colour — never swallowed into
    // a cue, and never reported as a success.
    const failure = page.locator('[data-testid="approval-error"]');
    await expect(failure).toBeVisible();
    await expect(failure).toContainText("may not approve");
    await expect(page.locator('[data-testid="approval-outcome"]')).toHaveCount(0);
  });

  test("offers no approval where GitLab could not answer", async ({ page }) => {
    // The shape of a machine with no GitLab token: the read says there is no approval
    // state, so the row is absent rather than offering an action the backend would refuse.
    // The review row stays — pointing an agent at a link needs no token of ours.
    await setApprovalControl(page, { unavailable: true });
    await openThread(page);
    await openMessageMenu(page);
    await expect(page.locator(reviewRow)).toHaveCount(1);
    await expect(page.locator(approveRow)).toHaveCount(0);
  });

  test("offers no approval on a MERGED merge request", async ({ page }) => {
    await openThread(page);
    // The second message names !42, which the mock reports as merged. GitLab refuses an
    // approval there, and an action that only ever earns a refusal reads as a bug.
    await openMessageMenu(page, 1);
    await expect(page.locator(reviewRow)).toContainText("Review !42 with Claude");
    await expect(page.locator(approveRow)).toHaveCount(0);
  });

  test("offers neither row on a message that names no merge request", async ({ page }) => {
    await gotoApp(page);
    await openConversationNamed(page, "Agent Sandbox");
    const bubble = page.locator('[data-testid="message"]').first();
    await bubble.hover();
    await bubble.locator('[data-testid="message-actions"]').click();
    // "Answer with" is offered there — this thread is opted in — and the two merge-request
    // rows are not, because there is no merge request to name.
    await expect(page.locator('[data-testid="action-answer-with"]')).toHaveCount(1);
    await expect(page.locator(reviewRow)).toHaveCount(0);
    await expect(page.locator(approveRow)).toHaveCount(0);
  });
});
