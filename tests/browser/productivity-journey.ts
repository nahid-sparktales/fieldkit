import { expect, type Page } from "@playwright/test";
/** Runs only against disposable local fixtures; never requires external mail or a model. */
export async function verifyProductivityJourney(
  staff: Page,
  customer: Page,
  ws: string,
) {
  const suffix = Date.now().toString(36),
    fieldName = `Reference ${suffix}`,
    formName = `Technical request ${suffix}`,
    macroName = `Follow-up ${suffix}`,
    viewName = `Priority queue ${suffix}`;
  await staff.goto(`/?workspace=${ws}&view=productivity`);
  await staff
    .getByRole("button", { name: "Ticket fields", exact: true })
    .click();
  await staff
    .getByRole("button", { name: "Create field", exact: true })
    .click();
  await staff.getByLabel("Field label", { exact: true }).fill(fieldName);
  await staff.getByLabel("Visible to customers", { exact: true }).check();
  await staff.getByLabel("Customers may edit", { exact: true }).check();
  await staff.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    staff.locator(".productivity-library-row").filter({ hasText: fieldName }),
  ).toBeVisible();
  await staff
    .getByRole("button", { name: "Request forms", exact: true })
    .click();
  await staff.getByRole("button", { name: "Create form", exact: true }).click();
  await staff.getByLabel("Name", { exact: true }).fill(formName);
  await staff
    .getByLabel("Active in the customer portal", { exact: true })
    .check();
  await staff
    .getByLabel("Add field", { exact: true })
    .selectOption({ label: fieldName });
  await staff
    .getByLabel("Always required when visible", { exact: true })
    .check();
  await staff.getByText("Preview this form", { exact: true }).click();
  await expect(
    staff.getByLabel(`${fieldName} *`, { exact: true }),
  ).toBeVisible();
  await staff.getByText("Preview this form", { exact: true }).click();
  await staff.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    staff.locator(".productivity-library-row").filter({ hasText: formName }),
  ).toContainText("Active");
  await customer
    .getByRole("button", { name: "My tickets", exact: true })
    .click();
  await customer
    .getByRole("button", { name: "New ticket", exact: true })
    .click();
  await customer
    .getByLabel("Request type", { exact: true })
    .selectOption({ label: formName });
  await customer
    .getByLabel(`${fieldName} *`, { exact: true })
    .fill("REF-UI-123");
  await customer
    .getByLabel("Subject", { exact: true })
    .fill(`Structured ticket ${suffix}`);
  await customer
    .getByLabel("Message", { exact: true })
    .fill("This synthetic request exercises a configured form.");
  await customer
    .getByRole("button", { name: "Send ticket", exact: true })
    .click();
  await expect(
    customer.getByRole("heading", {
      name: `Structured ticket ${suffix}`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(customer.getByText("REF-UI-123", { exact: true })).toBeVisible();
  const ticketId = new URL(customer.url()).searchParams.get("ticket")!;
  await staff.getByRole("button", { name: "Macros", exact: true }).click();
  await staff
    .getByRole("button", { name: "Create macro", exact: true })
    .click();
  await staff.getByLabel("Name", { exact: true }).fill(macroName);
  await staff
    .getByLabel("Reply or note template", { exact: true })
    .fill("Draft productivity response");
  await staff.getByLabel("Priority", { exact: true }).selectOption("high");
  await staff.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    staff.locator(".productivity-library-row").filter({ hasText: macroName }),
  ).toBeVisible();
  await staff.getByRole("button", { name: "Saved views", exact: true }).click();
  await staff.getByRole("button", { name: "Create view", exact: true }).click();
  await staff.getByLabel("Name", { exact: true }).fill(viewName);
  await staff.getByRole("button", { name: "Add filter", exact: true }).click();
  await staff.getByLabel("Field", { exact: true }).selectOption("priority");
  const filterValue = staff.getByLabel("Value", { exact: true });
  if (await filterValue.evaluate((node) => node.tagName === "SELECT"))
    await filterValue.selectOption("high");
  else await filterValue.fill("high");
  await staff.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    staff.locator(".productivity-library-row").filter({ hasText: viewName }),
  ).toBeVisible();
  // Fence a published workflow's independent reply before measuring preview effects.
  const takeover = await staff.request.post(
    `/v2/workspaces/${ws}/conversations/${ticketId}/control`,
    {
      headers: { Origin: new URL(staff.url()).origin },
      data: { mode: "human" },
    },
  );
  expect(takeover.status(), await takeover.text()).toBe(200);
  await staff.goto(`/?workspace=${ws}&view=inbox&conversation=${ticketId}`);
  const before = await (
    await staff.request.get(`/v2/workspaces/${ws}/conversations/${ticketId}`)
  ).json();
  expect(before.conversation.mode).toBe("human");
  await staff.getByRole("button", { name: "Use a macro", exact: true }).click();
  await staff.getByLabel("Find a macro", { exact: true }).fill(macroName);
  await staff
    .locator(".macro-results button")
    .filter({ hasText: macroName })
    .click();
  await expect(
    staff.getByRole("region", { name: "Macro draft preview" }),
  ).toBeVisible();
  await staff
    .getByRole("button", { name: "Use this draft", exact: true })
    .click();
  await expect(staff.getByLabel("Reply", { exact: true })).toHaveValue(
    "Draft productivity response",
  );
  const staged = await (
    await staff.request.get(`/v2/workspaces/${ws}/conversations/${ticketId}`)
  ).json();
  expect(staged.messages.length).toBe(before.messages.length);
  expect(staged.conversation.priority).toBe("normal");
  await staff
    .getByLabel("Reply", { exact: true })
    .fill("Reviewed productivity response");
  await staff.getByRole("button", { name: "Send reply", exact: false }).click();
  await expect(staff.getByLabel("Reply", { exact: true })).toHaveValue("");
  const sent = await (
    await staff.request.get(`/v2/workspaces/${ws}/conversations/${ticketId}`)
  ).json();
  expect(
    sent.messages.some((m: any) => m.body === "Reviewed productivity response"),
  ).toBe(true);
  expect(sent.conversation.priority).toBe("high");
  await staff
    .getByLabel("Inbox view", { exact: true })
    .selectOption({ label: `${viewName} · Personal` });
  await expect(
    staff
      .locator(".saved-view-ticket")
      .filter({ hasText: `Structured ticket ${suffix}` }),
  ).toBeVisible();
  await staff.setViewportSize({ width: 390, height: 844 });
  await expect(
    staff.getByRole("heading", {
      name: `Structured ticket ${suffix}`,
      exact: true,
    }),
  ).toBeVisible();
  expect(
    await staff.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await staff.setViewportSize({ width: 1440, height: 1000 });
  return { ticketId, fieldName, formName, macroName, viewName };
}
