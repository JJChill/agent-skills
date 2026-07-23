'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DB_FILE = path.join(__dirname, 'orders.json');

function saveOrder(order) {
  const orders = fs.existsSync(DB_FILE)
    ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))
    : [];
  orders.push(order);
  fs.writeFileSync(DB_FILE, JSON.stringify(orders, null, 2));
}

module.exports = { saveOrder };
