"use client";

import { useEffect } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import type { AppRouter } from "@/contracts/rpc";
import { configureQueryIdentity, getQueryRuntime, watchQueryChanges } from "@/lib/query-runtime";
import { useNoteStore } from "@/stores/use-note-store";
import { ApiError, asApiError } from "@/lib/api-error";
import { watchActionToastScope } from "@/lib/action-toasts";

export const { TRPCProvider, useTRPC } = createTRPCContext<AppRouter>();

configureQueryIdentity(() => {
  const { session, epoch } = useNoteStore.getState();
  return session ? { userId: session.user.id, workspaceId: session.workspace.id, epoch } : null;
});

export function QueryProvider({ children }: { children: React.ReactNode }) {
  useNoteStore(
    (state) => `${state.epoch}:${state.session?.user.id}:${state.session?.workspace.id}`,
  );
  const runtime = getQueryRuntime();
  useEffect(watchQueryChanges, []);
  useEffect(watchActionToastScope, []);
  useEffect(
    () =>
      useNoteStore.subscribe(() => {
        getQueryRuntime();
      }),
    [],
  );
  useEffect(
    () =>
      runtime.queryClient.getQueryCache().subscribe((event) => {
        if (
          event.type !== "updated" ||
          event.query.state.status !== "error" ||
          runtime !== getQueryRuntime()
        )
          return;
        const error = asApiError(event.query.state.error);
        if (error instanceof ApiError && error.status === 401 && useNoteStore.getState().session)
          useNoteStore.getState().clearSession();
      }),
    [runtime],
  );
  return (
    <QueryClientProvider key={runtime.scope} client={runtime.queryClient}>
      <TRPCProvider trpcClient={runtime.client} queryClient={runtime.queryClient}>
        {children}
      </TRPCProvider>
    </QueryClientProvider>
  );
}
