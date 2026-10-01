import { describe, expect, it } from 'vitest';
import { pairLinkFor, pairValueFrom } from './homescreen';

const ORIGIN = 'https://app.ecxfreebank.com';
const V = 'eyJ2IjoxLCJyZWxheSI6IndzczovL2FwcC5lY3hmcmVlYmFuay5jb20vd3MifQ';

describe('pasted pairing links', () => {
  it('takes the whole link, or the value alone', () => {
    expect(pairValueFrom(`${ORIGIN}/#pair=${V}`, ORIGIN)).toBe(V);
    expect(pairValueFrom(`  ${ORIGIN}/#pair=${V}\n`, ORIGIN)).toBe(V);
    expect(pairValueFrom(V, ORIGIN)).toBe(V);
    expect(pairValueFrom(pairLinkFor(V, { origin: ORIGIN, pathname: '/' }), ORIGIN)).toBe(V);
  });

  it('refuses another site, and ignores text without a link', () => {
    expect(() => pairValueFrom(`https://evil.example/#pair=${V}`, ORIGIN)).toThrow(/another site \(evil\.example\)/);
    expect(pairValueFrom('hello', ORIGIN)).toBeNull();
    expect(pairValueFrom('', ORIGIN)).toBeNull();
    expect(pairValueFrom(`${ORIGIN}/#pair=`, ORIGIN)).toBeNull();
  });
});

import { clean, githubUrl } from './report';

describe('reports', () => {
  it('are cleaned as the relay takes them', () => {
    expect(clean('a\r\nb\rc\td\u001b[2J‮e', true)).toBe('a\nb\nc\td[2Je');
    expect(clean('me\n@x', false)).toBe('me@x');
    // Invisible text goes: tags, zero-width, direction marks, the emoji variation selector.
    expect(clean('ok\u{E0049}\u{E0067} a\u200Bb\u200Ec \u2764\uFE0F', true)).toBe('ok abc \u2764');
  });
  it('link to the right GitHub page', () => {
    expect(githubUrl('idea')).toBe('https://github.com/mbdrivechains/freebank-app/issues/new?template=idea.yml');
    expect(githubUrl('security')).toBe('https://github.com/mbdrivechains/freebank-app/security/advisories/new');
  });
});

import { cameraError, decodeSize, scannedPair } from './scan';

describe('scanned QR codes', () => {
  it('must be a whole pairing link for this page; anything else is passed over', () => {
    expect(scannedPair(`${ORIGIN}/#pair=${V}`, ORIGIN)).toEqual({ value: V });
    const notOurs = { wrong: expect.stringMatching(/isn't a pairing code for this page/) };
    for (const text of [
      `https://evil.example/#pair=${V}`,
      `evil.example/#pair=${V}`,
      `\u200b${ORIGIN}/#pair=${V}`,
      `${ORIGIN}.evil.example/#pair=${V}`,
      V, // a bare value is fine to paste, not to scan
      `${ORIGIN}/#pair=`,
      'bitcoin:XkPvjfFq8Hj9wy9Wq3pRr1sBdXJxZ5nT2n',
      'https://example.com/',
      '',
    ])
      expect(scannedPair(text, ORIGIN), text).toEqual(notOurs);
  });

  it('say why the camera did not open, for the phone in hand', () => {
    expect(cameraError({ name: 'NotAllowedError' }, true).text).toMatch(/when your iPhone asks.*Settings, under Safari/);
    expect(cameraError({ name: 'NotAllowedError' }, false).text).toMatch(/browser’s settings for this site/);
    expect(cameraError({ name: 'NotFoundError' }, true).text).toMatch(/no camera/);
    expect(cameraError({ name: 'NotReadableError' }, true).text).toMatch(/busy/);
    expect(cameraError(new TypeError('Failed to fetch dynamically imported module: x'), true)).toEqual({
      text: expect.stringMatching(/did not load.*Reload/),
      reload: true,
    });
    expect(cameraError(new TypeError('Importing a module script failed.'), true).reload).toBe(true);
    expect(cameraError(null, false)).toEqual({ text: expect.stringMatching(/did not open/), reload: false });
  });

  it('decode frames at no more than 720 pixels a side', () => {
    expect(decodeSize(1280, 720)).toEqual({ w: 720, h: 405 });
    expect(decodeSize(720, 1280)).toEqual({ w: 405, h: 720 });
    expect(decodeSize(640, 480)).toEqual({ w: 640, h: 480 });
  });
});
