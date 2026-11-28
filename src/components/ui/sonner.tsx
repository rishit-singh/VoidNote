"use client";

import { Toaster as SonnerToaster } from "sonner";

export function Toaster() {
  return (
    <SonnerToaster
      theme="dark"
      position="bottom-right"
      closeButton
      toastOptions={{
        classNames: {
          toast: "border border-vn-stroke bg-vn-sidebar font-mono text-vn-text",
          description: "text-vn-muted",
          actionButton: "bg-vn-text text-vn-page",
          cancelButton: "bg-vn-hover text-vn-text",
        },
      }}
    />
  );
}
