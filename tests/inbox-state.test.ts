import { test } from "node:test";
import assert from "node:assert/strict";
import {
  actionParameter,
  inboxState,
  inboxStates,
  statusTone,
} from "../apps/web/src/inbox-state.js";

test("inbox queues distinguish approvals, human takeover, active and resolved conversations", () => {
  assert.equal(inboxState({ status: "open", mode: "agent" }), "agent");
  assert.equal(inboxState({ status: "open", mode: "human" }), "human");
  assert.equal(inboxState({ status: "needs_staff", mode: "agent" }), "human");
  assert.equal(
    inboxState({ status: "waiting_approval", mode: "agent" }),
    "approval",
  );
  assert.equal(
    inboxState({ status: "waiting_approval", mode: "human" }),
    "human",
  );
  assert.equal(inboxState({ status: "resolved", mode: "human" }), "resolved");
  assert.equal(
    inboxState({
      status: "waiting_approval",
      mode: "agent",
      approval_expires_at: "2000-01-01T00:00:00Z",
    }),
    "human",
  );
  assert.equal(
    inboxState({
      status: "waiting_approval",
      mode: "agent",
      approval_expires_at: "2099-01-01T00:00:00Z",
    }),
    "approval",
  );
});
test("shared status semantics pair attention with red, approvals amber, activity blue and success green", () => {
  assert.equal(inboxStates.human.tone, statusTone("needs_staff"));
  assert.equal(inboxStates.approval.tone, statusTone("waiting_approval"));
  assert.equal(inboxStates.agent.tone, statusTone("running"));
  assert.equal(inboxStates.resolved.tone, statusTone("resolved"));
  assert.equal(statusTone("failed"), "bad");
});

test("approval amounts retain exact units without reinterpreting custom or unknown currency parameters", () => {
  assert.equal(
    actionParameter("stripe_refund", "amountMinor", 2000, { currency: "usd" }),
    "20.00 USD (2000 minor units)",
  );
  assert.equal(
    actionParameter("stripe_refund", "amountMinor", 2000, { currency: "jpy" }),
    "2000",
  );
  assert.equal(
    actionParameter("custom_write", "amountMinor", 2000, { currency: "usd" }),
    "2000",
  );
  assert.equal(
    inboxState({
      status: "waiting_approval",
      mode: "agent",
      approval_expires_at: null,
    }),
    "human",
  );
});
