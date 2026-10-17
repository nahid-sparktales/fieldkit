import { expect, type Page } from "@playwright/test";
/** Signed-in workspace administrator. Uses only the isolated browser-test application. */
export async function automationJourney(page: Page, ws: string) {
  const name = `Follow-up review ${Date.now()}`;
  await page.goto(`/?workspace=${encodeURIComponent(ws)}&view=automations`);
  await expect(
    page.getByRole("heading", { name: "Automations", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Rule name", { exact: true }).fill(name);
  await page
    .getByLabel("Action 1 private note", { exact: true })
    .fill("Review this synthetic support request.");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(
    page.getByText("Draft saved. Preview it before activation.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Activate saved rule", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Preview matches", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Rule preview" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Activate saved rule", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Confirm rule activation" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Confirm activation", exact: true })
    .click();
  await expect(
    page.getByText("Rule activated for new matching events.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Disable rule", exact: true }).click();
  await expect(
    page.getByText("Rule disabled; pending work will be suppressed.", {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByLabel("Description", { exact: true })
    .fill("Draft should survive local tabs.");
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Execution history", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Rules", exact: true }).click();
  await expect(page.getByLabel("Description", { exact: true })).toHaveValue(
    "Draft should survive local tabs.",
  );
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "New rule", exact: true }).click();
  await expect(page.getByLabel("Rule name", { exact: true })).toHaveValue(name);
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(
    page.getByText("Draft saved. Preview it before activation.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByLabel("Trigger type", { exact: true })
    .selectOption("inactivity");
  await page
    .getByLabel("Start timer from", { exact: true })
    .selectOption("waiting");
  await page.getByLabel("Wait minutes", { exact: true }).fill("1440");
  await page
    .getByLabel("Action 1 type", { exact: true })
    .selectOption("resolve");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(
    page.getByText("Draft saved. Preview it before activation.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(
    page.getByRole("button", { name: "Activate saved rule", exact: true }),
  ).toBeDisabled();
  await page.setViewportSize({ width: 1440, height: 1000 });
}
