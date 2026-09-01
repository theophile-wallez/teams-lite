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

    // The pipeline is a GRAPH, in the shape its own author wrote: the mock's fixture declares
    // `needs`, so the panel groups by dependency and `🤖 opencode review` — which waits for
    // nothing — starts in the first column beside the lint it comes after by stage.
    const graph = page.locator('[data-testid="gitlab-pipeline-graph"]');
    await expect(graph).toHaveAttribute("data-grouping", "needs");
    const columns = graph.locator('[data-testid="gitlab-pipeline-column"]');
    await expect(columns).toHaveCount(3);
    await expect(columns.nth(0).locator('[data-testid="gitlab-pipeline-job"]')).toHaveCount(2);

    // And it is LIVE: the panel says it is following, and a job that was running turns
    // green on its own — the mock advances one step per read, so this is the poll working
    // rather than a still picture.
    await expect(page.locator('[data-testid="gitlab-pipeline-live"]')).toBeVisible();
    const unit = graph.locator('[data-testid="gitlab-pipeline-job"][data-name="🧪 unit"]');
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

    // A pasted SCREENSHOT is a picture, and the promise the whole page is built on still holds:
    // its bytes came through the backend, so what the browser holds is a local blob and it
    // asked GitLab for nothing (see `gitlab-upload.ts`).
    const picture = description.locator('[data-testid="message-image"]');
    await expect(picture).toHaveCount(1);
    await expect(picture).toHaveAttribute("src", /^blob:/);
    await expect(description).not.toContainText("/uploads/");
    await expect(description).not.toContainText("width=777");

    // A comment is the same markdown, because a review quotes code as often as a description
    // does.
    await page.locator('[data-testid="gitlab-comments"]').scrollIntoViewIfNeeded();
    const note = page.locator('[data-testid="gitlab-note"]').filter({ hasText: "MEDIUM" });
    await expect(note.locator("pre")).toContainText("sleep {{ .Values.drain }}");
  });

  test("draws a pasted screenshot, and leaves an image on another host a link", async ({
    page,
  }) => {
    await openGitLab(page);
    await openMergeRequest(page, 596);
    await page.locator('[data-testid="gitlab-comments"]').scrollIntoViewIfNeeded();
    const note = page.locator('[data-testid="gitlab-note"]').filter({ hasText: "Two replicas" });

    // The upload is drawn, at the size the author's own attribute block asked for — and it
    // holds that room before the bytes arrive, so the words around it do not move when they do.
    const picture = note.locator('[data-testid="message-image"]');
    await expect(picture).toHaveCount(1);
    await expect(picture).toHaveAttribute("src", /^blob:/);
    await expect(picture).toHaveAttribute("width", "420");

    // The badge on somebody ELSE's host stays a link. Fetching it would tell that host the
    // user read this page, which is the read receipt a mail body is stripped of.
    const address = "https://img.shields.io/badge/build-passing-green.svg";
    await expect(note.locator(`a[href="${address}"]`)).toContainText("build status");
    // The badge itself is never drawn — the link's own favicon chip, which every link in this
    // app wears, is a different picture from a different host.
    await expect(note.locator(`img[src="${address}"]`)).toHaveCount(0);
  });

  test("a picture that cannot be read costs the picture and nothing else", async ({ page }) => {
    await setMergeRequestControl(page, {
      refuse_upload: "GitLab no longer holds this picture, or the token cannot see it",
    });
    await openGitLab(page);
    await openMergeRequest(page, 596);
    await page.locator('[data-testid="gitlab-description-toggle"]').click();
    const description = page.locator('[data-testid="gitlab-description"]');

    // The picture says it is missing, by the name the author gave it — and every word of the
    // description is still there, which is the contract the diff's own failure already holds.
    await expect(description.locator('[data-testid="message-image-error"]')).toContainText(
      "deploy-topology.png",
    );
    await expect(description.locator("h2").first()).toHaveText("What changes");
    await expect(description.locator("table")).toHaveCount(1);
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

    // The press is a MOVEMENT, not a swap: the box is caught between the two heights while it
    // travels. Sampled off the box's own inline height, because that is what Motion drives —
    // and this is the one assertion that fails if the fold ever becomes an instant jump.
    const travel = page.evaluate(() => {
      const box = document.getElementById("gitlab-description-box")!;
      const seen: number[] = [];
      const started = performance.now();
      return new Promise<number[]>((resolve) => {
        const tick = () => {
          seen.push(box.getBoundingClientRect().height);
          if (performance.now() - started < 400) requestAnimationFrame(tick);
          else resolve(seen);
        };
        requestAnimationFrame(tick);
      });
    });
    await toggle.click();
    const heights = await travel;
    const shut = heights[0]!;
    const wide = heights.at(-1)!;
    expect(wide).toBeGreaterThan(shut + 40);
    const between = heights.filter((h) => h > shut + 8 && h < wide - 8);
    expect(between.length).toBeGreaterThan(3);

    // The press opens it: the same control the other way round, and that last line is now
    // inside the box. Measured after the motion settles rather than during it.
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

    // Walking away and coming back FOLDS again — the fold is the state a page opens in, and
    // this pane is not re-created when the open merge request changes, so the description is
    // keyed by it (see `mergeRequestId` on the mount).
    await toggle.click();
    await expect(description).not.toHaveAttribute("data-folded", "true");
    await page.locator('[data-testid="tab-gitlab"]').click();
    await openMergeRequest(page, 63);
    await openMergeRequest(page, 596);
    await expect(page.locator('[data-testid="gitlab-description"]')).toHaveAttribute(
      "data-folded",
      "true",
    );

    // A description that already fits keeps NO control: there is nothing behind it, and a
    // click that reveals nothing reads as a bug (!595's own is one sentence).
    await page.locator('[data-testid="tab-gitlab"]').click();
    await openMergeRequest(page, 595);
    await expect(page.locator('[data-testid="gitlab-description"]')).toBeVisible();
    await expect(page.locator('[data-testid="gitlab-description-toggle"]')).toHaveCount(0);
  });

  test("opens already folded — the fold is not an animation the reader watches", async ({
    page,
  }) => {
    // The page OPENS folded, and getting there is not a movement: a description that unrolled
    // and then rolled itself up is the reader watching the app make up its mind. It used to do
    // exactly that — the box was clamped by CSS until the words were measured, and the
    // measurement handed Motion its natural height to travel down FROM. So the height is only
    // ever animated by a PRESS (`everPressed` in gitlab-pane.tsx).
    await openGitLab(page);
    const sampled = page.evaluate(() => {
      const seen: number[] = [];
      const started = performance.now();
      return new Promise<number[]>((resolve) => {
        const tick = () => {
          const box = document.getElementById("gitlab-description-box");
          if (box) seen.push(box.getBoundingClientRect().height);
          if (performance.now() - started < 900) requestAnimationFrame(tick);
          else resolve(seen);
        };
        requestAnimationFrame(tick);
      });
    });
    await openMergeRequest(page, 596);
    const heights = await sampled;
    expect(heights.length).toBeGreaterThan(3);
    // The box is NEVER taller than the fold, on any frame it was on screen for. That is the
    // whole assertion: a collapse the reader watches starts at the document's own height (400px
    // and up on this fixture) and comes down, so one sample over the window would catch it.
    expect(Math.max(...heights)).toBeLessThan(200);
    // And it settles without travelling: two heights at most — the one before layout and the
    // fold — where an animation would leave a dozen.
    expect(new Set(heights.map(Math.round)).size).toBeLessThanOrEqual(2);
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

  test("rewrites and resolves from the merge request too, so one thread is one answer", async ({
    page,
  }) => {
    await openGitLab(page);
    await openMergeRequest(page, 596);
    const thread = page.locator('[data-testid="gitlab-discussion"][data-discussion="d-596-2"]');
    const mine = thread.locator('[data-testid="gitlab-note"][data-mine="true"]').first();

    // EDIT: the box opens on the words that are there, and the mark follows the rewrite.
    await mine.locator('[data-testid="gitlab-note-edit"]').click();
    await thread.locator('[data-testid="gitlab-note-edit-input"]').fill("Quoted it in `2f91ac0` — and pinned it.");
    await thread.locator('[data-testid="gitlab-note-edit-save"]').click();
    await expect(mine).toContainText("pinned it");
    await expect(mine.locator('[data-testid="gitlab-note-edited"]')).toBeVisible();
    await expect(page.locator('[data-testid="gitlab-action-done"]')).toContainText("rewritten");

    // RESOLVE: the same control the diff page's card offers, on the same thread.
    const resolve = thread.locator('[data-testid="gitlab-thread-resolve"]');
    await expect(resolve).toHaveText("Resolve");
    await resolve.click();
    await expect(page.locator('[data-testid="gitlab-action-done"]')).toContainText("resolved");
    await expect(resolve).toHaveText("Reopen");
    await resolve.click();
    await expect(page.locator('[data-testid="gitlab-action-done"]')).toContainText("reopened");

    // A STANDALONE comment carries neither state, so no resolution is offered on one — GitLab
    // answers 400 for it, and a control that cannot work must not be drawn.
    const plain = page.locator('[data-testid="gitlab-discussion"][data-discussion="d-596-1"]');
    await expect(plain).toBeVisible();
    await expect(plain.locator('[data-testid="gitlab-thread-resolve"]')).toHaveCount(0);
    // …and neither an edit nor a deletion on a colleague's words.
    await expect(plain.locator('[data-testid="gitlab-note-edit"]')).toHaveCount(0);
    await expect(plain.locator('[data-testid="gitlab-note-delete"]')).toHaveCount(0);
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

  test("keeps the approval and the merge in the header, and only where they can be reported", async ({
    page,
  }) => {
    await openGitLab(page);
    await openMergeRequest(page, 596);

    // The two decisions this page is opened to make live in its HEADER, so they are reachable
    // without reading down to them — and each is drawn ONCE, because a reader must never have
    // to choose which copy of a write to press.
    const header = page.locator('[data-testid="gitlab-pane"] > header');
    await expect(header.locator('[data-testid="gitlab-mr-actions"]')).toBeVisible();
    await expect(header.locator('[data-testid="gitlab-approve"]')).toBeVisible();
    await expect(header.locator('[data-testid="gitlab-merge"]')).toBeVisible();
    await expect(page.locator('[data-testid="gitlab-approve"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="gitlab-merge"]')).toHaveCount(1);

    // The header does not scroll, which is the whole point of moving them into it: the merge is
    // still on screen at the foot of the conversation, where the old panel was long gone.
    await page.locator('[data-testid="gitlab-comments"]').scrollIntoViewIfNeeded();
    await expect(header.locator('[data-testid="gitlab-merge"]')).toBeInViewport();

    // The WORDS stay in the article — GitLab's reason for refusing, what the armed press costs,
    // and what GitLab answered — because a header row is wide enough for a control and never
    // for a sentence.
    await expect(page.locator('[data-testid="gitlab-actions"]')).toBeVisible();
    await expect(page.locator('[data-testid="gitlab-merge-hint"]')).toHaveCount(1);

    // So the writes are offered on the page that carries those words and nowhere else: an
    // outward action must not be taken where its outcome cannot be reported.
    await pageTab(page, "pipelines").click();
    await expect(page.locator('[data-testid="gitlab-mr-actions"]')).toHaveCount(0);
    await pageTab(page, "overview").click();
    await expect(page.locator('[data-testid="gitlab-mr-actions"]')).toBeVisible();

    // And the row costs the header no width at any size: the controls hold theirs and the
    // TITLE is what gives way, on a phone as on a desktop (the long-title lesson).
    for (const width of [1200, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const paneBox = (await page.locator('[data-testid="gitlab-pane"]').boundingBox())!;
      const actions = (await page.locator('[data-testid="gitlab-mr-actions"]').boundingBox())!;
      expect(actions.x + actions.width).toBeLessThanOrEqual(paneBox.x + paneBox.width + 1);
      expect(paneBox.x + paneBox.width).toBeLessThanOrEqual(width + 1);
    }

    // Armed, it says on the button that the next press cannot be undone — the short spelling of
    // it on a phone, where the same sentence is under the page in full.
    await page.locator('[data-testid="gitlab-merge"]').click();
    const confirm = page.locator('[data-testid="gitlab-merge-confirm"]');
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("Confirm merge");
    // And the page brings that sentence to the reader, because the press it explains was made
    // in a header that does not scroll: the words may have been a screen away.
    await expect(page.locator('[data-testid="gitlab-merge-hint"]')).toBeInViewport();
    const armedBox = (await confirm.boundingBox())!;
    const armedPane = (await page.locator('[data-testid="gitlab-pane"]').boundingBox())!;
    expect(armedBox.x + armedBox.width).toBeLessThanOrEqual(armedPane.x + armedPane.width + 1);
    await page.setViewportSize({ width: 1200, height: 900 });

    // A walk through the strip takes the arming back: a destructive control left armed behind a
    // page the reader went to and returned from is one they have forgotten they armed.
    await pageTab(page, "pipelines").click();
    await pageTab(page, "overview").click();
    await expect(page.locator('[data-testid="gitlab-merge"]')).toBeVisible();
    await expect(page.locator('[data-testid="gitlab-merge-confirm"]')).toHaveCount(0);
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

  test("names an author who is also the assignee once, and two people twice", async ({ page }) => {
    await openGitLab(page);

    // !596 is assigned to the person who wrote it, which is the common case on the tenant. Its
    // name used to be spelled twice a centimetre apart — Author Ada, Assignees Ada — which
    // reads at a glance as two people.
    await openMergeRequest(page, 596);
    const rows = page.locator('[data-testid="gitlab-people"]');
    await expect(rows.filter({ hasText: "Author & assignee" })).toBeVisible();
    await expect(rows.filter({ hasText: "Assignees" })).toHaveCount(0);
    // Once, not twice: one chip carries the pair.
    await expect(rows.locator('[data-person="Ada Lovelace"]')).toHaveCount(1);

    // !63 is assigned to somebody else, and then both rows stand: merging them would drop a
    // name, and who the work sits with is what the assignee row is for.
    await openMergeRequest(page, 63);
    await expect(rows.filter({ hasText: "Author & assignee" })).toHaveCount(0);
    await expect(page.locator('[data-testid="gitlab-people"][data-label="Author"]')).toContainText(
      "Ada Lovelace",
    );
    await expect(
      page.locator('[data-testid="gitlab-people"][data-label="Assignees"]'),
    ).toContainText("Lucas Silva");
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

  // ---- the four PAGES of a merge request ----------------------------------
  //
  // The sub-header under the header: Overview, Commits, Pipelines, Diffs — GitLab's own set in
  // GitLab's own order, each one a route of its own (see lib/gitlab-mr-pages.ts). Two of the
  // four hold nothing yet and say so, which is what these tests hold them to.

  /** The strip's own tab for one page. Each carries a testid of its own, because the strip is
   *  the app's `Tabs` primitive and a trigger takes no data attribute of ours. */
  function pageTab(page: Page, name: string) {
    return page.locator(`[data-testid="gitlab-mr-page-${name}"]`);
  }

  test("names the four pages of a merge request, and opens on the Overview", async ({ page }) => {
    await openGitLab(page);
    await openMergeRequest(page, 596);

    const strip = page.locator('[data-testid="gitlab-mr-pages"]');
    await expect(strip).toBeVisible();
    await expect(page.locator('[role="tab"][data-testid^="gitlab-mr-page-"]')).toHaveText([
      "Overview",
      "Commits",
      "Pipelines",
      "Diffs",
    ]);

    // Opening a merge request means its Overview, and the strip says which page that is —
    // to a reader and to a screen reader alike.
    await expect(strip).toHaveAttribute("data-page", "overview");
    await expect(pageTab(page, "overview")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('[data-testid="gitlab-heading"]')).toBeVisible();
    expect(page.url()).toMatch(/\/mr\/[^/]+$/);

    // The tabs stand in the sub-header itself rather than inside a card: the row is the only
    // surface, and the wash sits on the current tab alone.
    const list = page.locator('[role="tablist"][aria-label="Merge request pages"]');
    await expect(list).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(list).toHaveCSS("box-shadow", "none");

    // And each tab really controls the page under it, which is what the primitive promises:
    // `aria-controls` names an element that is there.
    const controls = await pageTab(page, "overview").getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    await expect(page.locator(`#${controls}`)).toBeVisible();
  });

  test("a page is a PLACE: its own URL, reloadable, and Back leaves it", async ({ page }) => {
    await openGitLab(page);
    await openMergeRequest(page, 596);
    await pageTab(page, "commits").click();

    // The URL is what makes it a place rather than a piece of state, exactly as the diff's is.
    expect(page.url()).toMatch(/\/commits$/);
    await expect(page.locator('[data-testid="gitlab-mr-pages"]')).toHaveAttribute(
      "data-page",
      "commits",
    );
    // A page this app does not read yet SAYS so and offers GitLab's own for it. Drawn blank it
    // would read as a read that failed.
    const unbuilt = page.locator('[data-testid="gitlab-mr-unbuilt"]');
    await expect(unbuilt).toHaveAttribute("data-page", "commits");
    await expect(unbuilt).toContainText("not read here yet");
    await expect(page.locator('[data-testid="gitlab-mr-unbuilt-link"]')).toHaveAttribute(
      "href",
      /\/commits$/,
    );
    // And nothing of the Overview is left behind it: one page at a time, or the reader would
    // be reading the description under a heading that says Commits.
    await expect(page.locator('[data-testid="gitlab-heading"]')).toHaveCount(0);

    await page.reload();
    await expect(page.locator('[data-testid="gitlab-mr-unbuilt"]')).toHaveAttribute(
      "data-page",
      "commits",
    );

    // The browser's own Back returns to the page the reader came from.
    await page.goBack();
    await expect(page.locator('[data-testid="gitlab-heading"]')).toBeVisible();
    expect(page.url()).not.toMatch(/\/commits$/);
  });

  test("the Pipelines page holds the GRAPH, and the Overview keeps its own", async ({ page }) => {
    await openGitLab(page);
    await openMergeRequest(page, 596);
    await pageTab(page, "pipelines").click();

    // It is BUILT: the head pipeline drawn as the graph of its jobs. So it says nothing about
    // being missing, and the way out to GitLab is the page's own link rather than a stand-in.
    await expect(page.locator('[data-testid="gitlab-pipeline-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="gitlab-mr-unbuilt"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="gitlab-pipeline-link"]')).toBeVisible();
    // One page at a time: nothing of the Overview is left behind it.
    await expect(page.locator('[data-testid="gitlab-heading"]')).toHaveCount(0);

    // Back to the Overview from the strip itself, which is the way a reader takes.
    await pageTab(page, "overview").click();
    await expect(page.locator('[data-testid="gitlab-pipeline"]')).toBeVisible();
  });

  test("the strip is on the DIFF page too, and reaches the other three from it", async ({
    page,
  }) => {
    await openGitLab(page);
    await openMergeRequest(page, 596);

    // The Diffs tab opens the full-screen diff — the same place "Review the changes" opens.
    await pageTab(page, "diffs").click();
    await expect(page.locator('[data-testid="gitlab-diff-page"]')).toBeVisible();
    expect(page.url()).toMatch(/\/diff$/);
    await expect(page.locator('[data-testid="gitlab-mr-pages"]')).toHaveAttribute(
      "data-page",
      "diffs",
    );

    // A strip that vanished on one of the four would leave the reader with a Back button
    // where they wanted a Commits tab.
    await pageTab(page, "commits").click();
    await expect(page.locator('[data-testid="gitlab-mr-unbuilt"]')).toHaveAttribute(
      "data-page",
      "commits",
    );
    // And the app's own sidebar is back, because the diff was the one page that took it.
    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible();
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
   *  on a phone — so this is the one wait that holds everywhere. The feed is a separate wait
   *  (`waitForFeed`) because on a phone there is not one until the reader picks a file. */
  async function openDiffPage(page: Page) {
    await page.locator('[data-testid="gitlab-review-changes"]').scrollIntoViewIfNeeded();
    await page.locator('[data-testid="gitlab-review-changes"]').click();
    await expect(page.locator('[data-testid="gitlab-diff-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="gitlab-diff-tree"]')).toBeVisible({ timeout: 25_000 });
  }

  /** Wait for the FEED to hold a drawn file. Generous, because what takes the time is the lazy
   *  chunk and then Shiki resolving the first files' own grammars.
   *
   *  ATTACHED rather than visible: each file's header carries a sentinel of this app's that is
   *  DATA — a file with nothing to say beside its name draws no ink at all, which is most files. */
  async function waitForFeed(page: Page) {
    await expect(
      page.locator('[data-testid="gitlab-diff-feed"] [data-testid="gitlab-diff-file"]').first(),
    ).toBeAttached({ timeout: 25_000 });
  }

  /** One FILE of the feed, as the renderer's own element.
   *
   *  It carries no path of its own, so it is found by the header slot this app renders into it —
   *  a light-DOM child of that element. Scoping to it is what makes a line number mean one file,
   *  which in a feed is the whole difference between commenting on the code the reader means and
   *  on line 42 of something else. */
  function feedFile(page: Page, path: string) {
    return page
      .locator(`diffs-container:has([data-testid="gitlab-diff-file"][data-path="${path}"])`)
      .first();
  }

  /** What one file's own header says beside its name: why there is no code under it. */
  function fileNotice(page: Page, path: string) {
    return page.locator(`[data-testid="gitlab-diff-file-notice"][data-path="${path}"]`);
  }

  /** Bring one file to the top of the feed by pressing its row in the tree.
   *
   *  Pierre's tree renders into a shadow root and Playwright's CSS engine pierces an open one,
   *  so this drives the row a reader would press. The assertion is on the PANE's own statement
   *  of which file the reader is AT, which is what the press moves. */
  async function pickFile(page: Page, path: string) {
    await page.locator(`[data-item-path="${path}"]`).first().click();
    await expect(page.locator('[data-testid="gitlab-diff-pane"]')).toHaveAttribute(
      "data-path",
      path,
    );
    // The feed has just scrolled, and the renderer mounts what the scroll reached, resolves its
    // grammars and re-measures over the next frame or two. A gesture driven into that window
    // reads a line's box and presses where the box no longer is — which only a script is fast
    // enough to do (`pickDiffFile` in web/scripts/preview.ts makes the same allowance).
    await page.waitForTimeout(400);
  }

  /** Scroll the feed the way a reader does — the wheel over the code — and let the renderer
   *  settle: it mounts what the scroll reached, resolves its grammars and re-measures. */
  async function scrollFeed(page: Page, by: number) {
    await page.locator('[data-testid="gitlab-diff-feed"]').hover();
    await page.mouse.wheel(0, by);
    await page.waitForTimeout(700);
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
    // And nothing of the diff itself is on this page: no tree, no feed, so no highlighter on
    // the path of a merge request somebody opened to read the description.
    await expect(page.locator('[data-testid="gitlab-diff-tree"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="gitlab-diff-feed"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="gitlab-review-changes"]')).toBeVisible();
  });

  test("the diff is a PLACE: its own URL, reloadable, and Back leaves it", async ({ page }) => {
    await openGitLab(page);
    await openMergeRequest(page, 596);
    await openDiffPage(page);
    await waitForFeed(page);

    // The URL is what makes it a place rather than a piece of state — it can be sent to
    // somebody, and it survives a reload.
    expect(page.url()).toMatch(/\/diff$/);
    await expect(page.locator('[data-testid="gitlab-diff-title"]')).toContainText("HA replicas");
    await page.reload();
    await expect(page.locator('[data-testid="gitlab-diff-page"]')).toBeVisible();
    await waitForFeed(page);

    // It takes the WHOLE screen: the app's own sidebar is not drawn beside it, because the page
    // is already two columns and a third of chat rows would leave neither enough room.
    await expect(page.locator('[data-testid="sidebar"]')).toHaveCount(0);

    // And Back returns to the merge request it belongs to, which is still open.
    await page.locator('[data-testid="gitlab-diff-back"]').click();
    await expect(page.locator('[data-testid="gitlab-heading"]')).toBeVisible();
    expect(page.url()).not.toMatch(/\/diff$/);
  });

  test("holds every changed file in ONE feed, in GitLab's own order", async ({ page }) => {
    await openGitLab(page);
    await openMergeRequest(page, 596);
    await openDiffPage(page);
    await waitForFeed(page);

    // A review is read by scrolling, so the files are not behind a press each: the first ones
    // are drawn one under another, and the tree lists them all.
    await expect(feedFile(page, "charts/user-facing/values.yaml")).toBeVisible();
    await expect(feedFile(page, "charts/user-facing/templates/pdb.yaml")).toBeVisible();

    // Nothing was picked, so the reader is AT the first file that has a patch — never at a
    // sentence explaining there is nothing to see, which reads as a failed load.
    await expect(page.locator('[data-testid="gitlab-diff-pane"]')).toHaveAttribute(
      "data-path",
      "charts/user-facing/values.yaml",
    );
    await expect(page.locator('[data-testid="gitlab-diff-tree"]')).toBeVisible();
  });

  test("the tree follows the reader down the feed, and a press moves the feed", async ({
    page,
  }) => {
    await openGitLab(page);
    await openMergeRequest(page, 596);
    await openDiffPage(page);
    await waitForFeed(page);
    const pane = page.locator('[data-testid="gitlab-diff-pane"]');
    await expect(pane).toHaveAttribute("data-path", "charts/user-facing/values.yaml");

    // SCROLLING is the gesture: the file at the top of the screen changes, and the row the tree
    // lights changes with it. That pairing is the whole feature, and it is driven through the
    // pointer because the reader's own wheel is what it has to answer.
    await scrollFeed(page, 700);
    await expect(pane).not.toHaveAttribute("data-path", "charts/user-facing/values.yaml");
    // The row lighting itself must never read as a press: doing so threw a reader scrolling the
    // feed back to the top of the diff every few files.
    const reached = await pane.getAttribute("data-path");
    await scrollFeed(page, 200);
    const stillGoing = await pane.getAttribute("data-path");
    expect([reached, stillGoing]).not.toContain("charts/user-facing/values.yaml");

    // And a press in the tree is the other direction: that file comes to the top at once, with
    // nothing to load — the whole diff was read with the merge request.
    await pickFile(page, "charts/user-facing/values.yaml");
    await expect(feedFile(page, "charts/user-facing/values.yaml")).toBeVisible();
  });

  test("tells the files with no patch apart, in the feed", async ({ page }) => {
    await openGitLab(page);
    await openMergeRequest(page, 596);
    await openDiffPage(page);
    await waitForFeed(page);

    // Every one of them is IN the feed — the tree lists them, so a feed that skipped one would
    // make the tree lie about where the reader is — and each says something different in its own
    // header, because the reader's next move differs for each.
    await pickFile(page, "src/server/drain.ts");

    // A pure RENAME: no hunks by definition, and its patch IS the header stating the move — so
    // pierre draws that header and this page explains NOTHING. It must never read as a file
    // GitLab collapsed, which is what GitLab's own `collapsed: true` on those rows would have
    // made it.
    await expect(fileNotice(page, "src/server/drain.ts")).toHaveCount(0);
    await expect(feedFile(page, "src/server/drain.ts")).toBeVisible();

    // A BINARY file: GitLab describes it with one sentence rather than hunks, and this page says
    // so instead of running that prose through a code renderer.
    const binary = fileNotice(page, "docs/diagrams/rollout.png");
    await expect(binary).toHaveAttribute("data-state", "binary");
    await expect(binary).toContainText(/binary/i);

    // A file GitLab COLLAPSED — the one state a second read can mend — and it says GENERATED,
    // because a surprising change hides in one.
    const collapsed = fileNotice(page, "bun.lock");
    await expect(collapsed).toHaveAttribute("data-state", "collapsed");
    await expect(collapsed).toContainText(/did not expand/i);
    await expect(
      page.locator('[data-testid="gitlab-diff-generated"][data-path="bun.lock"]'),
    ).toContainText("generated");
  });

  test("offers the expanded read once, names what it costs, then stops offering", async ({
    page,
  }) => {
    await openGitLab(page);
    await openMergeRequest(page, 596);
    await openDiffPage(page);
    await waitForFeed(page);

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
    await expect(fileNotice(page, "bun.lock")).toHaveAttribute("data-state", "collapsed");

    await expand.click();
    // Now it does — the item the feed holds for that file has to be handed over again, which is
    // what its version is for: a file that came back with a patch under the same path went on
    // being drawn as the sentence that stood in for it.
    await pickFile(page, "bun.lock");
    await expect(
      page.locator('[data-testid="gitlab-diff-file"][data-path="bun.lock"]'),
    ).toHaveAttribute("data-state", "patch", { timeout: 25_000 });
    await expect(fileNotice(page, "bun.lock")).toHaveCount(0);
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

    // A pick is a navigation into the feed, opened AT that file.
    await pickFile(page, "src/server/health.ts");
    await expect(diffPage).toHaveAttribute("data-column", "patch");
    await waitForFeed(page);
    await expect(feedFile(page, "src/server/health.ts")).toBeVisible();
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

  test("opens the file that is ALREADY current, which on a phone is the only way out", async ({
    page,
  }) => {
    // THE TRAP THIS CLOSES. `@pierre/trees` publishes one callback, `onSelectionChange`, and its
    // controller returns early when the selection it is handed matches the one it holds — so a press
    // on the row that is already current reports NOTHING. On a narrow screen that press is also the
    // navigation from the files to the patch, so the reader was stuck: pressing the lit row did
    // nothing, for ever. A diff of ONE file is the worst of it, because that file is always the
    // current one and there is no other row to press instead.
    await page.setViewportSize({ width: 390, height: 844 });
    await openGitLab(page);
    await openMergeRequest(page, 596);
    await openDiffPage(page);

    const diffPage = page.locator('[data-testid="gitlab-diff-page"]');
    await expect(diffPage).toHaveAttribute("data-column", "files");

    // Press a file: this much always worked, because the selection really changed.
    await pickFile(page, HEALTH);
    await expect(diffPage).toHaveAttribute("data-column", "patch");

    // Back to the list. That file is now the one the page is AT, so its row is the lit one.
    await page.locator('[data-testid="gitlab-diff-back"]').click();
    await expect(diffPage).toHaveAttribute("data-column", "files");

    // Press it AGAIN. Nothing about the tree's selection changes, so the vendor reports nothing —
    // and before the fix this press did nothing at all, leaving the reader on the file list with no
    // way to the code. The assertion below timed out.
    //
    // It is asserted WITHOUT `pickFile`, which waits on the pane's own sentinel: what is being
    // tested is that the press navigates, so the navigation has to be the thing asserted.
    await page.locator(`[data-item-path="${HEALTH}"]`).first().click();
    await expect(diffPage).toHaveAttribute("data-column", "patch");
    await expect(page.locator('[data-testid="gitlab-diff-pane"]')).toHaveAttribute(
      "data-path",
      HEALTH,
    );

    // And a THIRD time, because a press must not be a one-off: whatever answers it has to keep
    // answering.
    await page.locator('[data-testid="gitlab-diff-back"]').click();
    await expect(diffPage).toHaveAttribute("data-column", "files");
    await page.locator(`[data-item-path="${HEALTH}"]`).first().click();
    await expect(diffPage).toHaveAttribute("data-column", "patch");
  });

  // ---- a NAME pressed in the code, and the two columns being dragged ----------
  //
  // A reviewer meets an identifier and asks one thing about it — what else in this branch touches
  // it? — and the panel on the right answers it (see lib/gitlab-diff-symbols.ts). The columns
  // either side of the code are dragged, because a deep tree truncates every path at a fixed width
  // and a reader who has picked their file wants the room back for the code.

  /** One token of the code of one file, pressed the way a reader presses it.
   *
   *  `[data-char]` is `@pierre/diffs`' own element per token — it wraps them once a token handler
   *  is passed — and Playwright's CSS engine pierces the open shadow root they live in. Scoped to
   *  ONE file, because the same name stands in several, and EXACT, because `server` is a substring
   *  of `serverReady` and a loose match would press the wrong token. */
  async function pressToken(page: Page, path: string, token: string) {
    await feedFile(page, path)
      .locator("[data-char]")
      .filter({ hasText: new RegExp(`^${token}$`) })
      .first()
      .click();
  }

  const symbolsPanel = (page: Page) => page.locator('[data-testid="gitlab-diff-symbols"]');

  const VALUES = "charts/user-facing/values.yaml";
  const PDB = "charts/user-facing/templates/pdb.yaml";

  test("a press on a name lists every place it stands in the changes", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openGitLab(page);
    await openMergeRequest(page, 596);
    await openDiffPage(page);
    await waitForFeed(page);

    // Nothing is open until the reader asks.
    await expect(symbolsPanel(page)).toHaveCount(0);

    // `podDisruptionBudget` is a key in the chart's values and is read in the template beside it,
    // so the answer spans two files — which is the whole reason this is a column and not a tooltip.
    await pickFile(page, VALUES);
    await pressToken(page, VALUES, "podDisruptionBudget");
    await expect(symbolsPanel(page)).toHaveAttribute("data-symbol", "podDisruptionBudget");
    await expect(symbolsPanel(page)).toHaveAttribute("data-total", "3");
    await expect(page.locator('[data-testid="gitlab-diff-symbols-summary"]')).toHaveText(
      "3 occurrences in 2 files",
    );

    // Grouped by file, in the diff's own order, and every row emphasizes exactly the name.
    const files = page.locator('[data-testid="gitlab-diff-symbols-file"]');
    await expect(files).toHaveCount(2);
    await expect(files.nth(0)).toHaveAttribute("data-path", VALUES);
    await expect(files.nth(1)).toHaveAttribute("data-path", PDB);
    const marks = page.locator('[data-testid="gitlab-diff-symbols-match"]');
    await expect(marks).toHaveCount(3);
    for (const mark of await marks.all()) await expect(mark).toHaveText("podDisruptionBudget");

    // What the search could NOT see is stated: a file whose patch never travelled may hold the name
    // and this list would never say so. Two of these seven carry none — the binary file and the one
    // GitLab collapsed — and the RENAME is not one of them, because its patch IS its header.
    await expect(page.locator('[data-testid="gitlab-diff-symbols-limits"]')).toContainText(
      "2 files",
    );
  });

  test("presses the same name to close it, and a brace opens nothing at all", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openGitLab(page);
    await openMergeRequest(page, 596);
    await openDiffPage(page);
    await waitForFeed(page);
    await pickFile(page, HEALTH);

    await pressToken(page, HEALTH, "draining");
    await expect(symbolsPanel(page)).toHaveAttribute("data-symbol", "draining");
    // The press is its own undo — the shape the comment gesture already has for its lit line.
    await pressToken(page, HEALTH, "draining");
    await expect(symbolsPanel(page)).toHaveCount(0);

    // A token that is not a NAME does nothing rather than opening an empty panel: a side panel that
    // appeared with nothing in it would read as a bug, where a press that changes nothing reads as a
    // brace not being a name.
    await pressToken(page, HEALTH, "\\{");
    await expect(symbolsPanel(page)).toHaveCount(0);
  });

  test("a row of the panel is a PLACE: it goes to that file", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openGitLab(page);
    await openMergeRequest(page, 596);
    await openDiffPage(page);
    await waitForFeed(page);

    await pickFile(page, VALUES);
    await pressToken(page, VALUES, "podDisruptionBudget");

    // The row for the OTHER file: pressing it makes that file the one on screen.
    await page
      .locator(`[data-testid="gitlab-diff-symbols-file"][data-path="${PDB}"]`)
      .locator('[data-testid="gitlab-diff-symbols-occurrence"]')
      .first()
      .click();
    await expect(page.locator('[data-testid="gitlab-diff-pane"]')).toHaveAttribute(
      "data-path",
      PDB,
    );
    // And the panel is still open: a reader walking a list of places presses the next one.
    await expect(symbolsPanel(page)).toBeVisible();
  });

  test("draws no occurrences panel on a phone, where the page is one column at a time", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openGitLab(page);
    await openMergeRequest(page, 596);
    await openDiffPage(page);
    await pickFile(page, HEALTH);
    await waitForFeed(page);

    // The press still lands — it is the same code — but a third column here would be a page
    // competing with the two this one already has.
    await pressToken(page, HEALTH, "draining");
    await expect(symbolsPanel(page)).toHaveCount(0);
    // And no splitter either: each column fills the screen in turn, so there is nothing to divide.
    await expect(page.locator('[data-testid="gitlab-diff-files-splitter"]')).toHaveCount(0);
  });

  test("drags the files column wider, and remembers how wide", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openGitLab(page);
    await openMergeRequest(page, 596);
    await openDiffPage(page);

    const files = page.locator('[data-testid="gitlab-diff-files"]');
    const before = (await files.boundingBox())!;
    const handle = page.locator('[data-testid="gitlab-diff-files-splitter"]');
    const grip = (await handle.boundingBox())!;

    // The STEPS matter: a jump straight from one point to the other fires no move between them, so
    // the drag would report nothing at all.
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + 120, grip.y + grip.height / 2, { steps: 10 });
    await page.mouse.up();

    const after = (await files.boundingBox())!;
    expect(after.width).toBeGreaterThan(before.width + 100);

    // It survives a reload, because it is the reader's own preference for this browser.
    await page.reload();
    await expect(page.locator('[data-testid="gitlab-diff-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="gitlab-diff-tree"]')).toBeVisible({ timeout: 25_000 });
    const reloaded = (await files.boundingBox())!;
    expect(Math.abs(reloaded.width - after.width)).toBeLessThan(2);

    // Put it back where every other diff test expects it: one browser profile serves the whole run,
    // so a column left 120 px wider is state they all inherit. The KEYBOARD is what does it, which
    // is also the one assertion that this separator really is one.
    await handle.focus();
    for (let i = 0; i < 8; i += 1) await handle.press("ArrowLeft");
    await expect
      .poll(async () => Math.round((await files.boundingBox())!.width))
      .toBeLessThan(Math.round(before.width) + 10);
  });

  test("never lets a drag squeeze the code below its own minimum", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 900 });
    await openGitLab(page);
    await openMergeRequest(page, 596);
    await openDiffPage(page);

    const handle = page.locator('[data-testid="gitlab-diff-files-splitter"]');
    const grip = (await handle.boundingBox())!;
    // Drag it as far right as the window goes. The patch is what this page is FOR, so the drag stops
    // where the code would start being squeezed rather than leaving eight characters of it.
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(1090, grip.y + grip.height / 2, { steps: 12 });
    await page.mouse.up();

    const pane = (await page.locator('[data-testid="gitlab-diff-pane"]').boundingBox())!;
    // `DIFF_CODE_MIN_WIDTH`, less a pixel for a fractional layout.
    expect(pane.width).toBeGreaterThanOrEqual(359);

    // Back to where it was, for the reason the test above gives.
    await handle.focus();
    for (let i = 0; i < 40; i += 1) await handle.press("ArrowLeft");
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

  /** The file every gesture below is made in. In a feed a line number names nothing on its own —
   *  line 5 is in most of these files — so the file travels with it, which is the rule the app
   *  itself follows. */
  const HEALTH = "src/server/health.ts";

  /** One line number in the gutter of one FILE of the feed.
   *
   *  The file, the number AND the side. The side because in a unified diff an old line and a new
   *  line can wear the same number: three lines into a change block, `3` is both the line that
   *  went and the one that came. `data-column-number` and `data-line-type` are pierre's own
   *  attributes on a gutter cell, inside the shadow root Playwright pierces; everything asserted
   *  afterwards is this app's own `data-testid`. */
  function gutterLine(
    page: Page,
    path: string,
    line: number,
    side: "additions" | "deletions" = "additions",
  ) {
    const types =
      side === "additions"
        ? ["context", "addition", "change-addition"]
        : ["context", "deletion", "change-deletion"];
    const selector = types
      .map((type) => `[data-column-number="${line}"][data-line-type="${type}"]`)
      .join(", ");
    return feedFile(page, path).locator(`:is(${selector})`).first();
  }

  /** Drag down the gutter from one line number to another. The STEPS matter: a jump straight
   *  from one point to the other fires no move between them, and pierre would report one line. */
  async function dragLines(page: Page, path: string, from: number, to: number) {
    const start = await gutterLine(page, path, from).boundingBox();
    const end = await gutterLine(page, path, to).boundingBox();
    if (!start || !end) throw new Error(`no gutter line ${from} or ${to} in ${path}`);
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 10 });
    await page.mouse.up();
  }

  async function openHealthFile(page: Page) {
    await openGitLab(page);
    await openMergeRequest(page, 596);
    await openDiffPage(page);
    await waitForFeed(page);
    await pickFile(page, HEALTH);
    await expect(feedFile(page, HEALTH)).toBeVisible();
  }

  test("a press on a line number opens a comment box under that line", async ({ page }) => {
    await openHealthFile(page);

    // Nothing is open until the reader asks: a box drawn by default would be a comment nobody
    // started.
    await expect(page.locator('[data-testid="gitlab-diff-composer"]')).toHaveCount(0);
    await gutterLine(page, HEALTH, 5).click();

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
    await dragLines(page, HEALTH, 3, 6);
    const composer = page.locator('[data-testid="gitlab-diff-composer"]');
    await expect(composer).toHaveAttribute("data-lines", "Lines 3–6");

    await page.locator('[data-testid="gitlab-diff-comment-cancel"]').click();
    await dragLines(page, HEALTH, 6, 3);
    await expect(composer).toHaveAttribute("data-lines", "Lines 3–6");
    await page.locator('[data-testid="gitlab-diff-comment-cancel"]').click();
  });

  test("the comment lands as a thread on the lines it was written about", async ({ page }) => {
    await openHealthFile(page);
    await dragLines(page, HEALTH, 3, 5);
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
    await gutterLine(page, HEALTH, 5).click();
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

  test("rewrites one of the user's own comments, and says it was edited", async ({ page }) => {
    await openHealthFile(page);
    const thread = page.locator('[data-testid="gitlab-diff-thread"][data-lines="Lines 8–10"]');
    const mine = thread.locator('[data-testid="gitlab-diff-note"][data-mine="true"]').first();

    // The box opens on the words that are THERE: an edit is a change to them, not a blank page.
    await mine.locator('[data-testid="gitlab-diff-note-edit"]').click();
    const box = thread.locator('[data-testid="gitlab-diff-note-edit-input"]');
    await expect(box).toHaveValue(/Kept them apart on purpose/);

    await box.fill("Kept them apart on purpose: each one is logged differently.");
    await thread.locator('[data-testid="gitlab-diff-note-edit-save"]').click();

    await expect(box).toHaveCount(0);
    await expect(mine).toContainText("each one is logged differently");
    // The words on screen are not the words the thread replied to, so the comment says so.
    await expect(mine.locator('[data-testid="gitlab-diff-note-edited"]')).toBeVisible();
    // And an edit is offered on the user's OWN comment only — a colleague's carries neither
    // control, exactly as it carries no deletion.
    const theirs = thread.locator('[data-testid="gitlab-diff-note"]').first();
    await expect(theirs).not.toHaveAttribute("data-mine", "true");
    await expect(theirs.locator('[data-testid="gitlab-diff-note-edit"]')).toHaveCount(0);
  });

  test("an edit that GitLab refused keeps the words in the box", async ({ page }) => {
    await openHealthFile(page);
    const thread = page.locator('[data-testid="gitlab-diff-thread"][data-lines="Lines 8–10"]');
    const mine = thread.locator('[data-testid="gitlab-diff-note"][data-mine="true"]').first();
    await mine.locator('[data-testid="gitlab-diff-note-edit"]').click();
    await thread.locator('[data-testid="gitlab-diff-note-edit-input"]').fill("Refused rewrite.");

    await setMergeRequestControl(page, {
      refuse: "GitLab refused: this account may not comment there",
    });
    await thread.locator('[data-testid="gitlab-diff-note-edit-save"]').click();

    // The box stays open with the rewrite in it, and the refusal is in the thread it belongs to.
    await expect(thread.locator('[data-testid="gitlab-diff-note-edit-input"]')).toHaveValue(
      "Refused rewrite.",
    );
    await expect(thread.locator('[data-testid="gitlab-diff-comment-error"]')).toContainText(
      "may not comment there",
    );
    await setMergeRequestControl(page, { clear: true });
    await thread.locator('[data-testid="gitlab-diff-note-edit-cancel"]').click();
  });

  test("resolves a thread, folds it, and the reopen undoes both", async ({ page }) => {
    await openHealthFile(page);
    const thread = page.locator('[data-testid="gitlab-diff-thread"][data-lines="Lines 8–10"]');
    await expect(thread).toHaveAttribute("data-open", "true");

    // One press either way: each direction is the other's undo, so nothing asks twice.
    const resolve = thread.locator('[data-testid="gitlab-diff-thread-resolve"]');
    await expect(resolve).toHaveText("Resolve");
    await resolve.click();

    // A settled objection has no claim on the code: the thread says it is resolved and folds,
    // which is what GitLab's own diff does.
    await expect(thread).toHaveAttribute("data-resolved", "true");
    await expect(thread).not.toHaveAttribute("data-open", "true");
    await expect(thread.locator('[data-testid="gitlab-diff-thread-resolved"]')).toBeVisible();
    await expect(thread.locator('[data-testid="gitlab-diff-note"]')).toHaveCount(0);
    // The fold says how much is behind it — "resolved" alone does not say whether anybody
    // answered — and the reader's own press opens it again.
    await expect(thread.locator('[data-testid="gitlab-diff-thread-open"]')).toContainText(
      "comments",
    );
    await thread.locator('[data-testid="gitlab-diff-thread-open"]').click();
    await expect(thread.locator('[data-testid="gitlab-diff-note"]').first()).toBeVisible();

    // And the undo is the same control, the other way round.
    await expect(resolve).toHaveText("Reopen");
    await resolve.click();
    await expect(thread).not.toHaveAttribute("data-resolved", "true");
    await expect(thread).toHaveAttribute("data-open", "true");
  });

  test("a comment written on a line is a THREAD, so it can be resolved at once", async ({
    page,
  }) => {
    await openHealthFile(page);
    // A comment on a diff line is filed as a discussion, which is what makes it resolvable —
    // unlike a plain comment on the merge request, which GitLab answers 400 for.
    await gutterLine(page, HEALTH, 5).click();
    await page.locator('[data-testid="gitlab-diff-comment-input"]').fill("Worth settling.");
    await page.locator('[data-testid="gitlab-diff-comment-send"]').click();

    const thread = page.locator('[data-testid="gitlab-diff-thread"][data-lines="Line 5"]');
    await expect(thread).toBeVisible();
    await expect(thread.locator('[data-testid="gitlab-diff-thread-resolve"]')).toHaveText(
      "Resolve",
    );

    // Put the fixture back: one mock process serves the whole run.
    await thread.locator('[data-testid="gitlab-diff-note-delete"]').first().click();
    await thread.locator('[data-testid="gitlab-diff-note-delete-confirm"]').first().click();
    await expect(thread).toHaveCount(0);
  });

  test("offers no comment on a file with no line to point at", async ({ page }) => {
    await openHealthFile(page);
    // A binary file has no patch, so it has no line to press and nothing to place a comment
    // against. Its own item in the feed holds no gutter at all, rather than one drawn dead.
    const binary = feedFile(page, "docs/diagrams/rollout.png");
    await pickFile(page, "docs/diagrams/rollout.png");
    await expect(fileNotice(page, "docs/diagrams/rollout.png")).toBeVisible();
    await expect(binary.locator("[data-column-number]")).toHaveCount(0);
    await expect(binary.locator('[data-testid="gitlab-diff-comment-affordance"]')).toHaveCount(0);
  });

  test("keeps a half-written comment where its own code is", async ({ page }) => {
    await openHealthFile(page);
    await gutterLine(page, HEALTH, 5).click();
    const composer = page.locator('[data-testid="gitlab-diff-composer"]');
    await expect(composer).toBeVisible();
    await page.locator('[data-testid="gitlab-diff-comment-input"]').fill("Worth a note.");

    // The reader never LEAVES a file in a feed: pressing another row moves the feed, and the box
    // stays under the line it is about, with the words still in it. It used to be thrown away,
    // which was right while the page drew one file at a time and would now cost a half-written
    // comment to a scroll.
    await pickFile(page, "charts/user-facing/values.yaml");
    await expect(composer).toHaveAttribute("data-lines", "Line 5");
    await expect(page.locator('[data-testid="gitlab-diff-comment-input"]')).toHaveValue(
      "Worth a note.",
    );

    // It goes when the reader says so, which is the one thing that takes it away.
    await page.locator('[data-testid="gitlab-diff-comment-cancel"]').click();
    await expect(composer).toHaveCount(0);
  });

  // ---- the pipeline is a GRAPH, and a page of its own ----------------------
  //
  // The panel draws a look at the run; `/mr/<id>/pipeline` is where it is read. Everything
  // below runs against the mock's own pipelines, whose fixture declares `needs` (see
  // `MOCK_LIVE_PIPELINE_JOBS`) — the field GitLab's REST answer does not carry and the backend
  // reads over GraphQL, without which half of this surface could not exist.

  /** Open the Pipelines page of the open merge request, through the Overview's own press.
   *
   *  The strip reaches it too (the test above takes that way); this is the other one, and the
   *  press beside the compact graph is what a reader looking at a run in flight uses. */
  async function openPipeline(page: Page) {
    await page.locator('[data-testid="gitlab-pipeline-open"]').click();
    await expect(page.locator('[data-testid="gitlab-pipeline-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="gitlab-pipeline-job"]').first()).toBeVisible();
  }

  test("opens the graph as a ROUTE, and the browser's own Back leaves it", async ({ page }) => {
    await openGitLab(page);
    await openMergeRequest(page, 596);
    await openPipeline(page);

    // A URL, so it survives a reload and can be sent to whoever is asking why CI is red — and
    // it is the page the strip names, not a second address for one surface.
    expect(page.url()).toMatch(/\/pipelines$/);
    await expect(page.locator('[data-testid="gitlab-mr-pages"]')).toHaveAttribute(
      "data-page",
      "pipelines",
    );
    await page.reload();
    await expect(page.locator('[data-testid="gitlab-pipeline-page"]')).toBeVisible();

    await page.goBack();
    await expect(page.locator('[data-testid="gitlab-heading"]')).toBeVisible();
    await expect(page.locator('[data-testid="gitlab-pipeline-page"]')).toHaveCount(0);
  });

  test("groups by dependency, regroups by stage, and keeps the curves either way", async ({
    page,
  }) => {
    await openGitLab(page);
    await openMergeRequest(page, 596);
    await openPipeline(page);
    const graph = page.locator('[data-testid="gitlab-pipeline-graph"]');
    const columns = graph.locator('[data-testid="gitlab-pipeline-column"]');

    // It OPENS on the dependency grouping, because that is the shape the pipeline declares —
    // and a dependency column is a level, so it carries no stage name.
    await expect(graph).toHaveAttribute("data-grouping", "needs");
    await expect(columns.first()).not.toHaveAttribute("data-stage", /.+/);
    // `🤖 opencode review` waits for nothing, so it starts at once even though its STAGE comes
    // after the lint's. That is the whole reason this grouping exists.
    const review = graph.locator('[data-testid="gitlab-pipeline-job"][data-name="🤖 opencode review"]');
    await expect(columns.nth(0).locator('[data-testid="gitlab-pipeline-job"]')).toHaveCount(2);
    await expect(review).toBeVisible();

    // A curve per declared dependency, both of whose ends are cards.
    const edges = graph.locator('[data-testid="gitlab-pipeline-edge"]');
    await expect(edges).toHaveCount(4);

    // Regrouped by STAGE the columns are named and counted, and the curves are STILL there:
    // the dependencies are a fact about the pipeline rather than about the grouping.
    await page.locator('[data-testid="gitlab-pipeline-grouping"] [data-value="stage"]').click();
    await expect(graph).toHaveAttribute("data-grouping", "stage");
    await expect(columns.nth(0)).toHaveAttribute("data-stage", "check");
    await expect(columns.nth(2)).toHaveAttribute("data-stage", "deploy");
    await expect(edges).toHaveCount(4);

    // And the second control takes them away, which is the plain stage view.
    await page.locator('[data-testid="gitlab-pipeline-needs-toggle"]').click();
    await expect(graph).toHaveAttribute("data-needs", "hidden");
    await expect(edges).toHaveCount(0);
  });

  test("orders the stages as the PIPELINE does, not as GitLab answered", async ({ page }) => {
    await openGitLab(page);
    await openMergeRequest(page, 596);
    await openPipeline(page);
    await page.locator('[data-testid="gitlab-pipeline-grouping"] [data-value="stage"]').click();
    const columns = page.locator('[data-testid="gitlab-pipeline-column"]');

    // GitLab's jobs endpoint answers NEWEST FIRST, so the mock hands them over reversed exactly
    // as the tenant does — measured: 16 of 25 pipelines. Reading the order off that answer drew
    // every multi-stage pipeline backwards, `check` last, and it shipped that way.
    await expect(columns.nth(0)).toHaveAttribute("data-stage", "check");
    await expect(columns.nth(1)).toHaveAttribute("data-stage", "test");
    await expect(columns.nth(2)).toHaveAttribute("data-stage", "deploy");

    // The JOBS list is the same read and takes the same order, so the two views never disagree
    // about which stage came first.
    await page.locator('[data-testid="gitlab-pipeline-view"] [data-value="jobs"]').click();
    const stages = page.locator('[data-testid="gitlab-pipeline-jobs-stage"]');
    await expect(stages.first()).toContainText("check");
    await expect(stages.last()).toContainText("deploy");
  });

  test("answers what one job waits for, and what waits on it", async ({ page }) => {
    await openGitLab(page);
    await openMergeRequest(page, 596);
    await openPipeline(page);
    const graph = page.locator('[data-testid="gitlab-pipeline-graph"]');
    const job = (name: string) =>
      graph.locator(`[data-testid="gitlab-pipeline-job"][data-name="${name}"]`);

    // Nothing pointed at: the whole graph is at full weight. The pointer is moved off first
    // deliberately — pressing "Open the pipeline" leaves it wherever that button was, and a
    // card that lands under it IS hovered, which is the behaviour rather than a fault.
    await page.mouse.move(4, 4);
    await expect(graph).not.toHaveAttribute("data-focused", /.+/);
    await expect(job("🤖 opencode review")).toHaveAttribute("data-related", "true");
    // At rest the graph is ONE neutral colour: not a single curve wears the accent, because an
    // accent on every wire says every dependency matters, which says nothing.
    await expect(graph.locator('[data-testid="gitlab-pipeline-edge"][data-lit="true"]')).toHaveCount(
      0,
    );

    // Pointing at the unit test lights its own chain — the lint it waits for, and the deploy
    // that waits on it — and takes the weight off everything else.
    await job("🧪 unit").hover();
    await expect(job("🧪 unit")).toHaveAttribute("data-related", "true");
    await expect(job("🔎 lint")).toHaveAttribute("data-related", "true");
    await expect(job("🚀 deploy staging")).toHaveAttribute("data-related", "true");
    await expect(job("🤖 opencode review")).toHaveAttribute("data-related", "false");
    // The curves of that chain are LIT and the rest are not — counted rather than looked at,
    // because a horizontal `<path>` has no box for a visibility check to measure. The unit test
    // waits for the lint and the deploy waits for the unit: two of the four.
    await expect(graph.locator('[data-testid="gitlab-pipeline-edge"][data-lit="true"]')).toHaveCount(
      2,
    );
    await expect(
      graph.locator('[data-testid="gitlab-pipeline-edge"][data-lit="false"]'),
    ).toHaveCount(2);
  });

  test("keeps every card's surface opaque, so a curve never crosses its words", async ({
    page,
  }) => {
    await openGitLab(page);
    await openMergeRequest(page, 596);
    await openPipeline(page);
    const graph = page.locator('[data-testid="gitlab-pipeline-graph"]');
    const job = (name: string) =>
      graph.locator(`[data-testid="gitlab-pipeline-job"][data-name="${name}"]`);

    // The whole card used to take an `opacity` when another job was pointed at, and a
    // translucent card lets the curves behind it show through its own name. So what fades is
    // the CONTENT and the card itself stays solid — in both states.
    const opacityOf = (name: string) =>
      job(name).evaluate((el) => getComputedStyle(el).opacity);
    expect(await opacityOf("🤖 opencode review")).toBe("1");
    await job("🧪 unit").hover();
    await expect(job("🤖 opencode review")).toHaveAttribute("data-related", "false");
    expect(await opacityOf("🤖 opencode review")).toBe("1");

    // And the curves are BEHIND the cards rather than over them, which is what makes an opaque
    // surface worth having.
    const behind = await graph
      .locator('[data-testid="gitlab-pipeline-edges"]')
      .evaluate((el) => getComputedStyle(el).zIndex);
    expect(Number(behind)).toBeLessThan(0);
  });

  test("tells the four tones apart, and offers nothing that writes", async ({ page }) => {
    await openGitLab(page);
    // !595 failed: the unit test blocks the merge, the review failed and nobody has to fix it,
    // and the deploy will never run now. Three answers, three colours, one pipeline.
    await openMergeRequest(page, 595);
    await openPipeline(page);
    const graph = page.locator('[data-testid="gitlab-pipeline-graph"]');
    const job = (name: string) =>
      graph.locator(`[data-testid="gitlab-pipeline-job"][data-name="${name}"]`);

    await expect(job("🔎 lint")).toHaveAttribute("data-tone", "success");
    await expect(job("🧪 unit")).toHaveAttribute("data-tone", "failed");
    // ORANGE, not red: a red mark on something nobody has to fix teaches a reader to ignore
    // red. The card says so in words too, because colour is never the only signal.
    await expect(job("🤖 opencode review")).toHaveAttribute("data-tone", "warning");
    await expect(job("🤖 opencode review")).toContainText("allowed to fail");
    await expect(job("🚀 deploy staging")).toHaveAttribute("data-tone", "idle");
    // The pipeline's own badge reads the JOBS, so a run holding a red job is never plain green.
    await expect(page.locator('[data-testid="gitlab-pipeline-status"]')).toHaveAttribute(
      "data-tone",
      "failed",
    );

    // GitLab's own graph puts a RETRY on every card. This app reads trackers: a card is a LINK
    // and nothing else, so there is no control inside one at all.
    await expect(graph.locator("button")).toHaveCount(0);
    // And what it links to is this app's own page for that job's LOG — the one thing anybody
    // wants after a red card — rather than a trip out to GitLab.
    await expect(job("🧪 unit")).toHaveAttribute("href", /\/jobs\/\d+$/);
    await expect(job("🧪 unit")).not.toHaveAttribute("target", "_blank");
  });

  test("drops the controls where they would change nothing, and lists the jobs instead", async ({
    page,
  }) => {
    await openGitLab(page);
    // !63's pipeline declares no dependencies at all, which is a real and common shape.
    await openMergeRequest(page, 63);
    await openPipeline(page);
    const graph = page.locator('[data-testid="gitlab-pipeline-graph"]');

    await expect(graph).toHaveAttribute("data-grouping", "stage");
    // No grouping to choose and no curves to light, so neither control is drawn: one that
    // changes nothing on screen reads as a bug.
    await expect(page.locator('[data-testid="gitlab-pipeline-grouping"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="gitlab-pipeline-needs-toggle"]')).toHaveCount(0);

    // The JOBS view is always there, because it answers the other question — what took how
    // long — and it is the one a phone reads better.
    await page.locator('[data-testid="gitlab-pipeline-view"] [data-value="jobs"]').click();
    await expect(page.locator('[data-testid="gitlab-pipeline-jobs"]')).toBeVisible();
    await expect(page.locator('[data-testid="gitlab-pipeline-job-row"]')).toHaveCount(2);
    await expect(page.locator('[data-testid="gitlab-pipeline-job-row"]').first()).toContainText(
      "30s",
    );
  });

  test("scrolls the graph sideways and never the page", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openGitLab(page);
    await openMergeRequest(page, 596);
    await openPipeline(page);

    // A pipeline is wider than a phone, so the GRAPH scrolls and the page around it does not:
    // a graph that widened its container would take the sub-header and the controls off the
    // screen with it.
    const graph = page.locator('[data-testid="gitlab-pipeline-graph"]');
    const box = await graph.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(390);
    const scrollable = await graph.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(scrollable).toBe(true);
    const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(pageWidth).toBeLessThanOrEqual(390);
    // And the strip and the controls are still whole, which is what that failure would cost.
    await expect(page.locator('[data-testid="gitlab-mr-pages"]')).toBeVisible();
    await expect(page.locator('[data-testid="gitlab-pipeline-view"]')).toBeVisible();

    await page.setViewportSize({ width: 1280, height: 900 });
  });

  // ---- one job's LOG, on a page of its own ---------------------------------
  //
  // Where a job card goes. Everything below runs against the mock's own trace, which is written
  // the way the RUNNER writes one — nested sections, a progress line rewritten in place, ANSI
  // colour — because that is the whole of what this page has to read (see
  // `web/src/lib/gitlab-job-log.ts` for the measured facts, and `mockJobLog` for the fixture).

  /** Open one job's log from the pipeline page, by the job's own name. */
  async function openJobLog(page: Page, jobName: string) {
    await page.locator(`[data-testid="gitlab-pipeline-job"][data-name="${jobName}"]`).click();
    await expect(page.locator('[data-testid="gitlab-job-log-page"]')).toBeVisible();
  }

  test("a job's log is a PLACE: its own URL, reloadable, and Back leaves it", async ({ page }) => {
    await openGitLab(page);
    await openMergeRequest(page, 595);
    await openPipeline(page);
    await openJobLog(page, "🧪 unit");

    // The URL names the job by its OWN id, which is how GitLab addresses one — never by its
    // place in the pipeline, which changes with every push.
    expect(page.url()).toMatch(/\/jobs\/\d+$/);
    await expect(page.locator('[data-testid="gitlab-job-log-line"]').first()).toBeVisible();
    // The strip is still there, with PIPELINES current: a job is a detail of that run, so a
    // reader inside one is inside the run — and the other three pages stay one press away.
    await expect(page.locator('[data-testid="gitlab-mr-pages"]')).toHaveAttribute(
      "data-page",
      "pipelines",
    );

    // A reload lands on the same log, which is what makes it something to send to a colleague.
    await page.reload();
    await expect(page.locator('[data-testid="gitlab-job-log-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="gitlab-job-log-line"]').first()).toBeVisible();

    // And the browser's own Back leaves it for the pipeline it came from.
    await page.goBack();
    await expect(page.locator('[data-testid="gitlab-pipeline-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="gitlab-job-log-page"]')).toHaveCount(0);

    // The header's own Back does the same thing, because "back" means one thing to a reader.
    await openJobLog(page, "🧪 unit");
    await page.locator('[data-testid="gitlab-job-back"]').click();
    await expect(page.locator('[data-testid="gitlab-pipeline-page"]')).toBeVisible();
  });

  test("draws the runner's own sections, what each cost, and folds them", async ({ page }) => {
    await openGitLab(page);
    await openMergeRequest(page, 595);
    await openPipeline(page);
    await openJobLog(page, "🧪 unit");

    const lines = page.locator('[data-testid="gitlab-job-log-line"]');
    const before = await lines.count();
    expect(before).toBeGreaterThan(10);

    // The marker itself is never a row: it is the fold, and the heading the runner wrote after it
    // is that row's own text. A page showing `section_start:…` would be one that read nothing.
    await expect(page.locator('[data-testid="gitlab-job-log"]')).not.toContainText("section_start");
    await expect(page.locator('[data-testid="gitlab-job-log"]')).not.toContainText("section_end");

    // A progress line rewritten in place shows only what the terminal would have been showing.
    await expect(page.locator('[data-testid="gitlab-job-log"]')).toContainText("Progress: 100%");
    await expect(page.locator('[data-testid="gitlab-job-log"]')).not.toContainText("Progress: 12%");

    // What a section COST is on its own row, which is the number a reader of a slow run came for.
    const step = page.locator('[data-testid="gitlab-job-log-section"]').filter({ hasText: "Step script" });
    await expect(step).toContainText("2m 9s");

    // Folding it takes everything under it — the NESTED section's own opening line included,
    // because a child left visible under a folded parent is a row with nothing to place it.
    await step.click();
    await expect(step).toHaveAttribute("data-folded", "true");
    // `expect.poll` AND NOT `expect(lines.count()).resolves`, which reads the count ONCE and does not
    // retry — a bare race against the re-render this click causes, and one of three in this file that
    // made the job-log tests lose a test at random on a full run.
    await expect.poll(() => lines.count()).toBeLessThan(before);
    await expect(page.locator('[data-testid="gitlab-job-log"]')).not.toContainText("Pnpm section");
    await expect(page.locator('[data-testid="gitlab-job-log"]')).not.toContainText("AssertionError");
    // And what is OUTSIDE the fold is untouched.
    await expect(page.locator('[data-testid="gitlab-job-log"]')).toContainText("Job failed");

    // One control folds every section, and the same one opens them all again.
    await page.locator('[data-testid="gitlab-job-log-fold-all"]').click();
    await expect(page.locator('[data-testid="gitlab-job-log-section"][data-folded="true"]')).toHaveCount(
      await page.locator('[data-testid="gitlab-job-log-section"]').count(),
    );
    await page.locator('[data-testid="gitlab-job-log-fold-all"]').click();
    await expect(lines).toHaveCount(before);
  });

  test("filters to the lines that match, and a line number goes back to the log", async ({
    page,
  }) => {
    await openGitLab(page);
    await openMergeRequest(page, 595);
    await openPipeline(page);
    await openJobLog(page, "🧪 unit");

    await page.locator('[data-testid="gitlab-job-log-search"]').fill("error");
    // The count is STATED: a filter that answered nothing looks exactly like a log that arrived
    // empty, and the reader would go looking for the wrong fault.
    await expect(page.locator('[data-testid="gitlab-job-log-matches"]')).toContainText("lines");
    const rows = page.locator('[data-testid="gitlab-job-log-line"]');
    await expect(rows).toHaveCount(2);
    // Every row that stayed says what was searched for, and keeps the log's OWN line number —
    // which is what places it in the run.
    const first = rows.first();
    await expect(first).toContainText("AssertionError");
    const number = await first.getAttribute("data-line");
    expect(Number(number)).toBeGreaterThan(1);

    // A query nothing matches says so rather than drawing an empty page.
    await page.locator('[data-testid="gitlab-job-log-search"]').fill("nothing-matches-this");
    await expect(page.locator('[data-testid="gitlab-job-log-matches"]')).toContainText("no line");
    await expect(rows).toHaveCount(0);

    // The clear puts the whole log back, and pressing a filtered row's number does the same and
    // takes the reader to that line in place.
    await page.locator('[data-testid="gitlab-job-log-search"]').fill("AssertionError");
    await expect(rows).toHaveCount(1);
    await page.locator('[data-testid="gitlab-job-log-number"]').first().click();
    await expect(page.locator('[data-testid="gitlab-job-log-search"]')).toHaveValue("");
    // The third and last of the non-retrying count assertions in this file — see the fold above.
    await expect.poll(() => rows.count()).toBeGreaterThan(2);
  });

  test("a job that has not run says so, rather than drawing a blank page", async ({ page }) => {
    await openGitLab(page);
    await openMergeRequest(page, 596);
    await openPipeline(page);
    // A `manual` job: GitLab answers 200 with an empty body (measured — 10 of 58 jobs), and the
    // reader's next move depends on WHY there is nothing, so the page says which reason it is.
    await openJobLog(page, "🚀 deploy staging");
    await expect(page.locator('[data-testid="gitlab-job-log-empty"]')).toContainText(
      "has not been started",
    );
    await expect(page.locator('[data-testid="gitlab-job-log-line"]')).toHaveCount(0);
    // The controls that act on lines are not drawn where there are none.
    await expect(page.locator('[data-testid="gitlab-job-log-search"]')).toHaveCount(0);
  });

  test("follows a live job, and states what it is", async ({ page }) => {
    await openGitLab(page);
    await openMergeRequest(page, 596);
    await openPipeline(page);
    await openJobLog(page, "🧪 unit");

    // A running job is a log to follow: the page says so, and the store's poll is armed exactly
    // while the job has not finished.
    await expect(page.locator('[data-testid="gitlab-job-log-page"]')).toHaveAttribute(
      "data-live",
      "true",
    );
    await expect(page.locator('[data-testid="gitlab-job-log-live"]')).toBeVisible();
    const rows = page.locator('[data-testid="gitlab-job-log-line"]');
    const first = await rows.count();
    // The mock's running log grows by a line on every read, so the poll shows itself — and BOTH halves
    // of that sentence had to be made true. The growth was capped at the fixture's own length, so the
    // page's own live poll exhausted it before this click (`mockRunningTrace` is unbounded now); and
    // this asserted the count ONCE with no retry, racing the re-render the click causes.
    await page.locator('[data-testid="gitlab-job-log-reload"]').click();
    await expect.poll(() => rows.count()).toBeGreaterThan(first);
    // A FINISHED job is not followed: nothing about its log can change again.
    await page.locator('[data-testid="gitlab-job-back"]').click();
    await openJobLog(page, "🔎 lint");
    await expect(page.locator('[data-testid="gitlab-job-log-live"]')).toHaveCount(0);
  });

  test("says what a log that did not travel whole is missing, and what a refusal costs", async ({
    page,
  }) => {
    await openGitLab(page);
    await openMergeRequest(page, 595);
    await openPipeline(page);

    // A log too big to travel: what is on screen is its END, because a job fails at the end of
    // its log and this instance refuses a Range read — so there is nothing to ask for the rest
    // with, and the page says so with GitLab's own page one press away.
    await setMergeRequestControl(page, { truncate_job_log: true });
    await openJobLog(page, "🧪 unit");
    await expect(page.locator('[data-testid="gitlab-job-log-truncated"]')).toContainText("end");
    await expect(page.locator('[data-testid="gitlab-job-log-truncated"]')).toContainText("MB");
    await expect(page.locator('[data-testid="gitlab-job-log-line"]').first()).toBeVisible();
    await expect(page.locator('[data-testid="gitlab-job-link"]')).toBeVisible();

    // The JOB answered and its LOG did not, which is what GitLab does with a trace file it has
    // dropped. "This job printed nothing" would be a claim about the job that nothing supports, so
    // the reason is stated instead.
    await setMergeRequestControl(page, { refuse_trace: "GitLab has no log for this job any more" });
    await page.reload();
    await expect(page.locator('[data-testid="gitlab-job-log-error"]')).toContainText(
      "no log for this job",
    );
    await expect(page.locator('[data-testid="gitlab-job-log-empty"]')).toHaveCount(0);
    // The job's own facts are still stated above it: the read that failed is the log's, not the
    // job's.
    await expect(page.locator('[data-testid="gitlab-job-facts"]')).toBeVisible();
    await setMergeRequestControl(page, { clear: true });

    // A read that FAILED ALTOGETHER is the whole screen, because this page has no other content to
    // fall back on — and it offers the one thing left.
    await setMergeRequestControl(page, {
      refuse_job_log: "GitLab refused: this account may not read the job's log",
    });
    await page.reload();
    await expect(page.locator('[data-testid="gitlab-job-log-error"]')).toContainText("refused");
    await expect(page.locator('[data-testid="gitlab-job-log-error-link"]')).toBeVisible();
    // And the header never says it is still reading over a refusal.
    await expect(page.locator('[data-testid="gitlab-job-summary"]')).not.toContainText("Reading");

    await setMergeRequestControl(page, { clear: true });
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
