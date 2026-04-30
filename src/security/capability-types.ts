import type { PermissionId, PermissionRisk } from "../core/modules/permissions.js";

export type RiskTier = PermissionRisk;

export interface Capability {
  id: string;
  tool: string;
  permission: PermissionId;
  scope: CapabilityScope;
  constraints?: CapabilityConstraints;
  riskLevel: RiskTier;
  createdAt: string;
  expiresAt: string | null;
  persistent: boolean;
  grantedVia: GrantMethod;
}

export type CapabilityScopeType = "once" | "file" | "folder" | "session" | "project";

export interface CapabilityScope {
  type: CapabilityScopeType;
  path?: string;
  pattern?: string;
  command?: string;
}

export interface CapabilityConstraints {
  maxFileSize?: number;
  allowedExtensions?: string[];
  commandAllowlist?: string[];
}

export type GrantMethod = "approve_once" | "approve_scoped" | "approve_persistent";

export interface CapabilityMatchContext {
  path?: string;
  command?: string;
  args?: Record<string, unknown>;
}
