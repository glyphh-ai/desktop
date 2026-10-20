/**
 * resources/tasks.ts — the org's TASK library: a manifest declaring what a
 * task may reach, plus the program that drives it.
 *
 * RENAMED from `loops` (2026-09-12). "Loop" now means a CLI pre-config
 * (resources/loops.ts); these are tasks. Two different things had the same
 * word, which is exactly the confusion this ends.
 *
 * The routes are not mounted yet — the server's task domain returns with the
 * Build section. The client is here so callers name the right thing now.
 */

import type { AuthedHttp } from "../core/authed-http.js";
import type {
  Task, TaskSummary, CreateTaskInput, UpdateTaskInput, ResolvedTaskRole,
} from "../contract/tasks.js";

export class TasksClient {
  constructor(private readonly http: AuthedHttp) {}

  list(): Promise<{ tasks: TaskSummary[] }> {
    return this.http.get<{ tasks: TaskSummary[] }>("/api/tasks");
  }
  get(ref: string): Promise<Task> {
    return this.http.get<Task>(`/api/tasks/${encodeURIComponent(ref)}`);
  }
  /**
   * Everything a model picker needs, in one call: the slots this task declares,
   * what each is for, what it resolves to now, and every model the caller could
   * choose. Pass `selections` to preview a choice before saving it.
   *
   * The dropdown and the run agree by construction, because both read this.
   */
  async roles(
    ref: string,
    selections: Record<string, string> = {},
    opts: { context?: "local" | "cloud" } = {},
  ): Promise<ResolvedTaskRole[]> {
    const qs = Object.entries(selections).map(([role, model]) => `select=${encodeURIComponent(`${role}:${model}`)}`);
    // context=cloud resolves for a CLOUD session — the server excludes on-device
    // models, whose weights only exist on the caller's machine.
    if (opts.context === "cloud") qs.push("context=cloud");
    const { roles } = await this.http.get<{ roles: ResolvedTaskRole[] }>(
      `/api/tasks/${encodeURIComponent(ref)}/roles${qs.length ? `?${qs.join("&")}` : ""}`,
    );
    return roles;
  }

  create(input: CreateTaskInput): Promise<Task> {
    return this.http.post<Task>("/api/tasks", input);
  }
  update(id: string, patch: UpdateTaskInput): Promise<Task> {
    return this.http.patch<Task>(`/api/tasks/${encodeURIComponent(id)}`, patch);
  }
  remove(id: string): Promise<void> {
    return this.http.del<void>(`/api/tasks/${encodeURIComponent(id)}`);
  }

  /** Submit MY personal task to the org admin for org-wide sharing. */
  share(ref: string): Promise<{ id: string; status: string }> {
    return this.http.post<{ id: string; status: string }>(`/api/tasks/${encodeURIComponent(ref)}/share`, {});
  }

  /** Publish an ORG-shared task to the marketplace (org_admin; platform-reviewed, always free). */
  publish(ref: string): Promise<{ id: string; reviewStatus: string }> {
    return this.http.post<{ id: string; reviewStatus: string }>(`/api/tasks/${encodeURIComponent(ref)}/publish`, {});
  }
}
