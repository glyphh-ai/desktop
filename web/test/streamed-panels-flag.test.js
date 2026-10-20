/**
 * streamed-panels-flag.test.js — the two-click flag (src/renderer/help/streamed-panels-flag.ts):
 * on needs a warning + "Turn on"; off is immediate; nothing persists on a cancel.
 */
import { describe, it, expect } from 'vitest';
import {
  nextFlagStep, flagSwitchChecked, flagWarningShown,
  STREAMED_PANELS_PREF, STREAMED_PANELS_WARNING,
} from '../../src/renderer/help/streamed-panels-flag.ts';

describe('streamed panels flag', () => {
  it('the pref is shared by name and the warning is his text', () => {
    expect(STREAMED_PANELS_PREF).toBe('streamedPanels');
    expect(STREAMED_PANELS_WARNING).toBe(
      'Streams a real browser from a worker to this page. Experimental: slower, costs more, and some sites block it. You can turn it off any time.',
    );
  });
  it('toggling on only ASKS — nothing persists, the switch stays off, the warning shows', () => {
    const r = nextFlagStep('off', 'toggle-on');
    expect(r).toEqual({ step: 'confirming' });
    expect(flagSwitchChecked(r.step)).toBe(false);
    expect(flagWarningShown(r.step)).toBe(true);
  });
  it('the second click ("Turn on") persists true and the switch goes on', () => {
    const r = nextFlagStep('confirming', 'confirm');
    expect(r).toEqual({ step: 'on', persist: true });
    expect(flagSwitchChecked('on')).toBe(true);
    expect(flagWarningShown('on')).toBe(false);
  });
  it('cancel from the warning goes back to off and persists nothing', () => {
    expect(nextFlagStep('confirming', 'cancel')).toEqual({ step: 'off' });
    expect(nextFlagStep('confirming', 'toggle-off')).toEqual({ step: 'off' });
  });
  it('turning off is immediate (persists false)', () => {
    expect(nextFlagStep('on', 'toggle-off')).toEqual({ step: 'off', persist: false });
  });
  it('redundant moves are no-ops', () => {
    expect(nextFlagStep('on', 'toggle-on')).toEqual({ step: 'on' });
    expect(nextFlagStep('off', 'toggle-off')).toEqual({ step: 'off' });
    expect(nextFlagStep('off', 'confirm')).toEqual({ step: 'off' });
    expect(nextFlagStep('on', 'cancel')).toEqual({ step: 'on' });
  });
});
