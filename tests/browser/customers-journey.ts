import { expect, type Page } from "@playwright/test";

export async function verifyCustomers(staff: Page, customer: Page) {
  const ws = new URL(staff.url()).searchParams.get("workspace")!;
  await staff.goto(`/?workspace=${ws}&view=inbox`);
  await staff.getByLabel("Group inbox by").selectOption("customer");
  const queue = staff.getByRole("region", { name: "Conversation queue" });
  const groups = queue.locator(".customer-group-toggle");
  await expect(groups).toHaveCount(1);
  await expect(groups).toContainText("A real customer");
  await groups.click();
  await expect(queue.locator(".conversation-card")).toHaveCount(4);
  await queue
    .getByRole("group", { name: "Conversation type" })
    .getByRole("button", { name: "Chatbot", exact: true })
    .click();
  await groups.click();
  await expect(queue.locator(".conversation-card")).toHaveCount(1);
  await expect(queue.locator(".conversation-card")).toContainText("Chatbot");
  await queue
    .getByRole("group", { name: "Conversation type" })
    .getByRole("button", { name: "Tickets", exact: true })
    .click();
  await groups.click();
  await expect(queue.locator(".conversation-card")).toHaveCount(3);
  await queue
    .getByRole("button", { name: /Email reply browser check/ })
    .click();
  const ticketId = new URL(staff.url()).searchParams.get("conversation")!;
  await staff
    .getByLabel("Reply", { exact: true })
    .fill("Keep this ticket draft while looking at the customer");
  await staff
    .getByRole("button", {
      name: "View customer: A real customer",
      exact: true,
    })
    .click();
  const panel = staff.getByRole("tabpanel", { name: "Customer", exact: true });
  await expect(
    panel.getByRole("heading", { name: "A real customer", exact: true }),
  ).toBeVisible();
  await expect(panel.locator(".customer-history-card")).toHaveCount(4);
  await panel.getByRole("tab", { name: "Customer notes", exact: true }).click();
  await expect(
    panel.getByText("Private return draft", { exact: true }),
  ).toBeVisible();
  const note = "Prefers a clear return deadline and an email confirmation.";
  await panel.getByLabel("Add a customer note", { exact: true }).fill(note);
  await staff.route(
    "**/customers/*/notes",
    (route) =>
      route.request().method() === "POST"
        ? route.fulfill({
            status: 503,
            json: { error: "Note service temporarily unavailable" },
          })
        : route.continue(),
    { times: 1 },
  );
  await panel
    .getByRole("button", { name: "Add customer note", exact: true })
    .click();
  await expect(
    panel.getByText("Note service temporarily unavailable", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByLabel("Add a customer note", { exact: true }),
  ).toHaveValue(note);
  await panel
    .getByRole("button", { name: "Add customer note", exact: true })
    .click();
  await expect(panel.getByText(note, { exact: true })).toHaveCount(1);
  await expect(
    panel.getByText("Customer note added. Nothing was sent to the customer.", {
      exact: true,
    }),
  ).toBeVisible();
  await staff.getByRole("tab", { name: "Conversation", exact: true }).click();
  await expect(staff.getByLabel("Reply", { exact: true })).toHaveValue(
    "Keep this ticket draft while looking at the customer",
  );
  await staff.getByRole("tab", { name: "Customer", exact: true }).click();
  await staff.screenshot({
    path: "test-results/inbox-customer-notes.png",
    fullPage: true,
    animations: "disabled",
  });
  const profileLink = panel.getByRole("link", {
    name: "Full profile ↗",
    exact: true,
  });
  const profileUrl = (await profileLink.getAttribute("href"))!;
  const customerId = new URL(
    profileUrl,
    "http://127.0.0.1:4351",
  ).searchParams.get("customer")!;
  // Customer sessions cannot see staff directories, profile notes, or inbox filters.
  for (const path of [
    "/customers",
    `/customers/${customerId}`,
    `/customers/${customerId}/notes`,
    "/inbox",
  ]) {
    const denied = await customer.request.get(`/v2/workspaces/${ws}${path}`);
    expect(denied.status()).toBe(403);
  }
  const publicTicket = await customer.request.get(
    `/v2/workspaces/${ws}/conversations/${ticketId}`,
  );
  expect(await publicTicket.text()).not.toContain(note);
  await profileLink.click();
  await expect(
    staff.getByRole("heading", { name: "Customers", exact: true }),
  ).toBeVisible();
  const profile = staff.getByRole("region", {
    name: "Customer profile",
    exact: true,
  });
  await profile
    .getByRole("tab", { name: "Customer notes", exact: true })
    .click();
  await expect(profile.getByText(note, { exact: true })).toBeVisible();
  await profile
    .getByRole("tab", { name: "Linked accounts", exact: true })
    .click();
  await profile
    .getByRole("button", { name: "Edit account links", exact: true })
    .click();
  await profile
    .getByRole("button", { name: "+ Add account link", exact: true })
    .click();
  await profile.getByLabel("Provider 1", { exact: true }).fill("test_store");
  await profile
    .getByLabel("Account ID 1", { exact: true })
    .fill("customer-browser-fixture");
  await profile
    .getByRole("button", { name: "Save reviewed links", exact: true })
    .click();
  await expect(
    profile.getByText("customer-browser-fixture", { exact: true }),
  ).toBeVisible();
  await staff.screenshot({
    path: "test-results/customer-accounts.png",
    fullPage: true,
    animations: "disabled",
  });
  await profile
    .getByRole("tab", { name: "Conversations", exact: true })
    .click();
  await staff.screenshot({
    path: "test-results/customers-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await staff.setViewportSize({ width: 390, height: 844 });
  expect(
    await staff.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await staff.screenshot({
    path: "test-results/customer-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await staff
    .getByRole("button", { name: "← All customers", exact: true })
    .click();
  await expect(
    staff.getByRole("region", { name: "Customer directory", exact: true }),
  ).toBeVisible();
  await staff.setViewportSize({ width: 1440, height: 1000 });
  await staff.getByRole("button", { name: "Team", exact: true }).click();
  await expect(
    staff.getByRole("heading", { name: "Invite a teammate", exact: true }),
  ).toBeVisible();
  await expect(
    staff.getByRole("heading", {
      name: "Reviewed customer mappings",
      exact: true,
    }),
  ).toHaveCount(0);
  await staff.getByRole("button", { name: "Customers", exact: true }).click();
  await staff.getByLabel("Search customers").fill("no matching customer");
  await expect(
    staff.getByRole("heading", { name: "No customers found", exact: true }),
  ).toBeVisible();
  await staff
    .getByLabel("Search customers")
    .fill("browser-customer@example.test");
  await expect(staff.locator(".customer-directory-card")).toHaveCount(1);
  // Navigating through a profile must preserve unsent inbox drafts.
  await staff.locator(".customer-directory-card").click();
  await profile
    .getByRole("tab", { name: "Conversations", exact: true })
    .click();
  await profile
    .locator(`a[href="/?workspace=${ws}&view=inbox&conversation=${ticketId}"]`)
    .click();
  await expect(staff.getByLabel("Reply", { exact: true })).toHaveValue(
    "Keep this ticket draft while looking at the customer",
  );
  await staff.getByLabel("Reply", { exact: true }).fill("");
  await staff.getByLabel("Group inbox by").selectOption("customer");
  await staff
    .getByRole("group", { name: "Conversation type" })
    .getByRole("button", { name: "All", exact: true })
    .click();
  await staff.screenshot({
    path: "test-results/inbox-grouped.png",
    fullPage: true,
    animations: "disabled",
  });
  await staff.setViewportSize({ width: 390, height: 844 });
  await staff
    .getByRole("button", { name: "← All conversations", exact: true })
    .click();
  await expect(
    staff.getByRole("region", { name: "Conversation queue" }),
  ).toBeVisible();
  expect(
    await staff.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    (await staff
      .getByLabel("Search conversations", { exact: true })
      .boundingBox())!.width,
  ).toBeGreaterThan(280);
  await staff.screenshot({
    path: "test-results/inbox-grouped-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await staff.setViewportSize({ width: 1440, height: 1000 });
}
