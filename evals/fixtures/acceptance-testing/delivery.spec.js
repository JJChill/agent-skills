'use strict';

// Started by a previous engineer — covers criterion 1 only.
const test = require('node:test');

test('free delivery for Dave books', async () => {
  await page.goto('https://shop.example.com/home');
  await page.click('#search-box');
  await page.type('#search-box', 'Modern Software Engineering');
  await page.click('button.search-submit');
  await page.click('.result-row:first-child .add-to-cart-btn');
  await page.goto('https://shop.example.com/cart');
  const shippingCell = await page.textContent('table#totals tr.shipping td');
  if (shippingCell !== '$0.00') throw new Error('expected $0.00 in shipping cell');
});
