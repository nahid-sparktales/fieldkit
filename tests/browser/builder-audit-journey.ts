import { expect, type Page, type Route } from "@playwright/test";

// Deterministic editor regressions: all suite writes are intercepted and no test run is launched.
export async function verifyBuilderAudit(page: Page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  let savedSuite: Record<string, any> = {
    id: "audit-suite",
    name: "Audit scenarios",
    revision: 4,
    cases: [
      {
        id: "returns",
        name: "Returns question",
        channel: "portal",
        fixtures: {},
        turns: [{ question: "Can I return this?", expected: {} }],
      },
      {
        id: "refund",
        name: "Partial refund",
        channel: "portal",
        fixtures: {},
        turns: [
          {
            question: "Refund twenty dollars",
            expected: {
              actionName: "refund_payment",
              parameters: { amountMinor: 2000, currency: "usd" },
            },
          },
        ],
      },
    ],
  };
  let rejectSave = true;
  let pendingSave: Promise<void> | undefined;
  const list = async (route: Route) => route.fulfill({ json: [savedSuite] });
  const save = async (route: Route) => {
    if (pendingSave) await pendingSave;
    if (rejectSave)
      return route.fulfill({
        status: 503,
        json: { error: "Could not save audit suite" },
      });
    savedSuite = {
      ...route.request().postDataJSON(),
      id: savedSuite.id,
      revision: savedSuite.revision + 1,
    };
    await route.fulfill({ json: savedSuite });
  };
  await page.route("**/evaluation/suites", list);
  await page.route("**/evaluation/suites/audit-suite", save);
  try {
    await page.getByRole("button", { name: "Test Lab", exact: true }).click();
    await page.getByRole("button", { name: /Audit scenarios/ }).click();
    await page
      .getByText("Exact route, citation and action checks", { exact: true })
      .click();
    const parameters = page.getByLabel("Exact action parameters", {
      exact: true,
    });
    await expect(parameters).toHaveValue("{}");
    await page.getByLabel("Case", { exact: true }).selectOption("1");
    await expect(parameters).toHaveValue(/"amountMinor": 2000/);
    await parameters.fill("{invalid");
    await expect(parameters).toHaveAttribute("aria-invalid", "true");
    await page.getByLabel("Case", { exact: true }).selectOption("0");
    await expect(parameters).toHaveValue("{}");
    await expect(parameters).toHaveAttribute("aria-invalid", "false");
    await page.getByLabel("Case", { exact: true }).selectOption("1");
    await expect(parameters).toHaveValue("{invalid");
    await expect(parameters).toHaveAttribute("aria-invalid", "true");
    await page.getByRole("button", { name: "Run setup", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Launch test run", exact: true }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "Results", exact: true }).click();
    await page.getByRole("button", { name: "Cases", exact: true }).click();
    await expect(parameters).toHaveValue("{invalid");
    await parameters.fill('{"amountMinor": 2000, "currency": "usd"}');
    await page
      .getByLabel("Suite name", { exact: true })
      .fill("Edited audit scenarios");
    await page.getByRole("button", { name: /^Audit scenarios/ }).click();
    await expect(page.getByLabel("Suite name", { exact: true })).toHaveValue(
      "Edited audit scenarios",
    );
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.getByRole("button", { name: "New suite", exact: true }).click();
    await expect(page.getByLabel("Suite name", { exact: true })).toHaveValue(
      "Edited audit scenarios",
    );
    await page.getByRole("button", { name: "Save suite", exact: true }).click();
    await expect(
      page.locator(".quality-page [role=alert]").first(),
    ).toContainText("Could not save audit suite");
    await expect(page.getByLabel("Suite name", { exact: true })).toHaveValue(
      "Edited audit scenarios",
    );
    await page.getByRole("button", { name: "Run setup", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Launch test run", exact: true }),
    ).toBeDisabled();
    rejectSave = false;
    let releaseSave!: () => void;
    pendingSave = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    await page.getByRole("button", { name: "Save suite", exact: true }).click();
    try {
      await expect(
        page.getByRole("button", { name: "New suite", exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByRole("button", { name: /^Audit scenarios/ }),
      ).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "Discard changes", exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "Cases", exact: true }),
      ).toBeEnabled();
    } finally {
      releaseSave();
    }
    await expect(page.getByText("Suite saved.", { exact: true })).toBeVisible();
    await expect(
      page.getByText(/Ready to run Edited audit scenarios · saved revision 5/),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Launch test run", exact: true }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Cases", exact: true }).click();
    await expect(page.getByLabel("Case", { exact: true })).toHaveValue("1");

    // Component changes remain local until explicitly saved or discarded.
    await page.getByRole("button", { name: "Workflow", exact: true }).click();
    const library = page.locator(".wf-library");
    await library.locator(":scope > summary").click();
    await page
      .getByRole("button", { name: "New Python step", exact: true })
      .click();
    await page
      .getByLabel("Component name", { exact: true })
      .fill("Keep this draft");
    page.once("dialog", (dialog) => dialog.dismiss());
    await page
      .getByRole("button", { name: "New API step", exact: true })
      .click();
    await expect(
      page.getByLabel("Component name", { exact: true }),
    ).toHaveValue("Keep this draft");
    page.once("dialog", (dialog) => dialog.dismiss());
    await page
      .getByRole("button", { name: "Close component editor", exact: true })
      .click();
    await expect(
      page.getByLabel("Component name", { exact: true }),
    ).toHaveValue("Keep this draft");
    let releaseComponentSave!: () => void;
    const pendingComponentSave = new Promise<void>((resolve) => {
      releaseComponentSave = resolve;
    });
    const componentSave = async (route: Route) => {
      await pendingComponentSave;
      await route.fulfill({
        status: 503,
        json: { error: "Component save unavailable" },
      });
    };
    await page.route("**/workflow/components", componentSave);
    await page
      .getByRole("button", { name: "Save component version", exact: true })
      .click();
    try {
      await expect(
        page.getByRole("button", { name: "New API step", exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "New Python step", exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "New subflow", exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByRole("button", {
          name: "Close component editor",
          exact: true,
        }),
      ).toBeDisabled();
    } finally {
      releaseComponentSave();
    }
    await expect(library.getByRole("alert")).toContainText(
      "Component save unavailable",
    );
    await expect(
      page.getByLabel("Component name", { exact: true }),
    ).toHaveValue("Keep this draft");
    await page.unroute("**/workflow/components", componentSave);
    page.once("dialog", (dialog) => dialog.accept());
    await page
      .getByRole("button", { name: "Close component editor", exact: true })
      .click();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() =>
      localStorage.removeItem("fieldkit.workflow.editor"),
    );
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Guided steps", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page
      .getByRole("button", { name: "Visual graph", exact: true })
      .click();
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Visual graph", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    const connector = page.locator(".wf-input").first();
    const outcome = page.locator(".wf-ports button").first();
    expect((await connector.boundingBox())!.width).toBeGreaterThanOrEqual(44);
    expect((await connector.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await outcome.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.getByRole("button", { name: "Zoom out", exact: true }).click();
    await expect(connector).toBeDisabled();
    await expect(outcome).toBeDisabled();
    await expect(page.getByText(/Overview: use Step settings/)).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 1000 });
  } finally {
    await page.unroute("**/evaluation/suites", list);
    await page.unroute("**/evaluation/suites/audit-suite", save);
  }
}
