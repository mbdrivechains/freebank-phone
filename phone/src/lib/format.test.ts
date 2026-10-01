import { describe, expect, it } from 'vitest';
import { fmtEcx, parseAmount, defaultDeviceName } from './format';

describe('format', () => {
  it('fmtEcx', () => {
    expect(fmtEcx(12.5)).toBe('12.50');
    expect(fmtEcx(0)).toBe('0.00');
    expect(fmtEcx(0.00012)).toBe('0.00012');
    expect(fmtEcx(-1.5)).toBe('-1.50');
    expect(fmtEcx(1234567.12345678)).toBe('1,234,567.12345678');
    expect(fmtEcx(1e-8)).toBe('0.00000001');
  });
  it('parseAmount', () => {
    expect(parseAmount('0.05')).toBe(0.05);
    expect(parseAmount('0,05')).toBe(0.05);
    expect(parseAmount('.5')).toBe(0.5);
    expect(parseAmount('1')).toBe(1);
    expect(parseAmount('0.000000001')).toBeNull();
    expect(parseAmount('0')).toBeNull();
    expect(parseAmount('-1')).toBeNull();
    expect(parseAmount('1e3')).toBeNull();
    expect(parseAmount('')).toBeNull();
  });
  it('defaultDeviceName', () => {
    expect(defaultDeviceName('Mozilla/5.0 (Linux; Android 14; Pixel 7)')).toBe('Android phone');
    expect(defaultDeviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe('iPhone');
  });
});
