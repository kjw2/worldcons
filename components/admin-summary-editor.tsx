"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pencil, Plus, Save, Trash2 } from "lucide-react";
import type { ReferencedProvision, RiskFlag, SummaryJson, TagType } from "@/lib/db/types";

const ENTITY_TYPES: Array<{ value: TagType; label: string }> = [
  { value: "court", label: "재판기관" },
  { value: "country", label: "국가" },
  { value: "law", label: "법령" },
  { value: "article", label: "조문" },
  { value: "right", label: "권리" },
  { value: "party", label: "당사자" },
  { value: "institution", label: "기관" },
  { value: "topic", label: "쟁점" },
  { value: "doctrine", label: "법리" },
  { value: "procedure", label: "절차" },
  { value: "case_type", label: "사건유형" },
];

const RISK_FLAGS: Array<{ value: RiskFlag; label: string }> = [
  { value: "translation_uncertain", label: "번역 검토" },
  { value: "source_text_incomplete", label: "원문 불완전" },
  { value: "provision_reference_uncertain", label: "조문 검토" },
  { value: "constitutional_relevance_uncertain", label: "헌법 관련성 검토" },
];

interface EditorState {
  koreanTitle: string;
  coreSummaryText: string;
  background: string;
  caseStructure: string;
  implications: string;
  practicalNotes: string;
  referencedProvisions: ReferencedProvision[];
  entities: SummaryJson["entities"];
  tagsText: string;
  categoriesText: string;
  riskFlags: RiskFlag[];
  note: string;
}

function listText(values: string[]) {
  return values.join("\n");
}

