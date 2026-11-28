const API_BASE = "https://backend.composio.dev/api/v3.1";
export const SLACK_SEND_MESSAGE_TOOL = "SLACK_SEND_MESSAGE";

export class ComposioHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Composio request failed (${status})`);
    this.name = "ComposioHttpError";
    this.status = status;
  }
}
export type ComposioClient = {
  createSlackLink(input: {
    userId: string;
    authConfigId: string;
    callbackUrl: string;
  }): Promise<{ connectedAccountId: string; redirectUrl: string; expiresAt: string }>;
  listSlackAccounts(input: { userId: string }): Promise<Array<{ id: string; status: string }>>;
  executeSlackMessage(input: {
    userId: string;
    connectedAccountId: string;
    channelId: string;
    text: string;
  }): Promise<{
    successful: boolean;
    requestId: string | null;
    data: Record<string, unknown>;
  }>;
};

export function createComposioClient(options: {
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  toolVersion: string;
}): ComposioClient {
  const fetcher = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  async function request(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    const response = await fetcher(`${API_BASE}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-api-key": options.apiKey,
        ...init.headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      // Do not propagate provider bodies; they may contain auth or user data.
      throw new ComposioHttpError(response.status);
    }
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("Composio returned an invalid response");
    }
    return body as Record<string, unknown>;
  }

  return {
    async createSlackLink(input) {
      const body = await request("/connected_accounts/link", {
        method: "POST",
        body: JSON.stringify({
          auth_config_id: input.authConfigId,
          user_id: input.userId,
          callback_url: input.callbackUrl,
          alias: "VoidNote Slack",
        }),
      });
      if (
        typeof body.connected_account_id !== "string" ||
        typeof body.redirect_url !== "string" ||
        typeof body.expires_at !== "string" ||
        !body.redirect_url.startsWith("https://")
      ) {
        throw new Error("Composio returned an invalid connection link");
      }
      return {
        connectedAccountId: body.connected_account_id,
        redirectUrl: body.redirect_url,
        expiresAt: body.expires_at,
      };
    },
    async listSlackAccounts(input) {
      const query = new URLSearchParams({
        toolkit_slugs: "slack",
        user_ids: input.userId,
        limit: "50",
      });
      const body = await request(`/connected_accounts?${query}`, { method: "GET" });
      if (!Array.isArray(body.items)) {
        throw new Error("Composio returned an invalid account list");
      }
      return body.items.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const record = item as Record<string, unknown>;
        return typeof record.id === "string" && typeof record.status === "string"
          ? [{ id: record.id, status: record.status }]
          : [];
      });
    },
    async executeSlackMessage(input) {
      const body = await request(`/tools/execute/${SLACK_SEND_MESSAGE_TOOL}`, {
        method: "POST",
        body: JSON.stringify({
          user_id: input.userId,
          connected_account_id: input.connectedAccountId,
          version: options.toolVersion,
          arguments: {
            channel: input.channelId,
            markdown_text: input.text,
          },
        }),
      });
      if (typeof body.successful !== "boolean") {
        throw new Error("Composio returned an invalid execution result");
      }
      const data =
        body.data && typeof body.data === "object" && !Array.isArray(body.data)
          ? (body.data as Record<string, unknown>)
          : {};
      return {
        successful: body.successful,
        requestId: typeof body.log_id === "string" ? body.log_id : null,
        data,
      };
    },
  };
}
