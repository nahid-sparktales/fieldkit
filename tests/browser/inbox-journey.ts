import { expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

export async function verifyInbox(page: Page, customer: Page) {
  const ws = new URL(page.url()).searchParams.get("workspace")!;
  const queue = page.getByRole("region", { name: "Conversation queue" });
  const original = queue.getByRole("button", {
    name: /What is your return policy/,
  });
  const reply = page.getByLabel("Reply", { exact: true });
  const management = page.locator(".ticket-management");
  const manageToggle = management.locator("summary");
  const filters = queue.getByRole("button", { name: /^Filters/ });
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
  await page.getByRole("tab", { name: "Notes", exact: true }).click();
  const notes = page.getByRole("region", {
    name: "Internal notes",
    exact: true,
  });
  await expect(
    notes.getByText("Private return draft", { exact: true }),
  ).toBeVisible();
  await expect(notes.getByText(/Internal note ·/)).toBeVisible();
  await page.getByLabel("Search internal notes").fill("nothing matches");
  await expect(
    notes.getByRole("heading", { name: "No matching notes" }),
  ).toBeVisible();
  await page.getByLabel("Search internal notes").fill("return");
  await page.screenshot({
    path: "test-results/inbox-notes.png",
    fullPage: true,
    animations: "disabled",
  });
  await notes.getByRole("button", { name: "Write internal note" }).click();
  await expect(reply).toBeFocused();
  await expect(page.getByLabel("Internal note", { exact: true })).toBeChecked();
  await expect(
    page
      .locator("#ticket-panel-conversation")
      .getByText("Private return draft", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Internal note", { exact: true }).uncheck();
  await page.getByRole("button", { name: "Resolve", exact: true }).click();
  await page
    .getByLabel("Inbox status", { exact: true })
    .selectOption("resolved");
  await expect(original).toBeVisible();
  await expect(shipping).toHaveCount(0);
  await page.getByRole("button", { name: "Reopen", exact: true }).click();
  await expect(original).toHaveCount(0);
  await page.getByLabel("Inbox status", { exact: true }).selectOption("human");
  await expect(original).toBeVisible();
  await manageToggle.click();
  await page.getByLabel("Assign conversation").selectOption({ index: 1 });
  await expect(
    page.getByText("Assignment updated.", { exact: true }),
  ).toBeVisible();
  await manageToggle.click();
  await filters.click();
  await expect(filters).toHaveAttribute("aria-expanded", "true");
  await page.getByLabel("Filter by assignee").selectOption("unassigned");
  await expect(
    page.getByRole("heading", { name: "No matching conversations" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  await filters.click();
  await expect(page.getByLabel("Filter by assignee")).not.toBeVisible();
  // Tabs have one keyboard stop and arrow-key navigation.
  await page.getByRole("tab", { name: "Conversation", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "Customer", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "Notes", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "Feedback", exact: true }),
  ).toBeFocused();
  const feedback = page.getByRole("region", {
    name: "Customer feedback",
    exact: true,
  });
  await expect(
    feedback.getByText("Issue solved", { exact: true }),
  ).toBeVisible();
  await expect(
    feedback.getByText("Experience: Good", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/inbox-feedback.png",
    fullPage: true,
    animations: "disabled",
  });
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
  const thread = page.getByRole("region", { name: "Selected conversation" });
  const composerBox = (await page.locator(".reply-form").boundingBox())!;
  const transcriptBox = (await page
    .locator("#ticket-panel-conversation")
    .boundingBox())!;
  expect(composerBox.height).toBeGreaterThanOrEqual(160);
  expect(composerBox.height).toBeLessThan(260);
  expect(transcriptBox.height).toBeGreaterThan(composerBox.height * 1.5);
  await reply.focus();
  expect(
    Math.abs(
      (await page.locator(".reply-form").boundingBox())!.height -
        composerBox.height,
    ),
  ).toBeLessThan(1);
  await expect(
    page.getByRole("slider", { name: "Conversation size", exact: true }),
  ).toHaveCount(0);
  const originalBox = (await thread.boundingBox())!;
  const queueBox = (await queue.boundingBox())!;
  const viewportHeight = page.viewportSize()!.height;
  expect(queueBox.x + queueBox.width).toBeLessThanOrEqual(originalBox.x + 1);
  expect(Math.abs(queueBox.y - originalBox.y)).toBeLessThan(3);
  expect(Math.abs(queueBox.height - originalBox.height)).toBeLessThan(3);
  expect(queueBox.y).toBeGreaterThanOrEqual(0);
  expect(queueBox.y + queueBox.height).toBeLessThanOrEqual(viewportHeight + 1);
  expect(originalBox.y + originalBox.height).toBeLessThanOrEqual(
    viewportHeight + 1,
  );
  // Long queues scroll inside their pane, keeping the reply area in view.
  expect(
    await queue
      .locator(".conversation-items")
      .evaluate((el) =>
        ["auto", "scroll"].includes(getComputedStyle(el).overflowY),
      ),
  ).toBe(true);
  await expect(reply).toBeInViewport();
  await expect(management).not.toHaveAttribute("open");
  await manageToggle.click();
  await expect(
    page.getByRole("button", { name: "Mark as unread", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Mark as unread", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Mark as read", exact: true }),
  ).toBeVisible();
  await manageToggle.click();
  const sections = queue.getByRole("group", { name: "Inbox sections" });
  await sections.getByRole("button", { name: /^Unread/ }).click();
  await expect(original).toBeVisible();
  await manageToggle.click();
  await page.getByRole("button", { name: "Mark as read", exact: true }).click();
  await manageToggle.click();
  await expect(original).toHaveCount(0);
  await filters.click();
  await page.getByLabel("Filter by read status").selectOption("read");
  await filters.click();
  await expect(original).toBeVisible();
  await sections.getByRole("button", { name: /^Open/ }).click();
  await reply.fill("Draft while expanded");
  await page
    .getByRole("button", { name: "Expand conversation", exact: true })
    .click();
  await expect(queue).toBeHidden();
  const expandedBox = (await thread.boundingBox())!;
  expect(expandedBox.width).toBeGreaterThan(originalBox.width + 200);
  expect(Math.abs(expandedBox.height - originalBox.height)).toBeLessThan(3);
  await expect(reply).toHaveValue("Draft while expanded");
  await page.screenshot({
    path: "test-results/inbox-expanded.png",
    fullPage: true,
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "Show conversation list", exact: true })
    .click();
  await expect(queue).toBeVisible();
  await reply.fill("");
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
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/inbox-mobile-queue.png",
    fullPage: true,
    animations: "disabled",
  });
  await shipping.click();
  await expect(reply).toHaveValue("Shipping draft kept separately");
  await expect(reply).toBeInViewport();
  await expect(
    page.getByRole("button", { name: "Send reply", exact: true }),
  ).toBeInViewport();
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
