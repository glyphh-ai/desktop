import { describe, expect, it } from 'vitest';
import { PHONE_THEME_IDS, themeToApply } from '../src/mobile-theme.ts';

describe('the phone paints the member\'s theme (his report, 2026-10-05: purple buttons on the phone only)', () => {
  it('the server preference wins when the phone knows it', () => {
    expect(themeToApply('modern-dark', 'dark')).toBe('modern-dark');
    expect(themeToApply(' modern-light ', 'dark')).toBe('modern-light');
  });

  it('an unknown or missing server theme falls back to the device, then to High Vis dark', () => {
    expect(themeToApply('neon-zebra', 'nord')).toBe('nord');
    expect(themeToApply(undefined, 'dracula')).toBe('dracula');
    expect(themeToApply(null, null)).toBe('dark');
    expect(themeToApply(42, 'bogus')).toBe('dark');
  });

  it('offers the Modern pair the desktop offers', () => {
    expect(PHONE_THEME_IDS).toContain('modern-dark');
    expect(PHONE_THEME_IDS).toContain('modern-light');
  });
});
