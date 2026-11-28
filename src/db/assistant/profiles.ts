import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { assistantSourceSchema } from "../../contracts/assistant";
import {
  type ContactDetails,
  type ContactFields,
  contactFieldsSchema,
} from "../../contracts/contacts";
import { type PersonRecord, personSchema } from "../../contracts/people";
import { idSchema, type Principal, WorkspaceError } from "../../contracts/workspace";
import { appendApplicationEvent } from "../activity";
import { assistantProfileChanges } from "../assistant-profiles-schema";
import { contactDetails as contactDetailsTable } from "../contact-schema";
import type { Database } from "../repository";
import { commandReceipts, DEFAULT_BRANCH, domainEvents, outbox, people } from "../schema";
import {
  authorize,
  deterministicId,
  fingerprint,
  guardNewWrite,
  lockWriteContext,
  type Transaction,
  validateSources,
} from "./shared";

const executorSchema = z.enum(["agent", "workflow"]);

type AssistantExecutor = z.infer<typeof executorSchema>;

export type AssistantProfileWriteContext = { turnId: string; executor: AssistantExecutor };
const profileFieldPatchSchema = contactFieldsSchema
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, "Patch at least one sourced field.");

const sourcedProfileInput = z.object({
  operationId: idSchema,
  sources: z.array(assistantSourceSchema).min(1).max(30),
});

const createProfileInput = sourcedProfileInput.extend({
  displayName: z.string().trim().min(1).max(200),
  fields: contactFieldsSchema.partial().default({}),
});

const updateProfileInput = sourcedProfileInput.extend({
  personId: idSchema,
  expectedPersonRevision: z.number().int().nonnegative().max(2_147_483_646),
  expectedContactRevision: z.number().int().nonnegative().max(2_147_483_646),
  fields: profileFieldPatchSchema,
});

type ProfileChangeRow = typeof assistantProfileChanges.$inferSelect;

type ProfileOperation = "create" | "patch";

type ProfileFields = Partial<ContactFields>;

const contactDefaults: ContactFields = { organization: "", role: "", links: [] };

function contactDTO(
  personId: string,
  row?: typeof contactDetailsTable.$inferSelect,
): ContactDetails {
  return {
    personId,
    organization: row?.organization ?? "",
    role: row?.role ?? "",
    links: row?.links ?? [],
    revision: row?.revision ?? 0,
    updatedAt: row?.updatedAt?.toISOString() ?? null,
  };
}

function personDTO(row: typeof people.$inferSelect): PersonRecord {
  return personSchema.parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  });
}

function resultDTO(person: PersonRecord, contact: ContactDetails, change: ProfileChangeRow) {
  return {
    person,
    contact,
    provenance: {
      operationId: change.operationId,
      actorId: change.actorId,
      executor: change.executor,
      sources: change.sources,
    },
  };
}

async function currentProfile(tx: Transaction, workspaceId: string, personId: string) {
  const [person] = await tx
    .select()
    .from(people)
    .where(
      and(eq(people.workspaceId, workspaceId), eq(people.id, personId), isNull(people.deletedAt)),
    )
    .for("update")
    .limit(1);

  if (!person) {
    throw new WorkspaceError("not_found", "Profile is unavailable.");
  }

  const [contact] = await tx
    .select()
    .from(contactDetailsTable)
    .where(
      and(
        eq(contactDetailsTable.workspaceId, workspaceId),
        eq(contactDetailsTable.personId, personId),
      ),
    )
    .for("update")
    .limit(1);

  return {
    person,
    contact,
    personRecord: personDTO(person),
    contactRecord: contactDTO(personId, contact),
  };
}

async function latestFieldOwner(
  tx: Transaction,
  workspaceId: string,
  personId: string,
  field: keyof ContactFields,
) {
  const [change] = await tx
    .select()
    .from(assistantProfileChanges)
    .where(
      and(
        eq(assistantProfileChanges.workspaceId, workspaceId),
        eq(assistantProfileChanges.personId, personId),
        sql`${assistantProfileChanges.fields} ? ${field}`,
      ),
    )
    .orderBy(desc(assistantProfileChanges.contactRevision), desc(assistantProfileChanges.createdAt))
    .limit(1);

  return change;
}

