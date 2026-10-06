import { expect, type Page } from "@playwright/test";
import { readdir, readFile } from "node:fs/promises";
import { defaultWorkflow } from "../../packages/platform/src/workflow-definition.js";
export async function verifyCustomerSupport(staff: Page, customer: Page) {
  const ws = new URL(staff.url()).searchParams.get("workspace")!,
    headers = { Origin: "http://127.0.0.1:4351" };
  const setup = await staff.request.put(`/v2/workspaces/${ws}/ticket-email`, {
    headers,
    data: { address: "support@inbound.example.test" },
  });
  expect(setup.ok()).toBe(true);
  const connection = await setup.json();
  await customer
    .getByRole("button", { name: "My tickets", exact: true })
    .click();
  await customer
    .getByRole("button", { name: "New ticket", exact: true })
    .click();
  await customer
    .getByLabel("Subject", { exact: true })
    .fill("Email reply browser check");
  await customer
    .getByLabel("Message", { exact: true })
    .fill("What is your return policy?");
  await customer.route(
    "**/conversations",
    (route) =>
      route.fulfill({
        status: 503,
        json: { error: "Temporary submission failure" },
      }),
    { times: 1 },
  );
  await customer
    .getByRole("button", { name: "Send ticket", exact: true })
    .click();
  await expect(
    customer.getByText("Temporary submission failure", { exact: true }),
  ).toBeVisible();
  await expect(customer.getByLabel("Message", { exact: true })).toHaveValue(
    "What is your return policy?",
  );
  await customer
    .getByRole("button", { name: "Send ticket", exact: true })
    .click();
  await expect(
    customer.getByRole("heading", {
      name: "Email reply browser check",
      exact: true,
    }),
  ).toBeVisible();
  const id = new URL(customer.url()).searchParams.get("ticket")!;
  await expect(
    customer.getByRole("heading", { name: "Did this solve your issue?" }),
  ).toHaveCount(0);
  // The staff reply takes over before asynchronous automation can deliver anything stale.
  const reply = await staff.request.post(
    `/v2/workspaces/${ws}/conversations/${id}/messages`,
    {
      headers,
      data: {
        body: "We received your email test ticket. Reply directly to this message.",
        requestKey: crypto.randomUUID(),
      },
    },
  );
  expect(reply.ok()).toBe(true);
  const message = await reply.json();
  await expect(
    customer.getByText(
      "We received your email test ticket. Reply directly to this message.",
      { exact: true },
    ),
  ).toBeVisible();
  let email: any;
  await expect
    .poll(
      async () => {
        const files = await readdir(".fieldkit/browser");
        const file = files.find(
          (f) => f.startsWith("ticket-") && f.includes(message.id),
        );
        if (!file) return false;
        email = JSON.parse(await readFile(`.fieldkit/browser/${file}`, "utf8"));
        return !!email.options.replyTo;
      },
      { timeout: 15000 },
    )
    .toBe(true);
  await customer
    .getByRole("button", { name: "Close ticket", exact: true })
    .click();
  await expect(
    customer.getByRole("heading", { name: "Did this solve your issue?" }),
  ).toBeVisible();
  const inbound = {
    MessageID: crypto.randomUUID(),
    OriginalRecipient: email.options.replyTo,
    FromFull: { Email: email.to },
    StrippedTextReply: "Replying from my email: please reopen this ticket.",
    TextBody: "Replying from my email: please reopen this ticket.",
  };
  const auth = `Basic ${Buffer.from(`fieldkit:${connection.password}`).toString("base64")}`;
  const webhook = `/v2/webhooks/email/${ws}`;
  for (let i = 0; i < 2; i++)
    expect(
      (
        await staff.request.post(webhook, {
          headers: { Authorization: auth },
          data: inbound,
        })
      ).ok(),
    ).toBe(true);
  await expect(
    customer.getByText(inbound.StrippedTextReply, { exact: true }),
  ).toHaveCount(1);
  await expect(
    customer.getByRole("heading", { name: "Did this solve your issue?" }),
  ).toHaveCount(0);
  const detail = await customer.request.get(
    `/v2/workspaces/${ws}/conversations/${id}`,
  );
  expect((await detail.json()).conversation.mode).toBe("human");
  await customer.setViewportSize({ width: 390, height: 844 });
  expect(
    await customer.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await customer.screenshot({
    path: "test-results/ticket-email-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await customer.setViewportSize({ width: 1440, height: 1000 });
  await customer.screenshot({
    path: "test-results/ticket-email-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  const def = defaultWorkflow();
  const node = def.nodes.find((n) => n.type === "reply")!;
  if (node.type === "reply")
    node.data = {
      mode: "workspace",
      content: "exact",
      text: "This reply uses the live chat workflow.",
    };
  const channel = await staff.request.get(
    `/v2/workspaces/${ws}/workflow?channel=widget`,
  );
  const draft = await staff.request.put(
    `/v2/workspaces/${ws}/workflow?channel=widget`,
    {
      headers,
      data: { revision: (await channel.json()).revision, definition: def },
    },
  );
  expect(draft.ok()).toBe(true);
  await staff.goto(`/?workspace=${ws}&view=workflow&channel=widget`);
  await expect(
    staff.getByLabel("Channel workflow", { exact: true }),
  ).toHaveValue("widget");
  await staff
    .getByRole("button", { name: "Publish workflow", exact: true })
    .click();
  await expect(staff.getByRole("status")).toContainText("Workflow published");
  await staff
    .getByLabel("Channel workflow", { exact: true })
    .selectOption("portal");
  await expect(
    staff.getByText(/Using workspace default · version/),
  ).toBeVisible();
  await staff
    .getByLabel("Channel workflow", { exact: true })
    .selectOption("widget");
  await expect(staff.getByText(/Published version \d/)).toBeVisible();
  await customer
    .getByRole("button", { name: "Help center", exact: true })
    .click();
  await customer
    .getByRole("button", { name: "Open support chat", exact: true })
    .click();
  const popup = customer.getByRole("dialog", {
    name: "Support chat",
    exact: true,
  });
  await expect(popup).toBeVisible();
  await expect(
    popup.getByRole("button", { name: "Minimize support chat", exact: true }),
  ).toBeFocused();
  await customer
    .getByLabel("Your message", { exact: true })
    .fill("Draft kept while minimized");
  await customer.getByLabel("Your message", { exact: true }).press("Escape");
  await expect(popup).toBeHidden();
  await expect(
    customer.getByRole("button", { name: "Open support chat", exact: true }),
  ).toBeFocused();
  await customer
    .getByRole("button", { name: "Open support chat", exact: true })
    .click();
  await expect(
    customer.getByLabel("Your message", { exact: true }),
  ).toHaveValue("Draft kept while minimized");
  await customer
    .getByLabel("Your message", { exact: true })
    .fill("What is the return policy?");
  await customer.getByLabel("Your message", { exact: true }).press("Enter");
  await expect(
    customer.getByText("This reply uses the live chat workflow.", {
      exact: true,
    }),
  ).toBeVisible({ timeout: 15000 });
  await expect(
    customer.getByRole("heading", { name: "Did this solve your issue?" }),
  ).toHaveCount(0);
  await customer.getByRole("button", { name: "End chat", exact: true }).click();
  await expect(
    customer.getByRole("heading", { name: "Did this solve your issue?" }),
  ).toBeVisible();
  await customer.reload();
  await customer
    .getByRole("button", { name: "Open support chat", exact: true })
    .click();
  await expect(
    customer.getByText("This reply uses the live chat workflow.", {
      exact: true,
    }),
  ).toBeVisible();
  await popup
    .getByRole("radio", { name: "No, I still need help", exact: true })
    .check();
  await popup
    .getByText("Add an experience rating or comment (optional)")
    .click();
  await popup
    .getByLabel("Feedback comment (optional)")
    .fill("The answer did not cover my situation.");
  await popup
    .getByRole("button", { name: "Send feedback", exact: true })
    .click();
  await expect(
    popup.getByRole("heading", { name: "Feedback sent", exact: true }),
  ).toBeVisible();
  await expect(
    popup.getByRole("button", { name: "Send feedback", exact: true }),
  ).toHaveCount(0);
  const composer = popup.getByLabel("Your message", { exact: true });
  await expect(composer).toBeVisible();
  await expect(composer).toBeFocused();
  await composer.fill("Could you explain returns for a gift?");
  await customer.route(
    "**/conversations/*/messages",
    (route) =>
      route.fulfill({
        status: 503,
        json: { error: "Temporary follow-up failure" },
      }),
    { times: 1 },
  );
  await composer.press("Enter");
  await expect(
    popup.getByText("Temporary follow-up failure", { exact: true }),
  ).toBeVisible();
  await expect(composer).toHaveValue("Could you explain returns for a gift?");
  await composer.press("Enter");
  await expect(
    popup.getByText("Could you explain returns for a gift?", { exact: true }),
  ).toHaveCount(1);
  await expect(
    popup.getByText("This reply uses the live chat workflow.", { exact: true }),
  ).toHaveCount(2, { timeout: 15000 });
  await popup.getByRole("button", { name: "End chat", exact: true }).click();
  await customer.reload();
  await customer
    .getByRole("button", { name: "Open support chat", exact: true })
    .click();
  await expect(
    popup.getByRole("heading", { name: "Feedback sent", exact: true }),
  ).toBeVisible();
  await expect(
    popup.getByRole("button", { name: "Send feedback", exact: true }),
  ).toHaveCount(0);
  const conversations = await staff.request.get(
    `/v2/workspaces/${ws}/conversations`,
  );
  const chat = (await conversations.json()).conversations.find(
    (c: any) => c.channel_kind === "widget" && c.feedback_resolved === false,
  );
  expect(chat).toBeTruthy();
  await staff.goto(`/?workspace=${ws}&view=inbox&conversation=${chat.id}`);
  await staff.getByRole("tab", { name: "Feedback", exact: true }).click();
  const feedbackPanel = staff.getByRole("region", {
    name: "Customer feedback",
    exact: true,
  });
  await expect(
    feedbackPanel.getByText("The answer did not cover my situation.", {
      exact: true,
    }),
  ).toBeVisible();
  await staff.screenshot({
    path: "test-results/inbox-unresolved-feedback.png",
    fullPage: true,
    animations: "disabled",
  });
  await customer.setViewportSize({ width: 390, height: 844 });
  expect(
    await customer.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const box = await popup.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(box!.y + box!.height).toBeLessThanOrEqual(844);
  await customer.screenshot({
    path: "test-results/chat-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await customer.setViewportSize({ width: 1440, height: 1000 });
  await customer.screenshot({
    path: "test-results/chat-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await staff.getByRole("button", { name: "Publish", exact: true }).click();
  await staff
    .getByRole("button", { name: "Support options", exact: true })
    .click();
  for (const option of [
    { label: "Tickets only", tickets: true, chat: false },
    { label: "Chatbot only", tickets: false, chat: true },
    { label: "Neither", tickets: false, chat: false },
    { label: "Tickets & chatbot", tickets: true, chat: true },
  ]) {
    await staff.getByRole("radio", { name: new RegExp(option.label) }).check();
    await staff
      .getByRole("button", { name: "Save support options", exact: true })
      .click();
    await expect(
      staff.getByText("Support options saved.", { exact: true }),
    ).toBeVisible();
    await customer.reload();
    await expect(
      customer.getByRole("button", { name: "Submit a ticket", exact: true }),
    ).toHaveCount(option.tickets ? 1 : 0);
    await expect(
      customer.getByRole("button", { name: "Open support chat", exact: true }),
    ).toHaveCount(option.chat ? 1 : 0);
    await expect(
      customer.getByRole("heading", { name: "Browse our knowledge" }),
    ).toBeVisible();
  }
  await staff.setViewportSize({ width: 390, height: 844 });
  await staff.locator(".support-options").scrollIntoViewIfNeeded();
  expect(
    await staff.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await staff.screenshot({
    path: "test-results/support-options-mobile.png",
    fullPage: false,
    animations: "disabled",
  });
  await staff.setViewportSize({ width: 1440, height: 1000 });
  await staff.getByRole("button", { name: "Knowledge", exact: true }).click();
  await staff.getByRole("button", { name: "Gaps", exact: true }).click();
}
