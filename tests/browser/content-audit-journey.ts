import { expect, type Page, type Route } from "@playwright/test";

/** Read-only regressions: write endpoints are never reached, including key rotation. */
export async function verifyContentWorkspace(page: Page) {
  const ws = new URL(page.url()).searchParams.get("workspace")!;
  const visit = (view: string) =>
    page.goto(`/?workspace=${ws}&view=${encodeURIComponent(view)}`);
  const acceptNextDialog = () =>
    page.once("dialog", (dialog) => dialog.accept());

  await visit("knowledge");
  await page.getByRole("button", { name: "FAQs", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Your FAQs", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("FAQ question", { exact: true }),
  ).not.toBeVisible();
  await page.getByRole("button", { name: "Create FAQ", exact: true }).click();
  await page
    .getByLabel("FAQ question", { exact: true })
    .fill("Content audit draft question");
  await page
    .getByLabel("FAQ answer", { exact: true })
    .fill("Content audit draft answer");
  await page.getByRole("button", { name: "Sources", exact: true }).click();
  await page.getByRole("button", { name: "FAQs", exact: true }).click();
  await expect(page.getByLabel("FAQ answer", { exact: true })).toHaveValue(
    "Content audit draft answer",
  );
  await page
    .getByRole("button", { name: "Generate drafts", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Write manually", exact: true })
    .click();
  await expect(page.getByLabel("FAQ question", { exact: true })).toHaveValue(
    "Content audit draft question",
  );
  acceptNextDialog();
  await page
    .getByRole("button", { name: "Discard draft", exact: true })
    .click();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Create FAQ", exact: true }).click();
  const instructionBox = await page
    .getByLabel("Writing instructions (optional)", { exact: true })
    .boundingBox();
  const saveBox = await page
    .getByRole("button", { name: "Save draft", exact: true })
    .boundingBox();
  // The action bar must follow the inputs, without covering the answer on mobile.
  expect(saveBox!.y).toBeGreaterThanOrEqual(
    instructionBox!.y + instructionBox!.height,
  );
  await page.getByRole("button", { name: "← All FAQs", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });

  // Exercise record switching with local read fixtures; never mutate saved FAQs.
  const faqFixture = (route: Route) =>
    route.fulfill({
      json: {
        faqs: ["First", "Second"].map((name) => ({
          id: `content-audit-${name.toLowerCase()}`,
          title: `${name} audit FAQ`,
          metadata: { answer: `${name} saved answer` },
          status: "draft",
          visibility: "staff",
          revision: 1,
        })),
      },
    });
  await page.route(`**/v2/workspaces/${ws}/faqs`, faqFixture);
  let approvals = 0;
  await page.route(`**/v2/workspaces/${ws}/faqs/*/approve`, (route) => {
    approvals++;
    return route.fulfill({ json: {} });
  });
  await visit("knowledge");
  await page.getByRole("button", { name: "FAQs", exact: true }).click();
  const firstFaq = page.locator(".faq-card").filter({
    has: page.getByRole("heading", { name: "First audit FAQ", exact: true }),
  });
  const secondFaq = page.locator(".faq-card").filter({
    has: page.getByRole("heading", { name: "Second audit FAQ", exact: true }),
  });
  await firstFaq.getByRole("button", { name: "Edit FAQ", exact: true }).click();
  await page
    .getByLabel("FAQ question", { exact: true })
    .fill("Keep this local edit");
  await page
    .getByRole("button", { name: "← All FAQs · draft kept", exact: true })
    .click();
  page.once("dialog", (dialog) => dialog.dismiss());
  await secondFaq
    .getByRole("button", { name: "Edit FAQ", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Resume FAQ draft", exact: true })
    .click();
  await expect(page.getByLabel("FAQ question", { exact: true })).toHaveValue(
    "Keep this local edit",
  );
  await page
    .getByRole("button", { name: "← All FAQs · draft kept", exact: true })
    .click();
  page.once("dialog", (dialog) => dialog.dismiss());
  await firstFaq
    .getByRole("button", { name: "Approve for answers", exact: true })
    .click();
  expect(approvals).toBe(0);
  await page
    .getByRole("button", { name: "Resume FAQ draft", exact: true })
    .click();
  await expect(page.getByLabel("FAQ question", { exact: true })).toHaveValue(
    "Keep this local edit",
  );
  acceptNextDialog();
  await page
    .getByRole("button", { name: "Discard draft", exact: true })
    .click();
  await page.unroute(`**/v2/workspaces/${ws}/faqs`, faqFixture);
  await page.unroute(`**/v2/workspaces/${ws}/faqs/*/approve`);

  await visit("publish");
  await expect(
    page.getByRole("heading", { name: "Your channels", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Support options", exact: true })
    .click();
  await expect(page.locator(".support-mode-options")).toHaveCSS(
    "display",
    "grid",
  );
  await expect(page.locator(".support-mode-options label")).toHaveCount(4);
  await page
    .getByRole("button", { name: "← All channels", exact: true })
    .click();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  const welcome = page.getByLabel("Welcome heading", { exact: true });
  const original = await welcome.inputValue();
  await welcome.fill("Content audit local preview");
  await page.getByRole("button", { name: "Channels", exact: true }).click();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await expect(welcome).toHaveValue("Content audit local preview");
  acceptNextDialog();
  await page.getByRole("button", { name: "Reload saved", exact: true }).click();
  await expect(welcome).toHaveValue(original);

  await visit("connections");
  await page.setViewportSize({ width: 390, height: 844 });
  const claude = page.getByRole("button", { name: /Claude \/ Anthropic/ });
  await claude.click();
  const configured = page.getByRole("heading", {
    name: "Configure Claude / Anthropic",
    exact: true,
  });
  await expect(configured).toBeFocused();
  await expect(configured).toBeInViewport();
  await expect(page.getByLabel("API key", { exact: true })).toBeInViewport();
  await page
    .getByRole("button", { name: "← All connections", exact: true })
    .click();
  await expect(claude).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 1000 });

  const fail = (route: Route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Content audit read failure" }),
    });
  await page.route(`**/v2/workspaces/${ws}/sources`, fail);
  await visit("knowledge");
  await expect(
    page.getByText(
      "Your knowledge could not be loaded. Try again to check your saved sources.",
    ),
  ).toBeVisible();
  await expect(page.getByText("0 sources", { exact: true })).not.toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Connect your first source →",
      exact: true,
    }),
  ).not.toBeVisible();
  await page.unroute(`**/v2/workspaces/${ws}/sources`, fail);
  await page
    .getByRole("button", { name: "Try loading knowledge again", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Try loading knowledge again",
      exact: true,
    }),
  ).not.toBeVisible();

  await page.route(`**/v2/workspaces/${ws}/connections`, fail);
  await visit("connections");
  await expect(
    page.getByText(
      "Connection status is unavailable. Your saved connections have not been removed.",
    ),
  ).toBeVisible();
  await expect(page.locator(".connection-card")).toHaveCount(0);
  await page.unroute(`**/v2/workspaces/${ws}/connections`, fail);
  await page
    .getByRole("button", { name: "Try loading connections again", exact: true })
    .click();
  await expect(page.locator(".connection-card").first()).toBeVisible();

  // Supply existing-key metadata and intercept rotation to test confirmation/pending safely.
  // Keep this response local: a route.fetch() could still be pending when the
  // rotation-triggered refresh completes the visible UI and the next journey starts.
  let connectionResponses = 0;
  const identityStatus = async (route: Route) => {
    await route.fulfill({
      json: {
        connections: [
          { provider: "widget_identity", status: "connected", metadata: {} },
        ],
      },
    });
    connectionResponses++;
  };
  await page.route(`**/v2/workspaces/${ws}/connections`, identityStatus);
  let rotations = 0;
  let finishRotation: (() => void) | undefined;
  const rotateIdentity = async (route: Route) => {
    rotations++;
    await new Promise<void>((resolve) => {
      finishRotation = resolve;
    });
    await route.fulfill({ json: { secret: "intercepted-test-value" } });
  };
  await page.route(`**/v2/workspaces/${ws}/identity-key`, rotateIdentity);
  await visit("publish");
  await page
    .getByRole("button", { name: "Developer integration", exact: true })
    .click();
  const rotate = page.getByRole("button", {
    name: "Rotate identity signing key",
    exact: true,
  });
  page.once("dialog", (dialog) => dialog.dismiss());
  await rotate.click();
  expect(rotations).toBe(0);
  acceptNextDialog();
  await rotate.click();
  await expect.poll(() => rotations).toBe(1);
  await expect(
    page.getByRole("button", { name: "Working…", exact: true }),
  ).toBeDisabled();
  const previousConnectionResponses = connectionResponses;
  finishRotation!();
  await expect(
    page.getByText(
      "Signing key rotated. Update your website server with the new key.",
      { exact: true },
    ),
  ).toBeVisible();
  // The success message appears before connections.reload() has finished.
  // Drain that request before removing the handler or navigating to the next test.
  await expect
    .poll(() => connectionResponses)
    .toBeGreaterThan(previousConnectionResponses);
  await page.unroute(`**/v2/workspaces/${ws}/identity-key`, rotateIdentity);
  await page.unroute(`**/v2/workspaces/${ws}/connections`, identityStatus);
  await visit("publish");
}
