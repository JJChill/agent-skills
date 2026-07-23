'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const mock = require('node:test').mock;

// Brittle: patches globals and our own module internals, and cannot
// control the day of week, so the discount branch is untested.
test('placeOrder totals price times quantity', async () => {
  global.fetch = async () => ({
    json: async () => ({ data: { amount_cents: 500 } }),
  });
  const storage = require('./storage');
  mock.method(storage, 'saveOrder', () => {});

  const { placeOrder } = require('./order-service');
  const order = await placeOrder('BOOK-1', 2);

  // Fails on Saturdays and Sundays because of the weekend discount.
  assert.equal(order.total, 10);
});
