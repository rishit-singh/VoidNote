import { z } from "zod";
import type { Session } from "@/contracts/workspace";

const commandSchema = z
  .object({
    workspaceId: z.string().uuid(),
    userId: z.string().uuid(),
    noteId: z.string().uuid(),
    commandId: z.string().uuid(),
    status: z.enum(["pending", "rejected"]).default("pending"),
    rejection: z.string().max(1000).nullable().default(null),
  })
  .strict();
export type PendingSummaryCommand = z.infer<typeof commandSchema>;

/** One persisted command per note. Unknown outcomes retain the exact command for explicit retry. */
export function pendingSummaryCommands(session: Session) {
  const scope = { userId: session.user.id, workspaceId: session.workspace.id };
  const key = `voidnote:pending-summaries:v1:${scope.userId}:${scope.workspaceId}`;
  const snapshot = () => {
    try {
      const raw = localStorage.getItem(key);
      const saved = raw ? z.array(commandSchema).parse(JSON.parse(raw) as unknown) : [];
      return {
        commands: saved.filter(
          (command) => command.userId === scope.userId && command.workspaceId === scope.workspaceId,
        ),
        error: null,
      };
    } catch (error) {
      return {
        commands: [] as PendingSummaryCommand[],
        error: error instanceof Error ? error : new Error("Saved summary recovery is unavailable."),
      };
    }
  };
  const read = () => {
    const result = snapshot();
    if (result.error) throw result.error;
    return result.commands;
  };
  const write = (commands: PendingSummaryCommand[]) =>
    localStorage.setItem(key, JSON.stringify(commands.map((item) => commandSchema.parse(item))));
  const prepare = (noteId: string) => {
    const existing = read().find((item) => item.noteId === noteId);
    if (existing) return existing;
    const command: PendingSummaryCommand = {
      ...scope,
      noteId,
      commandId: crypto.randomUUID(),
      status: "pending",
      rejection: null,
    };
    write([...read(), command]);
    return command;
  };

  return {
    read,
    snapshot,
    prepare,
    async prepareExclusive(noteId: string) {
      if (typeof navigator !== "undefined" && navigator.locks) {
        return navigator.locks.request(`${key}:${noteId}`, () => prepare(noteId));
      }
      return prepare(noteId);
    },
    forNote(noteId: string) {
      return read().find((command) => command.noteId === noteId) ?? null;
    },
    acknowledge(command: PendingSummaryCommand) {
      write(
        read().filter(
          (saved) => saved.noteId !== command.noteId || saved.commandId !== command.commandId,
        ),
      );
    },
    reject(command: PendingSummaryCommand, reason: string) {
      const current = read();
      write(
        current.map((saved) =>
          saved.noteId === command.noteId && saved.commandId === command.commandId
            ? { ...saved, status: "rejected", rejection: reason.slice(0, 1000) }
            : saved,
        ),
      );
    },
  };
}
