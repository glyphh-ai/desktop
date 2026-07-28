/**
 * models-ipc — the org-admin Models page's bridge to the control plane.
 *
 * Mirrors the platform's Configure → Models surface: the whole catalog with the
 * org's support flags, provider enablement + BYOK keys (write-only), and the
 * org's custom OpenAI-compatible models. Every handler is a thin, guarded pass
 * through the SDK — the server enforces org_admin on all writes; a non-admin
 * gets the server's refusal back as `error`, never a crash.
 */

import { ipcMain } from "electron";
import { getClient } from "./glyphh-client";
import type { CustomModelInput } from "@glyphh/client";

function wrap<T>(fn: () => Promise<T>): Promise<{ ok: boolean; data?: T; error?: string }> {
  return fn()
    .then((data) => ({ ok: true as const, data }))
    .catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }));
}

export function registerModelsIpc(): void {
  ipcMain.handle("org-models-list", () => wrap(() => getClient().orgModels.list()));
  ipcMain.handle("org-models-set-supported", (_e, modelId: string, supported: boolean) =>
    wrap(() => getClient().orgModels.setSupported(String(modelId), !!supported)));

  ipcMain.handle("org-custom-models-list", () => wrap(() => getClient().orgModels.listCustom()));
  ipcMain.handle("org-custom-models-save", (_e, input: CustomModelInput) =>
    wrap(() => getClient().orgModels.saveCustom(input)));
  ipcMain.handle("org-custom-models-delete", (_e, id: string) =>
    wrap(() => getClient().orgModels.deleteCustom(String(id))));

  ipcMain.handle("org-providers-list", () => wrap(() => getClient().catalog.providers()));
  ipcMain.handle("org-provider-enable", (_e, slug: string, key?: string) =>
    wrap(() => getClient().providers.enable(String(slug), key ? String(key) : undefined)));
  ipcMain.handle("org-provider-disable", (_e, slug: string) =>
    wrap(() => getClient().providers.disable(String(slug))));
  ipcMain.handle("org-provider-clear-key", (_e, slug: string) =>
    wrap(() => getClient().providers.clearKey(String(slug))));
}
