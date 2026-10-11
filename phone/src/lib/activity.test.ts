import { describe, expect, it } from 'vitest';
import { mask, note, recentActivity } from './activity';

describe('recent activity', () => {
  it('masks what could identify the user or their coins', () => {
    const txid = 'a'.repeat(64);
    expect(mask(`sent ${txid}`)).toBe('sent <txid>');
    expect(mask('to XkPvjfFq8Hj9wy9Wq3pRr1sBdXJxZ5nT2n now')).toBe('to <address> now');
    expect(mask('to btx1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080 now')).toBe('to <address> now');
    expect(mask('relay 163.47.9.132 refused')).toBe('relay <ip> refused');
    expect(mask('https://app.ecxfreebank.com/#pair=eyJ2IjoxLCJyZWxheSI6')).toBe('https://app.ecxfreebank.com/#pair=<link>');
    expect(mask(`room ${'Zm9vYmFy'.repeat(6)}`)).toBe('room <id>');
    // IPv6 and MAC addresses; times stay.
    expect(mask('connect() to [2002:c0a8:15b:e472:3720:50ce:93e8:1736]:8455 at 12:01:07')).toBe('connect() to [<ip>]:<n> at 12:01:07');
    expect(mask('fe80::1%wlp2s0 and ::ffff:1.2.3.4')).toBe('<ip>%wlp2s0 and <ip>');
    expect(mask('ether 3c:22:fb:01:9a:7e')).toBe('ether <ip>');
    // Short ids, any address prefix, amounts, passwords in URLs.
    expect(mask('tx c2004004e2 to sGx4mWyTKY3V4bNdgcSxKTbZ1iVkKHyLGM')).toBe('tx <hex> to <address>');
    expect(mask('send: Not enough: you have 0.5 sECX, need 12.5 sECX (1500000 sats); fee 22600')).toBe('send: Not enough: you have <amount> sECX, need <amount> sECX (<amount> sats); fee <n>');
    expect(mask('an older desktop: 0.5 ECX')).toBe('an older desktop: <amount> ECX');
    expect(mask('wss://bob:hunter2@relay.example/ws')).toBe('wss://<user>@relay.example/ws');
    // What helps find a problem stays: states, request names, errors, heights.
    expect(mask('link: reconnecting; send: The desktop is busy (block 307)')).toBe('link: reconnecting; send: The desktop is busy (block 307)');
  });

  it('keeps the latest 60 events, one line each, with the time', () => {
    for (let i = 0; i < 70; i++) note(`event ${i}\nsecond line`);
    const got = recentActivity().split('\n');
    expect(got).toHaveLength(60);
    expect(got[0]).toMatch(/^\d\d:\d\d event 10 second line$/);
    expect(got[59]).toMatch(/ event 69 second line$/);
  });
});
