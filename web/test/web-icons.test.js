/**
 * web-icons.test.js — the src an app tile wears on the web (web/src/web-icons.js):
 * the row's own bytes first, then its favicon through our /webicon proxy
 * (carried as faviconUrl, or derived from url), else "" so the wall keeps its
 * letter / app mark.
 */
import { describe, it, expect } from 'vitest';
import { iconForRow } from '../src/web-icons.js';
import { WEB_ICON_ROUTE } from '../webicon.mjs';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const SVG = 'data:image/svg+xml;base64,PHN2Zy8+';
const proxied = (host) => `${WEB_ICON_ROUTE}?u=${encodeURIComponent(`https://www.google.com/s2/favicons?domain=${host}&sz=64`)}`;

describe('iconForRow', () => {
  it('wears the carried bytes before anything else', () => {
    expect(iconForRow({ iconDataUrl: SVG, faviconUrl: 'https://www.google.com/s2/favicons?domain=shoes.example&sz=64', url: 'https://shoes.example' })).toBe(SVG);
    expect(iconForRow({ iconDataUrl: PNG })).toBe(PNG);
  });
  it('takes only an image data URL as bytes', () => {
    expect(iconForRow({ iconDataUrl: 'data:text/html;base64,PGI+', url: 'https://reddit.com' })).toBe(proxied('reddit.com'));
    expect(iconForRow({ iconDataUrl: 'https://cdn.example/icon.png', url: 'https://reddit.com' })).toBe(proxied('reddit.com'));
    expect(iconForRow({ iconDataUrl: '' })).toBe('');
  });
  it('proxies the carried favicon URL through our origin', () => {
    expect(iconForRow({ faviconUrl: 'https://www.google.com/s2/favicons?domain=slack.com&sz=64', url: 'https://app.slack.com/client' })).toBe(proxied('slack.com'));
  });
  it('derives the favicon from the url when the row carries none (a server row, an older desktop)', () => {
    expect(iconForRow({ url: 'https://www.reddit.com/r/all' })).toBe(proxied('www.reddit.com'));
    expect(iconForRow({ url: 'http://Monday.com/boards' })).toBe(proxied('monday.com'));
  });
  it('never proxies a carried favicon URL that is off the rule', () => {
    expect(iconForRow({ faviconUrl: 'https://evil.example/favicons?domain=slack.com&sz=64' })).toBe('');
    expect(iconForRow({ faviconUrl: 'https://www.google.com/s2/favicons?domain=user@slack.com&sz=64', url: 'yo://home' })).toBe('');
  });
  it('is "" for a Glyphh app with no local icon and no URL, a native app, or no row — the caller keeps its fallback', () => {
    expect(iconForRow({ id: 'happy-shoes', name: 'Happy Shoes', appArchetype: 'glyphh-app', url: null, execPath: '/Users/me/.glyphh/apps/happy-shoes/ui/index.html' })).toBe('');
    expect(iconForRow({ name: 'Finder', url: null, execPath: '/System/Library/CoreServices/Finder.app' })).toBe('');
    expect(iconForRow({ url: 'yo://home' })).toBe('');
    expect(iconForRow({ url: 'file:///Users/me/index.html' })).toBe('');
    expect(iconForRow({})).toBe('');
    expect(iconForRow(null)).toBe('');
    expect(iconForRow(undefined)).toBe('');
    expect(iconForRow('https://reddit.com')).toBe('');
  });
});
