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
  });
  await customer.setViewportSize({ width: 1440, height: 1000 });
  await customer.screenshot({
    path: "test-results/ticket-email-desktop.png",
    fullPage: true,
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
  await customer.getByRole("button", { name: "Chat now", exact: true }).click();
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
  await customer.getByRole("button", { name: "Chat now", exact: true }).click();
  await expect(
    customer.getByText("This reply uses the live chat workflow.", {
      exact: true,
    }),
  ).toBeVisible();
  await customer.setViewportSize({ width: 390, height: 844 });
  expect(
    await customer.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await customer.screenshot({
    path: "test-results/chat-mobile.png",
    fullPage: true,
  });
  await customer.setViewportSize({ width: 1440, height: 1000 });
  await customer.screenshot({
    path: "test-results/chat-desktop.png",
    fullPage: true,
  });
  await staff.getByRole("button", { name: "Knowledge", exact: true }).click();
  await staff.getByRole("button", { name: "Gaps", exact: true }).click();
}