function assertAgentOwnedField(
  field: keyof ContactFields,
  current: ContactFields[keyof ContactFields],
  owner: ProfileChangeRow | undefined,
) {
  if (owner?.executor === "user") {
    throw new WorkspaceError("conflict", `The ${field} field is user-authored.`);
  }

  if (fingerprint(owner?.fields[field]) !== fingerprint(current)) {
    if (current !== "" && !(Array.isArray(current) && current.length === 0)) {
      throw new WorkspaceError("conflict", `The ${field} field has no current agent ownership.`);
    }
  }
}

async function priorOperation(
  tx: Transaction,
  workspaceId: string,
  operationId: string,
): Promise<ProfileChangeRow | undefined> {
  const [row] = await tx
    .select()
    .from(assistantProfileChanges)
    .where(
      and(
        eq(assistantProfileChanges.workspaceId, workspaceId),
        eq(assistantProfileChanges.operationId, operationId),
        sql`${assistantProfileChanges.executor} in ('agent', 'workflow')`,
      ),
    )
    .limit(1);

  return row;
}

function receiptFingerprint(
  principal: Principal,
  workspaceId: string,
  operation: ProfileOperation,
  executor: AssistantExecutor,
  input: unknown,
  turnId: string,
) {
  return fingerprint({
    actorId: principal.id,
    workspaceId,
    kind: `assistant-profile-${operation}`,
    version: 1,
    executor,
    input,
    turnId,
  });
}

async function lockOperation(tx: Transaction, workspaceId: string, operationId: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${workspaceId}:assistant-profile-operation:${operationId}`}, 0))`,
  );
}

async function lockProfileFields(tx: Transaction, workspaceId: string) {
  // User and assistant writes use the same lock before touching profile/contact
  // rows, which also stabilizes source validation against concurrent edits.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${workspaceId}:profile-fields`}, 0))`,
  );
}

async function returnReplay(
  tx: Transaction,
  workspaceId: string,
  principal: Principal,
  operation: ProfileOperation,
  executor: AssistantExecutor,
  turnId: string,
  input: unknown,
  previous: ProfileChangeRow,
) {
  if (
    previous.actorId !== principal.id ||
    previous.executor !== executor ||
    previous.kind !== operation ||
    previous.turnId !== turnId ||
    previous.fingerprint !==
      receiptFingerprint(principal, workspaceId, operation, executor, input, turnId)
  ) {
    throw new WorkspaceError("command_reused", "Profile operation ID was used for other inputs.");
  }

  const { personRecord, contactRecord } = await currentProfile(tx, workspaceId, previous.personId);

  return resultDTO(personRecord, contactRecord, previous);
}

async function appendPersonAudit(
  tx: Transaction,
  workspaceId: string,
  principal: Principal,
  commandId: string,
  operationId: string,
  executor: AssistantExecutor,
  person: PersonRecord,
) {
  const eventId = crypto.randomUUID();

  await tx.insert(domainEvents).values({
    workspaceId,
    id: eventId,
    entityType: "person",
    entityId: person.id,
    noteId: null,
    personId: person.id,
    branchId: DEFAULT_BRANCH,
    revision: person.revision,
    operation: "save",
    operationVersion: 1,
    actorId: principal.id,
    commandId,
    payload: person,
    createdAt: new Date(person.updatedAt),
  });
  await tx.insert(outbox).values({ workspaceId, eventId, kind: "person.changed" });
  await appendApplicationEvent(tx, {
    id: eventId,
    workspaceId,
    type: "profile.changed",
    actorId: principal.id,
    executor,
    operationId,
    personId: person.id,
  });
}

