/**
 * Unit tests for CommissionService — the money-split engine.
 *
 * Pure function, no database. Run with:
 *   npx jest tests/unit/commissionService.test.js
 *
 * Rules under test (from src/services/CommissionService.js):
 *   - Default commission rate: 20%
 *   - Location: premium 25%, rural 15%, urban/other 20%
 *   - Price overrides (applied AFTER location, so they win):
 *       price > 2000  -> 30%
 *       price < 200   -> 15%
 *   - Invalid/zero/negative price -> all zeros
 *   - platformFee + spotterEarning always equals the price
 */

const CommissionService = require('../../src/services/CommissionService');

describe('CommissionService.calculateCommission', () => {
  describe('location-based rates', () => {
    test('urban uses the default 20%', () => {
      const r = CommissionService.calculateCommission(1000, 'urban');
      expect(r.commissionRate).toBe(0.20);
      expect(r.platformFee).toBe(200);
      expect(r.spotterEarning).toBe(800);
    });

    test('premium uses 25%', () => {
      const r = CommissionService.calculateCommission(1000, 'premium');
      expect(r.commissionRate).toBe(0.25);
      expect(r.platformFee).toBe(250);
      expect(r.spotterEarning).toBe(750);
    });

    test('rural uses 15%', () => {
      const r = CommissionService.calculateCommission(1000, 'rural');
      expect(r.commissionRate).toBe(0.15);
      expect(r.platformFee).toBe(150);
      expect(r.spotterEarning).toBe(850);
    });

    test('defaults to 20% when no location is given', () => {
      expect(CommissionService.calculateCommission(1000).commissionRate).toBe(0.20);
    });

    test('unknown location falls back to 20%', () => {
      expect(CommissionService.calculateCommission(1000, 'space-station').commissionRate).toBe(0.20);
    });
  });

  describe('price-based overrides beat location', () => {
    test('price > 2000 forces 30% even on premium', () => {
      const r = CommissionService.calculateCommission(3000, 'premium');
      expect(r.commissionRate).toBe(0.30);
      expect(r.platformFee).toBe(900);
      expect(r.spotterEarning).toBe(2100);
    });

    test('price < 200 forces 15% even on premium', () => {
      const r = CommissionService.calculateCommission(100, 'premium');
      expect(r.commissionRate).toBe(0.15);
      expect(r.platformFee).toBe(15);
      expect(r.spotterEarning).toBe(85);
    });
  });

  describe('boundary values', () => {
    test('exactly 2000 is NOT a high-value override (stays 20%)', () => {
      expect(CommissionService.calculateCommission(2000, 'urban').commissionRate).toBe(0.20);
    });

    test('exactly 200 is NOT a low-value override (stays 20%)', () => {
      expect(CommissionService.calculateCommission(200, 'urban').commissionRate).toBe(0.20);
    });
  });

  describe('rounding', () => {
    test('fees are rounded to 2 decimal places', () => {
      const r = CommissionService.calculateCommission(250.5, 'urban');
      expect(r.platformFee).toBe(50.1);
      expect(r.spotterEarning).toBe(200.4);
    });
  });

  describe('invalid / edge inputs return all zeros', () => {
    test.each([
      ['zero', 0],
      ['negative', -100],
      ['null', null],
      ['undefined', undefined],
      ['non-numeric string', 'abc'],
    ])('%s price -> {0,0,0}', (_label, price) => {
      const r = CommissionService.calculateCommission(price, 'urban');
      expect(r).toEqual({ commissionRate: 0, platformFee: 0, spotterEarning: 0 });
    });

    test('numeric string is coerced and calculated', () => {
      const r = CommissionService.calculateCommission('1000', 'urban');
      expect(r.platformFee).toBe(200);
      expect(r.spotterEarning).toBe(800);
    });
  });

  describe('invariant: nothing is lost or created', () => {
    test.each([100, 200, 999.99, 1000, 2000, 5000])(
      'fee + earning === price for %p',
      (price) => {
        const r = CommissionService.calculateCommission(price, 'urban');
        expect(r.platformFee + r.spotterEarning).toBeCloseTo(price, 2);
      }
    );
  });
});
