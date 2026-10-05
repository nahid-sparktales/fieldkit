import { expect, type Page } from "@playwright/test";
import { defaultSlaPolicy } from "../../packages/platform/src/sla-contracts.js";
import { defaultWorkflow } from "../../packages/platform/src/workflow-definition.js";
export async function verifySlaShadow(staff: Page, customer: Page, ws: string) {
  const headers = { Origin: "http://127.0.0.1:4351" },
    base = `/v2/workspaces/${ws}`;
  const policy = defaultSlaPolicy();
  policy.enabled = true;
  policy.calendar.shifts = [1, 2, 3, 4, 5, 6, 7].map((day) => ({
    day,
    start: "00:00",
    end: "24:00",
  }));
  policy.rules[0].firstMinutes = 1;
  policy.rules[0].warningMinutes = 2;
  policy.rules[0].replies = "staff_only";
  expect(
    (
      await staff.request.put(`${base}/sla/policy`, {
        headers,
        data: { revision: 0, policy },
      })
    ).ok(),
  ).toBe(true);
  await staff.goto(`/?workspace=${ws}&view=needs%20attention`);
  await staff.getByRole("button", { name: "SLA policy", exact: true }).click();
  await expect(staff.getByLabel("Business timezone")).toHaveValue("UTC");
  await staff.getByLabel("Business timezone").fill("America/Toronto");
  await staff
    .getByRole("button", { name: "Save SLA policy", exact: true })
    .click();
  await expect(
    staff.getByText("Saved version 2", { exact: true }),
  ).toBeVisible();
  await staff
    .locator("summary")
    .filter({ hasText: "Preview a deadline" })
    .click();
  await staff.getByRole("button", { name: "Calculate deadline" }).click();
  await expect(
    staff.locator(".sla-policy [role=status]").filter({ hasText: "Due" }),
  ).toContainText("America/Toronto");
  const current = await (await staff.request.get(`${base}/workflow`)).json();
  const saved = await staff.request.put(`${base}/workflow`, {
    headers,
    data: { revision: current.revision, definition: defaultWorkflow() },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  const version = await saved.json();
  const pub = await staff.request.post(`${base}/workflow/publish`, {
    headers,
    data: { revision: version.revision },
  });
  expect(pub.ok(), await pub.text()).toBe(true);
  await staff.goto(`/?workspace=${ws}&view=shadow%20%26%20rollout`);
  await staff
    .locator("summary")
    .filter({ hasText: "Create an immutable candidate" })
    .click();
  await staff
    .getByLabel("Candidate name", { exact: true })
    .fill("Browser candidate");
  await staff
    .getByRole("button", { name: "Snapshot candidate", exact: true })
    .click();
  await expect(
    staff.getByText(
      "Candidate created without changing the published workflow.",
    ),
  ).toBeVisible();
  await staff.getByRole("button", { name: "Configure shadow test" }).click();
  await staff.locator(".shadow-launch input[name=percent]").fill("100");
  await staff.locator(".shadow-launch input[name=perRun]").fill("20000");
  await staff.locator(".shadow-launch input[type=checkbox][required]").check();
  await staff
    .getByRole("button", { name: "Start shadow test", exact: true })
    .click();
  await expect(
    staff.getByRole("button", { name: "Inspect comparisons" }),
  ).toBeVisible();
  const conv = await customer.request.post(`${base}/conversations`, {
    headers,
    data: {
      subject: "Shadow and SLA browser scenario",
      body: "What is your return policy?",
      requestKey: crypto.randomUUID(),
    },
  });
  expect(conv.ok(), await conv.text()).toBe(true);
  await staff.getByRole("button", { name: "Inspect comparisons" }).click();
  await expect(
    staff
      .locator(".shadow-comparison summary")
      .filter({ hasText: /^completed/ }),
  ).toBeVisible({ timeout: 30000 });
  await staff
    .locator(".shadow-comparison summary")
    .filter({ hasText: /^completed/ })
    .click();
  await expect(
    staff.getByRole("heading", { name: "Candidate (never sent)", exact: true }),
  ).toBeVisible();
  await staff.getByLabel("Verdict", { exact: true }).selectOption("pass");
  await staff
    .getByLabel("Review notes", { exact: true })
    .fill("Reviewed local fixture evidence and required checks.");
  await staff.getByRole("button", { name: "Record staff review" }).click();
  await staff
    .getByRole("button", { name: "Review live rollout", exact: true })
    .click();
  await staff
    .getByLabel("Required passing staff-reviewed comparisons")
    .fill("1");
  await staff
    .getByLabel("Release decision")
    .fill("Disposable browser test only; provider and model doubles.");
  await staff
    .locator(".shadow-launch")
    .filter({ hasText: "Enable a limited live rollout" })
    .locator("input[type=checkbox][required]")
    .check();
  await staff
    .getByRole("button", { name: "Enable live rollout", exact: true })
    .click();
  await staff
    .getByLabel("Reason for rollout change")
    .fill("Browser kill switch verification");
  await staff
    .getByRole("button", { name: "Stop rollout now", exact: true })
    .click();
  await expect(
    staff.getByText("Browser kill switch verification", { exact: true }),
  ).toBeVisible();
  await staff.screenshot({
    path: "test-results/shadow-desktop.png",
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
    path: "test-results/shadow-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await staff.setViewportSize({ width: 1440, height: 1000 });
  await staff.goto(`/?workspace=${ws}&view=needs%20attention`);
  await expect(
    staff
      .locator(".sla-queue-row")
      .filter({ hasText: "Shadow and SLA browser scenario" }),
  ).toBeVisible();
  await expect(
    staff
      .locator(".sla-queue-row")
      .filter({ hasText: "Shadow and SLA browser scenario" }),
  ).toContainText(/at risk|overdue/);
  await staff.screenshot({
    path: "test-results/sla-desktop.png",
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
    path: "test-results/sla-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await staff.setViewportSize({ width: 1440, height: 1000 });
}