function splitList(value: string) {
  return Array.from(
    new Set(
      value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function editorStateFromSummary(summary: SummaryJson): EditorState {
  return {
    koreanTitle: summary.koreanTitle,
    coreSummaryText: listText(summary.summary.coreSummary),
    background: summary.summary.background,
    caseStructure: summary.summary.caseStructure,
    implications: summary.summary.implications,
    practicalNotes: summary.summary.practicalNotes,
    referencedProvisions: summary.summary.referencedProvisions,
    entities: summary.entities,
    tagsText: listText(summary.tags),
    categoriesText: listText(summary.categories),
    riskFlags: summary.riskFlags,
    note: "",
  };
}

function emptyProvision(): ReferencedProvision {
  return {
    jurisdiction: "",
    lawName: "",
    article: "",
    description: "",
    confidence: "medium",
  };
}

function emptyEntity(): SummaryJson["entities"][number] {
  return {
    name: "",
    normalizedName: "",
    type: "topic",
  };
}

function resultMessage(payload: unknown) {
  if (!payload || typeof payload !== "object" || !("edit" in payload)) return "상세내용을 저장했습니다.";
  const edit = (payload as { edit?: { status?: string; reason?: string } }).edit;
  if (edit?.status === "updated") return "상세내용을 저장했습니다.";
  if (edit?.status === "skipped" || edit?.status === "invalid") return edit.reason ?? "저장할 수 없습니다.";
  if (edit?.status === "not_found") return "자료를 찾을 수 없습니다.";
  return "상세내용을 저장했습니다.";
}

export function AdminSummaryEditor({
  articleId,
  csrfToken,
  summary,
}: {
  articleId?: string;
  csrfToken: string;
  summary?: SummaryJson | null;
}) {
  const router = useRouter();
  const [form, setForm] = useState(() => (summary ? editorStateFromSummary(summary) : null));
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);

  if (!summary || !form) {
    return (
      <div className="rounded-md border border-rule bg-white p-4">
        <h3 className="text-base font-semibold tracking-normal text-ink">상세내용 직접 수정</h3>
        <p className="mt-2 text-sm leading-6 text-ink/62">요약 생성 후 수정할 수 있습니다.</p>
      </div>
    );
  }

  function updateProvision(index: number, patch: Partial<ReferencedProvision>) {
    setForm((current) => {
      if (!current) return current;
      const next = [...current.referencedProvisions];
      next[index] = { ...next[index], ...patch };
      return { ...current, referencedProvisions: next };
    });
  }

  function removeProvision(index: number) {
    setForm((current) => current && { ...current, referencedProvisions: current.referencedProvisions.filter((_, itemIndex) => itemIndex !== index) });
  }

  function updateEntity(index: number, patch: Partial<SummaryJson["entities"][number]>) {
    setForm((current) => {
      if (!current) return current;
      const next = [...current.entities];
      next[index] = { ...next[index], ...patch };
      return { ...current, entities: next };
    });
  }

  function removeEntity(index: number) {
    setForm((current) => current && { ...current, entities: current.entities.filter((_, itemIndex) => itemIndex !== index) });
  }

  function toggleRiskFlag(flag: RiskFlag) {
    setForm((current) => {
      if (!current) return current;
      const riskFlags = current.riskFlags.includes(flag)
        ? current.riskFlags.filter((item) => item !== flag)
        : [...current.riskFlags, flag];
      return { ...current, riskFlags };
    });
  }

  function buildSummary(): SummaryJson {
    if (!summary || !form) throw new Error("수정할 요약이 없습니다.");
    const currentForm = form;
    const currentSummary = summary;

    return {
      ...currentSummary,
      koreanTitle: currentForm.koreanTitle,
      summary: {
        ...currentSummary.summary,
        coreSummary: splitList(currentForm.coreSummaryText),
        referencedProvisions: currentForm.referencedProvisions
          .map((provision) => ({
            jurisdiction: provision.jurisdiction.trim(),
            lawName: provision.lawName.trim(),
            article: provision.article.trim(),
            description: provision.description.trim(),
            confidence: provision.confidence,
          }))
          .filter((provision) => provision.lawName || provision.article),
        background: currentForm.background,
        caseStructure: currentForm.caseStructure,
        implications: currentForm.implications,
        practicalNotes: currentForm.practicalNotes,
      },
      entities: currentForm.entities
        .map((entity) => ({
          name: entity.name.trim(),
          normalizedName: (entity.normalizedName || entity.name).trim(),
          type: entity.type,
        }))
        .filter((entity) => entity.name),
      tags: splitList(currentForm.tagsText),
      categories: splitList(currentForm.categoriesText),
      riskFlags: currentForm.riskFlags,
    };
  }

  async function saveSummary() {
    if (!articleId || isSaving) return;

    setIsSaving(true);
    setMessage(null);
    setIsError(false);

    try {
      if (!form) throw new Error("수정할 요약이 없습니다.");
      const response = await fetch(`/api/admin/articles/${encodeURIComponent(articleId)}/summary`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({
          note: form.note,
          summary: buildSummary(),
        }),
      });
      const payload: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        const errorMessage = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
          ? payload.error
          : `HTTP ${response.status}`;
        throw new Error(errorMessage);
      }

      const nextMessage = resultMessage(payload);
      setMessage(nextMessage);
      setIsError(/없|오류|실패|수 없습니다|찾을 수/.test(nextMessage));
      router.refresh();
    } catch (error) {
      setIsError(true);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <details className="rounded-md border border-rule bg-white p-4">
      <summary className="focus-ring flex cursor-pointer list-none items-center gap-2 rounded-sm text-base font-semibold tracking-normal text-ink marker:hidden">
        <Pencil className="size-4 text-amber-800" aria-hidden="true" />
        상세내용 직접 수정
      </summary>
      <div className="mt-4 grid gap-4">
        <p className="rounded-md border border-amber-400/25 bg-amber-50 px-3 py-2 text-xs font-semibold leading-5 text-amber-900">
          원문 스냅샷은 수정하지 않습니다. 저장하면 공개 요약, 카드 제목, 태그, 검색용 요약 데이터만 갱신됩니다.
        </p>

        <label className="grid gap-1 text-sm font-semibold text-ink/72">
          한국어 제목
          <input
            value={form.koreanTitle}
            onChange={(event) => setForm((current) => current && { ...current, koreanTitle: event.target.value })}
            className="focus-ring h-11 rounded-md border border-rule bg-parchment/35 px-3 text-sm text-ink"
          />
        </label>

        <label className="grid gap-1 text-sm font-semibold text-ink/72">
          핵심 요약
          <textarea
            value={form.coreSummaryText}
            onChange={(event) => setForm((current) => current && { ...current, coreSummaryText: event.target.value })}
            rows={5}
            className="focus-ring min-h-32 resize-y rounded-md border border-rule bg-parchment/35 px-3 py-2 text-sm leading-6 text-ink"
          />
        </label>

        <div className="grid gap-3 md:grid-cols-2">
          {[
            ["배경", "background"],
            ["사건 구조", "caseStructure"],
            ["시사점", "implications"],
            ["실무상 참고", "practicalNotes"],
          ].map(([label, key]) => (
            <label key={key} className="grid gap-1 text-sm font-semibold text-ink/72">
              {label}
              <textarea
                value={form[key as keyof Pick<EditorState, "background" | "caseStructure" | "implications" | "practicalNotes">]}
                onChange={(event) => setForm((current) => current && { ...current, [key]: event.target.value })}
                rows={5}
                className="focus-ring min-h-32 resize-y rounded-md border border-rule bg-parchment/35 px-3 py-2 text-sm leading-6 text-ink"
              />
            </label>
          ))}
        </div>

        <section className="grid gap-2">
          <div className="flex items-center justify-between gap-3">
            <h4 className="text-sm font-semibold text-ink">참조 조문</h4>
            <button
              type="button"
              onClick={() => setForm((current) => current && { ...current, referencedProvisions: [...current.referencedProvisions, emptyProvision()] })}
              className="focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-md border border-rule bg-white px-2.5 text-xs font-semibold text-ink/72 hover:bg-parchment"
            >
              <Plus className="size-3.5" aria-hidden="true" />
              추가
            </button>
          </div>
          {form.referencedProvisions.length === 0 ? <p className="text-sm text-ink/54">등록된 참조 조문이 없습니다.</p> : null}
          {form.referencedProvisions.map((provision, index) => (
            <div key={`${index}-${provision.lawName}-${provision.article}`} className="grid gap-2 rounded-md border border-rule bg-parchment/25 p-3">
              <div className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_9rem_auto]">
                <input
                  value={provision.jurisdiction}
                  onChange={(event) => updateProvision(index, { jurisdiction: event.target.value })}
                  placeholder="국가"
                  className="focus-ring h-10 rounded-md border border-rule bg-white px-3 text-sm text-ink"
                />
                <input
                  value={provision.lawName}
                  onChange={(event) => updateProvision(index, { lawName: event.target.value })}
                  placeholder="법령명"
                  className="focus-ring h-10 rounded-md border border-rule bg-white px-3 text-sm text-ink"
                />
                <input
                  value={provision.article}
                  onChange={(event) => updateProvision(index, { article: event.target.value })}
                  placeholder="조문"
                  className="focus-ring h-10 rounded-md border border-rule bg-white px-3 text-sm text-ink"
                />
                <select
                  value={provision.confidence}
                  onChange={(event) => updateProvision(index, { confidence: event.target.value as ReferencedProvision["confidence"] })}
                  className="focus-ring h-10 rounded-md border border-rule bg-white px-2 text-sm text-ink"
                >
                  <option value="high">high</option>
                  <option value="medium">medium</option>
                  <option value="low">low</option>
                </select>
                <button
                  type="button"
                  onClick={() => removeProvision(index)}
                  className="focus-ring inline-flex h-10 items-center justify-center rounded-md border border-court/25 bg-white px-2 text-court hover:bg-court/5"
                  title="참조 조문 삭제"
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </button>
              </div>
              <textarea
                value={provision.description}
                onChange={(event) => updateProvision(index, { description: event.target.value })}
                placeholder="설명"
                rows={2}
                className="focus-ring resize-y rounded-md border border-rule bg-white px-3 py-2 text-sm leading-6 text-ink"
              />
            </div>
          ))}
        </section>

        <section className="grid gap-2">
          <div className="flex items-center justify-between gap-3">
            <h4 className="text-sm font-semibold text-ink">엔티티</h4>
            <button
              type="button"
              onClick={() => setForm((current) => current && { ...current, entities: [...current.entities, emptyEntity()] })}
              className="focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-md border border-rule bg-white px-2.5 text-xs font-semibold text-ink/72 hover:bg-parchment"
            >
              <Plus className="size-3.5" aria-hidden="true" />
              추가
            </button>
          </div>
          {form.entities.length === 0 ? <p className="text-sm text-ink/54">등록된 엔티티가 없습니다.</p> : null}
          {form.entities.map((entity, index) => (
            <div key={`${index}-${entity.name}-${entity.type}`} className="grid gap-2 rounded-md border border-rule bg-parchment/25 p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_10rem_auto]">
              <input
                value={entity.name}
                onChange={(event) => updateEntity(index, { name: event.target.value })}
                placeholder="표시명"
                className="focus-ring h-10 rounded-md border border-rule bg-white px-3 text-sm text-ink"
              />
              <input
                value={entity.normalizedName}
                onChange={(event) => updateEntity(index, { normalizedName: event.target.value })}
                placeholder="정규화명"
                className="focus-ring h-10 rounded-md border border-rule bg-white px-3 text-sm text-ink"
              />
              <select
                value={entity.type}
                onChange={(event) => updateEntity(index, { type: event.target.value as TagType })}
                className="focus-ring h-10 rounded-md border border-rule bg-white px-2 text-sm text-ink"
              >
                {ENTITY_TYPES.map((type) => (
                  <option key={type.value} value={type.value}>{type.label}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => removeEntity(index)}
                className="focus-ring inline-flex h-10 items-center justify-center rounded-md border border-court/25 bg-white px-2 text-court hover:bg-court/5"
                title="엔티티 삭제"
              >
                <Trash2 className="size-4" aria-hidden="true" />
              </button>
            </div>
          ))}
        </section>

        <div className="grid gap-3 md:grid-cols-2">
          <label className="grid gap-1 text-sm font-semibold text-ink/72">
            태그
            <textarea
              value={form.tagsText}
              onChange={(event) => setForm((current) => current && { ...current, tagsText: event.target.value })}
              rows={4}
              className="focus-ring min-h-24 resize-y rounded-md border border-rule bg-parchment/35 px-3 py-2 text-sm leading-6 text-ink"
            />
          </label>
          <label className="grid gap-1 text-sm font-semibold text-ink/72">
            카테고리
            <textarea
              value={form.categoriesText}
              onChange={(event) => setForm((current) => current && { ...current, categoriesText: event.target.value })}
              rows={4}
              className="focus-ring min-h-24 resize-y rounded-md border border-rule bg-parchment/35 px-3 py-2 text-sm leading-6 text-ink"
            />
          </label>
        </div>

        <fieldset className="grid gap-2">
          <legend className="text-sm font-semibold text-ink">검수 신호</legend>
          <div className="flex flex-wrap gap-2">
            {RISK_FLAGS.map((flag) => (
              <label key={flag.value} className="inline-flex min-h-9 items-center gap-2 rounded-md border border-rule bg-parchment/35 px-3 text-sm font-semibold text-ink/72">
                <input
                  type="checkbox"
                  checked={form.riskFlags.includes(flag.value)}
                  onChange={() => toggleRiskFlag(flag.value)}
                  className="size-4 rounded border-rule text-court"
                />
                {flag.label}
              </label>
            ))}
          </div>
        </fieldset>

        <label className="grid gap-1 text-sm font-semibold text-ink/72">
          수정 메모
          <textarea
            value={form.note}
            onChange={(event) => setForm((current) => current && { ...current, note: event.target.value })}
            rows={3}
            className="focus-ring min-h-24 resize-y rounded-md border border-rule bg-parchment/35 px-3 py-2 text-sm leading-6 text-ink"
            placeholder="예: 기관명 번역 통일, 참조 조문 표현 수정"
          />
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={saveSummary}
            disabled={isSaving || !articleId}
            className="focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-mint px-4 text-sm font-semibold text-white transition hover:bg-mint/90 disabled:cursor-not-allowed disabled:opacity-55"
          >
            {isSaving ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Save className="size-4" aria-hidden="true" />}
            {isSaving ? "저장 중" : "수정 저장"}
          </button>
          {message ? <p className={`text-sm leading-6 ${isError ? "text-court" : "text-mint"}`}>{message}</p> : null}
        </div>
      </div>
    </details>
  );
}
