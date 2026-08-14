import { truncateText } from "./text.ts";
import type { MemoryRecord } from "./types.ts";

export interface ReviewTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export type ReviewListAction =
  | { kind: "apply"; decision: "approve" | "reject"; ids: readonly string[] }
  | { kind: "edit"; id: string; selectedIds: readonly string[] }
  | { kind: "cancel" };

export class MemoryReviewList {
  private readonly records: readonly MemoryRecord[];
  private readonly theme: ReviewTheme;
  private readonly done: (action: ReviewListAction) => void;
  private readonly checked = new Set<string>();
  private cursor = 0;
  private finished = false;

  constructor(
    records: readonly MemoryRecord[],
    theme: ReviewTheme,
    done: (action: ReviewListAction) => void,
    initialCheckedIds: Iterable<string> = [],
  ) {
    this.records = records;
    this.theme = theme;
    this.done = done;
    const ids = new Set(records.map((record) => record.id));
    for (const id of initialCheckedIds) {
      if (ids.has(id)) this.checked.add(id);
    }
  }

  handleInput(data: string): void {
    if (this.finished || this.records.length === 0) return;
    if (data === "\x1b" || data === "q") {
      this.finish({ kind: "cancel" });
      return;
    }
    if (data === "\x1b[A" || data === "k") {
      this.cursor = Math.max(0, this.cursor - 1);
      return;
    }
    if (data === "\x1b[B" || data === "j") {
      this.cursor = Math.min(this.records.length - 1, this.cursor + 1);
      return;
    }
    if (data === "\x1b[H" || data === "g") {
      this.cursor = 0;
      return;
    }
    if (data === "\x1b[F" || data === "G") {
      this.cursor = this.records.length - 1;
      return;
    }
    if (data === " ") {
      this.toggleCurrent();
      return;
    }
    if (data === "a") {
      for (const record of this.records) this.checked.add(record.id);
      return;
    }
    if (data === "n") {
      this.checked.clear();
      return;
    }
    if (data === "e") {
      this.finish({ kind: "edit", id: this.current().id, selectedIds: this.selectedIds() });
      return;
    }
    if (data === "r") {
      const ids = this.selectedIds();
      if (ids.length > 0) this.finish({ kind: "apply", decision: "reject", ids });
      return;
    }
    if (data === "\r" || data === "\n") {
      const ids = this.selectedIds();
      if (ids.length > 0) this.finish({ kind: "apply", decision: "approve", ids });
    }
  }

  render(width: number): string[] {
    if (this.records.length === 0) return [this.theme.fg("muted", "No pending memories")];
    const safeWidth = Math.max(24, width);
    const lines = [
      this.theme.fg("accent", this.theme.bold(truncateText(`Review pending memories (${this.checked.size}/${this.records.length} selected)`, safeWidth))),
      this.theme.fg("dim", truncateText("↑↓/j/k move · space select · enter approve · e edit · r reject · a all · n none · esc cancel", safeWidth)),
      "",
    ];
    const visibleRows = Math.min(12, this.records.length);
    const maxStart = Math.max(0, this.records.length - visibleRows);
    const start = Math.min(maxStart, Math.max(0, this.cursor - visibleRows + 1));
    const end = Math.min(this.records.length, start + visibleRows);
    for (let index = start; index < end; index += 1) {
      const record = this.records[index]!;
      const pointer = index === this.cursor ? ">" : " ";
      const checkbox = this.checked.has(record.id) ? "[x]" : "[ ]";
      const scope = record.scope === "global" ? "global" : `project ${record.scopeKey}`;
      const prefix = `${pointer} ${checkbox} ${scope} `;
      const line = truncateText(`${prefix}${record.statement}`, safeWidth);
      lines.push(index === this.cursor ? this.theme.fg("accent", line) : line);
    }
    if (start > 0 || end < this.records.length) {
      lines.push(this.theme.fg("dim", truncateText(`Showing ${start + 1}-${end} of ${this.records.length}`, safeWidth)));
    }
    return lines;
  }

  invalidate(): void {
    // Rendering is derived from the current selection and cursor, so there is no cache.
  }

  private current(): MemoryRecord {
    return this.records[this.cursor]!;
  }

  private toggleCurrent(): void {
    const id = this.current().id;
    if (this.checked.has(id)) this.checked.delete(id);
    else this.checked.add(id);
  }

  private selectedIds(): string[] {
    return this.records.filter((record) => this.checked.has(record.id)).map((record) => record.id);
  }

  private finish(action: ReviewListAction): void {
    if (this.finished) return;
    this.finished = true;
    this.done(action);
  }
}
