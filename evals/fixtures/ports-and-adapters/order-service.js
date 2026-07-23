'use strict';

const storage = require('./storage');

// Places an order: fetches the unit price from the vendor pricing API,
// applies the weekend discount, and persists the order.
async function placeOrder(sku, quantity) {
  const res = await fetch(`https://pricing.vendor.example.com/v1/price/${sku}`);
  const body = await res.json();
  const unitPrice = body.data.amount_cents / 100;

  let total = unitPrice * quantity;
  const day = new Date(Date.now()).getDay();
  if (day === 0 || day === 6) {
    total = total * 0.9; // 10% weekend discount
  }

  const order = { sku, quantity, total, placedAt: Date.now() };
  storage.saveOrder(order);
  return order;
}

module.exports = { placeOrder };
