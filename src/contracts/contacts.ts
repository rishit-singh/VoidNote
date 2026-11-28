import { z } from "zod";

export const publicContactLinkSchema = z.object({
  label: z.string().trim().min(1).max(80),
  url: z
    .url()
    .max(2000)
    .refine((value) => {
      const url = new URL(value);

      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
    }, "Use a public HTTP or HTTPS link without credentials."),
});

export const contactFieldsSchema = z.object({
  organization: z.string().trim().max(200),
  role: z.string().trim().max(200),
  links: z.array(publicContactLinkSchema).max(12),
});

export const contactDetailsSchema = contactFieldsSchema.extend({
  personId: z.uuid(),
  revision: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime({ offset: true }).nullable(),
});

export const saveContactDetailsSchema = z.object({
  workspaceId: z.uuid(),
  personId: z.uuid(),
  operationId: z.uuid(),
  expectedRevision: z.number().int().nonnegative().max(2_147_483_646),
  fields: contactFieldsSchema,
});

export type ContactDetails = z.infer<typeof contactDetailsSchema>;
export type ContactFields = z.infer<typeof contactFieldsSchema>;
export type SaveContactDetails = z.infer<typeof saveContactDetailsSchema>;
