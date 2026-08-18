import { test, expect, gotoApp, fetchCapturedSends, resetAgentPersonas } from "./helpers";
import type { Page } from "@playwright/test";

// The user's own CUSTOM AGENTS: `@bebou` and `@natacha`, each a name for an AI provider this
// machine already runs, with a face, a model and a standing instruction of its own (see
// src/agent_persona.rs and web/src/lib/agent-persona.ts).
//
// What these specs pin is the part the unit tests cannot: that a name the user invented really
// reaches the wire as the plain prefix the backend reads back, that the reply draws under that
// agent's own name and face rather than the vendor's, and that the INSTRUCTION — the whole
// point of the feature — never appears in a message.
//
// Two facts shape every test here:
//
//   - **A persona is an ADDRESS, not a program.** So a tag goes out as `@bebou` and nothing
//     else, exactly as `@claude` does; the provider behind it is what answers.
//   - **A persona is LOCAL.** Nothing about one travels, so the only thing another machine
//     ever sees is the line a reply signs itself with.
//
// The mock declares two of them (`mockPersonas`), and any test that changes that set resets it
// (`resetAgentPersonas`): one mock process serves the whole run.
test.describe("custom agents", () => {
  const editable = '[data-testid="composer-rich"] .tiptap-message';
  const options = '[data-testid="mention-suggestion"]';
  const chip = `${editable} [data-testid="agent-tag"]`;

  /** Open the sandbox thread — the one the backend's own policy opts in out of the box — and
   *  empty the composer, since the mock persists drafts for the whole run. */
  async function openSandbox(page: Page) {
    await gotoApp(page);
    await page.keyboard.press("Control+k");
    const input = page.locator("[cmdk-input]");
    await expect(input).toBeVisible();
    await input.fill("Agent Sandbox");
    await input.press("Enter");
    await expect(page.locator('[data-testid="conversation-title"]')).toContainText("Agent Sandbox");
    await page.locator(editable).click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await expect(page.locator(editable)).toHaveText("");
  }

  /** Scroll Settings down to the custom agents section. */
  async function openCustomAgents(page: Page) {
    await gotoApp(page);
    await page.locator('[data-testid="open-settings"]').click();
    const section = page.locator('[data-testid="custom-agents-settings"]');
    await expect(section).toBeVisible();
    await section.scrollIntoViewIfNeeded();
    return section;
  }

  test("the '@' offers the user's own agents after the providers, each with its own mark", async ({
    page,
  }) => {
    await openSandbox(page);
    await page.keyboard.type("@");
    const rows = page.locator(`${options}[data-kind="agent"]`);
    await expect(rows.first()).toBeVisible();
    // The providers first — a fixed short list a reader learns once — then the personas, in the
    // backend's own order. A menu whose first row moved as agents were added would have to be
    // read every time.
    await expect(rows.nth(0)).toHaveAttribute("data-agent", "claude");
    await expect(rows.nth(0)).not.toHaveAttribute("data-persona", /./);
    await expect(rows.nth(1)).toHaveAttribute("data-persona", "bebou");
    await expect(rows.nth(2)).toHaveAttribute("data-persona", "natacha");
    // Its own FACE where the provider's mark would be — the whole reason a persona is drawn
    // rather than named — and Claude's own mark on the one with no face.
    await expect(rows.nth(1).locator('img[data-persona="bebou"]')).toBeVisible();
    await expect(rows.nth(2).locator('[data-testid="claude-logo"]')).toBeVisible();
    // Each persona says which CLI is behind it, which is the one thing its own name cannot.
    await expect(rows.nth(1)).toContainText("Bebou");
    await expect(rows.nth(1)).toContainText("Claude");
  });

  test("a custom agent is found by its own name, and never by its provider's", async ({ page }) => {
    await openSandbox(page);
    await page.keyboard.type("@beb");
    const rows = page.locator(`${options}[data-kind="agent"]`);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute("data-persona", "bebou");
    // "@claude" offers the PROVIDER alone: offering every agent that happens to run on Claude
    // Code would bury the provider's own row under the user's.
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await page.keyboard.type("@claude");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute("data-agent", "claude");
    await expect(rows.first()).not.toHaveAttribute("data-persona", /./);
  });

  test("the tag reaches the wire as the plain prefix, and the reply is the agent's own", async ({
    page,
  }) => {
    await openSandbox(page);
    await page.keyboard.type("@bebou");
    await expect(page.locator(`${options}[data-persona="bebou"]`)).toBeVisible();
    await page.keyboard.press("Enter");
    // The chip the composer draws carries the AGENT, so it wears that agent's face and label
    // while the provider still decides its palette.
    await expect(page.locator(`${chip}[data-persona="bebou"]`)).toBeVisible();
    await expect(page.locator(`${chip} img[data-persona="bebou"]`)).toBeVisible();
    await expect(page.locator(chip)).toContainText("Bebou");

    await page.keyboard.type("which port does the backend listen on?");
    await page.keyboard.press("Enter");

    // ON THE WIRE it is the bare prefix and nothing else: no markup, no mention pair, nothing
    // a client that never heard of this feature could not render — which is what makes the
    // backend's own trigger read it back (`agent_policy::split_address`).
    await expect
      .poll(async () => (await fetchCapturedSends(page)).length, { timeout: 10_000 })
      .toBeGreaterThan(0);
    const sent = (await fetchCapturedSends(page)).at(-1)!;
    const body = sent.content_html ?? sent.text ?? "";
    expect(body).toContain("@bebou");
    expect(body).not.toContain("data-agent-tag");
    expect(body).not.toContain("data-agent-persona");
    expect(sent.mentions ?? []).toHaveLength(0);

    // The sent message draws the same chip, read back out of those words.
    const mine = '[data-testid="message"][data-mine="true"]';
    await expect(page.locator(`${mine} [data-testid="agent-tag"][data-persona="bebou"]`)).toBeVisible();

    // And the ANSWER is the agent's own: its name, its face, and the CLI named beside them —
    // never the vendor's name in its place.
    const signature = '[data-testid="agent-signature"][data-persona="bebou"]';
    await expect(page.locator(signature)).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(signature)).toContainText("Bebou");
    await expect(page.locator(signature)).toContainText("Claude");
    await expect(page.locator(`${signature} img[data-persona="bebou"]`)).toBeVisible();

    // The INSTRUCTION is in no message. It is the whole point of a custom agent and the one
    // thing that must never travel: it leads the prompt on the backend and appears nowhere in
    // the thread.
    const history = (await page.locator('[data-testid="message-pane"]').innerText()).toLowerCase();
    expect(history).not.toContain("/bebou");
    for (const send of await fetchCapturedSends(page)) {
      expect(`${send.content_html ?? ""}${send.text ?? ""}`).not.toContain("/bebou");
    }
  });

  test("a persona with no face wears the mark of the provider it runs", async ({ page }) => {
    await openSandbox(page);
    await page.keyboard.type("@natacha");
    await expect(page.locator(`${options}[data-persona="natacha"]`)).toBeVisible();
    await page.keyboard.press("Enter");
    const tag = page.locator(`${chip}[data-persona="natacha"]`);
    await expect(tag).toBeVisible();
    // No `<img>` at all: the provider's own artwork, which is what says a machine is
    // answering. A blank square, or a letter in a circle, would read as a person.
    await expect(tag.locator("img")).toHaveCount(0);
    await expect(tag.locator('[data-testid="claude-logo"]')).toBeVisible();
  });

  test("Settings lists them, and refuses a name that could never be summoned", async ({ page }) => {
    const section = await openCustomAgents(page);
    const rows = section.locator('[data-testid="custom-agent-row"]');
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: "Bebou" })).toContainText("@bebou");
    // The row states the instruction in one dim line, so an agent is recognisable — and that
    // is the only place in the app it is ever drawn.
    await expect(rows.filter({ hasText: "Bebou" })).toContainText("/bebou");

    await section.locator('[data-testid="add-custom-agent"]').click();
    const dialog = page.locator('[data-testid="custom-agent-dialog"]');
    await expect(dialog).toBeVisible();
    // `@claude` already summons the provider, so a persona of that name could never be
    // summoned and its instruction would silently lead nothing.
    await dialog.locator('[data-testid="custom-agent-name"]').fill("claude");
    await expect(dialog.locator('[data-testid="custom-agent-name-error"]')).toContainText("@claude");
    await expect(dialog.locator('[data-testid="custom-agent-save"]')).toBeDisabled();
    // A name already taken is refused too, and the one being edited never is.
    await dialog.locator('[data-testid="custom-agent-name"]').fill("bebou");
    await expect(dialog.locator('[data-testid="custom-agent-name-error"]')).toContainText("@bebou");
    // The address is repaired as it is typed: nobody has to learn the charset one keystroke
    // at a time.
    await dialog.locator('[data-testid="custom-agent-name"]').fill("Review Bot");
    await expect(dialog.locator('[data-testid="custom-agent-name"]')).toHaveValue("review-bot");
    await expect(dialog.locator('[data-testid="custom-agent-name-error"]')).toHaveCount(0);
  });

  test("Escape closes the form and stays in Settings", async ({ page }) => {
    // The app shell's own Escape leaves the open pane, and it is not part of the dialog's layer
    // stack — so both fired, and Escape in this form used to close the form AND navigate out of
    // Settings, taking the reader's place with it (`aModalIsOpen` in web/src/lib/platform.ts).
    const section = await openCustomAgents(page);
    await section.locator('[data-testid="custom-agent-edit"]').first().click();
    const dialog = page.locator('[data-testid="custom-agent-dialog"]');
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.locator('[data-testid="settings-pane"]')).toBeVisible();
    // A second Escape then does what it always did.
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-testid="settings-pane"]')).toBeHidden();
  });

  test("one made here answers to its own name, and one removed is a word again", async ({
    page,
  }) => {
    const section = await openCustomAgents(page);
    await section.locator('[data-testid="add-custom-agent"]').click();
    const dialog = page.locator('[data-testid="custom-agent-dialog"]');
    await dialog.locator('[data-testid="custom-agent-name"]').fill("reviewer");
    await dialog.locator('[data-testid="custom-agent-label"]').fill("Reviewer");
    await dialog.locator('[data-testid="custom-agent-preprompt"]').fill("Review what follows.");
    await dialog.locator('[data-testid="custom-agent-save"]').click();
    await expect(dialog).toBeHidden();
    await expect(section.locator('[data-testid="custom-agent-row"]')).toHaveCount(3);

    // It is addressable from the composer at once — the whole status comes back from the write,
    // so nothing has to be reloaded.
    await page.keyboard.press("Escape");
    await openSandbox(page);
    await page.keyboard.type("@reviewer");
    await expect(page.locator(`${options}[data-persona="reviewer"]`)).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page.locator(`${chip}[data-persona="reviewer"]`)).toContainText("Reviewer");
    // With no face of its own it wears its provider's mark, like `natacha`.
    await expect(page.locator(`${chip}[data-persona="reviewer"] img`)).toHaveCount(0);

    // Removed, it is a plain word again: the deletion asks twice, because nothing upstream
    // brings a custom agent back.
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    const again = await openCustomAgents(page);
    const row = again.locator('[data-testid="custom-agent-row"][data-persona="reviewer"]');
    await row.locator('[data-testid="custom-agent-delete"]').click();
    await row.locator('[data-testid="custom-agent-delete-confirm"]').click();
    await expect(again.locator('[data-testid="custom-agent-row"]')).toHaveCount(2);

    await page.keyboard.press("Escape");
    await openSandbox(page);
    await page.keyboard.type("@reviewer");
    // Not offered, and nothing drawn: an address nobody defined is the text it is.
    await expect(page.locator(`${options}[data-persona="reviewer"]`)).toHaveCount(0);
    await expect(page.locator(chip)).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await resetAgentPersonas(page);
  });
});
