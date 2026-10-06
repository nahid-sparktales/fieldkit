import { expect, type Page } from "@playwright/test";
import { createOTP } from "@better-auth/utils/otp";
import { base32 } from "@better-auth/utils/base32";

/** Real local auth, with only the disposable browser owner's factor and an unused custom role. */
export async function verifySecurityJourney(page: Page, ws: string) {
  const password = "correct-horse-battery-staple";
  const securityURL = `/?workspace=${ws}&view=security`;
  const name = `Browser reader ${Date.now()}`;
  await page.goto(securityURL);
  await expect(
    page.getByRole("heading", { name: "Security", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Verify your password for sensitive changes", { exact: true })
    .fill(password);
  await page
    .getByRole("button", { name: "Verify password", exact: true })
    .click();
  await expect(
    page.getByText("Password verified for five minutes.", { exact: true }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "New custom role", exact: true })
    .click();
  const role = page.locator("form.role-form");
  await role.getByLabel("Role name", { exact: true }).fill(name);
  await role
    .getByLabel("Role description", { exact: true })
    .fill("Read only synthetic browser role");
  await role
    .getByLabel("Ticket visibility", { exact: true })
    .selectOption("assigned");
  await role.getByLabel("tickets · read", { exact: true }).check();
  await role
    .getByRole("button", { name: "Save custom role", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: new RegExp(name) }),
  ).toBeVisible();
  await page.getByRole("button", { name: new RegExp(name) }).click();
  await expect(
    role.getByLabel("tickets · read", { exact: true }),
  ).toBeChecked();
  await expect(
    role.getByLabel("tickets · reply", { exact: true }),
  ).not.toBeChecked();
  await role.getByLabel("Role name", { exact: true }).fill(`${name} draft`);
  page.once("dialog", (dialog) => dialog.dismiss());
  await page
    .getByRole("button", { name: "New custom role", exact: true })
    .click();
  await expect(role.getByLabel("Role name", { exact: true })).toHaveValue(
    `${name} draft`,
  );
  await role.getByLabel("Role name", { exact: true }).fill(name);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/security-roles-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  page.once("dialog", (dialog) => dialog.accept());
  await role
    .getByRole("button", { name: "Delete unused role", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: new RegExp(name) }),
  ).toHaveCount(0);

  const account = page.locator("section.panel").filter({
    has: page.getByRole("heading", {
      name: "Your sign-in security",
      exact: true,
    }),
  });
  await account
    .getByLabel("Password to set up an authenticator", { exact: true })
    .fill(password);
  await account
    .getByRole("button", { name: "Set up authenticator", exact: true })
    .click();
  const setup = account.locator(".callout");
  await expect(
    setup.getByLabel("One-time recovery codes", { exact: true }),
  ).toBeVisible();
  const codes = (
    await setup
      .getByLabel("One-time recovery codes", { exact: true })
      .inputValue()
  ).split("\n");
  expect(codes.length).toBeGreaterThan(1);
  const uri = new URL(
    (await setup
      .getByRole("link", { name: "Open in authenticator app", exact: true })
      .getAttribute("href"))!,
  );
  const secret = Buffer.from(
    base32.decode(uri.searchParams.get("secret")!),
  ).toString();
  await setup
    .getByLabel("Authenticator code", { exact: true })
    .fill(await createOTP(secret).totp());
  await setup.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(account.getByText("Enabled", { exact: true })).toBeVisible();
  await setup
    .getByRole("button", {
      name: "I have stored my recovery codes",
      exact: true,
    })
    .click();
  await expect(
    account.getByLabel("One-time recovery codes", { exact: true }),
  ).toHaveCount(0);

  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome back", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-owner@example.test");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Confirm it’s you", exact: true }),
  ).toBeVisible();
  expect(
    (await page.request.get(`/v2/workspaces/${ws}/routing`)).status(),
  ).toBe(401);
  await page
    .getByRole("button", { name: "Use a recovery code", exact: true })
    .click();
  await page.getByLabel("Recovery code", { exact: true }).fill(codes[0]);
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Sign out", exact: true }),
  ).toBeVisible();
  await page.goto(securityURL);
  await expect(account.getByText("Enabled", { exact: true })).toBeVisible();
  await account
    .getByLabel("Verify your password for sensitive changes", { exact: true })
    .fill(password);
  await account
    .getByRole("button", { name: "Verify password", exact: true })
    .click();
  await expect(
    page.getByText("Password verified for five minutes.", { exact: true }),
  ).toBeVisible();
  await account
    .getByRole("button", {
      name: "Confirm authenticator or recovery code",
      exact: true,
    })
    .click();
  await account
    .getByRole("button", { name: "Use a recovery code", exact: true })
    .click();
  await account.getByLabel("Recovery code", { exact: true }).fill(codes[0]);
  await account.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(
    account
      .locator("form")
      .filter({ has: page.getByLabel("Recovery code", { exact: true }) })
      .getByRole("alert"),
  ).toContainText(/invalid.*code/i);
  await account.getByLabel("Recovery code", { exact: true }).fill(codes[1]);
  await account.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(
    account.getByLabel("Recovery code", { exact: true }),
  ).toHaveCount(0);
  await account
    .getByText("Recovery codes and factor removal", { exact: true })
    .click();
  await account
    .getByLabel("Password to remove authenticator", { exact: true })
    .fill(password);
  page.once("dialog", (dialog) => dialog.accept());
  await account
    .getByRole("button", { name: "Remove authenticator", exact: true })
    .click();
  await expect(
    account.getByText("Not enrolled", { exact: true }),
  ).toBeVisible();
}
