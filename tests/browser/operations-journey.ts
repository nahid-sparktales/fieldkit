import { expect, type Page } from "@playwright/test";
import { verifySlaShadow } from "./sla-shadow-journey.js";
export async function verifyOperationalControls(
  staff: Page,
  customer: Page,
  ws: string,
) {
  await staff.setViewportSize({ width: 1440, height: 1000 });
  await staff.goto(`/?workspace=${ws}&view=readiness`);
  await expect(
    staff.getByRole("heading", { name: "Readiness", exact: true }),
  ).toBeVisible();
  await staff
    .getByRole("button", { name: "Run safe checks", exact: true })
    .click();
  await expect(
    staff.getByText("Checks queued.", { exact: false }),
  ).toBeVisible();
  const core = staff.locator(".readiness-check").filter({
    has: staff.getByRole("heading", { name: "Installation", exact: true }),
  });
  await expect(core.getByText("read verified", { exact: true })).toBeVisible({
    timeout: 20000,
  });
  await core.getByRole("button", { name: "Evidence and testing" }).click();
  await expect(
    staff.getByRole("region", { name: "Diagnostic details" }),
  ).toContainText("Database, schema, worker and private volume");
  await staff.screenshot({
    path: "test-results/readiness-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await staff.setViewportSize({ width: 390, height: 844 });
  await expect(staff.locator(".sidebar")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  expect(
    await staff.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await staff.screenshot({
    path: "test-results/readiness-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await staff.setViewportSize({ width: 1440, height: 1000 });
  await staff.goto(`/?workspace=${ws}&view=publish`);
  await staff
    .getByRole("button", { name: "Customer attachments", exact: true })
    .click();
  await staff.getByLabel("Allow attachments", { exact: true }).check();
  await expect(staff.getByText("Attachment settings updated.")).toBeVisible();
  const base = await (await staff.request.get(`/v2/workspaces/${ws}`)).json();
  const channel = base.channels.find((ch: any) => ch.kind === "portal");
  const created = await customer.request.post(
    `/v2/workspaces/${ws}/conversations`,
    {
      headers: {
        "X-Fieldkit-Audience": "customer",
        Origin: "http://127.0.0.1:4351",
      },
      data: {
        body: "Please inspect this customer screenshot",
        subject: "Attachment browser verification",
        channelId: channel.id,
        requestKey: crypto.randomUUID(),
      },
    },
  );
  expect(created.ok(), await created.text()).toBe(true);
  const conv = await created.json();
  await staff.request.patch(`/v2/workspaces/${ws}/conversations/${conv.id}`, {
    headers: { Origin: "http://127.0.0.1:4351" },
    data: { mode: "human" },
  });
  await customer.goto(`/support/${base.workspace.slug}?ticket=${conv.id}`);
  await customer
    .getByRole("button", { name: "Reply to support", exact: true })
    .click();
  await customer
    .getByLabel("Your reply", { exact: true })
    .fill("Here is the screenshot");
  await customer.locator(".attachment-picker summary").click();
  await customer
    .locator("input[type=file]")
    .setInputFiles("tests/fixtures/logo.png");
  await expect(customer.locator(".attachment-picker")).toContainText(
    "logo.png",
  );
  await expect(
    customer.getByRole("button", { name: "Send reply", exact: true }),
  ).toBeEnabled();
  await customer
    .getByRole("button", { name: "Send reply", exact: true })
    .click();
  await expect(customer.locator(".attachment-card")).toContainText("logo.png");
  await expect(customer.locator(".attachment-card")).toContainText(
    "No malware detected",
    { timeout: 20000 },
  );
  await expect(customer.locator(".attachment-card")).toContainText(
    "AI has not inspected",
  );
  await staff.goto(`/?workspace=${ws}&view=inbox&conversation=${conv.id}`);
  const card = staff
    .locator("#ticket-panel-conversation .attachment-card")
    .filter({ hasText: "logo.png" });
  await card.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(
    card.getByRole("img", { name: "Preview of logo.png" }),
  ).toBeVisible();
  await staff.screenshot({
    path: "test-results/attachment-staff-preview.png",
    fullPage: true,
    animations: "disabled",
  });
  await customer.setViewportSize({ width: 390, height: 844 });
  expect(
    await customer.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await customer.screenshot({
    path: "test-results/attachment-customer-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await customer.setViewportSize({ width: 1440, height: 1000 });
  await verifySlaShadow(staff, customer, ws);
  // Restore the default for the earlier journeys' compact-composer checks.
  await staff.request.put(`/v2/workspaces/${ws}/attachments/settings`, {
    headers: { Origin: "http://127.0.0.1:4351" },
    data: { enabled: false, anonymous: false },
  });
}
