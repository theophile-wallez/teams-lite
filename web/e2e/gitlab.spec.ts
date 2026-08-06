import { test, expect, gotoApp, setMergeRequestControl } from "./helpers";
import type { Page } from "@playwright/test";

// The GitLab merge-request page: a sidebar of what is NOT merged, and one merge request in
// full — its description, its LIVE pipeline, its approvals, its comments, and the four
// writes it offers (merge, comment, delete a comment, close).
//
// Everything runs against the mock's own merge requests (the `gitlab_mr_*` fixtures in
// web/mock/server.ts): no GitLab, no token, nothing leaving the machine. That is what makes
// the MERGE — the one action in this app no later click takes back — testable at all.
//
// Serial, and each test leaves the surface as it found it, because one mock process serves
// the whole run and these tests MERGE and CLOSE the fixtures.
test.describe.serial("the GitLab merge-request page", () => {
  const row = '[data-testid="gitlab-row"]';

  /** Open the GitLab tab and wait for its rows. */
  async function openGitLab(page: Page) {
    await gotoApp(page);
    await page.locator('[data-testid="tab-gitlab"]').click();
    await expect(page.locator(row).first()).toBeVisible();
  }

  /** Open the merge request with this iid and wait for its page. */
  async function openMergeRequest(page: Page, iid: number) {
    await page.locator(`${row}[data-iid="${iid}"]`).click();
    await expect(page.locator('[data-testid="gitlab-heading"]')).toBeVisible();
  }

  test.afterEach(async ({ page }) => {
    await setMergeRequestControl(page, { clear: true });
  });

  test("lists what is not merged, and never a merged merge request", async ({ page }) => {
    await openGitLab(page);

    // Open by default — the question the page exists to answer.
    await expect(page.locator('[data-testid="gitlab-state-opened"]')).toHaveAttribute(
      "data-state",
      "active",
    );
    const rows = page.locator(row);
    await expect(rows).toHaveCount(4);
    // Every row states its project and its reference, because "!42" alone means nothing
    // across a hundred projects.
    await expect(rows.first().locator('[data-testid="gitlab-row-project"]')).toHaveText(
      "acme/webapp",
    );

    // A row carries NO pipeline badge: the list endpoint answers without one, so a status
    // per row would cost one request per merge request (see src/gitlab_mr.rs).
    await expect(page.locator('[data-testid="gitlab-pipeline-status"]')).toHaveCount(0);

    // The closed half is the other half of "not merged" — and the merged one is in neither.
    await page.locator('[data-testid="gitlab-state-closed"]').click();
    await expect(page.locator(`${row}[data-iid="594"]`)).toBeVisible();
    await expect(page.locator(`${row}[data-iid="596"]`)).toHaveCount(0);
    await page.locator('[data-testid="gitlab-state-opened"]').click();
    await expect(page.locator(`${row}[data-iid="596"]`)).toBeVisible();
  });

  /** Open the scope picker and wait until its rows can be clicked.
   *
   *  Radix keeps a CLOSING menu mounted for its exit animation, and a menu opened during
   *  that window is re-created mid-flight — which detaches the row this is about to click.
   *  Only a script drives a control that fast, so the waiting belongs here (the calendar's
   *  view menu makes the same allowance, for the same reason). */
  async function openScopePicker(page: Page) {
    const menu = page.locator('[role="menu"]');
    await menu.waitFor({ state: "detached" }).catch(() => {});
    await page.locator('[data-testid="gitlab-scope-picker"]').click();
    await menu.waitFor();
  }

  test("narrows by scope, and the filter says which is which", async ({ page }) => {
    await openGitLab(page);
    await openScopePicker(page);
    // Every scope names what it means: a four-way filter of one-word labels needs it.
    const options = page.locator('[data-testid="gitlab-scope-option"]');
    await expect(options).toHaveCount(4);
    await expect(options.filter({ hasText: "I review" })).toContainText("reviewer");

    await options.filter({ hasText: "Mine" }).click();
    await expect(page.locator('[data-testid="gitlab-scope-picker"]')).toHaveAttribute(
      "data-scope",
      "mine",
    );
    // Only the user's own: !595, and not Ada's !596.
    await expect(page.locator(`${row}[data-iid="595"]`)).toBeVisible();
    await expect(page.locator(`${row}[data-iid="596"]`)).toHaveCount(0);

    // Back to everything, so the next test starts where this one did.
    await openScopePicker(page);
    await page.locator('[data-testid="gitlab-scope-option"][data-scope="all"]').click();
    await expect(page.locator(`${row}[data-iid="596"]`)).toBeVisible();
  });

  test("draws one merge request in full, and its pipeline follows the run", async ({ page }) => {
    // Every read of the live pipeline moves it on, and the tests before this one have read
    // it — so it starts from its first frame here, which is what makes "a job turns green
    // on its own" a thing to watch rather than a race.
    await setMergeRequestControl(page, { clear: true });
    await openGitLab(page);
    await openMergeRequest(page, 596);

    // The header states the branches in the direction the merge goes.
    await expect(page.locator('[data-testid="gitlab-source-branch"]')).toHaveText(
      "feature/ha-replicas",
    );
    await expect(page.locator('[data-testid="gitlab-target-branch"]')).toHaveText("main");
    await expect(page.locator('[data-testid="gitlab-state"]')).toHaveText("Open");

    // The description is GitLab's own MARKDOWN through the app's own renderer, so its bold is
    // bold rather than asterisks — and no remote reference comes with it.
    const description = page.locator('[data-testid="gitlab-description"]');
    await expect(description.locator("strong").first()).toHaveText("two replicas");

    // The pipeline is grouped into GitLab's own stages, in GitLab's own order.
    const stages = page.locator('[data-testid="gitlab-stage"]');
    await expect(stages).toHaveCount(3);
    await expect(stages.nth(0)).toHaveAttribute("data-stage", "check");
    await expect(stages.nth(2)).toHaveAttribute("data-stage", "deploy");

    // And it is LIVE: the panel says it is following, and a job that was running turns
    // green on its own — the mock advances one step per read, so this is the poll working
    // rather than a still picture.
    await expect(page.locator('[data-testid="gitlab-pipeline-live"]')).toBeVisible();
    const unit = page.locator('[data-testid="gitlab-job"]').filter({ hasText: "unit" });
    await expect(unit).toHaveAttribute("data-status", "running");
    await expect(unit).toHaveAttribute("data-status", "success", { timeout: 20_000 });
  });

  test("draws the description as the markdown GitLab holds, not as its source", async ({
    page,
  }) => {
    await openGitLab(page);
    await openMergeRequest(page, 596);
    const description = page.locator('[data-testid="gitlab-description"]');

    // A heading is a heading, and its hashes are gone. Measured on the tenant: 32 of the 36
    // descriptions with words in them carry one (see examples/merge_request_markdown_recon.rs).
    await expect(description.locator("h2").first()).toHaveText("What changes");
    await expect(description).not.toContainText("## What changes");

    // A pipe table is a real table — 24 of those 36 hold one, and printed as source it is a
    // wall of pipes with the |---| row missing.
    const table = description.locator("table");
    await expect(table).toHaveCount(1);
    await expect(table.locator("th")).toHaveCount(3);
    await expect(table.locator("tbody tr")).toHaveCount(3);
    await expect(description).not.toContainText("| -------- |");

    // A fenced block keeps its own lines, and nothing inside it was parsed as markdown.
    const code = description.locator("pre");
    await expect(code).toHaveCount(1);
    await expect(code).toContainText("helmfile -e staging apply --selector name=web");
    await expect(description).not.toContainText("```");

    // A task list says which box is ticked, and a sub-bullet sits inside its own parent.
    await expect(description.getByText("☑ staging")).toBeVisible();
    await expect(description.getByText("☐ production, one cluster at a time")).toBeVisible();
    await expect(description.locator("ul ul li")).toHaveCount(2);

    // A thematic break is a rule rather than three characters — or, as the card parser read
    // it, nothing at all.
    await expect(description.locator("hr")).toHaveCount(1);

    // And NOTHING in it is fetched: the promise the whole page is built on holds for a body
    // written by somebody outside this app.
    await expect(description.locator("img")).toHaveCount(0);

    // A comment is the same markdown, because a review quotes code as often as a description
    // does.
    await page.locator('[data-testid="gitlab-comments"]').scrollIntoViewIfNeeded();
    const note = page.locator('[data-testid="gitlab-note"]').filter({ hasText: "MEDIUM" });
    await expect(note.locator("pre")).toContainText("sleep {{ .Values.drain }}");
  });

  test("says why a merge request cannot be merged, instead of refusing after the click", async ({
    page,
  }) => {
    await openGitLab(page);
    await openMergeRequest(page, 595);

    const merge = page.locator('[data-testid="gitlab-merge"]');
    await expect(merge).toBeDisabled();
    // GitLab's own reason, in words the reader can act on.
    await expect(page.locator('[data-testid="gitlab-merge-hint"]')).toContainText(
      "still needs an approval",
    );

    // A conflict is a different reason, and it is stated as one.
    await page.locator('[data-testid="tab-gitlab"]').click();
    await openMergeRequest(page, 63);
    await expect(page.locator('[data-testid="gitlab-merge"]')).toBeDisabled();
    await expect(page.locator('[data-testid="gitlab-merge-hint"]')).toContainText("conflicts");
  });

  test("the merge asks twice, and says what the second click costs", async ({ page }) => {
    await openGitLab(page);
    await openMergeRequest(page, 596);

    // The first click ARMS. Nothing has been merged: the state badge still says Open.
    await page.locator('[data-testid="gitlab-merge"]').click();
    const confirm = page.locator('[data-testid="gitlab-merge-confirm"]');
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("cannot be undone");
    await expect(page.locator('[data-testid="gitlab-merge-hint"]')).toContainText(
      "no later click takes it back",
    );
    await expect(page.locator('[data-testid="gitlab-state"]')).toHaveText("Open");

    // And it can be taken back before it happens.
    await page.locator('[data-testid="gitlab-merge-cancel"]').click();
    await expect(page.locator('[data-testid="gitlab-merge"]')).toBeVisible();
    await expect(page.locator('[data-testid="gitlab-state"]')).toHaveText("Open");
  });

  test("a refused merge is reported where the click was made", async ({ page }) => {
    await setMergeRequestControl(page, {
      refuse: "GitLab refused: this account may not merge that merge request",
    });
    await openGitLab(page);
    await openMergeRequest(page, 596);

    await page.locator('[data-testid="gitlab-merge"]').click();
    await page.locator('[data-testid="gitlab-merge-confirm"]').click();

    // The refusal is beside the button, in GitLab's own words — never swallowed, and never
    // left to the eleven pixels of the status line.
    await expect(page.locator('[data-testid="gitlab-action-error"]')).toContainText(
      "may not merge",
    );
    // And nothing was merged, so the page still offers the merge.
    await expect(page.locator('[data-testid="gitlab-state"]')).toHaveText("Open");
    await expect(page.locator('[data-testid="gitlab-merge"]')).toBeVisible();
  });

  test("comments under the user's own name, and takes one back", async ({ page }) => {
    await openGitLab(page);
    await openMergeRequest(page, 596);

    const input = page.locator('[data-testid="gitlab-comment-input"]');
    await input.fill("Checked the drain window against the load balancer — 20s is enough.");
    // The box says whose name it posts under, because that is what the reader is agreeing
    // to before they press it.
    await expect(page.locator('[data-testid="gitlab-composer"]')).toContainText("under your name");
    await page.locator('[data-testid="gitlab-comment-send"]').click();

    const posted = page
      .locator('[data-testid="gitlab-note"]')
      .filter({ hasText: "20s is enough" });
    await expect(posted).toBeVisible();
    // Only now is the box empty: a comment that never left must not vanish from under the
    // person who wrote it.
    await expect(input).toHaveValue("");

    // The user's OWN comment carries the undo that makes commenting acceptable — and it
    // asks twice, like every other action that cannot be walked back by hovering.
    await posted.locator('[data-testid="gitlab-note-delete"]').click();
    await posted.locator('[data-testid="gitlab-note-delete-confirm"]').click();
    await expect(
      page.locator('[data-testid="gitlab-note"]').filter({ hasText: "20s is enough" }),
    ).toHaveCount(0);
  });

  test("offers no deletion on somebody else's comment", async ({ page }) => {
    await openGitLab(page);
    await openMergeRequest(page, 596);

    // Grace's comment is not the user's, so there is nothing to delete on it — GitLab would
    // let a maintainer remove it, and this app never offers that.
    const theirs = page
      .locator('[data-testid="gitlab-note"]')
      .filter({ hasText: "Two replicas is right" });
    await expect(theirs).toBeVisible();
    await expect(theirs).not.toHaveAttribute("data-mine", "true");
    await expect(theirs.locator('[data-testid="gitlab-note-delete"]')).toHaveCount(0);

    // The user's own reply in the thread beside it does offer one.
    const mine = page.locator('[data-testid="gitlab-note"][data-mine="true"]').first();
    await expect(mine.locator('[data-testid="gitlab-note-delete"]')).toBeVisible();
  });

  test("replies into a thread rather than starting a new comment", async ({ page }) => {
    await openGitLab(page);
    await openMergeRequest(page, 596);

    const thread = page.locator('[data-testid="gitlab-discussion"][data-thread="true"]');
    await expect(thread).toBeVisible();
    const before = await thread.locator('[data-testid="gitlab-note"]').count();

    await thread.locator('[data-testid="gitlab-reply"]').click();
    await expect(page.locator('[data-testid="gitlab-composer"]')).toContainText(
      "Replying in a thread",
    );
    await page.locator('[data-testid="gitlab-comment-input"]').fill("Re-quoted, thanks.");
    await page.locator('[data-testid="gitlab-comment-send"]').click();

    // The reply landed IN the thread — the wrong place is exactly the failure nothing
    // reports afterwards.
    await expect(thread.locator('[data-testid="gitlab-note"]')).toHaveCount(before + 1);
    await expect(thread).toContainText("Re-quoted, thanks.");

    // Put the fixture back, since one mock process serves the whole run.
    const posted = thread.locator('[data-testid="gitlab-note"]').last();
    await posted.locator('[data-testid="gitlab-note-delete"]').click();
    await posted.locator('[data-testid="gitlab-note-delete-confirm"]').click();
    await expect(thread.locator('[data-testid="gitlab-note"]')).toHaveCount(before);
  });

  test("keeps GitLab's own events out of the conversation, behind a count", async ({ page }) => {
    await openGitLab(page);
    await openMergeRequest(page, 596);

    // "changed the description" is an event, not something anybody said, so it is not a
    // comment — and it is not hidden either: the count says it is there.
    await expect(page.locator('[data-testid="gitlab-events"]')).toHaveCount(0);
    const toggle = page.locator('[data-testid="gitlab-events-toggle"]');
    await expect(toggle).toContainText("1 event");
    await toggle.click();
    await expect(page.locator('[data-testid="gitlab-events"]')).toContainText(
      "changed the description",
    );
  });

  test("closes a merge request, and the reopen undoes it", async ({ page }) => {
    await openGitLab(page);
    await openMergeRequest(page, 63);

    // A close needs no confirmation, because the row that replaces it is its undo.
    await page.locator('[data-testid="gitlab-close"]').click();
    await expect(page.locator('[data-testid="gitlab-state"]')).toHaveText("Closed");
    await expect(page.locator('[data-testid="gitlab-action-done"]')).toContainText("Closed");
    // And it leaves the OPEN list, which is what that list promises.
    await expect(page.locator(`${row}[data-iid="63"]`)).toHaveCount(0);

    const reopen = page.locator('[data-testid="gitlab-reopen"]');
    await expect(reopen).toBeVisible();
    await reopen.click();
    await expect(page.locator('[data-testid="gitlab-state"]')).toHaveText("Open");
    await expect(page.locator(`${row}[data-iid="63"]`)).toBeVisible();
  });

  test("approves from the page, and the same control revokes", async ({ page }) => {
    await openGitLab(page);
    await openMergeRequest(page, 596);

    const approve = page.locator('[data-testid="gitlab-approve"]');
    await expect(approve).toHaveText("Approve");
    await approve.click();
    // The row becomes its own undo — the reason the approval write exists at all.
    await expect(approve).toHaveText("Revoke approval");
    await expect(page.locator('[data-testid="gitlab-approved-by"]')).toContainText("Théophile");

    await approve.click();
    await expect(approve).toHaveText("Approve");
  });

  test("says a machine with no token can read nothing, rather than showing an empty list", async ({
    page,
  }) => {
    await setMergeRequestControl(page, { no_token: true });
    await gotoApp(page);
    await page.locator('[data-testid="tab-gitlab"]').click();

    // An empty list would read as "no work". The notice names the one thing that fixes it.
    await expect(page.locator('[data-testid="gitlab-no-token"]')).toContainText("Settings");
    await expect(page.locator('[data-testid="gitlab-row"]')).toHaveCount(0);
  });

  test("survives a deep link, and an id that names nothing", async ({ page }) => {
    // The URL carries the pair the backend takes, with the project path encoded — so a
    // reload lands on the same merge request with no list to read it from.
    await page.goto("/mr/acme%2Fwebapp!596");
    await expect(page.locator('[data-testid="gitlab-heading"]')).toBeVisible();
    await expect(page.locator('[data-testid="gitlab-heading"]')).toContainText("HA replicas");

    // An id that names nothing resolves to "nothing open", and the page says so instead of
    // asking the backend about an address that means nothing.
    await page.goto("/mr/not-an-id");
    await expect(page.locator('[data-testid="gitlab-pane-empty"]')).toBeVisible();
  });

  test("merges, and the merge request leaves the list for good", async ({ page }) => {
    // LAST, deliberately: it is the one test that cannot be undone against the fixtures,
    // exactly as the action itself cannot be undone against GitLab.
    await openGitLab(page);
    await openMergeRequest(page, 596);

    await page.locator('[data-testid="gitlab-merge"]').click();
    await page.locator('[data-testid="gitlab-merge-confirm"]').click();

    await expect(page.locator('[data-testid="gitlab-action-done"]')).toContainText("Merged into main");
    await expect(page.locator('[data-testid="gitlab-state"]')).toHaveText("Merged");
    // A merged merge request offers neither a merge nor a close: there is nothing left to
    // do to it, and GitLab would refuse both.
    await expect(page.locator('[data-testid="gitlab-merge"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="gitlab-close"]')).toHaveCount(0);
    // And it is in neither list, because neither one holds what is merged.
    await expect(page.locator(`${row}[data-iid="596"]`)).toHaveCount(0);
    await page.locator('[data-testid="gitlab-state-closed"]').click();
    await expect(page.locator(`${row}[data-iid="596"]`)).toHaveCount(0);
  });
});
