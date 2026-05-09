import { z } from "zod";

export const SummarySchema = z.object({
  koreanTitle: z.string(),
  originalTitle: z.string().optional(),
  summary: z.object({
    coreSummary: z.array(z.string()),
    referencedProvisions: z.array(
      z.object({
        jurisdiction: z.string(),
        lawName: z.string(),
        article: z.string(),
        description: z.string(),
        confidence: z.enum(["high", "medium", "low"]),
      }),
    ),
    background: z.string(),
    caseStructure: z.string(),
    implications: z.string(),
    practicalNotes: z.string(),
  }),
  entities: z.array(
    z.object({
      name: z.string(),
      type: z.enum([
        "court",
        "country",
        "law",
        "article",
        "right",
        "party",
        "institution",
        "topic",
        "doctrine",
        "procedure",
        "case_type",
      ]),
      normalizedName: z.string(),
    }),
  ),
  tags: z.array(z.string()),
  categories: z.array(z.string()),
  riskFlags: z.array(
    z.enum([
      "translation_uncertain",
      "source_text_incomplete",
      "provision_reference_uncertain",
      "constitutional_relevance_uncertain",
    ]),
  ),
  aiMetadata: z
    .object({
      provider: z.string(),
      model: z.string(),
      generatedAt: z.string().optional(),
    })
    .optional(),
});

export type SummarySchemaOutput = z.infer<typeof SummarySchema>;

export const SummaryResponseJsonSchema = {
  type: "object",
  properties: {
    koreanTitle: { type: "string" },
    originalTitle: { type: "string" },
    summary: {
      type: "object",
      properties: {
        coreSummary: {
          type: "array",
          items: { type: "string" },
        },
        referencedProvisions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              jurisdiction: { type: "string" },
              lawName: { type: "string" },
              article: { type: "string" },
              description: { type: "string" },
              confidence: { type: "string", enum: ["high", "medium", "low"] },
            },
            required: ["jurisdiction", "lawName", "article", "description", "confidence"],
          },
        },
        background: { type: "string" },
        caseStructure: { type: "string" },
        implications: { type: "string" },
        practicalNotes: { type: "string" },
      },
      required: ["coreSummary", "referencedProvisions", "background", "caseStructure", "implications", "practicalNotes"],
    },
    entities: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          type: {
            type: "string",
            enum: [
              "court",
              "country",
              "law",
              "article",
              "right",
              "party",
              "institution",
              "topic",
              "doctrine",
              "procedure",
              "case_type",
            ],
          },
          normalizedName: { type: "string" },
        },
        required: ["name", "type", "normalizedName"],
      },
    },
    tags: {
      type: "array",
      items: { type: "string" },
    },
    categories: {
      type: "array",
      items: { type: "string" },
    },
    riskFlags: {
      type: "array",
      items: {
        type: "string",
        enum: [
          "translation_uncertain",
          "source_text_incomplete",
          "provision_reference_uncertain",
          "constitutional_relevance_uncertain",
        ],
      },
    },
  },
  required: ["koreanTitle", "summary", "entities", "tags", "categories", "riskFlags"],
} as const;
