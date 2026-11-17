"use server";

import "server-only";

import { z } from "zod";

import { hasActiveSubscription } from "@/features/access/entitlement";
import { getOrCreateStripeCustomer } from "@/features/billing/customer";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { requireUser } from "@/lib/user";

const inputSchema = z.object({
  planSlug: z.enum(["monthly", "annual"]),
});

export async function createCheckoutSession(input: {
  planSlug: string;
}): Promise<{ url: string }> {
  const parsed = inputSchema.parse(input);
  const user = await requireUser();

  if (await hasActiveSubscription(user.id)) {
    throw new Error("User already has an active subscription");
  }

  const plan = await prisma.plan.findUnique({
    where: { slug: parsed.planSlug },
  });

  if (!plan || !plan.isActive) {
    throw new Error(`Plan not available: ${parsed.planSlug}`);
  }

  const customerId = await getOrCreateStripeCustomer(user.id);
  const appUrl = process.env.APP_URL;

  if (!appUrl) {
    throw new Error("APP_URL is not set");
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: plan.stripePriceId, quantity: 1 }],
    success_url: `${appUrl}/dashboard?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appUrl}/pricing?checkout=cancelled`,
    allow_promotion_codes: true,
    subscription_data: { metadata: { userId: user.id } },
  });

  if (!session.url) {
    throw new Error("Stripe did not return a checkout URL");
  }

  return { url: session.url };
}
