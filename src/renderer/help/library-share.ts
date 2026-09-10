/**
 * library-share.ts — the SHARE + PUBLISH actions on a skill/loop detail view
 * (his order, 2026-09-02). Share submits a personal item to the org admin's
 * approval queue; Publish sends an org-shared item to the platform review desk
 * for the marketplace (always free). Both are submissions, not mutations — the
 * approvals are the gates, so a click just queues and reports honestly.
 */

export function wireLibraryActions(
  root: HTMLElement,
  kind: "skill" | "loop",
  get: () => { slug: string } | null,
): void {
  const note = root.querySelector<HTMLElement>(`#${kind}-share-note`);
  const say = (msg: string, isErr = false): void => {
    if (!note) return;
    note.textContent = msg;
    note.classList.remove("hidden");
    note.style.color = isErr ? "var(--danger, #e5484d)" : "";
  };
  root.querySelector<HTMLButtonElement>(`#${kind}-share-btn`)?.addEventListener("click", (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    const item = get();
    if (!item) return;
    btn.disabled = true;
    void window.glyphh.libraryShare(kind, item.slug).then((r) => {
      btn.disabled = false;
      if (r.ok) say("Submitted — an org admin approves it before it's shared with everyone.");
      else say(r.error || "Couldn't submit.", true);
    });
  });
  root.querySelector<HTMLButtonElement>(`#${kind}-publish-btn`)?.addEventListener("click", (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    const item = get();
    if (!item) return;
    btn.disabled = true;
    void window.glyphh.libraryPublish(kind, item.slug).then((r) => {
      btn.disabled = false;
      if (r.ok) say("Submitted to the marketplace review desk — it lists once approved, always free to install.");
      else say(r.error || "Couldn't submit.", true);
    });
  });
}
