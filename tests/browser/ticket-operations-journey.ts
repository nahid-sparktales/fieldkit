import { expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
export async function verifyTicketOperations(
  page: Page,
  customer: Page,
  ws: string,
) {
  const create = async (subject: string) => {
    const r = await customer.request.post(
      `/v2/workspaces/${ws}/conversations`,
      {
        headers: { Origin: "http://127.0.0.1:4351" },
        data: {
          subject,
          body: "Please connect me with a support person",
          requestKey: randomUUID(),
        },
      },
    );
    expect(r.status()).toBe(202);
    const c = await r.json();
    const control = await page.request.post(
      `/v2/workspaces/${ws}/conversations/${c.id}/control`,
      { headers: { Origin: "http://127.0.0.1:4351" }, data: { mode: "human" } },
    );
    expect(control.ok()).toBe(true);
    return c;
  };
  const source = await create("Duplicate operations fixture"),
    target = await create("Keep operations fixture");
  await page.goto(`/?workspace=${ws}&view=inbox&conversation=${source.id}`);
  const reply = page.getByLabel("Reply", { exact: true });
  await expect(reply).toBeVisible();
  await reply.fill("Draft preserved during selection");
  const queue = page.getByRole("region", { name: "Conversation queue" });
  await queue
    .getByRole("button", { name: "Select tickets", exact: true })
    .click();
  await queue.getByLabel(`Select ${source.subject}`, { exact: true }).check();
  await queue.getByLabel(`Select ${target.subject}`, { exact: true }).check();
  const bar = page.getByRole("region", { name: "Bulk ticket actions" });
  await bar.getByLabel("Bulk action", { exact: true }).selectOption("priority");
  await bar.getByLabel("Bulk priority", { exact: true }).selectOption("high");
  await bar.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(bar.getByText("2 of 2 updated.", { exact: true })).toBeVisible();
  await expect(reply).toHaveValue("Draft preserved during selection");
  await bar
    .getByRole("button", { name: "Clear selection", exact: true })
    .click();
  await queue
    .getByRole("button", { name: "Done selecting", exact: true })
    .click();
  const created = await customer.request.post(
    `/v2/workspaces/${ws}/conversations/${source.id}/messages`,
    {
      headers: { Origin: "http://127.0.0.1:4351" },
      data: { body: "Additional public details", requestKey: randomUUID() },
    },
  );
  expect(created.status()).toBe(201);
  await expect(
    page.getByText("A public message arrived while you were drafting.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Send reply", exact: true }),
  ).toBeDisabled();
  await expect(reply).toHaveValue("Draft preserved during selection");
  await page
    .getByRole("button", { name: "I reviewed the new activity", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Send reply", exact: true }),
  ).toBeEnabled();
  await reply.fill("");
  await page.getByRole("tab", { name: /Activity & tools/ }).click();
  await page
    .getByRole("button", { name: "Merge duplicate ticket", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Keep this ticket", exact: true })
    .selectOption(target.id);
  let previewArrived!: () => void, releasePreview!: () => void;
  const previewPending = new Promise<void>((resolve) => {
      previewArrived = resolve;
    }),
    previewReleased = new Promise<void>((resolve) => {
      releasePreview = resolve;
    }),
    previewPath = `**/v2/workspaces/${ws}/conversations/${source.id}/merge-preview`;
  await page.route(
    previewPath,
    async (route) => {
      const response = await route.fetch();
      previewArrived();
      await previewReleased;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  await page
    .getByRole("button", { name: "Preview merge", exact: true })
    .click();
  await previewPending;
  try {
    await expect(
      page.getByRole("combobox", { name: "Keep this ticket", exact: true }),
    ).toBeDisabled();
  } finally {
    releasePreview();
  }
  await expect(
    page.getByText(/messages from “Duplicate operations fixture”/),
  ).toBeVisible();
  await page
    .getByLabel(
      "I reviewed the target and understand this merge cannot be undone.",
    )
    .check();
  await page
    .getByRole("button", { name: "Merge into selected ticket", exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: "Selected conversation" })
      .getByRole("heading", { name: target.subject, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(`From ticket #${source.id.slice(0, 8)}`).first(),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/ticket-operations-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
}
