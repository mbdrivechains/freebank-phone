import { describe, expect, it } from 'vitest';
import { b64u, utf8 } from './crypto';
import { parsePayText, parsePayValue, payLinkFor, scannedPay } from './paylink';

const ORIGIN = 'https://app.ecxfreebank.com';
const ADDR = 'XdJ8vXmW3pQ4kzYb9Hn2RtA6cLsE5uFgV7';
const value = (o: unknown) => b64u(utf8(JSON.stringify(o)));

describe('payment links (desktop v0.2.8)', () => {
  it('a shop link round-trips: address, house, amount and name', () => {
    const url = payLinkFor(ORIGIN, '/', { address: ADDR, house: 5, amount: 0.05, name: 'Corner Shop' });
    expect(url.startsWith(ORIGIN + '/#pay=')).toBe(true);
    expect(parsePayText(url, ORIGIN)).toEqual({ address: ADDR, house: 5, amount: 0.05, name: 'Corner Shop' });
  });

  it('the counter link leaves the amount to the payer', () => {
    const url = payLinkFor(ORIGIN, '/', { address: ADDR, house: 5, amount: null, name: 'Corner Shop' });
    expect(parsePayText(url, ORIGIN).amount).toBeNull();
  });

  it('takes the value alone, and a bare address', () => {
    expect(parsePayText(value({ v: 1, a: ADDR, h: 3, u: 1, n: '' }), ORIGIN).house).toBe(3);
    expect(parsePayText(`  ${ADDR} `, ORIGIN)).toEqual({ address: ADDR, house: null, amount: null, name: '' });
  });

  it("refuses another site's link, damage, and junk", () => {
    expect(() => parsePayText(payLinkFor('https://evil.example', '/', { address: ADDR, house: 5, amount: 1, name: '' }), ORIGIN)).toThrow(/another site/);
    expect(() => parsePayText(ORIGIN + '/#pay=!!!', ORIGIN)).toThrow(/damaged/);
    expect(() => parsePayText('hello', ORIGIN)).toThrow(/isn't a FreeBank payment/);
    expect(() => parsePayValue(value({ v: 2, a: ADDR, h: 5 }))).toThrow(/version/);
  });

  it('checks the address, the house and the amount', () => {
    expect(() => parsePayValue(value({ v: 1, a: '1BitcoinAddressNotOurs1234567890', h: 5 }))).toThrow(/address/);
    expect(() => parsePayValue(value({ v: 1, a: ADDR, h: -1 }))).toThrow(/house/);
    expect(() => parsePayValue(value({ v: 1, a: ADDR, h: 1.5 }))).toThrow(/house/);
    // (JSON carries no Infinity: it reads as null, an open amount.)
    for (const u of [0, -1, 'x', 1e9]) expect(() => parsePayValue(value({ v: 1, a: ADDR, h: 5, u }))).toThrow(/amount/);
    expect(() => parsePayValue(value({ v: 1, a: ADDR, h: 5, u: 0.123456789 }))).toThrow(/8 decimals/);
    expect(parsePayValue(value({ v: 1, a: ADDR, h: 5, u: 0.00000001 })).amount).toBe(1e-8);
  });

  it("cleans the shop's name for showing", () => {
    const r = parsePayValue(value({ v: 1, a: ADDR, h: 5, u: 1, n: 'Shop‮​name\u0007' + 'x'.repeat(80) }));
    expect(r.name.startsWith('Shopname')).toBe(true);
    expect(r.name.length).toBe(40);
  });

  it('scanning passes over other QR codes and takes ours', () => {
    expect('wrong' in scannedPay('https://example.com/', ORIGIN)).toBe(true);
    const url = payLinkFor(ORIGIN, '/', { address: ADDR, house: 5, amount: 1, name: '' });
    expect(scannedPay(url, ORIGIN)).toEqual({ value: url });
  });
});
