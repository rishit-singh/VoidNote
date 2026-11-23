"use client";

import type { CSSProperties } from "react";
import { Toaster as Sonner } from "sonner";
import { useTheme } from "@/components/theme-provider";
import { useNoteStore } from "@/stores/use-note-store";

export function Toaster() {
  const { theme } = useTheme();
  const scope = useNoteStore(
    (state) => `${state.epoch}:${state.session?.user.id}:${state.session?.workspace.id}`,
  );
  return (
    <Sonner
      key={scope}
      theme={theme}
      className="toaster group"
      position="top-right"
      closeButton
      containerAriaLabel="Notifications"
      offset={{ top: "24px", right: "24px" }}
      mobileOffset={{
        top: "calc(env(safe-area-inset-top, 0px) + 16px)",
        left: "16px",
        right: "16px",
      }}
      style={
        {
          "--normal-bg": "hsl(var(--popover))",
          "--normal-text": "hsl(var(--popover-foreground))",
          "--normal-border": "hsl(var(--border))",
          "--border-radius": "var(--radius)",
        } as CSSProperties
      }
      toastOptions={{
        closeButtonAriaLabel: "Dismiss notification",
        classNames: {
          toast: "font-mono",
          description: "!text-muted-foreground",
          actionButton: "!bg-primary !text-primary-foreground",
          cancelButton: "!bg-muted !text-muted-foreground",
        },
      }}
    />
  );
}
