import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { chromium, type Page } from "@playwright/test";
import { z } from "zod";

const stagingHost = "voidnote-staging.rsrishitsingh.workers.dev";
const stagingSupabaseHost = "csmrsgywdosnrcfmnmuj.supabase.co";
const workspaceId = "094563d2-f5ad-4a0f-ad8e-c9a9a5d4f533";
const authCookieName = "voidnote-auth";
const officialSources = [
  "https://science.nasa.gov/mission/msl-curiosity/",
  "https://science.nasa.gov/mission/mars-2020-perseverance/",
] as const;
const userIdSchema = z.uuid();

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} in the environment; do not pass secrets as arguments.`);
  return value;
}

function parseArguments(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      url: { type: "string" },
      workspace: { type: "string" },
      user: { type: "string" },
      preflight: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (!values.url || !values.workspace || !values.user) {
    throw new Error(
      "Usage: bun scripts/check-staging-research.ts --url https://voidnote-staging.rsrishitsingh.workers.dev --workspace 094563d2-f5ad-4a0f-ad8e-c9a9a5d4f533 --user <existing-user-uuid> [--preflight]",
    );
  }
  assert.equal(values.workspace, workspaceId, "Only the authorized staging workspace is allowed.");

  const url = new URL(values.url);
  assert.equal(url.protocol, "https:", "Staging acceptance requires HTTPS.");
  assert.equal(
    url.hostname,
    stagingHost,
    "Refusing any origin other than the configured staging host.",
  );
  assert.equal(url.pathname, "/");
  assert.equal(url.search, "");
  assert.equal(url.hash, "");

  return {
    baseUrl: url.origin,
    userId: userIdSchema.parse(values.user),
    preflight: values.preflight,
  };
}

async function sessionFor(page: Page) {
  const response = await page.request.get(new URL("/api/session", page.url()).href);
  assert.equal(response.status(), 200, "Authenticated browser session must load.");
  return z
    .object({
      user: z.object({ id: z.uuid() }),
      workspace: z.object({ id: z.uuid() }),
    })
    .parse(await response.json());
}

async function main() {
  const { baseUrl, userId, preflight } = parseArguments(process.argv.slice(2));
  const supabaseUrl = requiredEnvironment("STAGING_SUPABASE_URL");
  const serviceRoleKey = requiredEnvironment("STAGING_SUPABASE_SERVICE_ROLE_KEY");
  const publishableKey = requiredEnvironment("STAGING_SUPABASE_PUBLISHABLE_KEY");
  assert.equal(new URL(supabaseUrl).hostname, stagingSupabaseHost);

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: userResult, error: userError } = await supabase.auth.admin.getUserById(userId);
  if (userError) throw new Error("Could not resolve the authorized staging user.");
  assert.equal(userResult.user.id, userId);
  assert.ok(userResult.user.email, "The authorized staging user must have an email.");

  const { data: linkResult, error: linkError } = await supabase.auth.admin.generateLink({
    type: "magiclink",
    email: userResult.user.email,
  });
  if (linkError || !linkResult.properties.hashed_token) {
    throw new Error("Could not create a staging sign-in link.");
  }

  // The app callback exchanges only a PKCE `code`. Instead verify the
  // admin-issued magic-link hash through Supabase SSR and transfer the exact
  // app cookies into this isolated browser context.
  const cookieJar = new Map<string, { name: string; value: string; options: CookieOptions }>();
  const auth = createServerClient(supabaseUrl, publishableKey, {
    cookieOptions: {
      name: authCookieName,
      path: "/",
      sameSite: "lax",
      httpOnly: true,
      secure: true,
    },
    cookies: {
      getAll: () => [...cookieJar.values()].map(({ name, value }) => ({ name, value })),
      setAll: (cookiesToSet) => {
        for (const cookie of cookiesToSet) {
          if (cookie.options.maxAge === 0) cookieJar.delete(cookie.name);
          else cookieJar.set(cookie.name, cookie);
        }
      },
    },
  });
  const { data: verified, error: verifyError } = await auth.auth.verifyOtp({
    token_hash: linkResult.properties.hashed_token,
    type: "magiclink",
  });
  if (verifyError || verified.user?.id !== userId || cookieJar.size === 0) {
    throw new Error("Staging magic-link verification did not establish the authorized session.");
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.addCookies(
    [...cookieJar.values()].map(({ name, value, options }) => ({
      name,
      value,
      domain: new URL(baseUrl).hostname,
      path: options.path ?? "/",
      httpOnly: options.httpOnly ?? true,
      secure: options.secure ?? true,
      sameSite:
        options.sameSite === "strict"
          ? ("Strict" as const)
          : options.sameSite === "none"
            ? ("None" as const)
            : ("Lax" as const),
      ...(options.maxAge === undefined
        ? {}
        : { expires: Math.floor(Date.now() / 1000) + options.maxAge }),
      ...(options.expires === undefined
        ? {}
        : { expires: Math.floor(options.expires.getTime() / 1000) }),
    })),
  );
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    // Admin-issued authentication; this does not exercise email delivery.
    await page.goto(baseUrl);
    const session = await sessionFor(page);
    assert.equal(session.user.id, userId, "Magic-link session resolved to the wrong user.");
    assert.equal(
      session.workspace.id,
      workspaceId,
      "Authenticated user is in the wrong workspace.",
    );

    await page.getByRole("button", { name: "New note" }).click();
    await page.waitForURL((url) => /^\/notes\/[0-9a-f-]{36}$/.test(url.pathname), {
      timeout: 15_000,
    });
    const noteId = z.uuid().parse(new URL(page.url()).pathname.split("/").at(-1));
    console.log(JSON.stringify({ checkpoint: "staging-note-created", noteId }));
    const title = page.getByLabel("Title", { exact: true });
    await title.fill(`Staging research acceptance ${new Date().toISOString()}`);
    await title.waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Ask", exact: true }).waitFor({
      state: "visible",
      timeout: 30_000,
    });
    if (preflight) {
      console.log(
        JSON.stringify({
          result: "authenticated-browser-and-note-preflight-passed",
          authSetup: "admin-issued magic-link token verified through Supabase SSR; no email sent",
          stagingHost,
          userId,
          workspaceId,
          noteId,
          stoppedBefore: "assistant Send",
        }),
      );
      return;
    }

    await page.getByRole("button", { name: "Ask", exact: true }).click();
    const panel = page.getByRole("region", { name: "Assistant", exact: true });
    const composer = panel.getByRole("textbox", { name: "Message Assistant" });
    await composer.waitFor({ state: "visible" });

    const question = [
      "Using only these two official NASA mission pages, compare Curiosity and Perseverance by",
      "their Mars landing dates and principal mission objectives. Start one research task with",
      "these exact source URLs, disable source discovery, and do not answer until the saved report",
      "is available. Cite the passages and clearly say if either page does not establish a detail.",
      ...officialSources,
    ].join(" ");
    await composer.fill(question);
    await panel.getByRole("button", { name: "Send", exact: true }).click();

    const tasks = panel.getByRole("region", { name: "Research tasks", exact: true });
    await tasks.waitFor({ state: "visible", timeout: 180_000 });
    const runLinks = tasks.locator('a[href^="/research/"]');
    await runLinks.first().waitFor({ state: "visible", timeout: 60_000 });
    const href = await runLinks.first().getAttribute("href");
    assert.ok(href);
    const runId = z.uuid().parse(href.split("/").at(-1));
    console.log(JSON.stringify({ checkpoint: "research-accepted", noteId, runId }));

    await page.goto(new URL(href, baseUrl).href);
    await page.getByRole("heading", { name: "Research", exact: true }).waitFor();
    await page.getByText("Completed", { exact: true }).waitFor({ timeout: 12 * 60_000 });
    await page.getByLabel("Result quality: Answered").waitFor();

    const answer = page.locator("main").getByText(/Curiosity|Perseverance/);
    await answer.first().waitFor();
    const reportText = await page.locator("main").innerText();
    assert.match(reportText, /Curiosity/i);
    assert.match(reportText, /Perseverance/i);
    assert.match(reportText, /2012|August 2012/i);
    assert.match(reportText, /2021|February 2021/i);

    const citations = page.locator('main a[href^="https://science.nasa.gov/mission/"]');
    const citationHrefs: string[] = [];
    for (let index = 0; index < (await citations.count()); index += 1) {
      const href = await citations.nth(index).getAttribute("href");
      if (href) citationHrefs.push(href);
    }
    assert.ok(
      officialSources.every((source) => citationHrefs.some((href) => href.startsWith(source))),
      "Completed report must cite both supplied NASA mission pages.",
    );
    assert.ok((await page.locator("main blockquote").count()) >= 2, "Expected quoted evidence.");

    const savedReport = reportText;
    await page.reload();
    await page.getByText("Completed", { exact: true }).waitFor();
    assert.equal(
      await page.locator("main").innerText(),
      savedReport,
      "Reload changed the saved report.",
    );

    const noteHref = await noteHrefFromReport(page);
    await page.goto(new URL(noteHref, baseUrl).href);
    const savedTasks = page.getByRole("region", { name: "Research tasks", exact: true });
    await savedTasks.waitFor({ state: "visible" });
    assert.equal(
      await savedTasks.locator(`a[href="/research/${runId}"]`).count(),
      1,
      "The completed run must remain linked from the originating assistant thread.",
    );
    assert.deepEqual(pageErrors, [], "Browser raised a page error.");

    console.log(
      JSON.stringify(
        {
          result: "browser-and-persistence-checks-passed",
          stagingHost,
          userId,
          workspaceId,
          runId,
          question,
          status: "completed",
          citedSources: [...new Set(citationHrefs)],
          answer: reportText,
          semanticReviewRequired: true,
          caveat:
            "This runner checks real authenticated UI, saved report reload, quote presence and source links. Independently compare each quoted passage and claim to NASA text before declaring semantic acceptance; verify telemetry, usage settlement, reuse and activity delivery separately.",
        },
        null,
        2,
      ),
    );
  } finally {
    await context.close();
    await browser.close();
  }
}

async function noteHrefFromReport(page: Page) {
  const backToNote = page.getByRole("link", { name: "Back to note", exact: true });
  const href = await backToNote.getAttribute("href");
  if (!href?.startsWith("/notes/"))
    throw new Error("Research report did not link back to its note.");
  z.uuid().parse(href.split("/").at(-1));
  return href;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Staging research acceptance failed.");
  process.exitCode = 1;
});
