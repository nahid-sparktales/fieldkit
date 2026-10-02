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
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
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
  expect(errors).toEqual([]);
  await customerContext.close();
});
