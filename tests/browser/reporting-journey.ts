import { expect, type Page } from "@playwright/test";
/** Disposable local workspace only. The schedule stays paused; no external delivery is requested. */
export async function verifyReportingJourney(page: Page, ws: string) {
  const name = `Support dashboard ${Date.now().toString(36)}`;
  await page.goto(`/?workspace=${ws}&view=dashboards`);
  await expect(
    page.getByRole("heading", { name: "Dashboards", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "New dashboard", exact: true })
    .click();
  await expect(page.locator(".report-kpi")).toHaveCount(4);
  await expect
    .poll(() =>
      page
        .locator(".report-widget:has(.report-kpi) .report-widget-body")
        .evaluateAll((elements) =>
          elements.every(
            (element) => element.scrollHeight <= element.clientHeight + 1,
          ),
        ),
    )
    .toBe(true);
  await page.screenshot({
    path: ".fieldkit/reporting-overview-desktop.png",
    fullPage: true,
  });
  await page.getByLabel("Dashboard name", { exact: true }).fill(name);
  await page
    .getByLabel("Visibility", { exact: true })
    .selectOption("workspace");
  for (const [type, title] of [
    ["bar", "Tickets by status"],
    ["stacked_bar", "Channel mix by status"],
    ["table", "Ticket totals table"],
  ]) {
    await page.getByRole("button", { name: "Add widget", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Widget title", { exact: true }).fill(title);
    await dialog.getByLabel("Chart type", { exact: true }).selectOption(type);
    await dialog.getByLabel("Group by", { exact: true }).selectOption("status");
    if (type === "stacked_bar")
      await dialog
        .getByLabel("Series", { exact: true })
        .selectOption("channel");
    if (type === "bar") {
      await dialog.getByText(/Additional filters ·/).click();
      await dialog
        .getByLabel("Additional Channels", { exact: true })
        .selectOption("portal");
      await dialog.getByText(/Widget filter overrides/).click();
      await dialog
        .getByLabel("Date range", { exact: true })
        .selectOption("last7");
    }
    await dialog
      .getByRole("button", { name: "Apply widget", exact: true })
      .click();
  }
  const widget = page.getByRole("region", {
      name: "Conversation volume",
      exact: true,
    }),
    handle = widget.getByRole("button", {
      name: /^Move Conversation volume\./,
    });
  const before = await widget.getAttribute("style");
  await handle.focus();
  await handle.press("ArrowRight");
  await handle.press("Shift+ArrowDown");
  await expect(widget).not.toHaveAttribute("style", before!);
  const box = await handle.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      box.x + box.width / 2 + 100,
      box.y + box.height / 2 + 48,
      { steps: 5 },
    );
    await page.mouse.up();
  }
  await page
    .getByRole("button", { name: "Save dashboard", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Edit dashboard", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  const id = new URL(page.url()).searchParams.get("dashboard")!;
  const saved = await (
    await page.request.get(`/v2/workspaces/${ws}/dashboards/${id}`)
  ).json();
  expect(saved.definition.widgets).toHaveLength(9);
  expect(new Set(saved.definition.widgets.map((w: any) => w.type)).size).toBe(
    6,
  );
  const restricted = saved.definition.widgets.find(
    (w: any) => w.title === "Tickets by status",
  );
  expect(restricted.restrictions.channels).toEqual(["portal"]);
  expect(restricted.overrides.period).toBe("last7");
  await page.reload();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(
    page.getByText("Additional filters: Channels", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "View records for Conversation volume",
      exact: true,
    })
    .click();
  await expect(page.getByRole("dialog")).toContainText("matching records");
  await page
    .getByRole("button", { name: "Close preview", exact: true })
    .click();
  await page.screenshot({
    path: ".fieldkit/reporting-desktop.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Export Conversation volume", exact: true })
    .click();
  await page.getByLabel("Maximum exported rows", { exact: true }).fill("10");
  await page
    .getByRole("button", { name: "Create CSV export", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Recent reports & exports",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Download CSV", exact: true }).first(),
  ).toBeVisible({ timeout: 60000 });
  await page.getByRole("button", { name: "Schedules", exact: true }).click();
  await page
    .getByRole("button", { name: "Schedule this dashboard", exact: true })
    .click();
  await page.getByLabel("Frequency", { exact: true }).selectOption("daily");
  await page.getByLabel("Time zone", { exact: true }).fill("UTC");
  await page.getByLabel("Schedule enabled", { exact: true }).uncheck();
  await page
    .getByRole("button", { name: "Save schedule", exact: true })
    .click();
  await expect(
    page
      .locator(".report-schedules .report-library-row")
      .filter({ hasText: name }),
  ).toContainText("Paused");
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({
    path: ".fieldkit/reporting-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
}
