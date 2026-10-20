/**
 * contract/office.ts — GLYPHH OFFICE wire shapes, starting with SLIDES. A deck is
 * ONE self-contained HTML document (1920×1080 self-scaling stage, <section
 * class="slide"> pages, built-in nav) stored org-side in R2; decks are org-SHARED
 * agent-authored documents, addressed by their stable `file` name.
 */

export interface OfficeSlideMeta {
  /** "<slug>.html" — unique per org; the stable name decks are addressed by. */
  file: string;
  title: string;
  /** <section class="slide"> count. */
  slides: number;
  sizeBytes: number;
  updatedAt: string;
}

/** One deck in full: the metadata plus the complete HTML document. */
export interface OfficeSlide extends OfficeSlideMeta {
  html: string;
}

// ── DOCS ──────────────────────────────────────────────────────────────────────

export interface OfficeDocMeta {
  /** "<slug>.md" — unique per org; the stable name docs are addressed by. */
  file: string;
  title: string;
  sizeBytes: number;
  /** Drive pointer (null = root). */
  folderId: string | null;
  updatedAt: string;
}

/** One document in full: the metadata plus the complete markdown source. */
export interface OfficeDoc extends OfficeDocMeta {
  markdown: string;
}

/** A proposed edit — review-and-approve. Approve applies the replacement
 *  server-side; a document that moved on resolves "stale", never wrong. */
export interface OfficeSuggestion {
  id: string;
  file: string;
  section: string;
  beforeMd: string;
  afterMd: string;
  note: string;
  authorKind: "agent" | "user";
  status: "pending" | "approved" | "rejected" | "stale";
  createdAt: string;
}

export interface CreateSuggestionInput {
  section?: string;
  /** Exact text to replace; "" (or omitted) appends to the end. */
  beforeMd?: string;
  afterMd: string;
  note?: string;
  authorKind?: "agent" | "user";
}

/** A code-defined document template (served read-only to every org). */
export interface OfficeDocTemplate {
  slug: string;
  name: string;
  category: string;
  description: string;
  markdown: string;
}

// ── DRIVE ─────────────────────────────────────────────────────────────────────

export interface OfficeFolder {
  id: string;
  name: string;
  parentId: string | null;
  updatedAt: string;
}

/** One Drive entry — a POINTER at an object, never a copy. Every kind rides
 *  the same listing: office by FILE name, the rest by row id (`ref`). */
export type DriveKind = "slides" | "docs" | "sheets" | "design" | "media" | "music" | "file";
export interface OfficeDriveFile {
  kind: DriveKind;
  /** The stable reference: office/design = the file name; media/music/file = the uuid. */
  ref: string;
  /** Office/design keep their file name for the editors' open-by-name APIs. */
  file?: string;
  title: string;
  sizeBytes: number;
  folderId: string | null;
  /** media: image|video|audio|voice|…; file: the files.kind bucket. */
  subkind?: string;
  mime?: string;
  updatedAt: string;
}

export interface OfficeDriveListing {
  folders: OfficeFolder[];
  files: OfficeDriveFile[];
}

// ── SHEETS ────────────────────────────────────────────────────────────────────

/** A cell: a value, or a formula with its MATERIALIZED value ({f, v}) — the
 *  engine runs client/agent-side; stored workbooks always carry values. */
export type SheetCell = string | number | null | { f: string; v?: string | number | null };
export interface SheetColumn {
  name: string;
  type?: "text" | "number" | "date" | "currency";
  /** An AI column: the prompt the agent materializes values from. */
  aiPrompt?: string;
}
/** A chart saved on a sheet, rendered as self-contained SVG (panel + export). */
export interface ChartSpec {
  id: string;
  type: "bar" | "line" | "area" | "pie" | "scatter" | "combo";
  title?: string;
  sheet?: string;
  categoriesRef?: string;
  series: Array<{ name?: string; valuesRef: string; type?: ChartSpec["type"]; color?: string }>;
  legend?: boolean;
  stacked?: boolean;
  colors?: string[];
  size?: { w: number; h: number };
}

/** Sparse per-cell styling, keyed by A1 address. */
export interface CellStyle {
  bold?: boolean; italic?: boolean; underline?: boolean;
  color?: string; fill?: string;
  align?: "left" | "center" | "right";
  border?: { top?: boolean; right?: boolean; bottom?: boolean; left?: boolean; color?: string };
  numberFormat?: string;
}

/** A conditional-formatting rule painted over a range. */
export interface CondFormat {
  id: string;
  range: string;
  kind: "colorScale" | "dataBar" | "cellRule" | "textRule" | "iconSet";
  scale?: { min: string; mid?: string; max: string };
  bar?: { color: string; negativeColor?: string };
  op?: "gt" | "lt" | "gte" | "lte" | "eq" | "neq" | "between" | "contains" | "startsWith" | "endsWith" | "isEmpty" | "notEmpty";
  value?: string | number;
  value2?: string | number;
  style?: CellStyle;
  iconSet?: "arrows" | "traffic" | "flags";
  thresholds?: number[];
}

/** A workbook-scoped named range usable in formulas. */
export interface NamedRange { name: string; sheet: string; range: string }

/** A data-validation rule for a range. */
export interface DataValidation {
  id: string;
  range: string;
  rule:
    | { kind: "list"; source: string[] }
    | { kind: "listRange"; ref: string }
    | { kind: "number"; op: CondFormat["op"]; value?: number; value2?: number }
    | { kind: "date"; op: CondFormat["op"]; value?: string; value2?: string }
    | { kind: "textLen"; op: CondFormat["op"]; value?: number }
    | { kind: "custom"; formula: string };
  strict?: boolean;
}

export interface Worksheet {
  name: string;
  columns: SheetColumn[];
  rows: SheetCell[][];
  /** Panel-maintained layout: px widths per column / heights per row. */
  colWidths?: Array<number | null>;
  rowHeights?: Array<number | null>;
  charts?: ChartSpec[];
  condFormats?: CondFormat[];
  validations?: DataValidation[];
  styles?: Record<string, CellStyle>;
  frozen?: { rows?: number; cols?: number };
}
export interface Workbook { sheets: Worksheet[]; namedRanges?: NamedRange[] }

export interface OfficeSheetMeta {
  /** "<slug>.json" — unique per org; the stable name workbooks are addressed by. */
  file: string;
  title: string;
  sheets: number;
  totalRows: number;
  sizeBytes: number;
  folderId: string | null;
  updatedAt: string;
}

export interface OfficeSheet extends OfficeSheetMeta {
  workbook: Workbook;
}
