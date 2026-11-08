import { createHash } from "node:crypto";

export interface RecoveryIdentity {
  readonly sessionID: string;
  readonly messageID: string;
  readonly partID: string;
  readonly callID: string;
  readonly tool: string;
}

const referencePattern = /^lc1_[0-9a-f]{32}$/;

export function hashText(text: string): string {
  // Hash the JSON string so distinct lone surrogates survive the UTF-8 encoding.
  return createHash("sha256").update(JSON.stringify(text)).digest("hex");
}

export function recoveryReference(identity: RecoveryIdentity, sourceHash: string): string {
  const key = JSON.stringify([
    identity.sessionID,
    identity.messageID,
    identity.partID,
    identity.callID,
    identity.tool,
    sourceHash,
  ]);
  return `lc1_${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
}

export function isRecoveryReference(value: string): boolean {
  return referencePattern.test(value);
}

export function recoveryReferences(text: string): Set<string> {
  return new Set(text.match(/\blc1_[0-9a-f]{32}\b/g));
}
