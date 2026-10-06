import { z } from "zod";

export const RoutingSettings = z
  .object({
    enabled: z.boolean().default(false),
    defaultTeamId: z.string().min(1).max(200).nullable().default(null),
    availabilityTtlSeconds: z.number().int().min(60).max(1800).default(300),
  })
  .strict();
export const TeamInput = z
  .object({
    id: z.string().min(1).max(200).optional(),
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(1000).default(""),
    active: z.boolean().default(true),
    routingEnabled: z.boolean().default(false),
    overflowTeamId: z.string().min(1).max(200).nullable().default(null),
    overflowAfterMinutes: z.number().int().min(1).max(10080).default(30),
    memberIds: z.array(z.string().min(1).max(200)).max(200).default([]),
  })
  .strict();
export const AgentAvailability = z
  .object({
    state: z.enum(["available", "away", "offline"]),
  })
  .strict();
export const AgentCapacity = z
  .object({
    capacity: z.number().int().min(1).max(200),
  })
  .strict();
export const ManualAssignment = z
  .object({
    teamId: z.string().min(1).max(200).nullable().optional(),
    assignedTo: z.string().min(1).max(200).nullable().optional(),
    overrideCapacity: z.boolean().default(false),
    reason: z.string().trim().max(500).default(""),
  })
  .strict();
export type ManualAssignmentInput = z.input<typeof ManualAssignment>;
export const routingReasons: Record<string, string> = {
  ready: "Waiting for assignment",
  disabled: "Automatic routing is off",
  missing_team: "Missing team",
  inactive_team: "Team is inactive",
  team_disabled: "Team routing is off",
  no_members: "No team members",
  no_authorized_members: "No authorized members",
  no_available_members: "No available members",
  at_capacity: "All available members are at capacity",
  assigned: "Assigned by round robin",
  manual: "Assigned manually",
  manual_unassigned: "Manually left unassigned",
  owner_unavailable: "Previous owner no longer authorized",
  no_longer_eligible: "No longer waiting for human handling",
};
