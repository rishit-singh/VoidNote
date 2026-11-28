import { Buffer } from "node:buffer";

import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";

import type { ResearchSource } from "../../ai/research/ports";
import type { ResearchFinding } from "../../contracts/research";
import {
  type ResearchLookupInput,
  researchLookupInputSchema,
  type SavedResearchMatch,
} from "../../contracts/research/lookup";
import { type Principal, WorkspaceError } from "../../contracts/workspace";
import { contactDetails } from "../contact-schema";
import type { Database } from "../repository";
import { researchItems } from "../research-schema";
import { people, workspaceMemberships, workspaces } from "../schema";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

const cursorSchema = z.object({
  workspaceId: z.uuid(),
  filter: z.string(),
  updatedAt: z.iso.datetime(),
  batchId: z.uuid(),
  personId: z.uuid(),
});

async function authorize(tx: Transaction, principal: Principal, workspaceId: string) {
  const [member] = await tx
    .select({ id: workspaceMemberships.userId })
    .from(workspaceMemberships)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, principal.id),
        isNull(workspaceMemberships.revokedAt),
        isNull(workspaces.deletedAt),
      ),
    )
    .for("share", { of: [workspaceMemberships, workspaces] })
    .limit(1);

  if (!member) {
    throw new WorkspaceError("forbidden", "Workspace access denied.");
  }
}

/** Retrieval time never substitutes for the date of a claim. */
export function researchEvidenceFreshness(
  findings: ResearchFinding[],
  maxAgeDays?: number,
  now = Date.now(),
): SavedResearchMatch["freshness"] {
  if (!findings.length || maxAgeDays === undefined) {
    return "unknown";
  }

  const dates = findings.map((finding) =>
    finding.citations.flatMap((citation) => (citation.asOf ? [Date.parse(citation.asOf)] : [])),
  );

  if (dates.some((values) => values.length === 0)) {
    return "unknown";
  }

  const cutoff = now - maxAgeDays * 86_400_000;

  return dates.every((values) => values.some((date) => date >= cutoff && date <= now))
    ? "within-requested-age"
    : "stale";
}

/** Read v1 evidence without copying its full source blobs into every tool response.
 * Results are candidates, never a claim that a new question has been answered.
 */
