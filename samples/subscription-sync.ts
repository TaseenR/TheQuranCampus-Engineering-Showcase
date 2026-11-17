import 'server-only';

import { SubscriptionStatus } from "@prisma/client";
import type Stripe from "stripe";

import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";

export function mapStatus(
  stripeStatus: Stripe.Subscription.Status,
): SubscriptionStatus {
  switch (stripeStatus) {
    case "trialing":
      return SubscriptionStatus.TRIALING;
    case "active":
      return SubscriptionStatus.ACTIVE;
    case "past_due":
      return SubscriptionStatus.PAST_DUE;
    case "canceled":
      return SubscriptionStatus.CANCELED;
    case "incomplete":
      return SubscriptionStatus.INCOMPLETE;
    case "incomplete_expired":
      return SubscriptionStatus.INCOMPLETE_EXPIRED;
    case "unpaid":
      return SubscriptionStatus.UNPAID;
    case "paused":
      return SubscriptionStatus.PAUSED;
    default: {
      const _exhaustive: never = stripeStatus;
      throw new Error(`Unhandled Stripe subscription status: ${stripeStatus}`);
    }
  }
}

export async function syncSubscription(event: Stripe.Event): Promise<void> {
  let stripeSub: Stripe.Subscription;

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;

    if (!session.subscription) {
      return;
    }

    const subId =
      typeof session.subscription === "string"
        ? session.subscription
        : session.subscription.id;

    stripeSub = await stripe.subscriptions.retrieve(subId);
  } else if (
    event.type === "customer.subscription.created" ||
    event.type === "customer.subscription.updated" ||
    event.type === "customer.subscription.deleted"
  ) {
    stripeSub = event.data.object as Stripe.Subscription;
  } else {
    return;
  }

  const customerId =
    typeof stripeSub.customer === "string"
      ? stripeSub.customer
      : stripeSub.customer.id;

  let userId = stripeSub.metadata?.userId;

  if (!userId) {
    const user = await prisma.user.findFirst({
      where: { stripeCustomerId: customerId },
      select: { id: true },
    });

    if (!user) {
      throw new Error(
        `No local user for Stripe subscription ${stripeSub.id} ` +
          `(customer: ${customerId})`,
      );
    }

    userId = user.id;
  }

  const stripePriceId = stripeSub.items.data[0]?.price.id;

  if (!stripePriceId) {
    throw new Error(`Subscription ${stripeSub.id} has no price`);
  }

  const plan = await prisma.plan.findUnique({
    where: { stripePriceId },
    select: { id: true },
  });

  if (!plan) {
    throw new Error(
      `No local Plan for Stripe price ${stripePriceId} ` +
        `(subscription: ${stripeSub.id})`,
    );
  }

  const subscriptionWithPeriodEnd = stripeSub as Stripe.Subscription & {
    current_period_end?: number;
  };
  const currentPeriodEndSeconds =
    subscriptionWithPeriodEnd.current_period_end ??
    stripeSub.items.data[0]?.current_period_end;

  if (currentPeriodEndSeconds == null) {
    throw new Error(`Subscription ${stripeSub.id} has no current period end`);
  }

  // Stripe's flexible billing mode communicates cancellation via
  // cancel_at (unix timestamp) rather than the legacy boolean
  // cancel_at_period_end. Prefer cancel_at as the authoritative
  // signal; fall back to the boolean for older/non-flexible subscriptions.
  const cancelAt = stripeSub.cancel_at;
  const cancelAtPeriodEnd =
    cancelAt != null ? true : (stripeSub.cancel_at_period_end ?? false);

  const data = {
    status: mapStatus(stripeSub.status),
    currentPeriodEnd: new Date(currentPeriodEndSeconds * 1000),
    cancelAtPeriodEnd,
    planId: plan.id,
  };

  await prisma.subscription.upsert({
    where: { stripeSubscriptionId: stripeSub.id },
    create: {
      ...data,
      userId,
      stripeCustomerId: customerId,
      stripeSubscriptionId: stripeSub.id,
    },
    update: data,
  });
}
