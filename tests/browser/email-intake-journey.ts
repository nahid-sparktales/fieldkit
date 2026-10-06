import { expect, type Page, type Route } from "@playwright/test";
/** Local UI contract. Mutations are intercepted; no mailbox or credential is changed. */
export async function verifyEmailIntakeSettings(page: Page) {
  const ws = new URL(page.url()).searchParams.get("workspace")!;
  const addresses: any[] = [];
  const settings = {
    configured: true,
    address: "support@example.test",
    smtpConfigured: true,
    webhookUrl: "https://example.test/webhook",
    canRetry: true,
    addresses,
    teams: [{ id: "billing-team", name: "Billing" }],
    inbound: [],
    outbound: [],
    inboundAttempts: [],
    outboundAttempts: [],
  };
  const read = (route: Route) => route.fulfill({ json: settings });
  const save = async (route: Route) => {
    const draft = route.request().postDataJSON();
    addresses.push({
      ...draft,
      id: "billing-address",
      integrationId: "fixture",
    });
    await route.fulfill({ json: addresses[0] });
  };
  await page.route(`**/v2/workspaces/${ws}/ticket-email`, read);
  await page.route(`**/v2/workspaces/${ws}/ticket-email/addresses`, save);
  try {
    await page.goto(`/?workspace=${ws}&view=publish`);
    await page
      .getByRole("button", { name: "Email support", exact: true })
      .click();
    const panel = page.locator(".ticket-email-settings");
    await expect(
      panel.getByText("No support addresses configured yet.", { exact: true }),
    ).toBeVisible();
    await panel
      .getByRole("button", { name: "Add support address", exact: true })
      .click();
    const editor = panel.getByRole("form", { name: "Support address editor" });
    await editor
      .getByLabel("Support address", { exact: true })
      .fill("billing@example.test");
    await editor
      .getByLabel("Display name", { exact: true })
      .fill("Billing support");
    await editor
      .getByLabel("Reply identity address", { exact: true })
      .fill("billing@example.test");
    await editor
      .getByLabel("Default team", { exact: true })
      .selectOption("billing-team");
    await editor
      .getByLabel("Send one acknowledgement for each new ticket")
      .check();
    await editor
      .getByRole("button", { name: "Save support address", exact: true })
      .click();
    await expect(
      panel.getByText("Support address saved.", { exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", {
        name: "Edit support address billing@example.test",
        exact: true,
      }),
    ).toBeVisible();
    expect(addresses[0]).toMatchObject({
      defaultTeamId: "billing-team",
      acknowledge: true,
      workflowEnabled: false,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await panel
      .getByRole("button", {
        name: "Edit support address billing@example.test",
        exact: true,
      })
      .click();
    await editor
      .getByLabel("Display name", { exact: true })
      .fill("Unsaved label");
    page.once("dialog", (dialog) => dialog.dismiss());
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(
      editor.getByLabel("Display name", { exact: true }),
    ).toHaveValue("Unsaved label");
    page.once("dialog", (dialog) => dialog.accept());
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(editor).not.toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } finally {
    await page.unroute(`**/v2/workspaces/${ws}/ticket-email`, read);
    await page.unroute(`**/v2/workspaces/${ws}/ticket-email/addresses`, save);
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
}
