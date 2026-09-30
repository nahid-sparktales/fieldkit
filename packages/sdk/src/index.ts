export class FieldKitClient {
  constructor(
    private options: {
      url: string;
      workspaceId: string;
      token: string;
      customerId?: string;
    },
  ) {}
  private async call(path: string, data?: unknown) {
    const response = await fetch(
      `${this.options.url.replace(/\/$/, "")}/v2/workspaces/${encodeURIComponent(this.options.workspaceId)}${path}`,
      {
        method: data === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          "Content-Type": "application/json",
        },
        body: data === undefined ? undefined : JSON.stringify(data),
      },
    );
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.error ?? `FieldKit returned ${response.status}`);
    return result;
  }
  identify(input: {
    externalCustomerId: string;
    name: string;
    email?: string;
  }): Promise<{ id: string }> {
    return this.call("/identities", input);
  }
  request(input: {
    externalCustomerId: string;
    body: string;
    requestKey: string;
    channelId?: string;
  }): Promise<{ id: string; status: string }> {
    return this.call("/requests", input);
  }
  reply(
    conversationId: string,
    input: { externalCustomerId: string; body: string; requestKey: string },
  ) {
    return this.call(
      `/requests/${encodeURIComponent(conversationId)}/messages`,
      input,
    );
  }
  status(conversationId: string): Promise<{
    id: string;
    status: string;
    mode: string;
    messages: {
      id: string;
      role: string;
      body: string;
      citations: unknown[];
      created_at: string;
    }[];
  }> {
    return this.call(
      "/requests/" +
        encodeURIComponent(conversationId) +
        (this.options.customerId
          ? "?externalCustomerId=" + encodeURIComponent(this.options.customerId)
          : ""),
    );
  }
}
