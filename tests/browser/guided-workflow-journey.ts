import { expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

async function exportDraft(page: Page) {
  const portability = page.locator("details").filter({
    has: page.locator(":scope > summary", {
      hasText: "Templates and portability",
    }),
  });
  if (!(await portability.evaluate((el) => (el as HTMLDetailsElement).open)))
    await portability.locator("summary").click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON", exact: true }).click();
  return JSON.parse(await readFile((await (await download).path())!, "utf8"));
}

export async function verifyGuidedWorkflow(page: Page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Workflow", exact: true }).click();
  await page
    .getByLabel("Channel workflow", { exact: true })
    .selectOption("default");
  const original = await exportDraft(page);
  expect(original.nodes.some((n: any) => n.type === "custom")).toBe(true);
  expect(original.nodes.some((n: any) => n.type === "subflow")).toBe(true);
  await page.getByRole("button", { name: "Guided steps", exact: true }).click();
  await expect(
    page.getByRole("list", { name: "Workflow steps", exact: true }),
  ).toBeVisible();
  expect(await exportDraft(page)).toEqual(original);
  await page.getByRole("button", { name: "Visual graph", exact: true }).click();
  expect(await exportDraft(page)).toEqual(original);
  await page.getByRole("button", { name: "Guided steps", exact: true }).click();

  // Template changes remain drafts, with a cancellable confirmation and Undo.
  const templates = page.locator(".wf-template-picker");
  await templates.locator("summary").click();
  page.once("dialog", (d) => d.dismiss());
  await templates.getByRole("button", { name: /^Send to your team/ }).click();
  expect(await exportDraft(page)).toEqual(original);
  page.once("dialog", (d) => d.accept());
  await templates.getByRole("button", { name: /^Send to your team/ }).click();
  await expect(page.locator(".wf-step-card")).toHaveCount(2);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await exportDraft(page)).toEqual(original);

  // Build a separate channel workflow using only guided controls.
  await page
    .getByLabel("Channel workflow", { exact: true })
    .selectOption("zendesk");
  await expect(
    page.getByRole("button", { name: "Guided steps", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await templates.locator("summary").click();
  page.once("dialog", (d) => d.accept());
  await templates.getByRole("button", { name: /^Send a saved reply/ }).click();
  await page
    .getByLabel("Customer reply", { exact: true })
    .fill("Thanks for reaching out. Your ticket is with our team.");
  await page
    .getByRole("button", { name: "Edit Incoming conversation", exact: true })
    .click();
  await page.locator(".wf-insert-step summary").click();
  await page
    .getByLabel("New step for next", { exact: true })
    .selectOption("condition");
  await page.getByRole("button", { name: "Insert step", exact: true }).click();
  await page
    .getByLabel("Step name", { exact: true })
    .fill("Is this a Zendesk ticket?");
  await page.getByLabel("Condition", { exact: true }).selectOption("channel");
  await page.getByLabel("Channel", { exact: true }).selectOption("zendesk");
  await expect(
    page.getByLabel("If the condition matches", { exact: true }),
  ).toHaveValue("reply");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(
    page.getByText("Draft saved. Publish it to use it for new conversations."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Publish workflow", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText(
      "Connect Is this a Zendesk ticket? → no to exactly one step.",
      { exact: true },
    ),
  ).toBeVisible();
  const otherwise = page
    .locator(".wf-route-setting")
    .filter({ has: page.getByLabel("Otherwise", { exact: true }) });
  await otherwise.locator("summary").click();
  await page
    .getByLabel("New step for no", { exact: true })
    .selectOption("handoff");
  await otherwise
    .getByRole("button", { name: "Insert step", exact: true })
    .click();
  await page
    .getByLabel("Customer handoff message")
    .fill("A teammate will help with this question.");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await page
    .getByRole("button", { name: "Publish workflow", exact: true })
    .click();
  await expect(page.getByText(/^Published version \d+$/)).toBeVisible();
  await page
    .getByLabel("Test question", { exact: true })
    .fill("Can you help me?");
  await page
    .getByRole("button", { name: "Test workflow", exact: true })
    .click();
  await expect(page.getByLabel("Workflow test result")).toContainText(
    "Thanks for reaching out. Your ticket is with our team.",
  );
  await page.getByLabel("Test channel", { exact: true }).selectOption("portal");
  await page
    .getByRole("button", { name: "Test workflow", exact: true })
    .click();
  await expect(page.getByLabel("Workflow test result")).toContainText(
    "A teammate will help with this question.",
  );

  // Editing both views keeps the same shared draft and survives reload after save.
  await page.getByRole("button", { name: "Visual graph", exact: true }).click();
  await page.getByLabel("Selected step").selectOption("reply");
  await expect(page.getByLabel("Customer reply", { exact: true })).toHaveValue(
    "Thanks for reaching out. Your ticket is with our team.",
  );
  await page.getByRole("button", { name: "Guided steps", exact: true }).click();
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Edit Is this a Zendesk ticket?",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "Expand editor ⤢", exact: true })
    .click();
  const editor = page.getByRole("dialog", { name: "Saved reply", exact: true });
  await expect(
    editor.getByLabel("If the condition matches", { exact: true }),
  ).toHaveValue("reply");
  await page.screenshot({
    path: "test-results/workflow-guided-desktop.png",
    animations: "disabled",
  });
  await editor
    .getByRole("button", { name: "Close expanded editor", exact: true })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Expand editor ⤢", exact: true })
    .click();
  await expect(
    editor.getByRole("list", { name: "Workflow steps", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/workflow-guided-mobile.png",
    animations: "disabled",
  });
  await editor
    .getByRole("button", {
      name: "Edit Is this a Zendesk ticket?",
      exact: true,
    })
    .click();
  await expect(editor.getByLabel("Step name", { exact: true })).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/workflow-guided-mobile-settings.png",
    animations: "disabled",
  });
  await editor
    .getByRole("button", { name: "Back to steps", exact: true })
    .click();
  await expect(
    editor.getByRole("button", { name: "Show step settings", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(editor).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
}
