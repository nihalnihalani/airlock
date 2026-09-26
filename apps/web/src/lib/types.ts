/** Type aliases for contract schemas that export only a zod value (no `type` alias upstream). */
import type { z } from "zod";
import type { CaseInput as CaseInputSchema, PreviewResult as PreviewResultSchema } from "@airlock/contracts";

export type CaseInput = z.infer<typeof CaseInputSchema>;
export type PreviewResult = z.infer<typeof PreviewResultSchema>;
