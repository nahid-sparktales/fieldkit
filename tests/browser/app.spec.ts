import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("real onboarding, knowledge review, portal conversation, and human takeover", async ({
  page,
  browser,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Create an account", exact: true })
    .click();
  await page.getByLabel("Name", { exact: true }).fill("Test owner");
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-owner@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("correct-horse-battery-staple");
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await expect(
    page.getByText("Check your email to verify your account."),
  ).toBeVisible();
  const email = await readFile(
    ".fieldkit/browser/browser_owner_example_test.txt",
    "utf8",
  );
  await page.goto(email.match(/https?:\/\/\S+/)![0]);
  await page.goto("/");
  if (await page.getByRole("heading", { name: "Welcome back" }).isVisible()) {
    await page
      .getByLabel("Email", { exact: true })
      .fill("browser-owner@example.test");
    await page
      .getByLabel("Password", { exact: true })
      .fill("correct-horse-battery-staple");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }
  await expect(
    page.getByRole("heading", { name: "A home for your support." }),
  ).toBeVisible();
  await page.getByLabel("Business name").fill("Northstar Workshop");
  await page.getByLabel("Portal address").fill("northstar-workshop");
  await page
    .getByLabel("Installation setup token")
    .fill(await readFile(".fieldkit/browser/setup-token", "utf8"));
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(
    page.getByRole("heading", {
      name: "A thoughtful start to better support.",
    }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/workspace.png", fullPage: true });
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await page
    .getByLabel("API key", { exact: true })
    .fill("test-key-placeholder");
  await page.getByRole("button", { name: "Verify & connect" }).click();
  await expect(page.getByText("Connection verified and saved.")).toBeVisible();
  await page.getByRole("button", { name: "Knowledge", exact: true }).click();
  await page.locator("input[type=file]").setInputFiles({
    name: "returns.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(
      "Unused items can be returned within 30 days. Contact our team for help.",
    ),
  });
  await expect(async () => {
    await page.getByRole("button", { name: "Refresh status" }).click();
    await expect(
      page.locator("td").getByText("ready", { exact: true }),
    ).toBeVisible();
  }).toPass({ timeout: 20000 });
  await page.getByLabel("Audience for returns.txt").selectOption("customer");
  await page
    .getByRole("button", { name: "Publish article", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Unpublish article", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/knowledge.png", fullPage: true });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Reply behavior").selectOption("automatic");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Workspace settings saved.")).toBeVisible();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const portal = page.locator("section.panel").filter({
    has: page.getByRole("heading", { name: "Support portal", exact: true }),
  });
  await portal.getByLabel("Publish this channel").check();
  await portal.getByRole("button", { name: "Save channel" }).click();
  await expect(portal.getByText("published", { exact: true })).toBeVisible();
  const customerContext = await browser.newContext(),
    customer = await customerContext.newPage();
  await customer.goto("http://127.0.0.1:4351/support/northstar-workshop");
  await expect(
    customer.getByRole("heading", { name: "How can we help?" }).first(),
  ).toBeVisible();
  await expect(
    customer.getByRole("heading", { name: "returns.txt" }),
  ).toBeVisible();
  await customer
    .getByRole("button", { name: "Sign in / Create account" })
    .click();
  await customer
    .getByRole("button", { name: "Create an account", exact: true })
    .click();
  await customer.getByLabel("Name", { exact: true }).fill("A real customer");
  await customer
    .getByLabel("Email", { exact: true })
    .fill("browser-customer@example.test");
  await customer
    .getByLabel("Password", { exact: true })
    .fill("correct-horse-battery-staple");
  await customer
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await expect(
    customer.getByText("Check your email to verify your account."),
  ).toBeVisible();
  const customerEmail = await readFile(
    ".fieldkit/browser/browser_customer_example_test.txt",
    "utf8",
  );
  await customer.goto(customerEmail.match(/https?:\/\/\S+/)![0]);
  await customer.goto("http://127.0.0.1:4351/support/northstar-workshop");
  await expect(customer.getByText("Your support account")).toBeVisible();
  await customer.getByLabel("Your message").fill("What is your return policy?");
  await customer.getByRole("button", { name: "Send →" }).click();
  await expect(
    customer.getByText("You can return an unused item within 30 days."),
  ).toBeVisible({ timeout: 20000 });
  await expect(
    customer.getByRole("heading", { name: "Your tickets" }),
  ).toBeVisible();
  await customer.screenshot({
    path: "test-results/portal.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Inbox", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "What is your return policy?" }).last(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Take over", exact: true }).click();
  await expect(page.getByText("human takeover", { exact: true })).toBeVisible();
  await page
    .getByLabel("Reply", { exact: true })
    .fill("I’m here to help with your return.");
  await page.getByRole("button", { name: "Send reply" }).click();
  await expect(
    customer.getByText("I’m here to help with your return."),
  ).toBeVisible({ timeout: 10000 });
  await page.screenshot({ path: "test-results/inbox.png", fullPage: true });
  await customer.reload();
  await expect(
    customer.getByRole("button", { name: /What is your return policy/ }),
  ).toBeVisible();
  await customer
    .getByRole("button", { name: /What is your return policy/ })
    .click();
  await expect(
    customer.getByText("I’m here to help with your return."),
  ).toBeVisible();
  await customer.setViewportSize({ width: 390, height: 844 });
  await customer.screenshot({
    path: "test-results/mobile.png",
    fullPage: true,
  });
  expect(
    await customer.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  await customerContext.close();
});
