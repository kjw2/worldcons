import { z } from "zod";

export const ADMIN_WORK_ACTIONS = ["abort", "retry", "candidate-retry", "publish", "withdraw"] as const;
export type AdminWorkAction = (typeof ADMIN_WORK_ACTIONS)[number];

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

const adminWorkActionSchema = z.object({
  action: z.enum(ADMIN_WORK_ACTIONS),
  reason: z.string().trim().min(5).max(500).refine((value) => !CONTROL_CHARACTERS.test(value)),
  confirmation: z.string().trim().max(40),
  idempotencyKey: z.string().trim().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/),
}).strict().superRefine((value, context) => {
  if (["publish", "withdraw"].includes(value.action) && value.confirmation !== value.action) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["confirmation"], message: `${value.action} confirmation is required` });
  }
});

export type AdminWorkActionBody = z.infer<typeof adminWorkActionSchema>;

export function parseAdminWorkActionBody(value: unknown) {
  const result = adminWorkActionSchema.safeParse(value);
  return result.success
    ? { ok: true as const, data: result.data }
    : { ok: false as const, error: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") };
}

export function actionAllowedForKind(kind: string, action: AdminWorkAction) {
  if (kind === "execution") return action === "abort" || action === "retry";
  if (kind === "candidate") return action === "candidate-retry";
  if (kind === "article") return action === "publish" || action === "withdraw";
  return false;
}
