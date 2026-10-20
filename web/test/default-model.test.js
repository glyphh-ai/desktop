import { describe, it, expect } from 'vitest';
import { resolveDefaultModel } from '../src/default-model.ts';

// The Glyphh agent's rule, on the phone (his order, 2026-09-30).
const models = [
  { id: 'openai::gpt-5.5', name: 'gpt-5.5', providerSlug: 'openai', modality: 'chat' },
  { id: 'anthropic::claude-sonnet-5', name: 'claude-sonnet-5', providerSlug: 'anthropic', modality: 'chat' },
  { id: 'auto::Auto', name: 'Auto', providerSlug: 'auto', modality: 'chat', autoRouter: true },
  { id: 'fireworks_ai::qwen3-embedding-8b', name: 'qwen3-embedding-8b', modality: 'embedding' },
];

describe('resolveDefaultModel', () => {
  it("opens on the member's own Default model, by id or by bare name", () => {
    expect(resolveDefaultModel(models, 'anthropic::claude-sonnet-5', 'gpt-5.5')).toBe('anthropic::claude-sonnet-5');
    expect(resolveDefaultModel(models, 'claude-sonnet-5', 'gpt-5.5')).toBe('anthropic::claude-sonnet-5');
  });
  it("falls to the org's default when the member has none, or theirs is gone from the list", () => {
    expect(resolveDefaultModel(models, '', 'gpt-5.5')).toBe('openai::gpt-5.5');
    expect(resolveDefaultModel(models, 'anthropic::claude-opus-4-1', 'gpt-5.5')).toBe('openai::gpt-5.5');
  });
  it('then the team router, then the first chat model — never an embedding model', () => {
    expect(resolveDefaultModel(models, '', '')).toBe('auto::Auto');
    expect(resolveDefaultModel(models.filter((m) => !m.autoRouter), '', '')).toBe('anthropic::claude-sonnet-5');
    expect(resolveDefaultModel(models.filter((m) => m.modality === 'embedding'), '', '')).toBe('');
  });
});
