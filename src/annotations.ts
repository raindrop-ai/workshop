import { randomUUID } from "crypto";
import { asc, eq } from "drizzle-orm";
import { getDrizzleDb } from "./db";
import { annotations } from "./db/schema";
import type { AgentAnnotationSource } from "./agent-provider";

export type AnnotationKind = "issue" | "good" | "note";
export type AnnotationSource = "user" | AgentAnnotationSource;

export interface Annotation {
  id: string;
  run_id: string;
  span_id: string | null;
  kind: AnnotationKind;
  note: string | null;
  source: AnnotationSource;
  created_at: number;
}

export interface CreateAnnotationInput {
  run_id: string;
  span_id?: string | null;
  kind: AnnotationKind;
  note?: string | null;
  source: AnnotationSource;
}

const KINDS: ReadonlySet<AnnotationKind> = new Set(["issue", "good", "note"]);
const SOURCES: ReadonlySet<AnnotationSource> = new Set(["user", "claude-code", "codex", "opencode"]);

export class InvalidAnnotationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAnnotationError";
  }
}

export class AnnotationNotFoundError extends Error {
  constructor(id: string) {
    super(`Annotation not found: ${id}`);
    this.name = "AnnotationNotFoundError";
  }
}

export function createAnnotation(input: CreateAnnotationInput): Annotation {
  if (!input.run_id) throw new InvalidAnnotationError("run_id is required");
  if (!KINDS.has(input.kind)) throw new InvalidAnnotationError(`invalid kind: ${input.kind}`);
  if (!SOURCES.has(input.source)) throw new InvalidAnnotationError(`invalid source: ${input.source}`);

  const row: Annotation = {
    id: randomUUID(),
    run_id: input.run_id,
    span_id: input.span_id ?? null,
    kind: input.kind,
    note: input.note ?? null,
    source: input.source,
    created_at: Date.now(),
  };
  getDrizzleDb().insert(annotations).values(row).run();
  return row;
}

export function deleteAnnotation(id: string): Annotation {
  const removed = getDrizzleDb()
    .delete(annotations)
    .where(eq(annotations.id, id))
    .returning()
    .get();
  if (!removed) throw new AnnotationNotFoundError(id);
  return removed;
}

export function getAnnotationsByRun(runId: string): Annotation[] {
  return getDrizzleDb()
    .select()
    .from(annotations)
    .where(eq(annotations.run_id, runId))
    .orderBy(asc(annotations.created_at), asc(annotations.id))
    .all();
}
