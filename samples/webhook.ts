import type Stripe from "stripe";

import { syncSubscription } from "@/features/billing/sync";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const body = await req.text();

  const sig = req.headers.get("stripe-signature");

  if (!sig) {
    return new Response("Missing stripe-signature header", { status: 400 });
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error("STRIPE_WEBHOOK_SECRET not set");
    return new Response("Server misconfigured", { status: 500 });
  }

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    return new Response(`Signature verification failed: ${msg}`, {
      status: 400,
    });
  }

  const seen = await prisma.processedWebhook.findUnique({
    where: { eventId: event.id },
  });

  if (seen) {
    return new Response("Already processed", { status: 200 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await syncSubscription(event);
        break;
      case "invoice.payment_failed":
        console.log(`Payment failed for event ${event.id}`);
        break;
      default:
        return new Response("Event type ignored", { status: 200 });
    }
  } catch (err) {
    console.error(`Webhook ${event.id} (${event.type}) failed:`, err);
    return new Response("Internal error", { status: 500 });
  }

  await prisma.processedWebhook.create({
    data: { eventId: event.id, type: event.type },
  });

  return new Response("OK", { status: 200 });
}