export function createResearchEvidenceRepository(db: Database) {
  return {
    async lookup(principal: Principal, workspaceId: string, value: Partial<ResearchLookupInput>) {
      const input = researchLookupInputSchema.parse(value);

      const filter = JSON.stringify({
        query: input.query,
        personIds: [...new Set(input.personIds)].sort(),
        maxAgeDays: input.maxAgeDays ?? null,
        includeActive: input.includeActive,
      });

      let cursor: z.infer<typeof cursorSchema> | undefined;

      if (input.cursor) {
        try {
          cursor = cursorSchema.parse(
            JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")),
          );

          if (cursor.workspaceId !== workspaceId || cursor.filter !== filter) {
            throw new Error("scope");
          }
        } catch {
          throw new WorkspaceError("invalid_cursor", "Research lookup filters changed.");
        }
      }

      return db.transaction(async (tx) => {
        await authorize(tx, principal, workspaceId);
        const escaped = input.query.replace(/[\\%_]/g, "\\$&");

        const pattern = `%${escaped}%`;

        const rows = await tx
          .select({
            batchId: researchItems.batchId,
            personId: researchItems.personId,
            displayName: researchItems.displayName,
            generation: researchItems.generation,
            status: researchItems.status,
            updatedAt: researchItems.updatedAt,
            profileRevision: researchItems.profileRevision,
            contactRevision: researchItems.contactRevision,
            currentProfileRevision: people.revision,
            currentContactRevision: contactDetails.revision,
            facts: researchItems.facts,
          })
          .from(researchItems)
          .innerJoin(
            people,
            and(
              eq(people.workspaceId, researchItems.workspaceId),
              eq(people.id, researchItems.personId),
              isNull(people.deletedAt),
            ),
          )
          .leftJoin(
            contactDetails,
            and(
              eq(contactDetails.workspaceId, researchItems.workspaceId),
              eq(contactDetails.personId, researchItems.personId),
            ),
          )
          .where(
            and(
              eq(researchItems.workspaceId, workspaceId),
              input.personIds.length ? inArray(researchItems.personId, input.personIds) : undefined,
              input.includeActive
                ? inArray(researchItems.status, ["queued", "running", "completed", "partial"])
                : inArray(researchItems.status, ["completed", "partial"]),
              input.query
                ? sql`(${researchItems.displayName} ilike ${pattern} or exists (
                    select 1 from jsonb_array_elements(${researchItems.facts}) as fact
                    where (fact->'finding'->>'question') ilike ${pattern}
                       or (fact->'finding'->>'answer') ilike ${pattern}
                  ) or exists (
                    select 1 from jsonb_array_elements(${researchItems.request}->'requestedFacts') as question
                    where (question->>'question') ilike ${pattern}
                  ))`
                : undefined,
              cursor
                ? or(
                    lt(researchItems.updatedAt, new Date(cursor.updatedAt)),
                    and(
                      eq(researchItems.updatedAt, new Date(cursor.updatedAt)),
                      lt(researchItems.batchId, cursor.batchId),
                    ),
                    and(
                      eq(researchItems.updatedAt, new Date(cursor.updatedAt)),
                      eq(researchItems.batchId, cursor.batchId),
                      lt(researchItems.personId, cursor.personId),
                    ),
                  )
                : undefined,
            ),
          )
          .orderBy(
            desc(researchItems.updatedAt),
            desc(researchItems.batchId),
            desc(researchItems.personId),
          )
          .limit(input.limit + 1);

        const selected = rows.slice(0, input.limit);

        const items: SavedResearchMatch[] = selected.map((row) => {
          const findings = row.facts.flatMap((fact) =>
            fact.state === "completed" && fact.finding ? [fact.finding] : [],
          );

          return {
            batchId: row.batchId,
            personId: row.personId,
            displayName: row.displayName,
            generation: row.generation,
            status: row.status,
            updatedAt: row.updatedAt.toISOString(),
            identityCurrent:
              row.profileRevision === row.currentProfileRevision &&
              row.contactRevision === (row.currentContactRevision ?? 0),
            freshness: researchEvidenceFreshness(findings, input.maxAgeDays),
            findings,
          };
        });

        const last = selected.at(-1);

        return {
          items,
          match: "literal" as const,
          nextCursor:
            rows.length > input.limit && last
              ? Buffer.from(
                  JSON.stringify({
                    workspaceId,
                    filter,
                    updatedAt: last.updatedAt.toISOString(),
                    batchId: last.batchId,
                    personId: last.personId,
                  }),
                ).toString("base64url")
              : null,
        };
      });
    },

    /** Internal bounded reuse of immutable saved pages. Publication still pins
     * these snapshots in its own run; never reuse solely by a person's name.
     */
    async reusableSources(
      principal: Principal,
      workspaceId: string,
      personId: string,
      maxBytes = 48_000,
    ): Promise<ResearchSource[]> {
      return db.transaction(async (tx) => {
        await authorize(tx, principal, workspaceId);
        const rows = await tx
          .select({ sources: researchItems.sources })
          .from(researchItems)
          .innerJoin(
            people,
            and(
              eq(people.workspaceId, researchItems.workspaceId),
              eq(people.id, researchItems.personId),
              eq(people.revision, researchItems.profileRevision),
              isNull(people.deletedAt),
            ),
          )
          .leftJoin(
            contactDetails,
            and(
              eq(contactDetails.workspaceId, researchItems.workspaceId),
              eq(contactDetails.personId, researchItems.personId),
            ),
          )
          .where(
            and(
              eq(researchItems.workspaceId, workspaceId),
              eq(researchItems.personId, personId),
              inArray(researchItems.status, ["completed", "partial"]),
              sql`${researchItems.contactRevision} = coalesce(${contactDetails.revision}, 0)`,
            ),
          )
          .orderBy(desc(researchItems.updatedAt), desc(researchItems.batchId))
          .limit(3);

        const output: ResearchSource[] = [];

        const digests = new Set<string>();

        let bytes = 0;

        for (const row of rows) {
          for (const source of row.sources) {
            const size = new TextEncoder().encode(source.text).byteLength;

            if (digests.has(source.digest) || bytes + size > Math.min(128_000, maxBytes)) {
              continue;
            }

            output.push(source);
            digests.add(source.digest);
            bytes += size;

            if (output.length === 4) {
              return output;
            }
          }
        }

        return output;
      });
    },
  };
}
