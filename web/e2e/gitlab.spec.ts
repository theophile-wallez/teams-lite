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

  test("wears GitLab's line in the tab strip, and GitLab's colours once it is current", async ({
    page,
  }) => {
    // The tab strip is a row of the app's OWN glyphs, and a strip says which section is
    // current: a brand mark lit in every state read as the selected tab. So the tanuki has
    // two spellings — the outline at rest, one weight with its four neighbours, and GitLab's
    // three fills where every other tab takes the accent (see `GitLabLogoOutline`).
    await gotoApp(page);
    const tab = page.locator('[data-testid="tab-gitlab"]');
    const outline = tab.locator('[data-testid="gitlab-logo-outline"]');
    const brand = tab.locator('[data-testid="gitlab-logo"]');
    await expect(tab).toHaveAttribute("data-state", "inactive");
    await expect(outline).toBeVisible();
    await expect(brand).toBeHidden();
    const atRest = await outline.boundingBox();

    await tab.click();
    await expect(tab).toHaveAttribute("data-state", "active");
    await expect(brand).toBeVisible();
    await expect(outline).toBeHidden();

    // And the swap never moves the target the user aims at: the two marks are one size, in
    // one place, so only the ink changes.
    const asCurrent = await brand.boundingBox();
    expect(atRest).not.toBeNull();
    expect(asCurrent).not.toBeNull();
    expect(Math.abs(asCurrent!.x - atRest!.x)).toBeLessThan(1);
    expect(Math.abs(asCurrent!.y - atRest!.y)).toBeLessThan(1);
    expect(Math.abs(asCurrent!.width - atRest!.width)).toBeLessThan(1);
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

    // This fixture is a whole document, so the page folds it to eight lines — the fold is the
    // subject of its own test below, and this one is about the MARKDOWN, so it asks for the
    // rest before reading any of it.
    await page.locator('[data-testid="gitlab-description-toggle"]').click();
    await expect(description).not.toHaveAttribute("data-folded", "true");

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

  test("a long description opens folded to eight lines, and the reader owns it from then on", async ({
    page,
  }) => {
    await openGitLab(page);
    await openMergeRequest(page, 596);

    const description = page.locator('[data-testid="gitlab-description"]');
    const toggle = page.locator('[data-testid="gitlab-description-toggle"]');
    const fade = page.locator('[data-testid="gitlab-description-fade"]');

    // It opens FOLDED, and the box is the fold rather than the document: eight lines of 13px
    // over a 1.625 leading is 169px, and this fixture's own markdown is several times that.
    await expect(description).toHaveAttribute("data-folded", "true");
    await expect(toggle).toHaveText("Show more");
    await expect(async () => {
      const box = (await description.boundingBox())!;
      expect(box.height).toBeLessThan(240);
    }).toPass();
    const folded = (await description.boundingBox())!;

    // The gradient is over the FOOT of that window, inside it — three of the eight lines —
    // so the words run out rather than being cut off by a rule.
    const fadeBox = (await fade.boundingBox())!;
    expect(fadeBox.height).toBeGreaterThan(50);
    expect(fadeBox.height).toBeLessThan(80);
    expect(fadeBox.y + fadeBox.height).toBeLessThanOrEqual(folded.y + folded.height + 1);

    // The foot of the document is OUTSIDE that window while it is folded — clipped by the box
    // rather than shown small — which is the fact the reader is pressing the control about.
    const tail = description.getByText("☐ production, one cluster at a time");
    const foldedTail = (await tail.boundingBox())!;
    expect(foldedTail.y).toBeGreaterThan(folded.y + folded.height);

    // The press opens it: the same control the other way round, and that last line is now
    // inside the box. Measured after the motion settles rather than during it.
    await toggle.click();
    await expect(toggle).toHaveText("Show less");
    await expect(description).not.toHaveAttribute("data-folded", "true");
    await expect(async () => {
      const box = (await description.boundingBox())!;
      const openTail = (await tail.boundingBox())!;
      expect(box.height).toBeGreaterThan(folded.height);
      expect(openTail.y + openTail.height).toBeLessThanOrEqual(box.y + box.height + 1);
    }).toPass();
    // The gradient says nothing about an open description.
    await expect(fade).toHaveCSS("opacity", "0");

    // And it folds again, on the reader's own press.
    await toggle.click();
    await expect(description).toHaveAttribute("data-folded", "true");
    await expect(async () => {
      const again = (await description.boundingBox())!;
      expect(again.height).toBeLessThan(240);
    }).toPass();

    // A description that already fits keeps NO control: there is nothing behind it, and a
    // click that reveals nothing reads as a bug (!595's own is one sentence).
    await page.locator('[data-testid="tab-gitlab"]').click();
    await openMergeRequest(page, 595);
    await expect(page.locator('[data-testid="gitlab-description"]')).toBeVisible();
    await expect(page.locator('[data-testid="gitlab-description-toggle"]')).toHaveCount(0);
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

    // A colleague's comment is not the user's, so there is nothing to delete on it — GitLab
    // would let a maintainer remove it, and this app never offers that.
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

    // Named rather than "the thread on this merge request": the fixture holds two, one of
    // them on a diff line, and a reply has to land in the one it was written under.
    const thread = page.locator('[data-testid="gitlab-discussion"][data-discussion="d-596-2"]');
    await expect(thread).toBeVisible();
    await expect(thread).toHaveAttribute("data-thread", "true");
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
    // Who approved is named the way this app names people: the user's own approval reads as
    // the user, not as the way their GitLab account happens to be spelled.
    await expect(page.locator('[data-testid="gitlab-approved-by"]')).toContainText("You");

    await approve.click();
    await expect(approve).toHaveText("Approve");
  });

  test("draws a colleague the app's own Teams knows as that colleague", async ({ page }) => {
    await openGitLab(page);

    // The sidebar has no room for a name, so the row states whose face it draws. The user's
    // own merge request is attributed the way this app calls THEM — not the way GitLab spells
    // their account, which is the whole point of matching the two by real name.
    await expect(page.locator(`${row}[data-iid="595"]`)).toHaveAttribute("data-author", "You");
    // …and a merge request by somebody only GitLab knows keeps GitLab's own words.
    await expect(page.locator(`${row}[data-iid="63"]`)).toHaveAttribute(
      "data-author",
      "Ada Lovelace",
    );

    await openMergeRequest(page, 596);

    // A colleague in both systems, drawn as the colleague: their Teams name, and their real
    // face — fetched through the backend like every other avatar here, never from GitLab.
    const note = page.locator('[data-testid="gitlab-note"]').filter({ hasText: "Two replicas" });
    await expect(note.locator('[data-testid="gitlab-note-author"]')).toHaveText("Mia Chen");
    await expect(note.locator("img[data-picture='face']")).toBeVisible();

    // The people on the merge request, in all three shapes. The user themselves is named the
    // way this app names them everywhere else.
    const person = (name: string) =>
      page.locator(`[data-testid="gitlab-person"][data-person="${name}"]`).first();
    await expect(person("You")).toBeVisible();
    // A colleague the app knows who has no Teams photo keeps tinted initials — there is
    // nothing to fetch, and the app never falls back to GitLab's own avatar URL.
    await expect(person("Lucas Silva")).toBeVisible();
    await expect(person("Lucas Silva").locator("img")).toHaveCount(0);
    // And somebody GitLab alone knows keeps GitLab's own name, over initials.
    await expect(person("Ada Lovelace")).toBeVisible();
    await expect(person("Ada Lovelace").locator("img")).toHaveCount(0);

    // The bot that reviews is nobody in Teams, and stays what GitLab called it.
    const robot = page.locator('[data-testid="gitlab-note"]').filter({ hasText: "MEDIUM" });
    await expect(robot.locator('[data-testid="gitlab-note-author"]')).toHaveText("review-bot");
    await expect(robot.locator("img")).toHaveCount(0);
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

  test("a long title is shortened in the header and wrapped in the page, and widens neither", async ({
    page,
  }) => {
    // !297's title lists every ticket its branch closes, which is the length an author on the
    // tenant really writes. A title that long used to grow the whole column to its own width:
    // `truncate` shortens nothing while its container is free to grow, so the article and
    // every control on it went off the right of the screen.
    await openGitLab(page);
    await openMergeRequest(page, 297);

    const pane = page.locator('[data-testid="gitlab-pane"]');
    const title = page.locator('[data-testid="gitlab-title"]');
    const heading = page.locator('[data-testid="gitlab-heading"]');

    for (const width of [1200, 390]) {
      await page.setViewportSize({ width, height: 900 });
      // The pane is measured against the WINDOW rather than against its own class list: what
      // broke was the geometry, and only the geometry says it is mended.
      const paneBox = (await pane.boundingBox())!;
      expect(paneBox.x + paneBox.width).toBeLessThanOrEqual(width + 1);

      // The header keeps ONE line and ends in an ellipsis — it is shortened, so it holds more
      // than it draws.
      const headerLine = (await title.boundingBox())!;
      expect(headerLine.height).toBeLessThan(30);
      expect(headerLine.x + headerLine.width).toBeLessThanOrEqual(paneBox.x + paneBox.width + 1);
      const shortened = await title.evaluate((el) => el.scrollWidth > el.clientWidth);
      expect(shortened).toBe(true);

      // The heading holds the title in FULL, over as many lines as that takes, and stays
      // inside the pane while it does.
      const headingBox = (await heading.boundingBox())!;
      expect(headingBox.height).toBeGreaterThan(headerLine.height);
      expect(headingBox.x + headingBox.width).toBeLessThanOrEqual(paneBox.x + paneBox.width + 1);
      await expect(heading).toContainText("ACME-3351");
    }
    await page.setViewportSize({ width: 1200, height: 900 });

    // The DIFF page names the merge request it belongs to in the same one line, and it is a
    // whole screen of two columns: a header that grew would take the file tree with it.
    await page.goto("/mr/acme%2Finfrastructure!297/diff");
    const diffPage = page.locator('[data-testid="gitlab-diff-page"]');
    await expect(diffPage).toBeVisible();
    const diffBox = (await diffPage.boundingBox())!;
    expect(diffBox.x + diffBox.width).toBeLessThanOrEqual(1201);
    const diffTitle = (await page.locator('[data-testid="gitlab-diff-title"]').boundingBox())!;
    expect(diffTitle.height).toBeLessThan(30);
    expect(diffTitle.x + diffTitle.width).toBeLessThanOrEqual(1201);
  });

  // ---- the DIFF, which is a page of its own -------------------------------
  //
  // `/mr/<id>/diff` — the whole screen, the changed files down the left, one of them read on
  // the right. The merge-request page above it only STATES what changed and offers the way in.
  //
  // The renderers are somebody else's (`@pierre/trees` for the tree, `@pierre/diffs` for the
  // patch, both behind a lazy import), so these tests assert on this app's own `data-testid`s
  // and on ONE attribute of pierre's — `data-item-path`, which is how a row is addressed.
  // Asserting on their internals would be a test of their release notes.
  //
  // Every state a real GitLab answer holds is in the fixture, because four of the five are
  // files with NO patch (see `mockDiffFiles` in web/mock/server.ts). They sit BEFORE the merge
  // below, which is destructive to !596.

  /** Press "Review the changes" and wait for the diff page's FILES to be drawn.
   *
   *  The files are what every width opens on — both columns on a wide screen, that column alone
   *  on a phone — so this is the one wait that holds everywhere. A patch is a separate wait
   *  (`waitForPatch`) because on a phone there is not one until the reader picks a file. */
  async function openDiffPage(page: Page) {
    await page.locator('[data-testid="gitlab-review-changes"]').scrollIntoViewIfNeeded();
    await page.locator('[data-testid="gitlab-review-changes"]').click();
    await expect(page.locator('[data-testid="gitlab-diff-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="gitlab-diff-tree"]')).toBeVisible({ timeout: 25_000 });
  }

  /** Wait for a patch to be highlighted. Generous, because what takes the time is the lazy
   *  chunk and then Shiki resolving that file's own grammar. */
  async function waitForPatch(page: Page) {
    await expect(page.locator('[data-testid="gitlab-diff-patch"]')).toBeVisible({
      timeout: 25_000,
    });
  }

  /** Show one file by pressing its row in the tree.
   *
   *  Pierre's tree renders into a shadow root and Playwright's CSS engine pierces an open one,
   *  so this drives the row a reader would press. The assertion is on the PANE's own statement
   *  of what it holds, which is present whatever draws that file's name — pierre's header over
   *  a patch, this app's over a sentence. */
  async function pickFile(page: Page, path: string) {
    await page.locator(`[data-item-path="${path}"]`).first().click();
    await expect(page.locator('[data-testid="gitlab-diff-pane"]')).toHaveAttribute(
      "data-path",
      path,
    );
  }

  test("states what changed on the merge request, and draws no diff there", async ({ page }) => {
    await openGitLab(page);
    await openMergeRequest(page, 596);
    await page.locator('[data-testid="gitlab-changes"]').scrollIntoViewIfNeeded();

    // The summary counts what travelled and the lines that moved. That is what a reader
    // deciding whether to review needs; the code is one press away.
    const summary = page.locator('[data-testid="gitlab-changes-summary"]');
    await expect(summary).toContainText("7 files");
    await expect(summary).toContainText("+27");
    await expect(page.locator('[data-testid="gitlab-changes-link"]')).toHaveAttribute(
      "href",
      /\/diffs$/,
    );
    // And nothing of the diff itself is on this page: no tree, no patch, so no highlighter on
    // the path of a merge request somebody opened to read the description.
    await expect(page.locator('[data-testid="gitlab-diff-tree"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="gitlab-diff-patch"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="gitlab-review-changes"]')).toBeVisible();
  });

  test("the diff is a PLACE: its own URL, reloadable, and Back leaves it", async ({ page }) => {
    await openGitLab(page);
    await openMergeRequest(page, 596);
    await openDiffPage(page);
    await waitForPatch(page);

    // The URL is what makes it a place rather than a piece of state — it can be sent to
    // somebody, and it survives a reload.
    expect(page.url()).toMatch(/\/diff$/);
    await expect(page.locator('[data-testid="gitlab-diff-title"]')).toContainText("HA replicas");
    await page.reload();
    await expect(page.locator('[data-testid="gitlab-diff-page"]')).toBeVisible();
    await waitForPatch(page);

    // It takes the WHOLE screen: the app's own sidebar is not drawn beside it, because the page
    // is already two columns and a third of chat rows would leave neither enough room.
    await expect(page.locator('[data-testid="sidebar"]')).toHaveCount(0);

    // And Back returns to the merge request it belongs to, which is still open.
    await page.locator('[data-testid="gitlab-diff-back"]').click();
    await expect(page.locator('[data-testid="gitlab-heading"]')).toBeVisible();
    expect(page.url()).not.toMatch(/\/diff$/);
  });

  test("opens on a file with something to read, and follows the row pressed", async ({ page }) => {
    await openGitLab(page);
    await openMergeRequest(page, 596);
    await openDiffPage(page);
    await waitForPatch(page);

    // Nothing was picked, so the page opens on the first file that HAS a patch — never on a
    // sentence explaining there is nothing to see, which reads as a failed load.
    await expect(page.locator('[data-testid="gitlab-diff-pane"]')).toHaveAttribute(
      "data-change",
      "changed",
    );
    await expect(page.locator('[data-testid="gitlab-diff-tree"]')).toBeVisible();

    await pickFile(page, "src/server/health.ts");
    await waitForPatch(page);
  });

  test("tells the files with no patch apart", async ({ page }) => {
    await openGitLab(page);
    await openMergeRequest(page, 596);
    await openDiffPage(page);
    await waitForPatch(page);
    const notice = page.locator('[data-testid="gitlab-diff-file-notice"]');

    // A pure RENAME: no hunks by definition, and its patch IS the header stating the move — so
    // pierre draws that header and this page explains NOTHING. It must never read as a file
    // GitLab collapsed, which is what GitLab's own `collapsed: true` on those rows would have
    // made it.
    await pickFile(page, "src/server/drain.ts");
    await expect(page.locator('[data-testid="gitlab-diff-pane"]')).toHaveAttribute(
      "data-change",
      "renamed",
    );
    await expect(notice).toHaveCount(0);
    await waitForPatch(page);

    // A BINARY file: GitLab describes it with one sentence rather than hunks, and this page says
    // so instead of running that prose through a code renderer.
    await pickFile(page, "docs/diagrams/rollout.png");
    await expect(notice).toHaveAttribute("data-state", "binary");
    await expect(notice).toContainText(/binary/i);
    await expect(page.locator('[data-testid="gitlab-diff-patch"]')).toHaveCount(0);

    // A file GitLab COLLAPSED — the one state a second read can mend. It carries this app's own
    // heading, because pierre draws none where there is no patch, and it says GENERATED,
    // because a surprising change hides in one.
    await pickFile(page, "bun.lock");
    await expect(notice).toHaveAttribute("data-state", "collapsed");
    await expect(notice).toContainText(/did not expand/i);
    await expect(page.locator('[data-testid="gitlab-diff-file"]')).toContainText("generated");
  });

  test("offers the expanded read once, names what it costs, then stops offering", async ({
    page,
  }) => {
    await openGitLab(page);
    await openMergeRequest(page, 596);
    await openDiffPage(page);
    await waitForPatch(page);

    // At the foot of the FILES column, because what GitLab withheld is a fact about that list.
    const expand = page.locator(
      '[data-testid="gitlab-diff-files"] [data-testid="gitlab-diff-expand"]',
    );
    await expect(expand).toContainText("Expand 1 file");
    // The cost, before the press — the rule the update button follows for its 130 MB.
    await expect(page.locator('[data-testid="gitlab-diff-expand-hint"]')).toContainText(
      /slower and much larger/i,
    );

    // The collapsed file carries no patch until the reader asks.
    await pickFile(page, "bun.lock");
    await expect(page.locator('[data-testid="gitlab-diff-file-notice"]')).toHaveAttribute(
      "data-state",
      "collapsed",
    );

    await expand.click();
    // Now it does, and the sentence about it is gone.
    await waitForPatch(page);
    await expect(page.locator('[data-testid="gitlab-diff-file-notice"]')).toHaveCount(0);
    // Offered ONCE: a second press would pay half a megabyte for the same answer, and the
    // expanded read does not always expand everything either.
    await expect(expand).toHaveCount(0);
  });

  test("is one column at a time on a phone, and Back walks between them", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openGitLab(page);
    await openMergeRequest(page, 596);
    await openDiffPage(page);

    // A tree beside a patch at 390 px is neither, so the page is the FILES then the file — the
    // list-then-detail shape every other surface in this app takes below `md`. It OPENS on the
    // files, because that is the question a diff asks first: which of these do I want to read?
    const diffPage = page.locator('[data-testid="gitlab-diff-page"]');
    await expect(diffPage).toHaveAttribute("data-column", "files");
    await expect(page.locator('[data-testid="gitlab-diff-pane"]')).toHaveCount(0);

    // A pick is a navigation into the file.
    await pickFile(page, "src/server/health.ts");
    await expect(diffPage).toHaveAttribute("data-column", "patch");
    await waitForPatch(page);
    // And the files are gone: one column at a time.
    await expect(page.locator('[data-testid="gitlab-diff-files"]')).toHaveCount(0);

    // Split needs two columns of code, so the toggle is not drawn here at all: a control that
    // changes nothing reads as a bug.
    await expect(page.locator('[data-testid="gitlab-diff-layout"]')).toHaveCount(0);

    // Back leaves the file for the list rather than the page. Without the guard on the tree's
    // own selection callback this bounced straight back to the patch, which made the files
    // unreachable on a phone.
    await page.locator('[data-testid="gitlab-diff-back"]').click();
    await expect(diffPage).toHaveAttribute("data-column", "files");
    await expect(page.locator('[data-testid="gitlab-diff-tree"]')).toBeVisible();

    // And Back again leaves the diff for the merge request.
    await page.locator('[data-testid="gitlab-diff-back"]').click();
    await expect(page.locator('[data-testid="gitlab-heading"]')).toBeVisible();
  });

  test("offers the split layout where two columns of code fit, and remembers it", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openGitLab(page);
    await openMergeRequest(page, 596);
    await openDiffPage(page);

    const toggle = page.locator('[data-testid="gitlab-diff-layout"]');
    await expect(toggle).toHaveAttribute("data-layout", "unified");
    await page.locator('[data-testid="gitlab-diff-layout-split"]').click();
    await expect(toggle).toHaveAttribute("data-layout", "split");
    // Put it back: the choice is persisted per browser, and one mock process serves the run.
    await page.locator('[data-testid="gitlab-diff-layout-unified"]').click();
    await expect(toggle).toHaveAttribute("data-layout", "unified");
  });

  test("a diff that cannot be read costs its own surfaces and nothing else", async ({ page }) => {
    await setMergeRequestControl(page, {
      refuse_diff: "GitLab refused: this account may not read the changes",
    });
    await openGitLab(page);
    await openMergeRequest(page, 596);
    await page.locator('[data-testid="gitlab-changes"]').scrollIntoViewIfNeeded();

    await expect(page.locator('[data-testid="gitlab-changes-error"]')).toContainText(
      "may not read the changes",
    );
    // The merge-request page is a header and five panels. One that cannot be read must not
    // empty the others — the contract the comments already hold.
    await expect(page.locator('[data-testid="gitlab-heading"]')).toBeVisible();
    await expect(page.locator('[data-testid="gitlab-pipeline"]')).toBeVisible();
    await expect(page.locator('[data-testid="gitlab-comments"]')).toBeVisible();
    await expect(page.locator('[data-testid="gitlab-actions"]')).toBeVisible();
    // There is nothing to review, so no press is offered into an empty page — the way out to
    // GitLab's own is what is left.
    await expect(page.locator('[data-testid="gitlab-review-changes"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="gitlab-changes-link"]')).toBeVisible();
  });

  // ---- a comment on a diff line -------------------------------------------
  //
  // The gesture is the feature: a press on a line NUMBER, or a drag from one line number to
  // another. Both are driven here the way a reader makes them — through the pointer, over
  // pierre's own gutter — because a store call would pin the plumbing and not the gesture.

  /** One line number in the gutter of the open patch.
   *
   *  The number AND the side, because in a unified diff an old line and a new line can wear the
   *  same number: three lines into a change block, `3` is both the line that went and the one
   *  that came. `data-column-number` and `data-line-type` are pierre's own attributes on a
   *  gutter cell, inside the shadow root Playwright pierces; everything asserted afterwards is
   *  this app's own `data-testid`. */
  function gutterLine(page: Page, line: number, side: "additions" | "deletions" = "additions") {
    const types =
      side === "additions"
        ? ["context", "addition", "change-addition"]
        : ["context", "deletion", "change-deletion"];
    const selector = types
      .map((type) => `[data-column-number="${line}"][data-line-type="${type}"]`)
      .join(", ");
    return page.locator(`[data-testid="gitlab-diff-patch"] :is(${selector})`).first();
  }

  /** Drag down the gutter from one line number to another. The STEPS matter: a jump straight
   *  from one point to the other fires no move between them, and pierre would report one line. */
  async function dragLines(page: Page, from: number, to: number) {
    const start = await gutterLine(page, from).boundingBox();
    const end = await gutterLine(page, to).boundingBox();
    if (!start || !end) throw new Error(`no gutter line ${from} or ${to}`);
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 10 });
    await page.mouse.up();
  }

  async function openHealthFile(page: Page) {
    await openGitLab(page);
    await openMergeRequest(page, 596);
    await openDiffPage(page);
    await waitForPatch(page);
    await pickFile(page, "src/server/health.ts");
    await waitForPatch(page);
  }

  test("a press on a line number opens a comment box under that line", async ({ page }) => {
    await openHealthFile(page);

    // Nothing is open until the reader asks: a box drawn by default would be a comment nobody
    // started.
    await expect(page.locator('[data-testid="gitlab-diff-composer"]')).toHaveCount(0);
    await gutterLine(page, 5).click();

    const composer = page.locator('[data-testid="gitlab-diff-composer"]');
    await expect(composer).toBeVisible();
    // It says which line, and which FILE: a line number means nothing without one.
    await expect(composer).toHaveAttribute("data-lines", "Line 5");
    await expect(composer).toContainText("src/server/health.ts");
    // And it says what the send costs before it is pressed.
    await expect(composer).toContainText("Everybody watching is told");

    // Cancel takes it away, and the words with it.
    await page.locator('[data-testid="gitlab-diff-comment-cancel"]').click();
    await expect(composer).toHaveCount(0);
  });

  test("a drag down the line numbers comments on the span, in reading order", async ({ page }) => {
    await openHealthFile(page);

    // Downwards, and then UPWARDS over the same lines: GitLab hangs a thread on the LAST line
    // of a range, so a pair left in pointer order would file an upward drag at the top of the
    // block and name the span backwards. Both gestures must say the same thing.
    await dragLines(page, 3, 6);
    const composer = page.locator('[data-testid="gitlab-diff-composer"]');
    await expect(composer).toHaveAttribute("data-lines", "Lines 3–6");

    await page.locator('[data-testid="gitlab-diff-comment-cancel"]').click();
    await dragLines(page, 6, 3);
    await expect(composer).toHaveAttribute("data-lines", "Lines 3–6");
    await page.locator('[data-testid="gitlab-diff-comment-cancel"]').click();
  });

  test("the comment lands as a thread on the lines it was written about", async ({ page }) => {
    await openHealthFile(page);
    await dragLines(page, 3, 5);
    await expect(page.locator('[data-testid="gitlab-diff-composer"]')).toBeVisible();

    await page
      .locator('[data-testid="gitlab-diff-comment-input"]')
      .fill("This block runs on every probe.");
    await page.locator('[data-testid="gitlab-diff-comment-send"]').click();

    // The box goes only once GitLab has taken the words, and what is left is the thread they
    // became — on the same lines, under the user's own name.
    await expect(page.locator('[data-testid="gitlab-diff-composer"]')).toHaveCount(0);
    const thread = page.locator('[data-testid="gitlab-diff-thread"][data-lines="Lines 3–5"]');
    await expect(thread).toBeVisible();
    await expect(thread).toContainText("This block runs on every probe.");
    await expect(thread.locator('[data-testid="gitlab-diff-note"]').first()).toHaveAttribute(
      "data-mine",
      "true",
    );

    // And the undo that makes writing one from this page acceptable, asked for twice.
    await thread.locator('[data-testid="gitlab-diff-note-delete"]').first().click();
    await thread.locator('[data-testid="gitlab-diff-note-delete-confirm"]').first().click();
    await expect(thread).toHaveCount(0);
  });

  test("draws the threads already on the file, and replies into one", async ({ page }) => {
    await openHealthFile(page);

    // The thread the fixture holds: a comment on a RANGE, by a colleague, with the user's own
    // answer under it. A colleague's comment offers no deletion — this app deletes only what
    // the user wrote themselves, exactly as it does for a Teams message.
    const thread = page.locator('[data-testid="gitlab-diff-thread"][data-lines="Lines 8–10"]');
    await expect(thread).toBeVisible();
    const theirs = thread.locator('[data-testid="gitlab-diff-note"]').first();
    await expect(theirs).toContainText("Three returns for one question");
    await expect(theirs.locator('[data-testid="gitlab-diff-note-delete"]')).toHaveCount(0);

    await thread.locator('[data-testid="gitlab-diff-thread-reply"]').click();
    await thread.locator('[data-testid="gitlab-diff-reply-input"]').fill("Splitting it then.");
    await thread.locator('[data-testid="gitlab-diff-reply-send"]').click();

    // A reply lands IN the thread rather than starting one of its own: the count grows and no
    // second card appears on those lines.
    await expect(thread.locator('[data-testid="gitlab-diff-note"]')).toHaveCount(3);
    await expect(page.locator('[data-testid="gitlab-diff-thread"][data-lines="Lines 8–10"]')).toHaveCount(1);
  });

  test("a comment that GitLab refused is reported at the box, with the words still in it", async ({
    page,
  }) => {
    await openHealthFile(page);
    await gutterLine(page, 5).click();
    await page.locator('[data-testid="gitlab-diff-comment-input"]').fill("Refused, this one.");

    await setMergeRequestControl(page, {
      refuse: "GitLab refused: this account may not comment there",
    });
    await page.locator('[data-testid="gitlab-diff-comment-send"]').click();

    // The refusal is beside the words rather than on a page the reader is not looking at — and
    // the box keeps what they wrote, because a comment that never left must not vanish.
    await expect(page.locator('[data-testid="gitlab-diff-comment-error"]')).toContainText(
      "may not comment there",
    );
    await expect(page.locator('[data-testid="gitlab-diff-comment-input"]')).toHaveValue(
      "Refused, this one.",
    );
    // Cleared, because one mock process serves the whole run and a refusal left armed would
    // fail every write after this one.
    await setMergeRequestControl(page, { clear: true });
    await page.locator('[data-testid="gitlab-diff-comment-cancel"]').click();
  });

  test("offers no comment on a file with no line to point at", async ({ page }) => {
    await openHealthFile(page);
    // A binary file has no patch, so there is nothing to press and nothing to place a comment
    // against. The control is not drawn at all rather than drawn dead.
    await pickFile(page, "docs/diagrams/rollout.png");
    await expect(page.locator('[data-testid="gitlab-diff-file-notice"]')).toBeVisible();
    await expect(page.locator('[data-testid="gitlab-diff-comment-affordance"]')).toHaveCount(0);
  });

  test("takes a half-written comment away with the file it was about", async ({ page }) => {
    await openHealthFile(page);
    await gutterLine(page, 5).click();
    await expect(page.locator('[data-testid="gitlab-diff-composer"]')).toBeVisible();

    // Walking to another file leaves the code the comment was about, so the box goes with it:
    // a composer left open over unrelated code would name a line it is not about.
    await pickFile(page, "charts/user-facing/values.yaml");
    await expect(page.locator('[data-testid="gitlab-diff-composer"]')).toHaveCount(0);
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
