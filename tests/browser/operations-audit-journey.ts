import { expect, type Page } from "@playwright/test";

export async function verifyOperationsAudit(page: Page, ws: string) {
  await verifyPendingSettingsGuard(page, ws);
  await verifyProfileRefreshDrafts(page, ws);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/?workspace=${ws}&view=settings`);
  const instructions = page.getByLabel("Agent instructions", { exact: true });
  const original = await instructions.inputValue();
  await instructions.fill(`${original}\nUnsaved settings navigation check`);
  await expect(
    page.getByText("Unsaved changes", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  await expect(instructions).toHaveValue(
    `${original}\nUnsaved settings navigation check`,
  );
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Inbox", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(instructions).toHaveValue(original);
  await expect(
    page.getByRole("button", { name: "Save settings", exact: true }),
  ).toBeDisabled();

  const savedInstructions = `${original}\nSaved draft baseline check`;
  await instructions.fill(savedInstructions);
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(
    page.getByText("Workspace settings saved.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save settings", exact: true }),
  ).toBeDisabled();
  await instructions.fill(`${savedInstructions} unsaved`);
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(instructions).toHaveValue(savedInstructions);
  await instructions.fill(original);
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Save settings", exact: true }),
  ).toBeDisabled();

  await page.getByRole("button", { name: "My profile", exact: true }).click();
  await expect(page.getByText("This session", { exact: true })).toBeVisible();
  await expect(page.locator(".profile-sessions li").first()).toContainText(
    "This session",
  );
  await expect(
    page.locator(".profile-sessions li").first().locator("strong"),
  ).toContainText(" on ");
  await expect(
    page.locator(".profile-sessions li").first().locator("details"),
  ).not.toHaveAttribute("open");

  await page.goto(`/?workspace=${ws}&view=readiness`);
  await page.setViewportSize({ width: 390, height: 844 });
  const firstCheck = page.locator(".readiness-check").first();
  const title = await firstCheck.getByRole("heading").textContent();
  const trigger = firstCheck.getByRole("button", {
    name: "Evidence and testing",
    exact: true,
  });
  await trigger.click();
  const details = page.getByRole("region", { name: "Diagnostic details" });
  await expect(
    details.getByRole("heading", { name: title!, exact: true }),
  ).toBeFocused();
  await expect(firstCheck).toBeHidden();
  await expect(
    details.getByRole("button", { name: "Back to checks", exact: false }),
  ).toBeInViewport();
  await details
    .getByRole("button", { name: "Back to checks", exact: false })
    .click();
  await expect(trigger).toBeFocused();
  await expect(details).toBeHidden();

  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const [view, endpoint, loading, falseEmpty] of [
    [
      "needs attention",
      "sla",
      "Loading response deadlines…",
      "No at-risk or overdue deadlines.",
    ],
    [
      "shadow & rollout",
      "shadow",
      "Loading experiments…",
      "No live rollout has been enabled.",
    ],
  ]) {
    const url = `**/v2/workspaces/${ws}/${endpoint}`;
    await page.route(url, async (route) => {
      // Keep background refreshes in the outage until the user actually clicks Retry.
      if (
        await page.evaluate(
          () => (window as any).__operationsRetryClicked === true,
        )
      )
        return route.fallback();
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Temporary test outage" }),
      });
    });
    await page.goto(`/?workspace=${ws}&view=${encodeURIComponent(view)}`);
    await expect(
      page.getByText("Temporary test outage", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText(loading, { exact: true })).toBeHidden();
    await expect(page.getByText(falseEmpty, { exact: true })).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Try again", exact: true }),
    ).toBeVisible();
    await page.evaluate(() => {
      document.addEventListener(
        "click",
        (event) => {
          if (
            (event.target as Element).closest("button")?.textContent ===
            "Try again"
          )
            (window as any).__operationsRetryClicked = true;
        },
        { capture: true },
      );
    });
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(
      page.getByText("Temporary test outage", { exact: true }),
    ).toBeHidden();
    await page.unroute(url);
    if (endpoint === "sla") {
      await expect(
        page.getByRole("heading", { name: "Response queue", exact: true }),
      ).toBeVisible();
      await page.route(url, (route) =>
        route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Temporary refresh outage" }),
        }),
      );
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect(page.getByText(/Showing results loaded at/)).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Response queue", exact: true }),
      ).toBeVisible();
      await expect(page.getByText(loading, { exact: true })).toBeHidden();
      await page.unroute(url);
      await page
        .getByRole("button", { name: "Try again", exact: true })
        .click();
      await expect(
        page.getByText("Temporary refresh outage", { exact: true }),
      ).toBeHidden();
    }
  }

  // Loading/error gating must not prevent the existing candidate draft hook
  // from restoring an unfinished form when the route mounts asynchronously.
  await page.goto(
    `/?workspace=${ws}&view=${encodeURIComponent("shadow & rollout")}`,
  );
  await page
    .getByText("Create an immutable candidate", { exact: true })
    .click();
  await page
    .getByLabel("Candidate name", { exact: true })
    .fill("Unsubmitted candidate draft");
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await page
    .getByRole("button", { name: "Shadow & rollout", exact: true })
    .click();
  await page
    .getByText("Create an immutable candidate", { exact: true })
    .click();
  await expect(page.getByLabel("Candidate name", { exact: true })).toHaveValue(
    "Unsubmitted candidate draft",
  );
  await page.getByLabel("Candidate name", { exact: true }).fill("");

  // Deterministic, read-only records exercise pagination and filtering without
  // creating hundreds of real jobs or audit events in the test workspace.
  const events = Array.from({ length: 45 }, (_, index) => ({
    id: `audit-navigation-${index}`,
    kind: index % 2 ? "settings.updated" : "knowledge.added",
    created_at: "2026-10-06T12:00:00.000Z",
    data: { source: `Audit source ${index}` },
  }));
  const auditUrl = `**/v2/workspaces/${ws}/audit`;
  await page.route(auditUrl, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ events }),
    }),
  );
  await page.goto(`/?workspace=${ws}&view=activity`);
  await page.getByRole("button", { name: /^Audit history/ }).click();
  await expect(page.locator(".activity-record")).toHaveCount(20);
  await expect(
    page.getByText("Showing 1–20 of 45", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(
    page.getByText("Showing 21–40 of 45", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Search activity", { exact: true })
    .fill("Audit source 44");
  await expect(page.locator(".activity-record")).toHaveCount(1);
  await expect(
    page.getByText("Showing 1–1 of 1", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  await page
    .getByLabel("Event type", { exact: true })
    .selectOption("settings.updated");
  await expect(
    page.getByText("Showing 1–20 of 22", { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.unroute(auditUrl);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await verifyCustomerDraftGuards(page, ws);
}

export async function verifyCustomerDraftGuards(page: Page, ws: string) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const root = `/v2/workspaces/${ws}/customers`;
  const response = await page.request.get(root);
  expect(response.ok()).toBe(true);
  const inventory = await response.json();
  // Deliberately use just one real customer as the fixture source. The second
  // profile exists only in intercepted GET responses; this works even when
  // the workspace has a single customer and never creates business records.
  const original = inventory.customers[0];
  expect(
    original,
    "The browser journey creates a customer before this helper",
  ).toBeTruthy();
  const copyId = `ui-audit-copy-${original.id}`;
  const copy = {
    ...original,
    id: copyId,
    name: "Navigation test customer",
    email: "navigation-test@example.test",
  };
  const listPattern = (url: URL) => url.pathname === root;
  const copyPattern = (url: URL) =>
    url.pathname === `${root}/${copyId}` ||
    url.pathname.startsWith(`${root}/${copyId}/`);
  await page.route(listPattern, (route) =>
    route.fulfill({
      json: { ...inventory, customers: [original, copy], total: 2 },
    }),
  );
  await page.route(copyPattern, async (route) => {
    expect(route.request().method()).toBe("GET");
    const upstream = await route.fetch({
      url: route
        .request()
        .url()
        .replace(`${root}/${copyId}`, `${root}/${original.id}`),
    });
    const data = await upstream.json();
    if (data.contact)
      data.contact = {
        ...data.contact,
        id: copyId,
        name: copy.name,
        email: copy.email,
      };
    await route.fulfill({ response: upstream, json: data });
  });
  try {
    await page.goto(`/?workspace=${ws}&view=activity`);
    await page.getByRole("button", { name: "Customers", exact: true }).click();
    const cards = page.locator(".customer-directory-card");
    await expect(cards.nth(1)).toBeVisible();
    await cards.first().click();
    await page
      .getByRole("tab", { name: "Customer notes", exact: true })
      .click();
    const note = page.getByLabel("Add a customer note", { exact: true });
    await note.fill("Unsaved customer note for navigation verification");
    const selectedUrl = page.url();
    let backPrompts = 0;
    const cancelBack = async (dialog: import("@playwright/test").Dialog) => {
      backPrompts += 1;
      await dialog.dismiss();
    };
    page.on("dialog", cancelBack);
    await page.evaluate(() => history.back());
    await expect.poll(() => backPrompts).toBe(1);
    await expect(page).toHaveURL(selectedUrl);
    await expect(note).toHaveValue(
      "Unsaved customer note for navigation verification",
    );
    page.off("dialog", cancelBack);
    await page.getByRole("tab", { name: "Conversations", exact: true }).click();
    await page
      .getByRole("tab", { name: "Customer notes", exact: true })
      .click();
    await expect(note).toHaveValue(
      "Unsaved customer note for navigation verification",
    );
    // Selecting the already-open profile must not prompt or discard its editor.
    let unexpectedDialog = false;
    const handleDialog = async (dialog: import("@playwright/test").Dialog) => {
      unexpectedDialog = true;
      await dialog.dismiss();
    };
    page.on("dialog", handleDialog);
    await cards.first().click();
    await expect(note).toHaveValue(
      "Unsaved customer note for navigation verification",
    );
    page.off("dialog", handleDialog);
    expect(unexpectedDialog).toBe(false);
    page.once("dialog", (dialog) => dialog.dismiss());
    await cards.nth(1).click();
    await expect(cards.first()).toHaveAttribute("aria-current", "true");
    await expect(note).toHaveValue(
      "Unsaved customer note for navigation verification",
    );
    page.once("dialog", (dialog) => dialog.accept());
    await cards.nth(1).click();
    await page
      .getByRole("tab", { name: "Linked accounts", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Edit account links", exact: true })
      .click();
    const userId = page.getByLabel("Verified portal user ID (optional)", {
      exact: true,
    });
    await userId.fill("unsaved-account-link");
    const editor = page.locator(".customer-account-editor");
    await editor
      .getByRole("button", { name: "+ Add account link", exact: true })
      .click();
    const rowNumber = await editor.locator(".account-link-editor-row").count();
    const provider = page.getByLabel(`Provider ${rowNumber}`, { exact: true });
    const account = page.getByLabel(`Account ID ${rowNumber}`, { exact: true });
    await provider.fill("audit_fixture");
    await account.fill("acct_pending");
    const mappingEndpoint = `**/v2/workspaces/${ws}/contacts/${copyId}/mapping`;
    let releaseSave!: () => void;
    const pendingSave = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    await page.route(mappingEndpoint, async (route) => {
      expect(route.request().method()).toBe("PUT");
      await pendingSave;
      await route.fulfill({
        status: 503,
        json: { error: "Account link save test failure" },
      });
    });
    try {
      await editor
        .getByRole("button", { name: "Save reviewed links", exact: true })
        .click();
      for (const control of await editor.locator("input, button").all())
        await expect(control).toBeDisabled();
      releaseSave();
      await expect(
        page
          .getByRole("alert")
          .filter({ hasText: "Account link save test failure" }),
      ).toBeVisible();
      await expect(userId).toBeEnabled();
      await expect(userId).toHaveValue("unsaved-account-link");
      await expect(provider).toHaveValue("audit_fixture");
      await expect(account).toHaveValue("acct_pending");
    } finally {
      releaseSave();
      await page.unroute(mappingEndpoint);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    page.once("dialog", (dialog) => dialog.dismiss());
    await page
      .getByRole("button", { name: "← All customers", exact: true })
      .click();
    await expect(userId).toHaveValue("unsaved-account-link");
    page.once("dialog", (dialog) => dialog.accept());
    await page
      .getByRole("button", { name: "← All customers", exact: true })
      .click();
    await expect(cards.nth(1)).toBeFocused();
    await page.setViewportSize({ width: 1440, height: 1000 });
  } finally {
    await page.unroute(listPattern);
    await page.unroute(copyPattern);
  }
}

export async function verifyPendingSettingsGuard(page: Page, ws: string) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/?workspace=${ws}&view=settings`);
  for (const [section, label, button, endpoint] of [
    [
      "Agent",
      "Agent instructions",
      "Save settings",
      `/v2/workspaces/${ws}/settings`,
    ],
    [
      "Workspace",
      "Workspace name",
      "Save workspace",
      `/v2/workspaces/${ws}/profile`,
    ],
    ["My profile", "Display name", "Save profile", "/v2/profile"],
  ]) {
    await page.getByRole("button", { name: section, exact: true }).click();
    const input = page.getByLabel(label, { exact: true });
    const original = await input.inputValue();
    const draft = "Pending save verification";
    const failure = `Pending ${section} save test failure`;
    await input.fill(draft);
    const form = input.locator("xpath=ancestor::form");
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pattern = (url: URL) => url.pathname === endpoint;
    await page.route(pattern, async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      await pending;
      await route.fulfill({
        status: 503,
        json: { error: failure },
      });
    });
    try {
      await page.getByRole("button", { name: button, exact: true }).click();
      await expect(input).toBeDisabled();
      for (const control of await form
        .locator("input[name]:not([readonly]), textarea[name], select[name]")
        .all())
        await expect(control).toBeDisabled();
      await expect(
        form.getByRole("button", { name: "Discard changes", exact: true }),
      ).toBeDisabled();
      release();
      await expect(page.getByText(failure, { exact: true })).toBeVisible();
      await expect(input).toBeEnabled();
      await expect(input).toHaveValue(draft);
      await expect(
        page.getByRole("button", { name: button, exact: true }),
      ).toBeEnabled();
      page.once("dialog", (dialog) => dialog.accept());
      await form
        .getByRole("button", { name: "Discard changes", exact: true })
        .click();
      await expect(input).toHaveValue(original);
    } finally {
      release();
      await page.unroute(pattern);
    }
  }
}

