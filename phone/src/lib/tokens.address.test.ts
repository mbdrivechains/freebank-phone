// Which addresses Tokens pays notes out to (tokens.ts addressOk): plain (P2PKH) FreeBank ones only.
import { describe, expect, it } from 'vitest';
import { addressOk } from './tokens';

describe('addressOk', () => {
  it('takes a plain FreeBank address, as the desktop gives', () => {
    expect(addressOk('XUFxwZZ1rK4XSzcYE1YsPnXu6Xo6kZEvua')).toBe(true);
    expect(addressOk('  XQH6TwYD466q5ccd8QjBwXSbhYUEYmuoHP ')).toBe(true);
  });
  it("refuses a wallet's default easynet address (s…: notes can't go there), eCash, bech32 and non-base58", () => {
    expect(addressOk('sYxffCrBsmbAs2CyjdVdaboC4V6Fiebnhw')).toBe(false);
    expect(addressOk('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')).toBe(false);
    expect(addressOk('fbk1qw508d6qejxtdg4y5r3zarvary0c5xw7k3lh8z9')).toBe(false);
    expect(addressOk('mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn')).toBe(false);
    expect(addressOk('XUFxwZZ1rK4XSzcYE1YsPnXu6Xo6kZEvu0')).toBe(false);
    expect(addressOk('')).toBe(false);
  });
});
