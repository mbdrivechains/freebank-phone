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