export async function verifyProfileRefreshDrafts(page: Page, ws: string) {
  await page.goto(`/?workspace=${ws}&view=settings&tab=profile`);
  const name = page.getByLabel("Display name", { exact: true });
  const password = page.getByLabel("Current password", { exact: true });
  const original = await name.inputValue();
  await name.fill("Profile draft during refresh");
  await password.fill("synthetic-unsaved-password");
  const endpoint = "**/api/auth/get-session";
  await page.route(endpoint, (route) =>
    route.fulfill({
      status: 503,
      json: { message: "Profile refresh test failure" },
    }),
  );
  try {
    await page
      .getByRole("button", { name: "Refresh sessions", exact: true })
      .click();
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "Profile refresh test failure" }),
    ).toBeVisible();
    await expect(name).toHaveValue("Profile draft during refresh");
    await expect(password).toHaveValue("synthetic-unsaved-password");
  } finally {
    await page.unroute(endpoint);
  }
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Profile refresh test failure" }),
  ).toBeHidden();
  await expect(name).toHaveValue("Profile draft during refresh");
  await expect(password).toHaveValue("synthetic-unsaved-password");
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(name).toHaveValue(original);
  await page
    .getByRole("button", { name: "Clear password fields", exact: true })
    .click();
  await expect(password).toHaveValue("");
  let unexpectedDialog = false;
  const cancel = async (dialog: import("@playwright/test").Dialog) => {
    unexpectedDialog = true;
    await dialog.dismiss();
  };
  page.on("dialog", cancel);
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  page.off("dialog", cancel);
  expect(unexpectedDialog).toBe(false);
  await expect(
    page.getByRole("heading", { name: "Activity", exact: true }),
  ).toBeVisible();
}
