import { createHash } from "node:crypto";
import type {
  ModelPort,
  ModelInput,
  FaqModelInput,
  SupportModelInput,
} from "../../packages/platform/src/model.js";
import type { Citation, Draft } from "../../packages/platform/src/contracts.js";
import type { EmbeddingConfig } from "../../packages/platform/src/model-providers.js";

const words = (text: string) =>
  text
    .toLowerCase()
    .match(/[a-z0-9]{3,}/g)
    ?.filter(
      (w) =>
        !new Set([
          "the",
          "and",
          "how",
          "can",
          "you",
          "your",
          "for",
          "with",
          "what",
          "does",
          "this",
          "that",
          "have",
          "are",
          "please",
        ]).has(w),
    ) ?? [];
function best(question: string, evidence: Citation[]) {
  const tokens = words(question);
  return evidence
    .map((e) => ({
      e,
      score: tokens.reduce(
        (n, w) => n + (e.excerpt.toLowerCase().includes(w) ? 1 : 0),
        0,
      ),
    }))
    .sort((a, b) => b.score - a.score)
    .find((e) => e.score > 0)?.e;
}
const draft = (
  intent: Draft["intent"],
  answer = "",
  citationIds: string[] = [],
): Draft => ({
  intent,
  answer,
  citationIds,
  actionName: null,
  parameters: {},
  reason: "Offline sandbox fixture; no AI model was called.",
});
export class StoreModel implements ModelPort {
  async embed(_ws: string, texts: string[], config?: EmbeddingConfig) {
    return texts.map((text) => {
      const vector = Array<number>(config?.dimensions ?? 1536).fill(0);
      for (const word of words(text))
        vector[
          createHash("sha256").update(word).digest().readUInt32BE(0) %
            vector.length
        ]++;
      if (!vector.some(Boolean)) vector[0] = 1;
      return vector;
    });
  }
  async answer(input: ModelInput): Promise<Draft> {
    const question =
      input.messages.findLast((m) => m.role === "customer")?.body ?? "";
    if (/human|speak to|warranty|lifetime|discount exception/i.test(question))
      return {
        ...draft("handoff"),
        reason: "Sandbox scenario: staff review is required for this request.",
      };
    const billing = Array.isArray(input.account)
      ? input.account
      : ((input.account as { billing?: any[] })?.billing ?? []);
    const account = billing.find((b: any) => b.mode === "test");
    const refund =
      /refund/i.test(question) &&
      !/policy|how long|when|how do/i.test(question);
    const cancel = /cancel/i.test(question);
    if (refund || cancel) {
      if (!account)
        return draft(
          "clarify",
          "[Sandbox simulation] Sign in as Alex to use the sample purchase and membership. Staff must verify account ownership before changing anything.",
        );
      const actionName = refund ? "refund_payment" : "cancel_subscription";
      if (!input.actions.some((a) => a.name === actionName))
        return {
          ...draft("handoff"),
          reason:
            "The requested sandbox action is not enabled in this workflow.",
        };
      const charge =
        account.charges?.find((c: any) => question.includes(c.id)) ??
        account.charges?.[0];
      const sub =
        account.subscriptions?.find((s: any) => question.includes(s.id)) ??
        account.subscriptions?.[0];
      if ((refund && !charge) || (cancel && !sub))
        return draft(
          "clarify",
          "[Sandbox simulation] There is no mapped sample purchase or membership for this account.",
        );
      const dollars = question.match(/\$(\d+(?:\.\d{1,2})?)/)?.[1];
      return {
        ...draft("action"),
        actionName,
        parameters: refund
          ? {
              chargeId: charge.id,
              amountMinor: dollars
                ? Math.round(Number(dollars) * 100)
                : charge.amountMinor - charge.refundedMinor,
              currency: charge.currency,
            }
          : { subscriptionId: sub.id },
      };
    }
    if (/^(hi|hello|hey|test)[!.\s]*$/i.test(question))
      return draft(
        "clarify",
        "[Sandbox simulation] Try asking about returns, shipping, the Summit Daypack, or Trail Club. Sign in as Alex to request a simulated refund or cancellation.",
      );
    const followup =
      question.length < 35 && /and |what about|how about/i.test(question);
    const evidence = best(
      question +
        (followup
          ? " " +
            input.messages
              .filter((m) => m.role === "customer")
              .slice(-2, -1)
              .map((m) => m.body)
              .join(" ")
          : ""),
      input.evidence,
    );
    if (!evidence)
      return {
        ...draft("handoff"),
        reason:
          "No matching customer-approved documentation in this offline sandbox.",
      };
    return draft(
      "answer",
      "[Sandbox simulation — retrieved policy excerpt]\n\n" + evidence.excerpt,
      [evidence.id],
    );
  }
  async faqs(input: FaqModelInput) {
    return input.evidence
      .slice(0, input.count)
      .map((e) => ({
        question:
          input.question ||
          `What should I know about ${e.title.replace(/\.md$/, "")}?`,
        answer: "[Sandbox draft — review before publishing]\n" + e.excerpt,
        citationIds: [e.id],
      }));
  }
  async assist(input: SupportModelInput) {
    const evidence = best(input.subject, input.evidence) ?? input.evidence[0];
    return {
      title: "Sandbox support draft",
      body:
        "[Scripted sandbox suggestion — no AI assessment]\n" +
        (evidence?.excerpt ?? "Staff should review this customer's request."),
      priority: "normal" as const,
      category: "sandbox",
      reason: "Offline fixture to exercise the review UI.",
      citationIds: evidence ? [evidence.id] : [input.messages[0].id],
      gaps: ["Review the actual conversation before using this suggestion."],
    };
  }
  async judge(): Promise<never> {
    throw new Error(
      "AI judging is unavailable in the offline sandbox. Turn off AI quality assessment to run rule checks; use a separate real-model installation for AI quality testing.",
    );
  }
  async analyzeGap(): Promise<never> {
    throw new Error(
      "AI gap analysis is unavailable in the offline sandbox. You can triage gaps and create manual FAQ drafts without an AI model.",
    );
  }
}
