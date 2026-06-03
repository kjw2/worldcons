import { z } from "zod";

export const SUMMARY_ENTITY_TYPES = [
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
] as const;

export const SUMMARY_RISK_FLAGS = [
  "translation_uncertain",
  "source_text_incomplete",
  "provision_reference_uncertain",
  "constitutional_relevance_uncertain",
] as const;

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
      type: z.enum(SUMMARY_ENTITY_TYPES),
      normalizedName: z.string(),
    }),
  ),
  tags: z.array(z.string()),
  categories: z.array(z.string()),
  riskFlags: z.array(z.enum(SUMMARY_RISK_FLAGS)),
  aiMetadata: z
    .object({
      provider: z.string(),
      model: z.string(),
      generatedAt: z.string().optional(),
    })
    .optional(),
});

export type SummarySchemaOutput = z.infer<typeof SummarySchema>;
type SummaryEntityType = (typeof SUMMARY_ENTITY_TYPES)[number];
type SummaryRiskFlag = (typeof SUMMARY_RISK_FLAGS)[number];

const ENTITY_TYPE_ALIASES: Record<string, SummaryEntityType> = {
  법원: "court",
  재판소: "court",
  재판부: "court",
  "재판부 구성원": "court",
  국가: "country",
  나라: "country",
  법: "law",
  법률: "law",
  법령: "law",
  조문: "article",
  조항: "article",
  헌법조항: "article",
  권리: "right",
  기본권: "right",
  당사자: "party",
  회사: "party",
  기업: "party",
  변호사: "party",
  로펌: "party",
  "정부 측 대리인": "party",
  기관: "institution",
  정부기관: "institution",
  주제: "topic",
  쟁점: "topic",
  법리: "doctrine",
  원칙: "doctrine",
  절차: "procedure",
  사건유형: "case_type",
  "사건 유형": "case_type",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function textArray(value: unknown) {
  if (Array.isArray(value)) {
    return value.map(cleanText).filter(Boolean);
  }
  const text = cleanText(value);
  return text ? [text] : [];
}

function normalizeConfidence(value: unknown) {
  const text = cleanText(value).toLowerCase();
  if (text === "high" || text === "medium" || text === "low") return text;
  return "low";
}

function normalizeEntityType(value: unknown, name: string): SummaryEntityType {
  const raw = cleanText(value);
  const normalized = raw.toLowerCase().replace(/\s+/g, "_");
  if ((SUMMARY_ENTITY_TYPES as readonly string[]).includes(normalized)) return normalized as SummaryEntityType;
  if (ENTITY_TYPE_ALIASES[raw]) return ENTITY_TYPE_ALIASES[raw];

  const combined = `${raw} ${name}`;
  if (/재판소|법원|court|tribunal/i.test(combined)) return "court";
  if (/헌법|법률|법령|조항|article|code|law/i.test(combined)) return /조항|article/i.test(combined) ? "article" : "law";
  if (/권리|자유|right|freedom/i.test(combined)) return "right";
  if (/절차|procedure|qpc/i.test(combined)) return "procedure";
  if (/법리|원칙|doctrine|principle/i.test(combined)) return "doctrine";
  if (/국가|country|france|germany|united states/i.test(combined)) return "country";
  if (/회사|당사자|원고|피고|신청인|party|company|법인/i.test(combined)) return "party";
  if (/기관|정부|minister|agency|authority/i.test(combined)) return "institution";
  return "topic";
}

function normalizeEntities(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!isRecord(item)) return null;
      const name = cleanText(item.name);
      if (!name) return null;
      return {
        name,
        type: normalizeEntityType(item.type, name),
        normalizedName: cleanText(item.normalizedName) || name,
      };
    })
    .filter((item): item is { name: string; type: SummaryEntityType; normalizedName: string } => Boolean(item));
}

function normalizeReferencedProvisions(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!isRecord(item)) return null;
      const jurisdiction = cleanText(item.jurisdiction);
      const lawName = cleanText(item.lawName);
      const article = cleanText(item.article);
      const description = cleanText(item.description);
      if (!jurisdiction && !lawName && !article && !description) return null;
      return {
        jurisdiction,
        lawName,
        article,
        description,
        confidence: normalizeConfidence(item.confidence),
      };
    })
    .filter((item): item is { jurisdiction: string; lawName: string; article: string; description: string; confidence: "high" | "medium" | "low" } => Boolean(item));
}

function normalizeRiskFlag(value: unknown): SummaryRiskFlag | null {
  const raw = cleanText(value);
  if (!raw) return null;
  const normalized = raw.toLowerCase();
  if ((SUMMARY_RISK_FLAGS as readonly string[]).includes(normalized)) return normalized as SummaryRiskFlag;
  if (/번역|translation/i.test(raw)) return "translation_uncertain";
  if (/원문|본문|불완전|제한|incomplete|source/i.test(raw)) return "source_text_incomplete";
  if (/조문|조항|법률|규정|provision|article/i.test(raw)) return "provision_reference_uncertain";
  if (/헌법.*관련|관련성|constitutional/i.test(raw)) return "constitutional_relevance_uncertain";
  return null;
}

function unique<T>(values: T[]) {
  return Array.from(new Set(values));
}

export function normalizeSummaryCandidate(value: unknown): unknown {
  const root = isRecord(value) ? value : {};
  const summary = isRecord(root.summary) ? root.summary : {};

  return {
    ...root,
    koreanTitle: cleanText(root.koreanTitle),
    originalTitle: cleanText(root.originalTitle) || undefined,
    summary: {
      ...summary,
      coreSummary: textArray(summary.coreSummary),
      referencedProvisions: normalizeReferencedProvisions(summary.referencedProvisions),
      background: cleanText(summary.background),
      caseStructure: cleanText(summary.caseStructure),
      implications: cleanText(summary.implications),
      practicalNotes: cleanText(summary.practicalNotes),
    },
    entities: normalizeEntities(root.entities),
    tags: unique(textArray(root.tags)),
    categories: unique(textArray(root.categories)),
    riskFlags: unique(textArray(root.riskFlags).map(normalizeRiskFlag).filter((flag): flag is SummaryRiskFlag => Boolean(flag))),
  };
}

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
