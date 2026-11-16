import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function AuthErrorPage() {
  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 p-8">
      <h1 className="text-xl font-semibold">Unable to sign in</h1>
      <p className="text-sm text-muted-foreground">
        Sign-in was cancelled or could not be completed. Try your provider again, or request a new
        email link and open it in the same browser where you requested it.
      </p>
      <Button asChild>
        <Link href="/">Back to sign in</Link>
      </Button>
    </main>
  );
}
