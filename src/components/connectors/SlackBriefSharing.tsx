"use client";

import { useEffect, useState } from "react";

import type { ConnectorStatus } from "@/contracts/connectors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Receipt = ConnectorStatus["receipts"][number];
type SavedBrief = { id: string; name: string };
type ShareCommand = {
  userId: string;
  workspaceId: string;
  briefId: string;
  channelId: string;
  operationId: string;
};
type ShareInput = Omit<ShareCommand, "userId">;

export function SlackBriefSharing(props: {
  userId: string;
  workspaceId: string;
  status: ConnectorStatus;
  briefs: SavedBrief[];
  briefsLoading?: boolean;
  onConnect(input: { workspaceId: string; operationId: string }): Promise<
    | {
        kind: "redirect";
        redirectUrl: string;
        expiresAt: string;
        usageStatus: "unreported";
      }
    | {
        kind: "receipt";
        operationId: string;
        status: "linked" | "failed" | "unknown";
        usageStatus: "unreported";
      }
  >;
  onShare(input: ShareInput): Promise<{
    status: "sent" | "failed" | "unknown";
    usageStatus: "unreported";
  }>;
}) {
  const [briefId, setBriefId] = useState("");
  const [channelId, setChannelId] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pendingCommand, setPendingCommand] = useState<ShareCommand | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [storageFailure, setStorageFailure] = useState(false);
  const storageKey = `voidnote:slack-share:${props.userId}:${props.workspaceId}`;

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      try {
        const raw = sessionStorage.getItem(storageKey);
        const value: unknown = raw ? JSON.parse(raw) : null;
        if (!active) return;
        if (
          value &&
          typeof value === "object" &&
          "userId" in value &&
          value.userId === props.userId &&
          "workspaceId" in value &&
          value.workspaceId === props.workspaceId &&
          "briefId" in value &&
          typeof value.briefId === "string" &&
          "channelId" in value &&
          typeof value.channelId === "string" &&
          "operationId" in value &&
          typeof value.operationId === "string"
        ) {
          const command = value as ShareCommand;
          setPendingCommand(command);
          setBriefId(command.briefId);
          setChannelId(command.channelId);
        }
        setStorageReady(true);
      } catch {
        if (active) setStorageFailure(true);
      }
    });
    return () => {
      active = false;
    };
  }, [props.userId, props.workspaceId, storageKey]);

  async function connect() {
    setPending(true);
    setMessage(null);
    try {
      const key = `voidnote:slack-connect:${props.userId}:${props.workspaceId}`;
      const storedOperationId = sessionStorage.getItem(key);
      const unresolvedReceipt = props.status.linkReceipts.find(
        (receipt) => receipt.status === "in_flight" || receipt.status === "unknown",
      );
      const storedReceipt = props.status.linkReceipts.find(
        (receipt) => receipt.operationId === storedOperationId,
      );
      const operationId =
        unresolvedReceipt?.operationId ??
        (storedReceipt ? crypto.randomUUID() : storedOperationId) ??
        crypto.randomUUID();
      if (operationId !== storedOperationId) {
        sessionStorage.setItem(key, operationId);
      }
      const result = await props.onConnect({ workspaceId: props.workspaceId, operationId });
      if (result.kind === "redirect") {
        window.location.assign(result.redirectUrl);
      } else {
        if (result.status === "linked" || result.status === "failed") {
          sessionStorage.removeItem(key);
        }
        setMessage(
          result.status === "unknown"
            ? "Slack authorization outcome is unknown. This request will not be resent; check the receipt before starting another."
            : `The previous authorization link is ${result.status}. You can explicitly start a new authorization.`,
        );
        setPending(false);
      }
    } catch {
      setMessage("Slack connection could not be confirmed. The same request will not be resent.");
      setPending(false);
    }
  }

  async function share() {
    setMessage(null);
    let command = pendingCommand;
    if (!command) {
      command = {
        userId: props.userId,
        workspaceId: props.workspaceId,
        briefId,
        channelId,
        operationId: crypto.randomUUID(),
      };
      try {
        // The exact immutable intent must reach durable browser storage before
        // the mutation is allowed to cross the network boundary.
        sessionStorage.setItem(storageKey, JSON.stringify(command));
      } catch {
        setStorageFailure(true);
        setMessage("This device cannot save the share request safely. Nothing was sent.");
        return;
      }
      setPendingCommand(command);
    }

    setPending(true);
    try {
      const result = await props.onShare({
        workspaceId: command.workspaceId,
        briefId: command.briefId,
        channelId: command.channelId,
        operationId: command.operationId,
      });
      if (result.status === "unknown") {
        setMessage(
          "Slack may have received this brief. Check this same operation; do not create another share.",
        );
      } else {
        sessionStorage.removeItem(storageKey);
        setPendingCommand(null);
        setMessage(
          result.status === "sent"
            ? "Brief shared in Slack. Provider usage was not reported; the budget hold remains."
            : "Slack did not confirm the share. Provider usage was not reported; the budget hold remains.",
        );
      }
    } catch {
      setMessage(
        "The result is uncertain. Check this same operation; do not create another share.",
      );
    } finally {
      setPending(false);
    }
  }

  const connected = props.status.connection === "connected";
  const connectionPending = props.status.connection === "pending";
  const lockIntent = pendingCommand !== null;
  const unresolvedReceipt = props.status.receipts.some(
    (receipt) =>
      receipt.status === "unknown" && receipt.operationId !== pendingCommand?.operationId,
  );
  const canSubmit =
    storageReady &&
    !storageFailure &&
    !pending &&
    !unresolvedReceipt &&
    (lockIntent || (Boolean(briefId) && Boolean(channelId))) &&
    props.status.budgetConfigured;

  return (
    <section className="flex flex-col gap-4 py-7" aria-labelledby="slack-sharing-title">
      <div>
        <h2 id="slack-sharing-title" className="m-0 text-base font-medium text-vn-text">
          Slack
        </h2>
        <p className="m-0 mt-1 text-sm text-vn-muted">
          Connect a Slack account, then explicitly share a saved brief to a channel.
        </p>
      </div>
      <p className="m-0 text-sm text-vn-muted">
        Composio does not report billable usage for these operations. The configured amount is only
        a reservation bound; its budget hold remains until authoritative usage is available.
      </p>
      {!props.status.configured && (
        <p className="m-0 text-sm text-vn-muted">Slack sharing is not configured.</p>
      )}
      {props.status.configured && connectionPending && (
        <p role="status" className="m-0 text-sm text-vn-muted">
          Slack authorization is pending. Complete the open flow, or start a new authorization if
          that flow was cancelled or expired.
        </p>
      )}
      {props.status.configured && !connected && (
        <Button className="self-start" disabled={pending} onClick={() => void connect()}>
          {pending
            ? "Checking Slack authorization…"
            : props.status.linkReceipts.some(
                  (receipt) => receipt.status === "unknown" || receipt.status === "in_flight",
                )
              ? "Check existing authorization"
              : props.status.connection === "pending" || props.status.connection === "revoked"
                ? "Start new Slack authorization"
                : "Connect Slack"}
        </Button>
      )}
      {connected && (
        <div className="grid max-w-[520px] gap-3">
          <label className="grid gap-1 text-sm text-vn-secondary">
            Saved brief
            <select
              className="h-9 rounded-md border border-vn-stroke bg-transparent px-3"
              value={briefId}
              disabled={lockIntent || !storageReady}
              onChange={(event) => setBriefId(event.target.value)}
            >
              <option value="">Choose a saved brief</option>
              {props.briefs.map((brief) => (
                <option key={brief.id} value={brief.id}>
                  {brief.name}
                </option>
              ))}
            </select>
          </label>
          {props.briefsLoading && (
            <p role="status" className="m-0 text-sm text-vn-muted">
              Loading saved briefs…
            </p>
          )}
          <Input
            aria-label="Slack channel ID"
            placeholder="Slack channel ID (for example, C012ABC)"
            value={channelId}
            disabled={lockIntent || !storageReady}
            onChange={(event) => setChannelId(event.target.value)}
          />
          <Button className="self-start" disabled={!canSubmit} onClick={() => void share()}>
            {pending
              ? "Checking share…"
              : lockIntent
                ? "Check existing share"
                : "Share saved brief"}
          </Button>
          {!props.status.budgetConfigured && (
            <p className="m-0 text-sm text-vn-muted">
              Sharing requires a configured service budget and operation bound.
            </p>
          )}
          {unresolvedReceipt && (
            <p className="m-0 text-sm text-vn-muted">
              A previous Slack share has an unknown outcome. Resolve it before starting another
              share.
            </p>
          )}
          {storageFailure && (
            <p className="m-0 text-sm text-vn-muted">
              Pending share storage is unavailable; no external operation will be sent.
            </p>
          )}
        </div>
      )}
      {message && (
        <p role="status" className="m-0 text-sm text-vn-secondary">
          {message}
        </p>
      )}
      {props.status.receipts.length > 0 && (
        <ul className="m-0 grid max-w-[680px] gap-2 pl-5 text-sm text-vn-secondary">
          {props.status.receipts.map((receipt: Receipt) => (
            <li key={receipt.operationId}>
              {receipt.status === "unknown"
                ? "Share outcome unknown — do not create a new operation."
                : `Share ${receipt.status}`}{" "}
              · {receipt.channelId} · {new Date(receipt.createdAt).toLocaleString()}
              {receipt.messageUrl && (
                <>
                  {" · "}
                  <a href={receipt.messageUrl} target="_blank" rel="noreferrer">
                    Open message
                  </a>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
