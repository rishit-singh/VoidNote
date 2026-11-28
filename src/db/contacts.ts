import { createHash } from "node:crypto";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import {
  contactDetailsSchema,
  saveContactDetailsSchema,
  type SaveContactDetails,
} from "../contracts/contacts";
import { type Principal, WorkspaceError } from "../contracts/workspace";
import { appendApplicationEvent } from "./activity";
import { assistantProfileChanges } from "./assistant-profiles-schema";
import { fingerprint } from "./assistant/shared";
import { contactDetails, contactReceipts } from "./contact-schema";
import type { Database } from "./repository";
import { people, workspaceMemberships, workspaces } from "./schema";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

async function authorize(tx: Transaction, principal: Principal, workspaceId: string) {
  const [membership] = await tx
    .select({ id: workspaces.id })
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
    .for("share");

  if (!membership) {
    throw new WorkspaceError("forbidden", "Workspace is unavailable.");
  }
}

export function createContactRepository(db: Database) {
  return {
    async getMany(principal: Principal, workspaceId: string, personIds: string[]) {
      if (personIds.length > 30) {
        throw new WorkspaceError("conflict", "Read at most thirty contacts at once.");
      }

      return db.transaction(async (tx) => {
        await authorize(tx, principal, workspaceId);

        if (personIds.length === 0) {
          return [];
        }

        const rows = await tx
          .select({
            personId: people.id,
            displayName: people.displayName,
            description: people.description,
            personRevision: people.revision,
            organization: contactDetails.organization,
            role: contactDetails.role,
            links: contactDetails.links,
            revision: contactDetails.revision,
            updatedAt: contactDetails.updatedAt,
          })
          .from(people)
          .leftJoin(
            contactDetails,
            and(
              eq(contactDetails.workspaceId, people.workspaceId),
              eq(contactDetails.personId, people.id),
            ),
          )
          .where(
            and(
              eq(people.workspaceId, workspaceId),
              inArray(people.id, personIds),
              isNull(people.deletedAt),
            ),
          );

        return rows.map((row) => ({
          ...row,
          organization: row.organization ?? "",
          role: row.role ?? "",
          links: row.links ?? [],
          revision: row.revision ?? 0,
          updatedAt: row.updatedAt?.toISOString() ?? null,
        }));
      });
    },

    async save(principal: Principal, value: SaveContactDetails) {
      const input = saveContactDetailsSchema.parse(value);
      const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");

      return db.transaction(async (tx) => {
        await authorize(tx, principal, input.workspaceId);
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`${input.workspaceId}:profile-fields`}, 0))`,
        );

        // The person lock serializes contact updates and profile deletion.
        const [person] = await tx
          .select({ id: people.id, revision: people.revision })
          .from(people)
          .where(
            and(
              eq(people.workspaceId, input.workspaceId),
              eq(people.id, input.personId),
              isNull(people.deletedAt),
            ),
          )
          .for("update");

        if (!person) {
          throw new WorkspaceError("not_found", "Contact is unavailable.");
        }

        // Workspace-wide operation identity also serializes accidental reuse on
        // another person, without changing the established person lock order.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`${input.workspaceId}:${input.operationId}`}, 0))`,
        );

        const [receipt] = await tx
          .select()
          .from(contactReceipts)
          .where(
            and(
              eq(contactReceipts.workspaceId, input.workspaceId),
              eq(contactReceipts.operationId, input.operationId),
            ),
          );

        if (receipt) {
          if (receipt.actorId !== principal.id || receipt.fingerprint !== hash) {
            throw new WorkspaceError("command_reused", "Contact update identity was reused.");
          }

          const [latest] = await tx
            .select()
            .from(contactDetails)
            .where(
              and(
                eq(contactDetails.workspaceId, input.workspaceId),
                eq(contactDetails.personId, input.personId),
              ),
            );

          if (!latest) {
            throw new WorkspaceError("not_found", "Contact details are unavailable.");
          }

          return contactDetailsSchema.parse({
            ...latest,
            updatedAt: latest.updatedAt.toISOString(),
          });
        }

        const [current] = await tx
          .select()
          .from(contactDetails)
          .where(
            and(
              eq(contactDetails.workspaceId, input.workspaceId),
              eq(contactDetails.personId, input.personId),
            ),
          );

        if ((current?.revision ?? 0) !== input.expectedRevision) {
          throw new WorkspaceError("conflict", "Contact details changed. Reload before saving.");
        }

        const values = {
          ...input.fields,
          revision: input.expectedRevision + 1,
          updatedAt: new Date(),
        };
        const [saved] = await tx
          .insert(contactDetails)
          .values({
            workspaceId: input.workspaceId,
            personId: input.personId,
            ...values,
          })
          .onConflictDoUpdate({
            target: [contactDetails.workspaceId, contactDetails.personId],
            set: values,
          })
          .returning();
        const result = contactDetailsSchema.parse({
          ...saved,
          updatedAt: saved!.updatedAt.toISOString(),
        });

        await tx.insert(contactReceipts).values({
          workspaceId: input.workspaceId,
          operationId: input.operationId,
          personId: input.personId,
          actorId: principal.id,
          fingerprint: hash,
          result,
        });

        const previousFields = {
          organization: current?.organization ?? "",
          role: current?.role ?? "",
          links: current?.links ?? [],
        };
        const changedFields = Object.fromEntries(
          (Object.keys(input.fields) as (keyof typeof input.fields)[]).flatMap((field) =>
            fingerprint(previousFields[field]) === fingerprint(input.fields[field])
              ? []
              : [[field, input.fields[field]]],
          ),
        );
        if (Object.keys(changedFields).length > 0) {
          await tx.insert(assistantProfileChanges).values({
            id: crypto.randomUUID(),
            workspaceId: input.workspaceId,
            operationId: input.operationId,
            actorId: principal.id,
            executor: "user",
            kind: "contact-save",
            turnId: null,
            personId: input.personId,
            expectedPersonRevision: person.revision,
            personRevision: person.revision,
            expectedContactRevision: input.expectedRevision,
            contactRevision: input.expectedRevision + 1,
            fingerprint: hash,
            fields: changedFields,
            sources: [],
          });
          await appendApplicationEvent(tx, {
            id: crypto.randomUUID(),
            workspaceId: input.workspaceId,
            type: "profile.changed",
            actorId: principal.id,
            executor: "user",
            operationId: input.operationId,
            personId: input.personId,
          });
        }

        return result;
      });
    },
  };
}
