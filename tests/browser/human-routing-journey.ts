import { expect, type Page } from "@playwright/test";

/** Uses only the caller's disposable authenticated workspace; restores routing opt-in/presence. */
export async function verifyHumanRouting(page: Page, ws: string) {
  const base = `/v2/workspaces/${ws}`;
  const original = await (await page.request.get(`${base}/routing`)).json();
  const name = `Browser Support ${Date.now()}`;
  const self = original.self;
  let team: any;
  try {
    await page.goto(`/?workspace=${ws}&view=teams`);
    await expect(
      page.getByRole("heading", { name: "Teams & routing", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Teams", exact: true }).click();
    await page.getByRole("button", { name: "New team", exact: true }).click();
    const form = page.locator("form.routing-team-editor:visible");
    await form.getByLabel("Team name", { exact: true }).fill(name);
    await form
      .getByLabel("Description", { exact: true })
      .fill("Synthetic browser test support team");
    if (self)
      await form
        .getByLabel(self.name || self.email || self.user_id, { exact: true })
        .check();
    await form
      .getByLabel("Allow automatic assignment for this team", { exact: true })
      .check();
    await form.getByRole("button", { name: "Save team", exact: true }).click();
    await expect(
      page.getByRole("button", { name: new RegExp(name) }),
    ).toBeVisible();
    const current = await (await page.request.get(`${base}/routing`)).json();
    team = current.teams.find((t: any) => t.name === name);
    expect(team.routing_enabled).toBe(true);
    expect(current.settings.enabled).toBe(original.settings.enabled);
    await page.getByRole("button", { name: new RegExp(name) }).click();
    await form.getByLabel("Team name", { exact: true }).fill(`${name} unsaved`);
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.getByRole("button", { name: "New team", exact: true }).click();
    await expect(form.getByLabel("Team name", { exact: true })).toHaveValue(
      `${name} unsaved`,
    );
    await form.getByLabel("Team name", { exact: true }).fill(name);
    await page
      .getByRole("button", { name: "Routing settings", exact: true })
      .click();
    const settings = page.locator("form.routing-team-editor:visible");
    await settings
      .getByLabel("Default team", { exact: true })
      .selectOption(team.id);
    await settings
      .getByLabel("Enable automatic human assignment", { exact: true })
      .check();
    if (!original.settings.enabled)
      page.once("dialog", (dialog) => dialog.accept());
    await settings
      .getByRole("button", { name: "Save routing settings", exact: true })
      .click();
    await expect(
      page.getByText("Routing settings saved", { exact: true }),
    ).toBeVisible();
    if (self) {
      await page
        .getByLabel("My availability", { exact: true })
        .selectOption("away");
      await expect
        .poll(
          async () =>
            (await (await page.request.get(`${base}/routing`)).json()).self
              .state,
        )
        .toBe("away");
      await page.request.post(`${base}/routing/heartbeat`, { data: {} });
      expect(
        (await (await page.request.get(`${base}/routing`)).json()).self.state,
      ).toBe("away");
    }
    await page
      .getByRole("button", { name: "Human queue", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Waiting for a person", exact: true }),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "test-results/human-routing-mobile.png",
      fullPage: true,
      animations: "disabled",
    });
  } finally {
    await page.request.put(`${base}/routing/settings`, {
      data: {
        enabled: original.settings.enabled,
        defaultTeamId: original.settings.default_team_id,
        availabilityTtlSeconds: original.settings.availability_ttl_seconds,
      },
    });
    if (self)
      await page.request.put(`${base}/routing/availability`, {
        data: { state: self.state },
      });
    if (team)
      await page.request.post(`${base}/routing/teams`, {
        data: {
          id: team.id,
          name: team.name,
          description: team.description,
          active: false,
          routingEnabled: false,
          memberIds: team.member_ids,
        },
      });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.reload();
  }
}
