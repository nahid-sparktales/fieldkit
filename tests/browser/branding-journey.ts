import { expect, type Page } from "@playwright/test";

export async function customizeHelpCenter(page: Page) {
  await page
    .getByRole("button", { name: "Open my profile", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your profile", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Display name", { exact: true })
    .fill("Northstar owner");
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Profile saved.");
  await expect(
    page.getByRole("button", { name: "Open my profile" }),
  ).toContainText("Northstar owner");
  await expect(
    page.getByLabel("Email address", { exact: true }),
  ).toHaveAttribute("readonly");
  await expect(page.getByText("This session", { exact: true })).toBeVisible();
  await page.route(
    "**/api/auth/list-sessions",
    (route) =>
      route.fulfill({
        status: 403,
        json: { code: "SESSION_NOT_FRESH", message: "Session is not fresh" },
      }),
    { times: 1 },
  );
  await page
    .getByRole("button", { name: "Refresh sessions", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Unlock session management",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(
    "Northstar owner",
  );
  await page
    .getByRole("button", { name: "Refresh sessions", exact: true })
    .click();
  await expect(page.getByText("This session", { exact: true })).toBeVisible();
  await page
    .getByLabel("Current password", { exact: true })
    .fill("test-only-placeholder");
  await page
    .getByLabel("New password", { exact: true })
    .fill("test-only-password-one");
  await page
    .getByLabel("Confirm new password", { exact: true })
    .fill("test-only-password-two");
  await page
    .getByRole("button", { name: "Change password", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveText(
    "The new passwords do not match.",
  );
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await page
    .getByLabel("Workspace name", { exact: true })
    .fill("Northstar Support");
  await page
    .getByRole("button", { name: "Save workspace", exact: true })
    .click();
  await expect(page.getByRole("status")).toHaveText("Workspace name saved.");
  await expect(
    page.getByLabel("Help center address", { exact: true }),
  ).toHaveValue(/\/support\/northstar-workshop$/);
  await expect(
    page.getByRole("combobox", { name: "Workspace", exact: true }),
  ).toContainText("Northstar Support");
  await page
    .getByRole("button", { name: "Customize help center →", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Make your help center yours" }),
  ).toBeVisible();
  await page
    .getByLabel("Help center name", { exact: true })
    .fill("Northstar Help");
  await page
    .getByLabel("Welcome heading", { exact: true })
    .fill("Hello from Northstar");
  await page
    .getByLabel("Welcome description", { exact: true })
    .fill("Practical answers for every step of your journey.");
  await page
    .getByLabel("Company website", { exact: true })
    .fill("https://example.com");
  await page
    .getByLabel("Privacy policy URL", { exact: true })
    .fill("https://example.com/privacy");
  await page
    .getByLabel("Terms of service URL", { exact: true })
    .fill("https://example.com/terms");
  await page
    .getByLabel("Footer text", { exact: true })
    .fill("Made for the Northstar community.");
  await page.getByRole("button", { name: "Ocean", exact: true }).click();
  await page
    .getByLabel("Upload logo", { exact: true })
    .setInputFiles("tests/fixtures/logo.png");
  await expect(
    page.getByRole("img", { name: "Logo preview", exact: true }),
  ).toBeVisible();
  const preview = page.getByRole("region", { name: "Help center preview" });
  await expect(preview.locator("h1")).toHaveText("Hello from Northstar");
  await expect(preview.locator(".portal-hero")).toHaveCSS(
    "background-color",
    "rgb(234, 241, 255)",
  );
  await page
    .getByRole("button", { name: "Save appearance", exact: true })
    .click();
  await expect(page.getByRole("status")).toHaveText(
    "Appearance saved. Your published channels now use this design.",
  );
  await expect(
    page.getByRole("button", { name: "Save appearance", exact: true }),
  ).toBeDisabled();
  await page.reload();
  await expect(
    page.getByLabel("Help center name", { exact: true }),
  ).toHaveValue("Northstar Help");
  await expect(
    page.getByRole("img", { name: "Logo preview", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/appearance-desktop.png",
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel("Welcome heading", { exact: true })).toHaveValue(
    "Hello from Northstar",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await preview.getByRole("button", { name: "Mobile", exact: true }).click();
  await preview.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "test-results/appearance-mobile.png",
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Channels", exact: true }).click();
}

export async function verifyBrandedPortal(page: Page) {
  await expect(page).toHaveTitle("Northstar Help · Help center");
  const logo = page.getByRole("img", {
    name: "Northstar Help logo",
    exact: true,
  });
  await expect(logo).toBeVisible();
  await expect
    .poll(() =>
      logo.evaluate((image) => (image as HTMLImageElement).naturalWidth),
    )
    .toBe(48);
  await expect(
    page.getByRole("link", { name: "Privacy policy", exact: true }),
  ).toHaveAttribute("href", "https://example.com/privacy");
  await expect(
    page.getByRole("link", { name: "Terms of service", exact: true }),
  ).toHaveAttribute("href", "https://example.com/terms");
  await expect(
    page.getByRole("link", { name: "Visit website ↗", exact: true }),
  ).toHaveAttribute("href", "https://example.com");
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute(
    "href",
    /\/appearance\/logo/,
  );
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
    "href",
    /\/appearance\/logo/,
  );
  await expect(page.locator(".portal-hero")).toHaveCSS(
    "background-color",
    "rgb(234, 241, 255)",
  );
  await page.screenshot({
    path: "test-results/branded-portal.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/branded-portal-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
}

export async function verifyBrandedWidget(staff: Page, widgetPage: Page) {
  const channel = staff.locator("section.panel").filter({
    has: staff.getByRole("heading", {
      name: "Embedded chatbot",
      exact: true,
    }),
  });
  await staff.getByRole("radio", { name: /Tickets & chatbot/ }).check();
  await staff
    .getByRole("button", { name: "Save support options", exact: true })
    .click();
  await expect(channel.getByText("published", { exact: true })).toBeVisible();
  await staff.getByRole("button", { name: "Appearance", exact: true }).click();
  await staff.getByRole("button", { name: "Midnight", exact: true }).click();
  await staff
    .getByRole("button", { name: "Save appearance", exact: true })
    .click();
  await expect(staff.getByRole("status")).toContainText("Appearance saved.");
  await widgetPage.goto("http://127.0.0.1:4351/widget/northstar-workshop");
  await expect(
    widgetPage.getByRole("img", { name: "Northstar Help logo", exact: true }),
  ).toBeVisible();
  await expect(
    widgetPage.getByRole("button", { name: "Send", exact: true }),
  ).toHaveCSS("background-color", "rgb(185, 201, 255)");
  await expect(
    widgetPage.getByRole("button", { name: "Send", exact: true }),
  ).toHaveCSS("color", "rgb(0, 0, 0)");
  await expect(widgetPage.locator(".live-chat")).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
  await staff.getByRole("button", { name: "Ocean", exact: true }).click();
  await staff
    .getByRole("button", { name: "Save appearance", exact: true })
    .click();
  await expect(staff.getByRole("status")).toContainText("Appearance saved.");
}
