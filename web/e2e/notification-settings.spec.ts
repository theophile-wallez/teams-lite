import { expect } from "@playwright/test";
import { test, gotoApp } from "./helpers";

// The Settings → Notifications section: the surface that turns Web Push on for THIS
// device (see src/lib/push.ts).
//
// What is checked here is the decision the section makes — offer a switch, or explain
// why it cannot — because that is the part with logic in it. The subscription itself
// is deliberately NOT driven: it needs a real push service (Apple's or Google's) and
// a real device to accept it, so a spec that clicked the switch would be asserting
// that Chromium cannot reach FCM in a sandbox. The pure decision table is unit tested
// in src/lib/push.test.ts, and the encryption against the RFC 8291 vector in
// src/push.rs.

// The sidebar's own half is the OFFER (src/components/notification-offer.tsx): the
// switch above was complete and nobody had it on, because nothing in the app ever said
// notifications existed. The press itself is not driven here for the reason given above —
// it asks a real push service — so what is pinned is the decision to offer, the shape the
// offer takes, and that one dismissal is for good.
test.describe("The notification offer", () => {
  test("offers notifications in the sidebar, and one dismissal is for good", async ({ page }) => {
    await gotoApp(page);

    const offer = page.locator('[data-testid="notification-offer"]');
    await expect(offer).toBeVisible();
    // Chromium can subscribe and this browser has not, so the row is the switch rather
    // than an explanation.
    await expect(offer).toHaveAttribute("data-shape", "enable");
    await expect(offer.locator('[data-testid="notification-offer-enable"]')).toBeVisible();

    await offer.locator('[data-testid="notification-offer-dismiss"]').click();
    await expect(offer).toHaveCount(0);

    // Per browser, and for good: a row that came back every launch would be a nag, and
    // the switch is in Settings for ever.
    await gotoApp(page);
    await expect(page.locator('[data-testid="notification-offer"]')).toHaveCount(0);
  });

  test("tells an iPhone tab the one thing that would fix it", async ({ page }) => {
    // The same iOS tab as below: no Push API until the page is on the Home Screen. The
    // row cannot offer a press there, so it is the sentence — which is what makes the
    // phone half of this feature reachable at all.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "userAgent", {
        get: () =>
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1",
      });
      // @ts-expect-error — deleting a global to reproduce the iOS tab environment.
      delete window.PushManager;
    });

    await gotoApp(page);
    const offer = page.locator('[data-testid="notification-offer"]');
    await expect(offer).toHaveAttribute("data-shape", "install");
    await expect(offer.locator('[data-testid="notification-offer-install"]')).toContainText(
      "Add to Home Screen",
    );
    await expect(offer.locator('[data-testid="notification-offer-enable"]')).toHaveCount(0);
  });
});

test.describe("Notification settings", () => {
  test("offers the switch on a browser that supports push", async ({ page }) => {
    await gotoApp(page);
    await page.locator('[data-testid="open-settings"]').click();
    await expect(page.locator('[data-testid="settings-pane"]')).toBeVisible();

    const section = page.locator('[data-testid="notification-settings"]');
    await expect(section).toBeVisible();
    // Chromium has the Push API and the mock backend reports itself as able to
    // push, so the section shows the switch rather than an explanation.
    const toggle = section.locator('[data-testid="push-toggle"]');
    await expect(toggle).toBeVisible();
    // Off until the user asks: nothing subscribes on load, because iOS refuses a
    // permission prompt that does not come from a tap.
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(section.locator('[data-testid="push-test"]')).toHaveCount(0);
  });

  test("explains itself instead of offering a switch when the browser cannot subscribe", async ({
    page,
  }) => {
    // An iPhone Safari TAB: the Push API is simply absent until the page is added to
    // the Home Screen. The section must say that — it is the single most common
    // reason a user finds no notifications, and "unsupported browser" would be both
    // wrong and discouraging.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "userAgent", {
        get: () =>
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1",
      });
      // @ts-expect-error — deleting a global to reproduce the iOS tab environment.
      delete window.PushManager;
    });

    await gotoApp(page);
    await page.locator('[data-testid="open-settings"]').click();
    const section = page.locator('[data-testid="notification-settings"]');
    await expect(section).toBeVisible();

    await expect(section.locator('[data-testid="push-toggle"]')).toHaveCount(0);
    await expect(section.locator('[data-testid="push-blocked"]')).toContainText(
      "Add to Home Screen",
    );
  });
});
