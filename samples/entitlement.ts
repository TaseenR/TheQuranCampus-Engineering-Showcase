import 'server-only';

import {
  SubscriptionStatus,
  type Course,
  type CourseItem,
  type UnlockRule,
  type User,
} from "@prisma/client";

import { hasCompletedRequirement } from "@/features/progression/unlock";
import { prisma } from "@/lib/prisma";
import type { EntitlementResult } from "@/types/access";

export async function canViewCourse(
  user: User | null,
  course: Pick<Course, "isPublished">,
): Promise<EntitlementResult> {
  if (user === null) {
    return { allowed: false, reason: "NOT_AUTHENTICATED" };
  }

  if (!course.isPublished && user.role !== "ADMIN") {
    return { allowed: false, reason: "NOT_PUBLISHED" };
  }

  return { allowed: true };
}

export async function hasActiveSubscription(userId: string): Promise<boolean> {
  const sub = await prisma.subscription.findFirst({
    where: {
      userId,
      status: {
        in: [
          SubscriptionStatus.ACTIVE,
          SubscriptionStatus.TRIALING,
          SubscriptionStatus.PAST_DUE,
        ],
      },
      currentPeriodEnd: { gt: new Date() },
    },
  });

  return Boolean(sub);
}

// Strategy doc §4.5 is the spec for course item entitlement evaluation.
export async function canViewCourseItem(
  user: User | null,
  courseItem: Pick<CourseItem, "isPublished" | "accessLevel" | "isPreview"> & {
    unlockRulesAsTarget: UnlockRule[];
  },
): Promise<EntitlementResult> {
  if (user === null) {
    return { allowed: false, reason: "NOT_AUTHENTICATED" };
  }

  if (!courseItem.isPublished && user.role !== "ADMIN") {
    return { allowed: false, reason: "NOT_PUBLISHED" };
  }

  // 1. Subscription check (paid items, non-preview)
  if (courseItem.accessLevel === "PAID" && !courseItem.isPreview) {
    const subscribed = await hasActiveSubscription(user.id);
    if (!subscribed) {
      return { allowed: false, reason: "SUBSCRIPTION_REQUIRED" };
    }
  }

  for (const rule of courseItem.unlockRulesAsTarget) {
    const completed = await hasCompletedRequirement(user.id, rule);

    if (!completed) {
      return {
        allowed: false,
        reason: "PREREQUISITE_INCOMPLETE",
        details: {
          ruleId: rule.id,
          requirementType: rule.requirementType,
        },
      };
    }
  }

  return { allowed: true };
}
