import { expect, type Page, type Route } from "@playwright/test";
/** UI fixtures intercept collaboration mutations; no invitation is sent. */
export async function verifyCollaborationJourney(page: Page) {
  const ws = new URL(page.url()).searchParams.get("workspace")!;
  const organizations: any[] = [],
    participants: any[] = [];
  const invitations: any[] = [];
  let following = false,
    includeNotes = false,
    sharing = "private",
    organizationId: string | null = null;
  const routes: [string, (route: Route) => Promise<void>][] = [];
  const add = async (
    pattern: string,
    handler: (route: Route) => Promise<void>,
  ) => {
    routes.push([pattern, handler]);
    await page.route(pattern, handler);
  };
  await add(`**/v2/workspaces/${ws}/organizations`, async (r) => {
    if (r.request().method() === "POST") {
      const d = r.request().postDataJSON();
      organizations.push({
        ...d,
        id: "fixture-company",
        active: true,
        revision: 1,
        member_count: 0,
      });
      await r.fulfill({ json: organizations[0] });
    } else await r.fulfill({ json: { organizations } });
  });
  await add(
    `**/v2/workspaces/${ws}/organizations/fixture-company`,
    async (r) => {
      if (r.request().method() === "PUT")
        Object.assign(organizations[0], r.request().postDataJSON(), {
          revision: organizations[0].revision + 1,
        });
      await r.fulfill({
        json:
          r.request().method() === "GET"
            ? { organization: organizations[0], members: [], invitations }
            : organizations[0],
      });
    },
  );
  await add(
    `**/v2/workspaces/${ws}/organizations/fixture-company/invitations`,
    async (r) => {
      invitations.push({
        id: "fixture-invitation",
        ...r.request().postDataJSON(),
        status: "queued",
      });
      await r.fulfill({ json: { id: "fixture-invitation", status: "queued" } });
    },
  );
  const convs = await page.request.get(`/v2/workspaces/${ws}/conversations`),
    data = await convs.json(),
    ticket = data.conversations.find(
      (c: any) => !c.external_id && c.channel_kind === "portal",
    );
  if (ticket) {
    await add(
      `**/v2/workspaces/${ws}/conversations/${ticket.id}/collaboration`,
      async (r) =>
        r.fulfill({
          json: {
            canManage: true,
            participants,
            invitations: [],
            followers: [],
            following,
            includeNotes,
            canReadNotes: true,
            organizations,
            organizationId,
            sharing,
            suggestions: [{ email: "suggestion@example.test" }],
          },
        }),
    );
    await add(
      `**/v2/workspaces/${ws}/conversations/${ticket.id}/participants`,
      async (r) => {
        const d = r.request().postDataJSON();
        expect(d.confirmFutureOnly).toBe(true);
        participants.push({
          id: "fixture-participant",
          email: d.email,
          joined_at: new Date().toISOString(),
          portal_contact_id: null,
        });
        await r.fulfill({ json: { participant: participants[0] } });
      },
    );
    await add(
      `**/v2/workspaces/${ws}/conversations/${ticket.id}/participants/*`,
      async (r) => {
        participants.splice(0);
        await r.fulfill({ json: { removed: true } });
      },
    );
    await add(
      `**/v2/workspaces/${ws}/conversations/${ticket.id}/following`,
      async (r) => {
        ({ following, includeNotes } = r.request().postDataJSON());
        await r.fulfill({ json: { following } });
      },
    );
    await add(
      `**/v2/workspaces/${ws}/conversations/${ticket.id}/sharing`,
      async (r) => {
        const d = r.request().postDataJSON();
        sharing = d.sharing;
        organizationId = d.organizationId;
        await r.fulfill({ json: { updated: true } });
      },
    );
  }
  try {
    await page.goto(`/?workspace=${ws}&view=customers`);
    await page
      .getByRole("button", { name: "Organizations", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "No organizations yet" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "New organization", exact: true })
      .click();
    await page
      .getByLabel("Organization name", { exact: true })
      .fill("Acme fixture");
    await page
      .getByLabel("Description", { exact: true })
      .fill("Synthetic company");
    await page
      .getByRole("button", { name: "Create organization", exact: true })
      .click();
    const detail = page.locator(".organization-detail");
    await expect(
      detail.getByRole("heading", { name: "Acme fixture", exact: true }),
    ).toBeVisible();
    await detail
      .getByLabel("Email address", { exact: true })
      .fill("manager@example.test");
    await detail
      .getByRole("combobox", { name: "Company role", exact: true })
      .selectOption("manager");
    await detail
      .getByRole("button", { name: "Send invitation", exact: true })
      .click();
    await expect(
      detail
        .locator(".collaboration-list li")
        .filter({ hasText: "manager@example.test" }),
    ).toBeVisible();
    expect(invitations[0].role).toBe("manager");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "test-results/organizations-mobile.png",
      fullPage: true,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    if (ticket) {
      await page.goto(`/?workspace=${ws}&view=inbox&conversation=${ticket.id}`);
      await page.getByRole("tab", { name: /Activity & tools/ }).click();
      const panel = page.getByRole("region", {
        name: "Ticket participants and sharing",
      });
      await expect(panel).toBeVisible();
      await panel
        .getByLabel("Participant email", { exact: true })
        .fill("colleague@example.test");
      page.once("dialog", (d) => d.accept());
      await panel
        .getByRole("button", { name: "Add participant", exact: true })
        .click();
      await expect(
        panel.getByText("colleague@example.test", { exact: true }),
      ).toBeVisible();
      await panel
        .getByRole("button", { name: "Follow ticket", exact: true })
        .click();
      await expect(
        panel.getByRole("button", { name: "Stop following", exact: true }),
      ).toBeVisible();
      await panel.getByLabel("Include internal notes when permitted").click();
      await expect.poll(() => includeNotes).toBe(true);
      await expect(
        panel.getByLabel("Include internal notes when permitted"),
      ).toBeChecked();
      await panel
        .getByText("Company sharing · Private ticket", { exact: true })
        .click();
      await panel
        .getByRole("combobox", { name: "Customer organization", exact: true })
        .selectOption("fixture-company");
      page.once("dialog", (d) => d.accept());
      await panel
        .getByRole("button", {
          name: "Share with company managers",
          exact: true,
        })
        .click();
      await expect(
        panel.getByText("Company sharing · Shared with managers", {
          exact: true,
        }),
      ).toBeVisible();
      await page.setViewportSize({ width: 390, height: 844 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: "test-results/ticket-collaboration-mobile.png",
        fullPage: true,
        animations: "disabled",
      });
      await page.setViewportSize({ width: 1440, height: 1000 });
      page.once("dialog", (d) => d.accept());
      await panel.getByRole("button", { name: "Remove", exact: true }).click();
      await expect(
        panel.getByText("colleague@example.test", { exact: true }),
      ).not.toBeVisible();
    }
  } finally {
    await page.goto(`/?workspace=${ws}&view=knowledge`);
    for (const [pattern, handler] of routes)
      await page.unroute(pattern, handler);
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
}

/** Real local API + portal journey. Only the browser-server mock transport delivers invitations. */
export async function verifyCollaborationPortal(
  staff: Page,
  customer: Page,
  ws: string,
) {
  const { readFile, readdir } = await import("node:fs/promises");
  const origin = new URL(staff.url()).origin,
    headers = { Origin: origin },
    customerHeaders = { ...headers, "X-Fieldkit-Audience": "customer" },
    prefix = `/v2/workspaces/${ws}`;
  const joined = await customer.request.post(
    "/v2/public/northstar-workshop/join",
    { headers, data: {} },
  );
  expect(joined.ok()).toBe(true);
  const identity = await joined.json();
  const contacts = await (await staff.request.get(`${prefix}/contacts`)).json();
  let other = contacts.contacts.find(
    (c: any) =>
      c.id !== identity.contactId &&
      c.email?.toLowerCase() !== identity.email.toLowerCase(),
  );
  if (!other) {
    // The combined fixture can contain only one customer. Join its separate verified owner
    // to the public portal through the normal endpoint, without forging a customer identity.
    const requester = await staff.request.post(
      "/v2/public/northstar-workshop/join",
      {
        headers,
        data: {},
      },
    );
    expect(requester.ok()).toBe(true);
    const joinedOwner = await requester.json();
    expect(joinedOwner.contactId).not.toBe(identity.contactId);
    other = { id: joinedOwner.contactId };
  }
  expect(!!other).toBe(true);
  const settings = await (
    await staff.request.get(`${prefix}/attachments/settings`)
  ).json();
  const createTicket = async (subject: string, body: string) => {
    const r = await staff.request.post(`${prefix}/conversations`, {
      headers,
      data: {
        subject,
        body,
        contactId: other.id,
        channelId: identity.channelId,
        requestKey: crypto.randomUUID(),
      },
    });
    expect(r.status()).toBe(202);
    const ticket = await r.json();
    const control = await staff.request.post(
      `${prefix}/conversations/${ticket.id}/control`,
      { headers, data: { mode: "human" } },
    );
    expect(control.ok()).toBe(true);
    return ticket;
  };
  const acceptInvitation = async (id: string) => {
    let text = "";
    await expect
      .poll(
        async () => {
          const files = await readdir(".fieldkit/browser");
          const filename = files.find(
            (f) => f.startsWith("ticket-") && f.includes(`invitation-${id}`),
          );
          if (!filename) return false;
          const mail = JSON.parse(
            await readFile(`.fieldkit/browser/${filename}`, "utf8"),
          );
          if (mail.to !== identity.email) return false;
          text = mail.text;
          return text.includes("?invitation=");
        },
        { timeout: 20000 },
      )
      .toBe(true);
    const url = new URL(text.match(/https?:\/\/\S+/)![0]);
    expect(url.origin).toBe(origin);
    await customer.goto(url.toString());
    await expect(
      customer.getByRole("heading", {
        name: "Support invitation",
        exact: true,
      }),
    ).toBeVisible();
    await customer
      .getByRole("button", { name: "Accept invitation", exact: true })
      .click();
    await expect(
      customer.getByRole("heading", {
        name: "Support invitation",
        exact: true,
      }),
    ).not.toBeVisible();
  };
  try {
    const enabled = await staff.request.put(`${prefix}/attachments/settings`, {
      headers,
      data: { enabled: true, anonymous: false },
    });
    expect(enabled.ok()).toBe(true);
    const orgResponse = await staff.request.post(`${prefix}/organizations`, {
      headers,
      data: {
        name: `Browser company ${crypto.randomUUID().slice(0, 8)}`,
        description: "Local verified invitation journey",
      },
    });
    expect(orgResponse.ok()).toBe(true);
    const org = await orgResponse.json();
    const history =
        "Company history created before manager invitation acceptance",
      ticket = await createTicket("Shared company browser ticket", history);
    const invite = await staff.request.post(
      `${prefix}/organizations/${org.id}/invitations`,
      { headers, data: { email: identity.email, role: "manager" } },
    );
    expect(invite.ok()).toBe(true);
    await acceptInvitation((await invite.json()).id);
    expect(
      (
        await customer.request.get(`${prefix}/conversations/${ticket.id}`, {
          headers: customerHeaders,
        })
      ).status(),
    ).toBe(404);
    const shared = await staff.request.put(
      `${prefix}/conversations/${ticket.id}/sharing`,
      {
        headers,
        data: {
          organizationId: org.id,
          sharing: "company",
          confirmHistory: true,
        },
      },
    );
    expect(shared.ok()).toBe(true);
    await customer.goto("/support/northstar-workshop");
    await customer
      .getByRole("button", { name: "My tickets", exact: true })
      .first()
      .click();
    await customer
      .getByRole("button", { name: "Company tickets", exact: true })
      .click();
    await customer
      .getByRole("button", { name: /Shared company browser ticket/ })
      .click();
    await expect(customer.getByText(history, { exact: true })).toBeVisible();
    await expect(
      customer.getByText(
        "Follow updates here. Email notifications require support to add you as a participant.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      customer.getByRole("button", { name: "Close ticket", exact: true }),
    ).toHaveCount(0);
    await expect(
      customer.getByRole("heading", {
        name: "Did this solve your issue?",
        exact: true,
      }),
    ).toHaveCount(0);
    await customer
      .getByRole("button", { name: /^(Reply to support|Add more details)$/ })
      .click();
    await customer
      .getByLabel("Your reply", { exact: true })
      .fill("Company manager adds a scanned support log");
    await customer.getByLabel("Choose files", { exact: true }).setInputFiles({
      name: "company-manager-log.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Local browser fixture: company diagnostic log"),
    });
    await expect(
      customer
        .locator(".attachment-picker")
        .getByText("company-manager-log.txt", { exact: true }),
    ).toBeVisible();
    await expect(
      customer.getByRole("button", { name: "Send reply", exact: true }),
    ).toBeEnabled();
    await customer
      .getByRole("button", { name: "Send reply", exact: true })
      .click();
    await expect(
      customer.getByText("Company manager adds a scanned support log", {
        exact: true,
      }),
    ).toBeVisible();
    const file = customer
      .locator(".attachment-card")
      .filter({ hasText: "company-manager-log.txt" });
    await expect(
      file.getByRole("button", { name: "Download", exact: true }),
    ).toBeVisible({ timeout: 20000 });
    const detail = await (
      await customer.request.get(`${prefix}/conversations/${ticket.id}`, {
        headers: customerHeaders,
      })
    ).json();
    expect(detail.access.requester).toBe(false);
    expect(detail.access.changeStatus).toBe(false);
    expect(detail.conversation.mode).toBe("human");
    const attachment = detail.messages
      .flatMap((m: any) => m.attachments ?? [])
      .find((f: any) => f.name === "company-manager-log.txt");
    expect(!!attachment).toBe(true);
    expect(
      (
        await customer.request.get(
          `${prefix}/attachments/${attachment.id}/content`,
          { headers: customerHeaders },
        )
      ).status(),
    ).toBe(200);
    await customer.setViewportSize({ width: 390, height: 844 });
    expect(
      await customer.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await customer.screenshot({
      path: "test-results/company-ticket-portal-mobile.png",
      fullPage: true,
      animations: "disabled",
    });
    await customer.setViewportSize({ width: 1440, height: 1000 });
    const removed = await staff.request.delete(
      `${prefix}/organizations/${org.id}/members/${identity.contactId}`,
      { headers },
    );
    expect(removed.ok()).toBe(true);
    expect(
      (
        await customer.request.get(`${prefix}/conversations/${ticket.id}`, {
          headers: customerHeaders,
        })
      ).status(),
    ).toBe(404);
    expect(
      (
        await customer.request.get(
          `${prefix}/attachments/${attachment.id}/content`,
          { headers: customerHeaders },
        )
      ).status(),
    ).toBe(404);
    const participantTicket = await createTicket(
      "Participant invitation browser ticket",
      "Private history from before this participant joined",
    );
    const added = await staff.request.post(
      `${prefix}/conversations/${participantTicket.id}/participants`,
      { headers, data: { email: identity.email, confirmFutureOnly: true } },
    );
    expect(added.ok()).toBe(true);
    const participant = await added.json();
    const future = await staff.request.post(
      `${prefix}/conversations/${participantTicket.id}/messages`,
      {
        headers,
        data: {
          body: "Visible correspondence after participant approval",
          requestKey: crypto.randomUUID(),
        },
      },
    );
    expect(future.ok()).toBe(true);
    await acceptInvitation(participant.invitation.id);
    await expect(
      customer.getByRole("heading", {
        name: "Participant invitation browser ticket",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      customer.getByText("Visible correspondence after participant approval", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      customer.getByText(
        "Private history from before this participant joined",
        { exact: true },
      ),
    ).toHaveCount(0);
    await expect(
      customer.getByText(
        /You can see correspondence sent after you were added/,
      ),
    ).toBeVisible();
    await expect(
      customer.getByRole("button", { name: "Close ticket", exact: true }),
    ).toHaveCount(0);
    const revoked = await staff.request.delete(
      `${prefix}/conversations/${participantTicket.id}/participants/${participant.participant.id}`,
      { headers },
    );
    expect(revoked.ok()).toBe(true);
    expect(
      (
        await customer.request.get(
          `${prefix}/conversations/${participantTicket.id}`,
          { headers: customerHeaders },
        )
      ).status(),
    ).toBe(404);
  } finally {
    await staff.request.put(`${prefix}/attachments/settings`, {
      headers,
      data: { enabled: !!settings.enabled, anonymous: !!settings.anonymous },
    });
    await customer.setViewportSize({ width: 1440, height: 1000 });
    await customer.goto("/support/northstar-workshop");
  }
}