export function createAssistantProfileRepository(db: Database) {
  return {
    async createProfile(
      principal: Principal,
      workspaceId: string,
      value: z.input<typeof createProfileInput>,
      context: AssistantProfileWriteContext,
    ) {
      const input = createProfileInput.parse(value);

      const turnId = idSchema.parse(context.turnId);

      const executor = executorSchema.parse(context.executor);

      const personId = deterministicId(workspaceId, input.operationId, "assistant-profile");

      const operationInput = { ...input, personId };

      const fingerprintValue = receiptFingerprint(
        principal,
        workspaceId,
        "create",
        executor,
        operationInput,
        turnId,
      );

      return db.transaction(async (tx) => {
        await authorize(tx, principal, workspaceId);
        const turn = await lockWriteContext(tx, principal, workspaceId, context);

        await lockOperation(tx, workspaceId, input.operationId);
        const previous = await priorOperation(tx, workspaceId, input.operationId);

        if (previous) {
          return returnReplay(
            tx,
            workspaceId,
            principal,
            "create",
            executor,
            turnId,
            operationInput,
            previous,
          );
        }

        guardNewWrite(turn);
        await lockProfileFields(tx, workspaceId);
        const sources = await validateSources(tx, principal, workspaceId, input.sources);

        const now = new Date();

        const personCommandId = deterministicId(workspaceId, input.operationId, "person-command");

        const person: PersonRecord = {
          id: personId,
          workspaceId,
          revision: 1,
          displayName: input.displayName,
          description: "",
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          deletedAt: null,
        };

        await tx.insert(people).values({
          id: person.id,
          workspaceId,
          revision: person.revision,
          displayName: person.displayName,
          description: "",
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        });
        const personCommandFingerprint = fingerprint({
          actorId: principal.id,
          workspaceId,
          entityType: "person",
          operation: "save",
          operationVersion: 1,
          input: {
            id: personId,
            expectedRevision: 0,
            content: { displayName: input.displayName, description: "" },
          },
        });

        await tx.insert(commandReceipts).values({
          workspaceId,
          commandId: personCommandId,
          actorId: principal.id,
          fingerprint: personCommandFingerprint,
          result: person,
        });

        const fields = contactFieldsSchema.partial().parse(input.fields);

        const hasFields = Object.keys(fields).length > 0;

        let contact: ContactDetails = {
          personId,
          ...contactDefaults,
          revision: 0,
          updatedAt: null,
        };

        if (hasFields) {
          const fullFields = contactFieldsSchema.parse({ ...contactDefaults, ...fields });

          const [savedContact] = await tx
            .insert(contactDetailsTable)
            .values({
              workspaceId,
              personId,
              ...fullFields,
              revision: 1,
              updatedAt: now,
            })
            .returning();

          contact = contactDTO(personId, savedContact);
        }

        await appendPersonAudit(
          tx,
          workspaceId,
          principal,
          personCommandId,
          input.operationId,
          executor,
          person,
        );
        const [change] = await tx
          .insert(assistantProfileChanges)
          .values({
            id: crypto.randomUUID(),
            workspaceId,
            operationId: input.operationId,
            actorId: principal.id,
            executor,
            kind: "create",
            turnId,
            personId,
            expectedPersonRevision: 0,
            personRevision: 1,
            expectedContactRevision: 0,
            contactRevision: contact.revision,
            fingerprint: fingerprintValue,
            fields,
            sources,
          })
          .returning();

        return resultDTO(person, contact, change!);
      });
    },

    async updateProfile(
      principal: Principal,
      workspaceId: string,
      value: z.input<typeof updateProfileInput>,
      context: AssistantProfileWriteContext,
    ) {
      const input = updateProfileInput.parse(value);

      const turnId = idSchema.parse(context.turnId);

      const executor = executorSchema.parse(context.executor);

      const fingerprintValue = receiptFingerprint(
        principal,
        workspaceId,
        "patch",
        executor,
        input,
        turnId,
      );

      return db.transaction(async (tx) => {
        await authorize(tx, principal, workspaceId);
        const turn = await lockWriteContext(tx, principal, workspaceId, context);

        await lockOperation(tx, workspaceId, input.operationId);
        const previous = await priorOperation(tx, workspaceId, input.operationId);

        if (previous) {
          return returnReplay(
            tx,
            workspaceId,
            principal,
            "patch",
            executor,
            turnId,
            input,
            previous,
          );
        }

        guardNewWrite(turn);
        await lockProfileFields(tx, workspaceId);
        const sources = await validateSources(tx, principal, workspaceId, input.sources);

        const current = await currentProfile(tx, workspaceId, input.personId);

        if (current.person.revision !== input.expectedPersonRevision) {
          throw new WorkspaceError(
            "conflict",
            "Profile changed; review before applying.",
            current.person.revision,
          );
        }

        if (current.contactRecord.revision !== input.expectedContactRevision) {
          throw new WorkspaceError(
            "conflict",
            "Profile facts changed; review before applying.",
            current.contactRecord.revision,
          );
        }

        for (const field of Object.keys(input.fields) as (keyof ContactFields)[]) {
          const owner = await latestFieldOwner(tx, workspaceId, input.personId, field);

          assertAgentOwnedField(field, current.contactRecord[field], owner);
        }

        const nextFields: ContactFields = {
          organization: current.contactRecord.organization,
          role: current.contactRecord.role,
          links: current.contactRecord.links,
        };

        for (const field of Object.keys(input.fields) as (keyof ContactFields)[]) {
          const value = input.fields[field];

          if (value !== undefined) {
            (nextFields as Record<keyof ContactFields, unknown>)[field] = value;
          }
        }

        const changedFields = Object.fromEntries(
          (Object.keys(input.fields) as (keyof ContactFields)[]).flatMap((field) =>
            fingerprint(current.contactRecord[field]) === fingerprint(input.fields[field])
              ? []
              : [[field, input.fields[field]]],
          ),
        ) as ProfileFields;

        let contact = current.contactRecord;

        if (Object.keys(changedFields).length > 0) {
          const nextRevision = current.contactRecord.revision + 1;

          const updatedAt = new Date();

          if (current.contact) {
            const [saved] = await tx
              .update(contactDetailsTable)
              .set({
                ...nextFields,
                revision: nextRevision,
                updatedAt,
              })
              .where(
                and(
                  eq(contactDetailsTable.workspaceId, workspaceId),
                  eq(contactDetailsTable.personId, input.personId),
                  eq(contactDetailsTable.revision, input.expectedContactRevision),
                ),
              )
              .returning();

            if (!saved) {
              throw new WorkspaceError(
                "conflict",
                "Profile facts changed; review before applying.",
              );
            }

            contact = contactDTO(input.personId, saved);
          } else {
            const [saved] = await tx
              .insert(contactDetailsTable)
              .values({
                workspaceId,
                personId: input.personId,
                ...nextFields,
                revision: nextRevision,
                updatedAt,
              })
              .returning();

            contact = contactDTO(input.personId, saved);
          }

          await appendApplicationEvent(tx, {
            id: crypto.randomUUID(),
            workspaceId,
            type: "profile.changed",
            actorId: principal.id,
            executor,
            operationId: input.operationId,
            personId: input.personId,
          });
        }

        const [change] = await tx
          .insert(assistantProfileChanges)
          .values({
            id: crypto.randomUUID(),
            workspaceId,
            operationId: input.operationId,
            actorId: principal.id,
            executor,
            kind: "patch",
            turnId,
            personId: input.personId,
            expectedPersonRevision: input.expectedPersonRevision,
            personRevision: current.person.revision,
            expectedContactRevision: input.expectedContactRevision,
            contactRevision: contact.revision,
            fingerprint: fingerprintValue,
            fields: changedFields,
            sources,
          })
          .returning();

        return resultDTO(current.personRecord, contact, change!);
      });
    },
  };
}
