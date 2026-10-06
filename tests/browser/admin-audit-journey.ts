import { expect, type Page } from "@playwright/test";

export async function verifyAdminRecords(page: Page, ws: string) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const actions = [
    {
      id: "audit-cancel",
      name: "cancel_subscription",
      description: "Cancel the selected subscription at period end.",
      kind: "stripe_cancel",
      enabled: true,
      config: {
        stripeMode: "test",
        idempotent: false,
        mappingKey: "customer_id",
      },
      policy: {
        mode: "approval",
        maxAmountMinor: 0,
        currency: "usd",
        dailyLimit: 10,
      },
    },
    {
      id: "audit-refund",
      name: "refund_payment",
      description: "Refund a captured payment after the required review.",
      kind: "stripe_refund",
      enabled: false,
      config: {
        stripeMode: "live",
        idempotent: false,
        mappingKey: "customer_id",
      },
      policy: {
        mode: "automatic",
        maxAmountMinor: 8900,
        currency: "usd",
        dailyLimit: 25,
      },
    },
  ];
  let saved: any;
  await page.route(`**/v2/workspaces/${ws}/actions`, (route) =>
    route.fulfill({ json: { actions } }),
  );
  await page.route(`**/v2/workspaces/${ws}/actions/audit-refund`, (route) => {
    saved = route.request().postDataJSON();
    return route.fulfill({ json: saved });
  });
  await page.goto(`/?workspace=${ws}&view=actions`);
  const configure = (name: string) =>
    page
      .locator(".action-card")
      .filter({ has: page.getByRole("heading", { name, exact: true }) })
      .getByRole("button", { name: "Configure action →", exact: true });
  await configure("cancel_subscription").click();
  await expect(
    page.getByLabel("Automatic refund limit (minor units)", { exact: true }),
  ).toBeHidden();
  await configure("refund_payment").click();
  await expect(page.getByLabel("Action name", { exact: true })).toHaveValue(
    "refund_payment",
  );
  await expect(
    page.getByLabel("What should the agent use this for?", { exact: true }),
  ).toHaveValue(actions[1].description);
  await expect(
    page.getByLabel("Stripe environment", { exact: true }),
  ).toHaveValue("live");
  await expect(
    page.getByLabel("Automatic refund limit (minor units)", { exact: true }),
  ).toHaveValue("8900");
  await expect(page.getByText(/Maximum per refund: \$89.00/)).toBeVisible();
  await page.getByLabel("Action name", { exact: true }).fill("reviewed_refund");
  page.once("dialog", (dialog) => dialog.dismiss());
  await configure("cancel_subscription").click();
  await expect(page.getByLabel("Action name", { exact: true })).toHaveValue(
    "reviewed_refund",
  );
  await page.getByRole("button", { name: "Save action", exact: true }).click();
  await expect(page.getByText("Action saved.", { exact: true })).toBeVisible();
  expect(saved).toMatchObject({
    name: "reviewed_refund",
    description: actions[1].description,
    kind: "stripe_refund",
    enabled: false,
    config: { stripeMode: "live" },
    policy: { maxAmountMinor: 8900, dailyLimit: 25 },
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const first = configure("cancel_subscription");
  await first.click();
  await expect(
    page.getByRole("heading", {
      name: "Edit action: cancel_subscription",
      exact: true,
    }),
  ).toBeFocused();
  await expect(
    page.getByLabel("Action name", { exact: true }),
  ).toBeInViewport();
  await page
    .getByRole("button", { name: "Back to actions", exact: true })
    .click();
  await expect(first).toBeFocused();
  await page.unroute(`**/v2/workspaces/${ws}/actions`);
  await page.unroute(`**/v2/workspaces/${ws}/actions/audit-refund`);

  await page.setViewportSize({ width: 1440, height: 1000 });
  const me = await (await page.request.get("/v2/me")).json();
  let removals = 0;
  await page.route(`**/v2/workspaces/${ws}/members`, (route) =>
    route.fulfill({
      json: {
        members: [
          {
            user_id: me.user.id,
            name: me.user.name,
            email: me.user.email,
            role: "owner",
          },
          ...(removals
            ? []
            : [
                {
                  user_id: "audit-offboarding",
                  name: "Audit teammate",
                  email: "audit@example.test",
                  role: "agent",
                },
              ]),
        ],
      },
    }),
  );
  await page.route(
    `**/v2/workspaces/${ws}/members/audit-offboarding`,
    (route) => {
      expect(route.request().method()).toBe("DELETE");
      removals++;
      return route.fulfill({ json: { removed: true } });
    },
  );
  await page.goto(`/?workspace=${ws}&view=team`);
  await expect(
    page.getByText("Owner access is protected", { exact: true }),
  ).toBeVisible();
  const remove = page.getByRole("button", {
    name: "Remove access for Audit teammate",
    exact: true,
  });
  page.once("dialog", (dialog) => dialog.dismiss());
  await remove.click();
  expect(removals).toBe(0);
  page.once("dialog", (dialog) => dialog.accept());
  await remove.click();
  await expect(remove).toHaveCount(0);
  expect(removals).toBe(1);
  await page.unroute(`**/v2/workspaces/${ws}/members`);
  await page.unroute(`**/v2/workspaces/${ws}/members/audit-offboarding`);
}

export async function verifyAnalyticsNavigation(page: Page, ws: string) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(
    `/?workspace=${ws}&view=analytics&from=2026-02-31&to=2026-03-05`,
  );
  await expect(
    page.getByText("Choose a start and end date.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Conversation volume over time",
      exact: true,
    }),
  ).toBeHidden();
  await page.goto(`/?workspace=${ws}&view=analytics`);
  const from = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  await page.getByLabel("From (UTC)", { exact: true }).fill(from);
  await expect(
    page.getByRole("heading", {
      name: "Conversation volume over time",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "View all conversations", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Conversation drill-down", exact: true }),
  ).toBeFocused();
  await page.locator(".analytics-table tbody a").first().click();
  await expect(
    page.getByRole("heading", { name: "Inbox", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(page.getByLabel("From (UTC)", { exact: true })).toHaveValue(
    from,
  );
  await expect(
    page.getByRole("heading", { name: "Conversation drill-down", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("From (UTC)", { exact: true })).toHaveValue(
    from,
  );
  await page
    .getByLabel("Search conversation subjects", { exact: true })
    .fill("no-matching-subject-audit");
  await expect(
    page.getByText(
      "No conversations match. Try another outcome, status or search.",
    ),
  ).toBeVisible();
  await page
    .getByLabel("Search conversation subjects", { exact: true })
    .fill("");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.goto(`/?workspace=${ws}&view=customers`);
  const customer = page.locator(".customer-directory-card").first();
  await customer.click();
  await page
    .getByRole("button", { name: "← All customers", exact: true })
    .click();
  await expect(customer).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/?workspace=${ws}&view=inbox`);
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page
    .getByLabel("Group inbox by", { exact: true })
    .selectOption("conversation");
  await expect(
    page.locator(".conversation-card .conversation-owner").first(),
  ).toBeVisible();
}

export async function verifyAdminAudit(page: Page, ws: string) {
  await verifyAdminRecords(page, ws);
  await verifyAnalyticsNavigation(page, ws);
}
