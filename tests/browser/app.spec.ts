import { test, expect } from "@playwright/test";
import { verifyCustomerSupport } from "./customer-support-journey.js";
import { verifyCustomers } from "./customers-journey.js";
import { verifyGuidedWorkflow } from "./guided-workflow-journey.js";
import { verifyInbox } from "./inbox-journey.js";
import { readFile } from "node:fs/promises";
import {
  customizeHelpCenter,
  verifyBrandedPortal,
  verifyBrandedWidget,
} from "./branding-journey.js";

test("real onboarding, knowledge review, portal conversation, and human takeover", async ({
  page,
  browser,
}) => {
  test.setTimeout(180000);
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
      name: "Let’s get your agent ready.",
    }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/workspace.png", fullPage: true });
  await expect(
    page.getByRole("progressbar", { name: "Setup progress" }),
  ).toHaveAttribute("max", "3");
  await page.getByRole("button", { name: "Inbox", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Inbox", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Inbox", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Let’s get your agent ready." }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await page
    .getByLabel("API key", { exact: true })
    .fill("test-key-placeholder");
  await page.getByRole("button", { name: "Verify & connect" }).click();
  await expect(page.getByText("Connection verified and saved.")).toBeVisible();
  await page
    .locator(".connection-card")
    .filter({
      has: page.getByRole("heading", {
        name: "Claude / Anthropic",
        exact: true,
      }),
    })
    .click();
  await page
    .getByLabel("API key", { exact: true })
    .fill("test-claude-placeholder");
  await page.getByLabel("Model ID to validate (optional)").fill("test-chat");
  await page.getByRole("button", { name: "Verify & connect" }).click();
  await expect(
    page
      .locator(".connection-card.chosen")
      .getByText("connected", { exact: true }),
  ).toBeVisible();
  await page
    .locator(".connection-card")
    .filter({ has: page.getByRole("heading", { name: "vLLM", exact: true }) })
    .click();
  await expect(page.getByLabel("Model API base URL")).toBeVisible();
  await expect(page.getByLabel("API key", { exact: true })).not.toHaveAttribute(
    "required",
  );
  await expect(page.getByLabel("Structured output format")).toHaveValue(
    "schema",
  );
  await page.screenshot({
    path: "test-results/model-connections.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByLabel("Response provider", { exact: true })
    .selectOption("anthropic");
  await page.getByLabel("Response model", { exact: true }).fill("test-chat");
  await expect(
    page.getByLabel("Embedding provider", { exact: true }),
  ).toHaveValue("openai");
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(page.getByText("Workspace settings saved.")).toBeVisible();
  await page.reload();
  await expect(
    page.getByLabel("Response provider", { exact: true }),
  ).toHaveValue("anthropic");
  await page.screenshot({
    path: "test-results/model-settings.png",
    fullPage: true,
  });
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
  await page.getByRole("button", { name: "Preview v1", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Preview v1", exact: true }),
  ).toBeFocused();
  await page.getByLabel("Search knowledge sources").fill("no matching source");
  await expect(
    page.getByRole("heading", { name: "No matching sources" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  await page.getByLabel("Filter source audience").selectOption("staff");
  await expect(
    page.getByRole("heading", { name: "No matching sources" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  await page
    .getByRole("button", { name: "＋ Connect source", exact: true })
    .click();

  await page
    .getByRole("combobox", { name: "Source", exact: true })
    .selectOption("site");
  await page.getByLabel("Title", { exact: true }).fill("Company documentation");
  await page
    .getByLabel("Documentation URL")
    .fill("https://docs.example.test/guide");
  await page.getByRole("button", { name: "Add source" }).click();
  const docs = page
    .getByRole("row")
    .filter({ hasText: "Company documentation" });
  await expect(
    docs.getByText("3 pages indexed", { exact: true }),
  ).toBeVisible();
  await expect(
    docs.getByLabel("Audience for Company documentation"),
  ).toHaveValue("staff");
  await docs.getByText("3 indexed pages", { exact: true }).click();
  await expect(
    docs.getByRole("link", { name: "GitBook page" }),
  ).toHaveAttribute("href", "https://docs.example.test/guide/unlinked");
  await docs.getByRole("button", { name: "Preview v1" }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Close preview" }).click();
  await page.screenshot({
    path: "test-results/documentation-site.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "FAQs", exact: true }).click();
  await page
    .getByRole("textbox", { name: "FAQ question", exact: true })
    .fill("How do I reach support?");
  await page
    .getByRole("textbox", { name: "FAQ answer", exact: true })
    .fill("Use the support portal to create a ticket.");
  await page.getByRole("button", { name: "Improve with AI" }).click();
  await expect(
    page.getByRole("textbox", { name: "FAQ answer", exact: true }),
  ).toHaveValue("Improved: Use the support portal to create a ticket.");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  const faq = page.locator("article.faq-card").filter({
    has: page.getByRole("heading", {
      name: "How do I reach support?",
      exact: true,
    }),
  });
  await expect(
    faq.getByText("Private until approved", { exact: true }),
  ).toBeVisible();
  await faq.getByRole("button", { name: "Approve for answers" }).click();
  await expect(
    faq.getByText("Approved for customer answers", { exact: true }),
  ).toBeVisible();
  await faq.getByRole("button", { name: "Publish FAQ", exact: true }).click();
  await expect(
    faq.getByRole("button", { name: "Unpublish FAQ" }),
  ).toBeVisible();
  await faq.getByRole("button", { name: "Edit FAQ" }).click();
  await page
    .getByRole("textbox", { name: "FAQ answer", exact: true })
    .fill("Use the help center contact form.");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(
    faq.getByText("Private until approved", { exact: true }),
  ).toBeVisible();
  await expect(faq.getByRole("button", { name: "Unpublish FAQ" })).toHaveCount(
    0,
  );
  await page
    .getByRole("button", { name: "Generate FAQs", exact: true })
    .click();
  const generated = page.locator("article.faq-card").filter({
    has: page.getByRole("heading", {
      name: "How long do I have to return an item?",
      exact: true,
    }),
  });
  await expect(
    generated.getByText("AI-assisted · Private until approved", {
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/faqs.png", fullPage: true });
  await page.locator(".faq-generation > summary").click();
  await page
    .getByRole("button", { name: "Review all documents and create FAQs" })
    .click();
  await expect(
    page.locator(".faq-review").getByText("completed", { exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await expect(
    page.getByRole("heading", {
      name: "What should I know about returns.txt?",
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/faq-agent.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", { name: "Save draft", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/faqs-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Workflow", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Design how your agent helps." }),
  ).toBeVisible();
  await page.getByLabel("Selected step").selectOption("agent");
  await page
    .getByLabel("Response provider (optional)")
    .selectOption("anthropic");
  await page.getByLabel("Response model (optional)").fill("test-chat");
  await page
    .getByLabel("Step instructions")
    .fill("Keep the answer to two clear sentences.");
  const agentNode = page.locator(".wf-node.agent");
  const oldLeft = await agentNode.evaluate(
    (el) => (el as HTMLElement).style.left,
  );
  await page
    .getByRole("button", { name: "Select Agent decision", exact: true })
    .press("ArrowRight");
  expect(
    await agentNode.evaluate((el) => (el as HTMLElement).style.left),
  ).not.toBe(oldLeft);
  const expandEditor = page.getByRole("button", {
    name: "Expand editor ⤢",
    exact: true,
  });
  const editor = page.getByRole("dialog", {
    name: "Customer support",
    exact: true,
  });
  await expandEditor.click();
  await expect(editor).toBeVisible();
  await expect(
    editor.getByRole("button", { name: "Close expanded editor" }),
  ).toBeFocused();
  await expect(editor.getByLabel("Selected step")).toHaveValue("agent");
  await expect(editor.getByLabel("Step instructions")).toHaveValue(
    "Keep the answer to two clear sentences.",
  );
  expect((await editor.boundingBox())!.width).toBeGreaterThan(1350);
  await editor
    .getByRole("button", { name: "Save draft", exact: true })
    .press("Shift+Tab");
  await expect(
    editor.getByRole("button", { name: "Remove step", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    editor.getByRole("button", { name: "Save draft", exact: true }),
  ).toBeFocused();
  expect(
    await page
      .getByRole("button", { name: "Workflow", exact: true })
      .evaluate((el) => Boolean(el.closest("[inert]"))),
  ).toBe(true);
  await editor.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(agentNode).toHaveCSS("left", oldLeft);
  await editor.getByRole("button", { name: "Redo", exact: true }).click();
  expect(
    await agentNode.evaluate((el) => (el as HTMLElement).style.left),
  ).not.toBe(oldLeft);
  const canvas = editor.getByLabel("Scrollable workflow canvas");
  const originalCanvasWidth = (await canvas.boundingBox())!.width;
  await editor.getByRole("button", { name: "Hide step settings" }).click();
  expect((await canvas.boundingBox())!.width).toBeGreaterThan(
    originalCanvasWidth + 250,
  );
  await editor.getByRole("button", { name: "Show step settings" }).click();
  await expect(editor.getByLabel("Step instructions")).toHaveValue(
    "Keep the answer to two clear sentences.",
  );
  await editor
    .getByRole("button", { name: "Fit workflow", exact: true })
    .click();
  await expect
    .poll(() =>
      canvas.evaluate((el) => {
        const bounds = el.getBoundingClientRect();
        return Array.from(el.querySelectorAll(".wf-node")).every((node) => {
          const rect = node.getBoundingClientRect();
          return (
            rect.left >= bounds.left &&
            rect.right <= bounds.right &&
            rect.top >= bounds.top &&
            rect.bottom <= bounds.bottom
          );
        });
      }),
    )
    .toBe(true);
  await page.screenshot({
    path: "test-results/workflow-expanded.png",
    animations: "disabled",
  });
  await editor.getByRole("button", { name: "Reset zoom to 100%" }).click();
  await expect(editor.getByLabel("Zoom level")).toHaveText("100%");
  await editor.getByRole("button", { name: "Zoom out", exact: true }).click();
  await editor
    .getByRole("button", { name: "Connect Agent decision answer", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(editor).toBeVisible();
  await expect(
    editor.getByRole("button", { name: "Cancel connection" }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(expandEditor).toBeFocused();
  await expect(page.getByLabel("Zoom level")).toHaveText("90%");
  await expect(page.getByLabel("Step instructions")).toHaveValue(
    "Keep the answer to two clear sentences.",
  );
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe(
    "hidden",
  );
  // Mobile opens on the canvas, with a separate settings view in the same editor.
  await page.setViewportSize({ width: 390, height: 844 });
  await expandEditor.click();
  await expect(editor.getByLabel("Selected step")).not.toBeVisible();
  await editor
    .getByRole("button", { name: "Fit workflow", exact: true })
    .click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/workflow-expanded-mobile.png",
    animations: "disabled",
  });
  await editor.getByRole("button", { name: "Show step settings" }).click();
  await expect(editor.getByLabel("Selected step")).toHaveValue("agent");
  await expect(canvas).not.toBeVisible();
  await expect(editor.getByLabel("Step instructions")).toHaveValue(
    "Keep the answer to two clear sentences.",
  );
  await page.screenshot({
    path: "test-results/workflow-expanded-mobile-settings.png",
    animations: "disabled",
  });
  await editor.getByRole("button", { name: "Back to canvas" }).click();
  await expect(
    editor.getByRole("button", { name: "Show step settings" }),
  ).toBeFocused();
  await editor.getByRole("button", { name: "Close expanded editor" }).click();
  await expect(expandEditor).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Show step settings" }).click();
  await page.getByLabel("Selected step").selectOption("knowledge");
  await page.getByLabel("Knowledge scope").selectOption("selected");
  await page.getByRole("checkbox", { name: /^returns\.txt/ }).check();
  await page.getByRole("button", { name: "＋ Condition", exact: true }).click();
  const conditionId = await page.getByLabel("Selected step").inputValue();
  await page.getByLabel("Condition", { exact: true }).selectOption("evidence");
  await page.getByLabel("Step name").fill("Check available knowledge");
  await page.getByLabel("Route yes", { exact: true }).selectOption("agent");
  await page.getByLabel("Route no", { exact: true }).selectOption("handoff");
  await page.getByLabel("Selected step").selectOption("knowledge");
  await page
    .getByLabel("Route found", { exact: true })
    .selectOption(conditionId);
  // Both outcome buttons and inspector dropdowns operate on the actual graph.
  await page
    .getByRole("button", {
      name: "Connect Search knowledge empty",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", {
      name: "Connect to Check available knowledge",
      exact: true,
    })
    .click();
  await page.getByLabel("Selected step").selectOption("knowledge");
  await expect(page.getByLabel("Route empty", { exact: true })).toHaveValue(
    conditionId,
  );
  await expandEditor.click();
  const saveDraft = editor.getByRole("button", {
    name: /^(Save draft|Saving…)$/,
    exact: true,
  });
  let releaseSave!: () => void;
  const pendingSave = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  await page.route(
    "**/workflow?channel=default",
    async (route) => {
      await pendingSave;
      await route.fulfill({
        status: 503,
        json: { error: "Save temporarily unavailable" },
      });
    },
    { times: 1 },
  );
  await saveDraft.click();
  try {
    await expect(saveDraft).toBeDisabled();
  } finally {
    releaseSave();
  }
  await expect(page.getByRole("alert")).toHaveText(
    "Save temporarily unavailable",
  );
  await expect(saveDraft).toBeEnabled();
  await saveDraft.click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText(
    "Draft saved. Publish it to use it for new conversations.",
  );
  const stepName = page.getByLabel("Step name", { exact: true });
  const savedStepName = await stepName.inputValue();
  await stepName.fill(`${savedStepName} edited`);
  await expect(page.getByRole("status")).toHaveCount(0);
  await stepName.fill(savedStepName);
  await editor.getByRole("button", { name: "Close expanded editor" }).click();
  await expect(
    page.getByRole("button", { name: "Publish workflow", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Publish workflow", exact: true })
    .click();
  await expect(
    page.getByText("Published version 1", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Test question", { exact: true })
    .fill("What is your return policy?");
  await page
    .getByRole("button", { name: "Test workflow", exact: true })
    .click();
  await expect(page.locator(".wf-test-result")).toContainText(
    "You can return an unused item within 30 days.",
  );
  await expect(page.locator(".wf-test-result")).toContainText(
    "Check available knowledge",
  );
  await expect(page.locator(".wf-node.agent")).toHaveClass(/visited/);
  await page.getByLabel("Selected step").selectOption("customer");
  await page.screenshot({
    path: "test-results/workflow.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await expect(page.getByLabel("Selected step")).toBeVisible();
  await page.screenshot({
    path: "test-results/workflow-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Reply behavior").selectOption("automatic");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Workspace settings saved.")).toBeVisible();
  await customizeHelpCenter(page);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const portal = page.locator("section.panel").filter({
    has: page.getByRole("heading", { name: "Support portal", exact: true }),
  });
  await portal.getByLabel("Publish this channel").check();
  await portal.getByRole("button", { name: "Save channel" }).click();
  await expect(portal.getByText("published", { exact: true })).toBeVisible();
  const customerContext = await browser.newContext(),
    customer = await customerContext.newPage();
  await verifyBrandedWidget(page, customer);
  await customer.goto("http://127.0.0.1:4351/support/northstar-workshop");
  await expect(
    customer.getByRole("heading", { name: "Hello from Northstar" }).first(),
  ).toBeVisible();
  await expect(
    customer.getByRole("heading", { name: "returns.txt" }),
  ).toBeVisible();
  await verifyBrandedPortal(customer);
  await customer
    .getByRole("button", { name: "Sign in / Create account" })
    .click();
  await expect(
    customer.getByText("WELCOME TO Northstar Help", { exact: true }),
  ).toBeVisible();
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
  await customer
    .getByRole("button", { name: "Your support account", exact: true })
    .click();
  await expect(
    customer.getByLabel("Display name", { exact: true }),
  ).toHaveValue("A real customer");
  await customer
    .getByRole("button", { name: "← Back to help center", exact: true })
    .click();
  await customer
    .getByRole("button", { name: "Submit a ticket", exact: true })
    .click();
  await customer
    .getByLabel("Subject", { exact: true })
    .fill("What is your return policy?");
  await customer
    .getByLabel("Message", { exact: true })
    .fill("What is your return policy?");
  await customer
    .getByRole("button", { name: "Send ticket", exact: true })
    .click();
  await expect(
    customer.getByText("Did this solve your issue?", { exact: true }),
  ).toHaveCount(0);
  await expect(
    customer.getByText("You can return an unused item within 30 days."),
  ).toBeVisible({ timeout: 20000 });
  await expect(
    customer.getByRole("heading", { name: "What is your return policy?" }),
  ).toBeVisible();
  await customer.screenshot({
    path: "test-results/portal.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Inbox", exact: true }).click();
  await page.getByLabel("Group inbox by").selectOption("conversation");
  await page
    .getByRole("region", { name: "Conversation queue" })
    .getByRole("button", { name: /What is your return policy/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "What is your return policy?" }).last(),
  ).toBeVisible();
  await customer
    .getByRole("button", { name: "Close ticket", exact: true })
    .click();
  await customer
    .getByRole("radio", { name: "Yes, solved", exact: true })
    .check();
  await customer
    .getByText("Add an experience rating or comment (optional)", {
      exact: true,
    })
    .click();
  await customer
    .getByLabel("Experience (optional)", { exact: true })
    .selectOption("good");
  await customer
    .getByRole("button", { name: "Send feedback", exact: true })
    .click();
  await expect(
    customer.getByText(
      "Thank you. Your feedback has been sent to the support team.",
      {
        exact: true,
      },
    ),
  ).toBeVisible();
  await expect(
    customer.getByRole("button", { name: "Send feedback", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Reopen", exact: true }).click();
  await page.getByRole("button", { name: "Take over", exact: true }).click();
  await expect(
    page.getByText("Agent paused · your team is in control", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Reply", { exact: true })
    .fill("I’m here to help with your return.");
  await page.getByRole("button", { name: "Send reply" }).click();
  await expect(
    customer.getByText("I’m here to help with your return."),
  ).toBeVisible({ timeout: 10000 });
  await verifyInbox(page, customer);
  await page.getByLabel("Reply", { exact: true }).fill("/customer-support");
  await page.getByLabel("Reply", { exact: true }).press("Enter");
  await expect(page.getByLabel("Reply", { exact: true })).toHaveValue("");
  const assistant = page.locator(".support-assistant");
  await assistant
    .getByRole("button", { name: "Triage and prioritize", exact: true })
    .click();
  await expect(
    assistant.getByRole("button", { name: "Apply triage", exact: true }),
  ).toBeEnabled({ timeout: 20000 });
  await assistant
    .getByRole("button", { name: "Apply triage", exact: true })
    .click();
  await expect(
    page.getByText("Priority: high · returns", { exact: true }),
  ).toBeVisible();
  await assistant
    .getByRole("button", { name: "Research across all sources", exact: true })
    .click();
  await expect(
    assistant.getByRole("button", {
      name: "Use as internal note",
      exact: true,
    }),
  ).toBeEnabled({ timeout: 20000 });
  await assistant
    .getByRole("button", { name: "Use as internal note", exact: true })
    .click();
  await expect(page.getByLabel("Internal note", { exact: true })).toBeChecked();
  await page
    .getByRole("tab", { name: "✦ Support assistant", exact: true })
    .click();
  await assistant
    .getByRole("button", { name: "Draft a customer response", exact: true })
    .click();
  await expect(
    assistant.getByRole("button", { name: "Use in reply", exact: true }),
  ).toBeEnabled({ timeout: 20000 });
  await assistant
    .getByRole("button", { name: "Use in reply", exact: true })
    .click();
  await expect(
    page.getByLabel("Internal note", { exact: true }),
  ).not.toBeChecked();
  await expect(page.getByLabel("Reply", { exact: true })).toHaveValue(
    /Unused items/,
  );
  await page
    .getByRole("tab", { name: "✦ Support assistant", exact: true })
    .click();
  await assistant
    .getByRole("button", {
      name: "Package an engineering escalation",
      exact: true,
    })
    .click();
  await expect(
    assistant.getByRole("button", {
      name: "Use as internal note",
      exact: true,
    }),
  ).toBeEnabled({ timeout: 20000 });
  await page.screenshot({
    path: "test-results/support-assistant.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/support-assistant-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Resolve", exact: true }).click();
  await assistant
    .getByRole("button", {
      name: "Turn resolved ticket into an article",
      exact: true,
    })
    .click();
  await expect(
    assistant.getByRole("button", {
      name: "Save private article",
      exact: true,
    }),
  ).toBeEnabled({ timeout: 20000 });
  await assistant
    .getByRole("button", { name: "Save private article", exact: true })
    .click();
  await expect(
    page.getByText(
      "Private article saved in Knowledge → Sources. Review it before approving or publishing.",
      { exact: true },
    ),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/inbox.png", fullPage: true });
  await customer.reload();
  await customer
    .getByRole("button", { name: "My tickets", exact: true })
    .click();
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
  await page.getByRole("button", { name: "Workflow", exact: true }).click();
  const library = page.locator(".wf-library");
  await library.locator("summary").first().click();
  await library
    .getByRole("button", { name: "New API step", exact: true })
    .click();
  await page
    .getByLabel("Component name", { exact: true })
    .fill("Service status");
  await page
    .getByLabel("Public API URL")
    .fill("https://status.example.com/api");
  const statusSchema = JSON.stringify({
    type: "object",
    properties: { status: { type: "string" } },
    required: ["status"],
    additionalProperties: false,
  });
  await page
    .getByLabel("Output JSON schema", { exact: true })
    .fill(statusSchema);
  await page
    .getByRole("checkbox", {
      name: "Allow this step’s output in customer replies and AI answers",
    })
    .check();
  await library.getByText("Test this step", { exact: true }).click();
  await library
    .getByRole("button", { name: "Test component", exact: true })
    .click();
  await expect(page.getByLabel("Component test output")).toContainText(
    '"status": "operational"',
  );
  await library
    .getByRole("button", { name: "Save component version", exact: true })
    .click();
  await expect(
    library.getByRole("button", { name: "Edit Service status", exact: true }),
  ).toBeVisible();
  await library
    .getByRole("button", { name: "New Python step", exact: true })
    .click();
  await page
    .getByLabel("Component name", { exact: true })
    .fill("Calculate eligibility");
  await library.getByText("Test this step", { exact: true }).click();
  await library
    .getByRole("button", { name: "Test component", exact: true })
    .click();
  await expect(library.getByRole("alert")).toContainText(
    "runner is not configured",
  );
  await library
    .getByRole("button", { name: "Save component version", exact: true })
    .click();
  await expect(
    library.getByRole("button", {
      name: "Edit Calculate eligibility",
      exact: true,
    }),
  ).toBeVisible();
  await expect(library.getByRole("alert")).toHaveCount(0);
  await library
    .getByRole("button", { name: "New subflow", exact: true })
    .click();
  await page
    .getByLabel("Workflow name", { exact: true })
    .fill("Return service status");
  await page
    .getByLabel("Input JSON schema", { exact: true })
    .fill(statusSchema);
  await page
    .getByLabel("Output JSON schema", { exact: true })
    .fill(statusSchema);
  await page
    .getByRole("checkbox", {
      name: "Allow returned values in customer reply templates",
    })
    .check();
  await page.getByLabel("Selected step").selectOption("result");
  await page.getByLabel("Output status source").selectOption("path");
  await page.getByLabel("Output status variable").fill("inputs.status");
  await page
    .getByLabel("Subflow test input JSON")
    .fill('{"status":"operational"}');
  await page
    .getByRole("button", { name: "Test workflow", exact: true })
    .click();
  await expect(page.getByLabel("Workflow test result")).toContainText(
    '"status": "operational"',
  );
  await page
    .getByRole("button", { name: "Save subflow version", exact: true })
    .click();
  await expect(
    page.getByText("Published version 1", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "＋ Custom step", exact: true })
    .click();
  const customId = await page.getByLabel("Selected step").inputValue();
  await page
    .getByLabel("Reusable component")
    .selectOption({ label: "Service status · latest v1" });
  await page
    .getByLabel("Route failed", { exact: true })
    .selectOption("handoff");
  await page.getByRole("button", { name: "＋ Subflow", exact: true }).click();
  const subflowId = await page.getByLabel("Selected step").inputValue();
  await page
    .getByLabel("Reusable component")
    .selectOption({ label: "Return service status · latest v1" });
  await page.getByLabel("Input status source").selectOption("path");
  await page
    .getByLabel("Input status variable")
    .fill(`steps.${customId}.output.status`);
  await page.getByLabel("Route done", { exact: true }).selectOption("customer");
  await page
    .getByLabel("Route failed", { exact: true })
    .selectOption("handoff");
  await page.getByLabel("Selected step").selectOption(customId);
  await page.getByLabel("Route done", { exact: true }).selectOption(subflowId);
  await page.getByLabel("Selected step").selectOption("start");
  await page.getByLabel("Route next", { exact: true }).selectOption(customId);
  await page.getByLabel("Selected step").selectOption("reply");
  await page.getByLabel("Reply content").selectOption("template");
  await page
    .getByLabel("Customer reply", { exact: true })
    .fill(`Service: {{steps.${subflowId}.output.status}}`);
  await page
    .getByLabel("Test question", { exact: true })
    .fill("What is your return policy?");
  await page
    .getByRole("button", { name: "Test workflow", exact: true })
    .click();
  await expect(page.getByLabel("Workflow test result")).toContainText(
    "Service: operational",
  );
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await page
    .getByRole("button", { name: "Publish workflow", exact: true })
    .click();
  await expect(
    page.getByText("Published version 2", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/custom-workflow.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Test Lab", exact: true }).click();
  await page.getByRole("button", { name: "New suite", exact: true }).click();
  await page
    .getByLabel("Suite name", { exact: true })
    .fill("Support regression");
  await page.getByLabel("Suite name", { exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Case", { exact: true })).toBeFocused();
  await page
    .getByLabel("Case name", { exact: true })
    .fill("Service continuity");
  await page
    .getByLabel("Customer message 1", { exact: true })
    .fill("Is the service online?");
  await page
    .getByRole("button", { name: "Add customer turn", exact: true })
    .click();
  await page.getByLabel("Customer message 2", { exact: true }).fill("And now?");
  await page
    .getByText("Customer, account and API fixtures", { exact: true })
    .click();
  await page.getByLabel("Fixtures JSON", { exact: true }).fill(
    JSON.stringify({
      steps: { [customId]: { output: { status: "operational" } } },
    }),
  );
  await page.getByLabel("Fixtures JSON", { exact: true }).fill("{invalid");
  await page.getByRole("button", { name: "Save suite", exact: true }).click();
  await expect(
    page.locator(".quality-page [role=alert]").first(),
  ).toContainText(/JSON|property/i);
  await page.getByLabel("Fixtures JSON", { exact: true }).fill(
    JSON.stringify({
      steps: { [customId]: { output: { status: "operational" } } },
    }),
  );
  await page.getByRole("button", { name: "Save suite", exact: true }).click();
  await expect(page.getByText("Suite saved.", { exact: true })).toBeVisible();
  await expect(page.locator(".quality-page [role=alert]").first()).toHaveText(
    "",
  );
  await page.getByLabel("Compare two variants").check();
  await page
    .getByRole("button", { name: "Launch test run", exact: true })
    .click();
  await expect(page.locator(".quality-result")).toHaveCount(4);
  await expect(
    page.getByRole("heading", { name: "AI quality assessment", exact: true }),
  ).toHaveCount(4);
  await expect(page.locator(".quality-result").first()).toContainText(
    "Grounding 5/5",
    { timeout: 30000 },
  );
  await page
    .locator(".quality-result")
    .first()
    .getByLabel("Review explanation")
    .fill("Reviewed this answer and route.");
  await page
    .locator(".quality-result")
    .first()
    .getByRole("button", { name: "Record staff review" })
    .click();
  await expect(
    page
      .locator(".quality-result")
      .first()
      .getByText("Review recorded. Original results retained."),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/test-lab.png", fullPage: true });
  await page.getByRole("button", { name: "Analytics", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Analytics", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Satisfaction", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Channel", { exact: true }).selectOption("portal");
  const through = await page.getByLabel("Through (UTC)").inputValue();
  await page.getByLabel("From (UTC)").fill("2099-01-01");
  await expect(
    page.getByText("The end date must be on or after the start date."),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Reset filters", exact: true })
    .click();
  await expect(page.getByLabel("Through (UTC)")).toHaveValue(through);
  await expect(
    page.getByRole("heading", { name: "Satisfaction", exact: true }),
  ).toBeVisible();

  await page.screenshot({ path: "test-results/analytics.png", fullPage: true });
  await page.getByRole("button", { name: "Inbox", exact: true }).click();
  await page.getByLabel("Search conversations").fill("no matching ticket");
  await expect(
    page.getByRole("heading", { name: "No matching conversations" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  await page
    .getByRole("region", { name: "Conversation queue" })
    .locator(".conversation-card")
    .first()
    .click();
  await page
    .getByRole("tab", { name: "Activity & tools", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Flag knowledge gap", exact: true })
    .click();
  await expect(
    page.getByText("Conversation flagged under Knowledge → Gaps.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Knowledge", exact: true }).click();
  await page.getByRole("button", { name: "Gaps", exact: true }).click();
  await expect(
    page.getByText("Nightly analysis · disabled", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Analyze now", exact: true }).click();
  await expect(
    page.getByText("Analysis queued.", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/knowledge-gaps.png",
    fullPage: true,
  });
  await verifyCustomerSupport(page, customer);
  await verifyCustomers(page, customer);
  await verifyGuidedWorkflow(page);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/custom-workflow-mobile.png",
    fullPage: true,
  });

  await page
    .getByRole("button", { name: "Toggle navigation", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Workspace navigation" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Close navigation", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    page.getByRole("button", { name: "Sign out", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "Close navigation", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Toggle navigation", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Inbox", exact: true }),
  ).toHaveCount(0);
  for (const section of ["Test Lab", "Analytics"]) {
    await page
      .getByRole("button", { name: "Toggle navigation", exact: true })
      .click();
    await page.getByRole("button", { name: section, exact: true }).click();
    await expect(
      page.getByRole("heading", { name: section, exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/${section.toLowerCase().replace(" ", "-")}-mobile.png`,
      fullPage: true,
    });
  }
  expect(errors).toEqual([]);
  await customerContext.close();
  await page
    .getByRole("button", { name: "Toggle navigation", exact: true })
    .click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome back", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe(
    "hidden",
  );
});
