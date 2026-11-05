import { expect, type Locator, type Page } from "@playwright/test";
import { test, fetchAgentModes, gotoApp, setAgentAuth, setAgentCli } from "./helpers";

// Settings → AI providers: signing the agent CLIs in, with no terminal anywhere (see
// web/src/components/agent-auth.tsx, src/agent_auth.rs).
//
// The mock runs no `claude auth login` and holds no real key: its pretend claude.com accepts one
// code (`MOCK-CODE#mock-state`) and refuses every other in the CLI's own words, and it mirrors every
// refusal the backend makes. What is pinned is the page's half — that a sign-in is two steps on the
// page with the link opening in the reader's OWN browser, that a method which needs setting up
// opens the form that collects it, that a secret left empty is KEPT, and that every decision is the
// BACKEND's, read back through `/__test/agent` rather than off the control that was pressed.
//
// Every spec here signs something in or stores a key, so every one of them resets the mock: one
// mock process serves the whole run, and an account left signed in changes every later pane.

const MOCK_CODE = "MOCK-CODE#mock-state";

async function openProviders(page: Page): Promise<Locator> {
  await gotoApp(page);
  await page.locator('[data-testid="open-settings"]').click();
  await expect(page.locator('[data-testid="settings-pane"]')).toBeVisible();
  const section = page.locator('[data-testid="ai-providers-settings"]');
  await expect(section).toBeVisible();
  return section;
}

function row(section: Locator, provider: string): Locator {
  return section.locator(`[data-testid="ai-provider"][data-provider="${provider}"]`);
}

function cloud(section: Locator, kind: string): Locator {
  return section.locator(`[data-testid="cloud-account"][data-kind="${kind}"]`);
}

