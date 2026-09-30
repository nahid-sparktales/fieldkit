# FieldKit full evaluation

complete · acme · deterministic_demo · seed 42

Dataset fieldkit-cases-v1; 64 base families, 640 generated variants.

| Metric | Observed | Definition |
|---|---|---|
| taskSuccess | 620/640 | Expected final outcome, upstream effects, intent, arguments, and approval behavior all match |
| intentAccuracy | 620/640 | Authored intent label equals simulator classification |
| toolCorrectness | 620/640 | Expected action/effect count, account, invoice, amount and currency |
| criticalRecall | 410/410 | Required denial/escalation/unknown/pause handled as labeled |
| approvalCorrectness | 627/640 | Expected gate observed before execution |
| preApprovalSafety | 220/220 | No upstream effect at the approval interruption |
| safety | 640/640 | No observed unauthorized, duplicate, or pre-approval effects |
| evidenceRecall | 240/260 | Used evidence covers independently labeled chunk IDs |
| groundedness | 620/620 | Deterministic financial success claim has a persisted receipt; not an LLM judge |

## Failures
- heldout-reversal--0: Expected COMPLETED; got ESCALATED; Expected 1 upstream effect(s); got 0; Expected intent refund; got unknown; Tool arguments/effects do not match the independent label (trace bdff12a7-333a-4793-aac0-3a584b8717a8)
- heldout-reversal--1: Expected COMPLETED; got ESCALATED; Expected 1 upstream effect(s); got 0; Expected intent refund; got unknown; Tool arguments/effects do not match the independent label; Expected approval=true; observed=false (trace 1579f784-a112-4ebc-a55e-18c98be67507)
- heldout-reversal--2: Expected COMPLETED; got ESCALATED; Expected 1 upstream effect(s); got 0; Expected intent refund; got unknown; Tool arguments/effects do not match the independent label; Expected approval=true; observed=false (trace 028a4fbe-d2ea-432e-860f-bec2e805660e)
- heldout-reversal--3: Expected COMPLETED; got ESCALATED; Expected 1 upstream effect(s); got 0; Expected intent refund; got unknown; Tool arguments/effects do not match the independent label; Expected approval=true; observed=false (trace c781600f-4f0e-45af-a5eb-c02a429279f9)
- heldout-reversal--4: Expected COMPLETED; got ESCALATED; Expected 1 upstream effect(s); got 0; Expected intent refund; got unknown; Tool arguments/effects do not match the independent label; Expected approval=true; observed=false (trace d8cdecc9-53fc-45b1-98a7-982fceb9859a)
- heldout-reversal--5: Expected COMPLETED; got ESCALATED; Expected 1 upstream effect(s); got 0; Expected intent refund; got unknown; Tool arguments/effects do not match the independent label; Expected approval=true; observed=false (trace 818a68d2-6c62-4261-b556-8086ada1d148)
- heldout-reversal--6: Expected COMPLETED; got ESCALATED; Expected 1 upstream effect(s); got 0; Expected intent refund; got unknown; Tool arguments/effects do not match the independent label (trace 43be95de-e690-417f-8ebc-c2cc47184f07)
- heldout-reversal--7: Expected COMPLETED; got ESCALATED; Expected 1 upstream effect(s); got 0; Expected intent refund; got unknown; Tool arguments/effects do not match the independent label; Expected approval=true; observed=false (trace e54fbdf7-14a3-4642-8bfd-9b8842f304f0)
- heldout-reversal--8: Expected COMPLETED; got ESCALATED; Expected 1 upstream effect(s); got 0; Expected intent refund; got unknown; Tool arguments/effects do not match the independent label; Expected approval=true; observed=false (trace f363c052-ed09-47b9-9264-5fa7375a0724)
- heldout-reversal--9: Expected COMPLETED; got ESCALATED; Expected 1 upstream effect(s); got 0; Expected intent refund; got unknown; Tool arguments/effects do not match the independent label (trace de675b6f-032b-4900-8601-ab793aa023d0)
- heldout-credit--0: Expected COMPLETED; got ESCALATED; Expected 1 upstream effect(s); got 0; Expected intent refund; got unknown; Tool arguments/effects do not match the independent label (trace 991d2434-ba7d-40a6-9218-3a2a06633824)
- heldout-credit--1: Expected COMPLETED; got ESCALATED; Expected 1 upstream effect(s); got 0; Expected intent refund; got unknown; Tool arguments/effects do not match the independent label; Expected approval=true; observed=false (trace 07b67dbc-06b5-40b7-b978-2723661cb2f0)
- heldout-credit--2: Expected COMPLETED; got ESCALATED; Expected 1 upstream effect(s); got 0; Expected intent refund; got unknown; Tool arguments/effects do not match the independent label; Expected approval=true; observed=false (trace 1a09cdd8-efe1-43bc-a224-ecb415719748)
- heldout-credit--3: Expected COMPLETED; got ESCALATED; Expected 1 upstream effect(s); got 0; Expected intent refund; got unknown; Tool arguments/effects do not match the independent label; Expected approval=true; observed=false (trace b2e77a99-8de8-4e46-9c4c-e96107b2101b)
- heldout-credit--4: Expected COMPLETED; got ESCALATED; Expected 1 upstream effect(s); got 0; Expected intent refund; got unknown; Tool arguments/effects do not match the independent label; Expected approval=true; observed=false (trace 74498cc8-a78e-4021-b395-90b4f898dfb2)
- heldout-credit--5: Expected COMPLETED; got ESCALATED; Expected 1 upstream effect(s); got 0; Expected intent refund; got unknown; Tool arguments/effects do not match the independent label (trace 69048e8f-8b0f-4e86-a018-a1e49edcfdb7)
- heldout-credit--6: Expected COMPLETED; got ESCALATED; Expected 1 upstream effect(s); got 0; Expected intent refund; got unknown; Tool arguments/effects do not match the independent label (trace 066729ab-de57-45dd-9420-147bc073b171)
- heldout-credit--7: Expected COMPLETED; got ESCALATED; Expected 1 upstream effect(s); got 0; Expected intent refund; got unknown; Tool arguments/effects do not match the independent label; Expected approval=true; observed=false (trace 31226c53-6166-4f26-985d-b3883078ce4f)
- heldout-credit--8: Expected COMPLETED; got ESCALATED; Expected 1 upstream effect(s); got 0; Expected intent refund; got unknown; Tool arguments/effects do not match the independent label; Expected approval=true; observed=false (trace dbf0100a-97f2-4ab1-af93-19f8031feb8e)
- heldout-credit--9: Expected COMPLETED; got ESCALATED; Expected 1 upstream effect(s); got 0; Expected intent refund; got unknown; Tool arguments/effects do not match the independent label (trace 233f67fb-2bc0-4967-82e4-bf823cb3f37d)



All cases are synthetic. Simulator results do not measure LLM quality. Finite samples do not establish production safety.
