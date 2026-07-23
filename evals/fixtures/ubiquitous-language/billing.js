'use strict';

// Bills every active subscription for the current billing period.
function billClients(clients) {
  const invoices = [];
  for (const client of clients) {
    if (client.subscription.state !== 'active') continue;
    invoices.push({
      customerId: client.id,
      amount: client.subscription.monthlyPrice,
    });
  }
  return invoices;
}

// A cancelled account holder keeps access for a few days after their
// membership ends — the team has been calling this "the buffer window",
// "grace days", or "the courtesy period" depending on who you ask.
function accessEndsAt(accountHolder) {
  const GRACE_DAYS = 5;
  const cancelledAt = accountHolder.subscription.cancelledAt;
  return new Date(cancelledAt.getTime() + GRACE_DAYS * 24 * 60 * 60 * 1000);
}

module.exports = { billClients, accessEndsAt };
