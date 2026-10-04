import { expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

export async function verifyInbox(page: Page, customer: Page) {
  const ws = new URL(page.url()).searchParams.get("workspace")!;
  const queue = page.getByRole("region", { name: "Conversation queue" });
  const original = queue.getByRole("button", {
    name: /What is your return policy/,
  });
  const reply = page.getByLabel("Reply", { exact: true });
  await expect(page.locator(".support-assistant")).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Send reply", exact: true }),
  ).toBeDisabled();
  const created = await customer.request.post(
    `/v2/workspaces/${ws}/conversations`,
    {
      headers: { Origin: "http://127.0.0.1:4351" },
      data: {
        subject: "Shipping estimate",
        body: "When will my package arrive?",
        requestKey: randomUUID(),
      },
    },
  );
  expect(created.status()).toBe(202);
  await page.getByRole("button", { name: "Refresh inbox" }).click();
  const shipping = queue.getByRole("button", { name: /Shipping estimate/ });
  await expect(shipping).toBeVisible();
  await reply.fill("Private return draft");
  await page.getByLabel("Internal note", { exact: true }).check();
  await shipping.click();
  await expect(reply).toHaveValue("");
  await reply.fill("Shipping draft kept separately");
  await page.getByRole("button", { name: "Knowledge", exact: true }).click();
  await page.getByRole("button", { name: "Inbox", exact: true }).click();
  await shipping.click();
  await expect(reply).toHaveValue("Shipping draft kept separately");
  await original.click();
  await expect(reply).toHaveValue("Private return draft");
  await expect(page.getByLabel("Internal note", { exact: true })).toBeChecked();
  await expect(
    page.getByText("Only visible to your team", { exact: true }),
  ).toBeVisible();
  await page.route("**/conversations/*/notes", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Test delivery interruption" }),
    }),
  );
  await page.getByRole("button", { name: "Add note", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Test delivery interruption",
  );
  await expect(reply).toHaveValue("Private return draft");
  await page.unroute("**/conversations/*/notes");
  await reply.press("Control+Enter");
  await expect(
    page.getByText("Private note added.", { exact: true }),
  ).toBeVisible();
  await expect(reply).toHaveValue("");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(original).not.toContainText("Private return draft");
  const customerHistory = await customer.request.get(
    `/v2/workspaces/${ws}/conversations`,
  );
  expect(await customerHistory.text()).not.toContain("Private return draft");
  await page.getByLabel("Internal note", { exact: true }).uncheck();
  await page.getByRole("button", { name: "Resolve", exact: true }).click();
  await page.getByRole("button", { name: /^Resolved \d/ }).click();
  await expect(original).toBeVisible();
  await expect(shipping).toHaveCount(0);
  await page.getByRole("button", { name: "Reopen", exact: true }).click();
  await expect(original).toHaveCount(0);
  await page.getByRole("button", { name: /Needs a person \d/ }).click();
  await expect(original).toBeVisible();
  await page.getByLabel("Assign conversation").selectOption({ index: 1 });
  await expect(
    page.getByText("Assignment updated.", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Filter by assignee").selectOption("unassigned");
  await expect(
    page.getByRole("heading", { name: "No matching conversations" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  // Tabs have one keyboard stop and arrow-key navigation.
  await page.getByRole("tab", { name: "Conversation", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "✦ Support assistant", exact: true }),
  ).toBeFocused();
  await expect(page.locator(".support-assistant")).toBeVisible();
  await page.keyboard.press("End");
  await expect(
    page.getByRole("tab", { name: "Activity & tools", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Home");
  await expect(
    page.getByRole("tab", { name: "Conversation", exact: true }),
  ).toBeFocused();
  await original.click();
  await page.screenshot({
    path: "test-results/inbox-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(queue).not.toBeVisible();
  await expect(
    page.getByRole("region", { name: "Selected conversation" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "← All conversations", exact: true })
    .click();
  await expect(original).toBeFocused();
  await expect(queue).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Selected conversation" }),
  ).not.toBeVisible();
  await page.screenshot({
    path: "test-results/inbox-mobile-queue.png",
    fullPage: true,
  });
  await shipping.click();
  await expect(reply).toHaveValue("Shipping draft kept separately");
  await expect(
    page
      .getByRole("heading", { name: "Shipping estimate", exact: true })
      .last(),
  ).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/inbox-mobile-conversation.png",
    fullPage: true,
  });
  // Leave no unsent draft behind in this disposable test.
  await reply.fill("");
  await page
    .getByRole("button", { name: "← All conversations", exact: true })
    .click();
  await original.click();
  await page.setViewportSize({ width: 1440, height: 1000 });
}