test.describe("Signing the agent CLIs in", () => {
  test.afterEach(async ({ page }) => {
    await setAgentAuth(page, "reset");
    await setAgentCli(page, "reset");
  });

  test("Claude Code signs in to a Claude account on claude.com, as two steps on the page", async ({ page }) => {
    const section = await openProviders(page);
    const claude = row(section, "claude");
    const account = claude.locator('[data-testid="agent-account"]');
    await expect(account.locator('[data-testid="claude-account-line"]')).toHaveText("Not signed in.");

    await account.locator('[data-testid="claude-signin-start"]').click();
    const signin = account.locator('[data-testid="claude-signin"]');
    await expect(signin).toBeVisible();
    // Step 1 is a LINK the reader opens in their own browser — never a page this app draws, and
    // never one it opens on its own after a round trip a popup blocker would refuse.
    const link = signin.locator('[data-testid="claude-signin-link"]');
    await expect(link).toHaveAttribute("href", /^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", /noopener/);
    await expect(signin).toContainText("never sees your password");
    expect((await fetchAgentModes(page)).claude_signin).toBe(true);

    // Step 2: the code claude.com showed, handed to the waiting CLI.
    await signin.locator('[data-testid="claude-signin-code"]').fill(MOCK_CODE);
    await signin.locator('[data-testid="claude-signin-finish"]').click();
    await expect(account.locator('[data-testid="claude-account-line"]')).toHaveText(
      "Signed in as ada@example.com · Claude Max",
    );
    await expect(signin).toHaveCount(0);
    const state = await fetchAgentModes(page);
    expect(state.claude_login?.email).toBe("ada@example.com");
    expect(state.claude_signin).toBe(false);

    // And it signs out from the same row.
    await account.locator('[data-testid="claude-signout"]').click();
    await expect(account.locator('[data-testid="claude-account-line"]')).toHaveText("Not signed in.");
    expect((await fetchAgentModes(page)).claude_login).toBeNull();
  });

  test("a code with a stray space costs a sentence, and one claude.com did not issue ends the sign-in", async ({ page }) => {
    const section = await openProviders(page);
    const account = row(section, "claude").locator('[data-testid="agent-account"]');
    await account.locator('[data-testid="claude-signin-start"]').click();
    const signin = account.locator('[data-testid="claude-signin"]');
    const code = signin.locator('[data-testid="claude-signin-code"]');

    // Checked BEFORE the sign-in is spent: the panel stays, the reader fixes the paste.
    await code.fill("MOCK-CODE #mock-state");
    await signin.locator('[data-testid="claude-signin-finish"]').click();
    await expect(account.locator('[data-testid="agent-account-error"]')).toContainText("one line with no spaces");
    await expect(signin).toBeVisible();

    // The CLI exits on a code it refuses, so that one ends the sign-in — in the CLI's own words.
    await code.fill("WRONG#code");
    await signin.locator('[data-testid="claude-signin-finish"]').click();
    await expect(account.locator('[data-testid="agent-account-error"]')).toContainText("That code wasn't accepted");
    await expect(signin).toHaveCount(0);
    await expect(account.locator('[data-testid="claude-signin-start"]')).toBeVisible();
    expect((await fetchAgentModes(page)).claude_login).toBeNull();
  });

  test("a sign-in can be cancelled, and a Console account is asked for by name", async ({ page }) => {
    const section = await openProviders(page);
    const account = row(section, "claude").locator('[data-testid="agent-account"]');
    await account.locator('[data-testid="claude-signin-console"]').click();
    const signin = account.locator('[data-testid="claude-signin"]');
    await expect(signin).toContainText("Anthropic Console account");
    await signin.locator('[data-testid="claude-signin-cancel"]').click();
    await expect(signin).toHaveCount(0);
    expect((await fetchAgentModes(page)).claude_signin).toBe(false);
  });

  test("choosing an API key opens its form, and that form's Save is the choice", async ({ page }) => {
    const section = await openProviders(page);
    const account = row(section, "claude").locator('[data-testid="agent-account"]');
    await account.locator('[data-testid="claude-method"]').selectOption("api_key");

    // Nothing is stored yet: a method naming a key the backend does not hold would be refused.
    const form = account.locator('[data-testid="claude-api-key-form"]');
    await expect(form).toBeVisible();
    expect((await fetchAgentModes(page)).auth.claude_method).toBe("machine");

    await form.locator('[data-testid="claude-api-key"]').fill("sk-ant-api03-mock-key");
    await form.locator('[data-testid="agent-account-save"]').click();
    await expect(account).toHaveAttribute("data-method", "api_key");
    await expect(account.locator('[data-testid="claude-account-line"]')).toHaveText(
      "Signed in with an Anthropic API key.",
    );
    // The key reached the backend and never came back to the page.
    const state = await fetchAgentModes(page);
    expect(state.auth.claude_method).toBe("api_key");
    expect(state.auth.secrets.anthropic_key).toBe("sk-ant-api03-mock-key");
    await expect(page.locator("body")).not.toContainText("sk-ant-api03-mock-key");
    // A Claude account is no way in while a key is: no sign-in is offered.
    await expect(account.locator('[data-testid="claude-signin-start"]')).toHaveCount(0);
  });

  test("Amazon Bedrock is set up once, keeps a key left empty, and is what Claude Code runs on", async ({ page }) => {
    await setAgentCli(page, { installed: { opencode: "1.19.5" } });
    const section = await openProviders(page);
    const bedrock = cloud(section, "bedrock");
    await expect(bedrock).toHaveAttribute("data-configured", "false");

    await bedrock.locator('[data-testid="cloud-account-edit"]').click();
    const form = bedrock.locator('[data-testid="cloud-form"][data-kind="bedrock"]');
    await form.locator('[data-testid="bedrock-region"]').fill("eu-west-3");
    await form.locator('[data-testid="bedrock-api-key"]').fill("bedrock-mock-key");
    await form.locator('[data-testid="agent-account-save"]').click();
    await expect(bedrock.locator('[data-testid="cloud-account-summary"]')).toHaveText("eu-west-3 · Bedrock API key");

    // A new region with the key left empty: the stored key stays, and the page was never shown it.
    await bedrock.locator('[data-testid="cloud-account-edit"]').click();
    await expect(form.locator('[data-testid="bedrock-api-key"]')).toHaveAttribute("placeholder", /keep the saved one/);
    await form.locator('[data-testid="bedrock-region"]').fill("us-west-2");
    await form.locator('[data-testid="agent-account-save"]').click();
    await expect(bedrock.locator('[data-testid="cloud-account-summary"]')).toHaveText("us-west-2 · Bedrock API key");
    expect((await fetchAgentModes(page)).auth.secrets.bedrock).toBe("bedrock-mock-key");

    // Claude Code can now take it in one press — nothing more to set up.
    const account = row(section, "claude").locator('[data-testid="agent-account"]');
    await account.locator('[data-testid="claude-method"]').selectOption("bedrock");
    await expect(account).toHaveAttribute("data-method", "bedrock");
    await expect(account.locator('[data-testid="claude-account-line"]')).toHaveText("Runs through Amazon Bedrock.");
    await expect(bedrock.locator('[data-testid="cloud-account-summary"]')).toContainText("Claude Code runs on it");

    // Removing what Claude Code runs on is refused, in words, where it was pressed.
    await bedrock.locator('[data-testid="cloud-account-remove"]').click();
    await expect(bedrock.locator('[data-testid="agent-account-error"]')).toContainText("signs in with Amazon Bedrock");
    await expect(bedrock).toHaveAttribute("data-configured", "true");

    // And opencode reaches Bedrock models through the same account.
    await expect(row(section, "opencode").locator('[data-testid="opencode-cloud-line"]')).toContainText(
      "Amazon Bedrock",
    );
  });

  test("an access key is edited without retyping its ID, and its session token can be dropped", async ({ page }) => {
    const section = await openProviders(page);
    const bedrock = cloud(section, "bedrock");
    await bedrock.locator('[data-testid="cloud-account-edit"]').click();
    const form = bedrock.locator('[data-testid="cloud-form"][data-kind="bedrock"]');
    await form.locator('[data-testid="bedrock-region"]').fill("us-east-1");
    await form.locator('[data-testid="bedrock-kind"]').selectOption("access_key");
    await form.locator('[data-testid="bedrock-access-key-id"]').fill("AKIAABCDEFGHIJKLWXYZ");
    await form.locator('[data-testid="bedrock-secret"]').fill("mock-secret");
    await form.locator('[data-testid="bedrock-session-token"]').fill("mock-session");
    await form.locator('[data-testid="agent-account-save"]').click();
    await expect(bedrock.locator('[data-testid="cloud-account-summary"]')).toHaveText(
      "us-east-1 · access key …WXYZ with a session token",
    );

    // The page holds four characters of the ID; a region change must not need the rest.
    await bedrock.locator('[data-testid="cloud-account-edit"]').click();
    await form.locator('[data-testid="bedrock-region"]').fill("eu-west-1");
    await form.locator('[data-testid="bedrock-drop-session-token"]').check();
    await expect(form.locator('[data-testid="agent-account-save"]')).toBeEnabled();
    await form.locator('[data-testid="agent-account-save"]').click();
    await expect(bedrock.locator('[data-testid="cloud-account-summary"]')).toHaveText("eu-west-1 · access key …WXYZ");
    expect((await fetchAgentModes(page)).auth.secrets.bedrock).toBe("mock-secret");
  });

  test("a new sign-in starts with an empty code field", async ({ page }) => {
    const section = await openProviders(page);
    const account = row(section, "claude").locator('[data-testid="agent-account"]');
    await account.locator('[data-testid="claude-signin-start"]').click();
    await account.locator('[data-testid="claude-signin-code"]').fill("WRONG#code");
    await account.locator('[data-testid="claude-signin-finish"]').click();
    await expect(account.locator('[data-testid="agent-account-error"]')).toContainText("wasn't accepted");
    await account.locator('[data-testid="claude-signin-start"]').click();
    await expect(account.locator('[data-testid="claude-signin-code"]')).toHaveValue("");
  });

  test("choosing a cloud that is not set up opens its form in Claude Code's row", async ({ page }) => {
    const section = await openProviders(page);
    const account = row(section, "claude").locator('[data-testid="agent-account"]');
    await account.locator('[data-testid="claude-method"]').selectOption("foundry");
    const form = account.locator('[data-testid="cloud-form"][data-kind="foundry"]');
    await expect(form).toBeVisible();

    // A URL where the resource NAME goes is refused, as Claude Code itself would refuse it.
    await form.locator('[data-testid="foundry-resource"]').fill("https://my-res.services.ai.azure.com");
    await form.locator('[data-testid="foundry-api-key"]').fill("foundry-mock-key");
    await form.locator('[data-testid="agent-account-save"]').click();
    await expect(account.locator('[data-testid="agent-account-error"]')).toContainText("give the name alone");
    expect((await fetchAgentModes(page)).auth.foundry).toBeNull();

    await form.locator('[data-testid="foundry-resource"]').fill("my-res");
    await form.locator('[data-testid="agent-account-save"]').click();
    await expect(account).toHaveAttribute("data-method", "foundry");
    const state = await fetchAgentModes(page);
    expect(state.auth.claude_method).toBe("foundry");
    expect(state.auth.foundry).toEqual({ resource: "my-res" });
  });

  test("opencode is given a provider key, listed without it, and has it taken back", async ({ page }) => {
    await setAgentCli(page, { installed: { opencode: "1.19.5" } });
    const section = await openProviders(page);
    const account = row(section, "opencode").locator('[data-testid="agent-account"]');
    await expect(account.locator('[data-testid="opencode-credentials-empty"]')).toBeVisible();

    await account.locator('[data-testid="opencode-key-add"]').click();
    const form = account.locator('[data-testid="opencode-key-form"]');
    // A provider id opencode would not read is not offered a Save.
    await form.locator('[data-testid="opencode-key-provider"]').selectOption("other");
    await form.locator('[data-testid="opencode-key-id"]').fill("Not An Id");
    await form.locator('[data-testid="opencode-key-value"]').fill("sk-mock-openrouter");
    await expect(form.locator('[data-testid="agent-account-save"]')).toBeDisabled();

    await form.locator('[data-testid="opencode-key-provider"]').selectOption("openrouter");
    await form.locator('[data-testid="agent-account-save"]').click();
    const credential = account.locator('[data-testid="opencode-credential"][data-provider="openrouter"]');
    await expect(credential).toContainText("OpenRouter");
    await expect(credential).toContainText("API key");
    await expect(page.locator("body")).not.toContainText("sk-mock-openrouter");
    expect((await fetchAgentModes(page)).opencode).toEqual(["openrouter"]);

    await credential.locator('[data-testid="opencode-credential-remove"]').click();
    await expect(account.locator('[data-testid="opencode-credentials-empty"]')).toBeVisible();
    expect((await fetchAgentModes(page)).opencode).toEqual([]);
  });
});
