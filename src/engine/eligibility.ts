import type { Context } from "@opencode/plugin/promise/plugin";
import type { SessionContext } from "@opencode/plugin/promise/session";
import type { RecoveryIdentity } from "../recovery/integrity.ts";
import { isSpanCheckpoint } from "./checkpoint.ts";

type History = Awaited<ReturnType<Context["session"]["context"]>>;
type Assistant = Extract<History[number], { type: "assistant" }>;
type Tool = Extract<Assistant["content"][number], { type: "tool" }>;
type ToolMessage = Extract<SessionContext["messages"][number], { role: "tool" }>;

export interface Candidate {
  readonly identity: RecoveryIdentity;
  readonly tool: Tool;
  readonly suffixTokens?: number;
}

export interface EligibleResult {
  readonly sourceText: string;
  readonly header?: string;
  readonly trailer: readonly string[];
  readonly entries: readonly string[];
  readonly firstEntry: number;
  readonly unit: "lines" | "entries" | "paths";
  readonly observation?: string;
}

const readHeader = /^Read (file|directory) (.+), (lines|entries) (\d+)-(\d+)$/;
const protectedDirectories = /^(?:\.(?:agents?|claude|codex|cursor|git|github|opencode|rules|ssh)|instructions?)$/i;
const protectedNames = /^(?:agents?|claude|gemini|codex|readme|skill|instructions?|.+\.instructions|\.env|\.netrc|\.npmrc)(?:\..*)?$|\.(?:log|pem|key)$/i;
const checkpoint = "[Live Compact omitted ";

const hasProviderMetadata = (value: object) => "providerMetadata" in value && value.providerMetadata !== undefined;
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function canRewriteToolResult(message: ToolMessage, part: ToolMessage["content"][number]): boolean {
  if (hasProviderMetadata(message) || part.providerExecuted ||
      (isObject(part.result) && hasProviderMetadata(part.result))) return false;
  if (!hasProviderMetadata(part)) return true;
  const metadata = part.providerMetadata;
  if (!isObject(metadata) || Object.keys(metadata).length !== 1 || !isObject(metadata.openai)) return false;
  return Object.keys(metadata.openai).length === 1 &&
    typeof metadata.openai.itemId === "string" && metadata.openai.itemId.length > 0;
}

function protectedPath(path: string): boolean {
  const parts = path.split(/[\\/]/);
  return parts.some((part) => protectedDirectories.test(part)) || protectedNames.test(parts.at(-1) ?? "");
}

function originalText({ identity, tool }: Candidate): string | undefined {
  if (tool.id !== identity.callID || tool.name !== identity.tool || tool.executed === true) return;
  if (tool.state.status !== "completed" || tool.state.content.length !== 1) return;
  const item = tool.state.content[0];
  if (item?.type === "text") return item.text;
}

function eligibleRead(tool: Tool, sourceText: string): EligibleResult | undefined {
  if (tool.state.status !== "completed") return;
  const { path, offset } = tool.state.input;
  const truncated = tool.state.metadata?.truncated;
  if (typeof path !== "string" || protectedPath(path) || typeof truncated !== "boolean") return;
  if (path.includes("://") || /[\r\n]/.test(path)) return;

  const [header, ...entries] = sourceText.split("\n");
  const match = header?.match(readHeader);
  if (!match || match[2] !== path) return;
  const kind = match[1];
  const unit = match[3];
  if ((kind === "file" && unit !== "lines") || (kind === "directory" && unit !== "entries")) return;
  if (unit !== "lines" && unit !== "entries") return;

  const start = Number(match[4]);
  const end = Number(match[5]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) return;
  if (start !== (offset === undefined || offset === 0 ? 1 : offset)) return;
  const trailer: string[] = [];
  if (truncated) {
    const last = entries.pop();
    if (last !== `[Output truncated. Continue reading with offset: ${end + 1}]`) return;
    trailer.push(last);
  }
  if (entries.length !== end - start + 1) return;
  if (unit === "lines" && !entries.every((entry, index) => entry.startsWith(`${start + index}: `))) return;
  if (unit === "entries" && !entries.every((entry) => entry.length > 0)) return;
  return { sourceText, header, entries, trailer, firstEntry: start, unit };
}

function eligibleGlob(tool: Tool, sourceText: string): EligibleResult | undefined {
  if (tool.state.status !== "completed" || typeof tool.state.input.pattern !== "string") return;
  const count = tool.state.metadata?.count;
  const truncated = tool.state.metadata?.truncated;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1 || typeof truncated !== "boolean") return;
  const entries = sourceText.split("\n");
  const trailer = truncated ? entries.splice(-2) : [];
  if (truncated && (trailer[0] !== "" || trailer[1] !== `(Results are truncated: showing first ${count} results. Consider using a more specific path or pattern.)`)) return;
  if (entries.length !== count || !entries.every((entry) => /^(?:[/\\]|[A-Za-z]:[/\\])/.test(entry))) return;
  return { sourceText, entries, trailer, firstEntry: 1, unit: "paths" };
}

function eligibleGrep(tool: Tool, sourceText: string): EligibleResult | undefined {
  if (tool.state.status !== "completed" || typeof tool.state.input.pattern !== "string") return;
  const { matches, truncated } = tool.state.metadata ?? {};
  if (typeof matches !== "number" || !Number.isSafeInteger(matches) || matches < 1 || typeof truncated !== "boolean") return;
  const [header, ...entries] = sourceText.split("\n");
  if (header !== `Found ${matches} matches`) return;
  const trailer = truncated ? entries.splice(-2) : [];
  if (truncated && (trailer[0] !== "" ||
      trailer[1] !== `(Results are truncated: showing first ${matches} results. Consider using a more specific path or pattern.)`)) return;
  let observed = 0;
  let file = false;
  for (const entry of entries) {
    if (/^  Line \d+: /.test(entry) && file) observed++;
    else if (/^[^\s].+:$/.test(entry) && !protectedPath(entry.slice(0, -1))) file = true;
    else if (!entry && file) file = false;
    else return;
  }
  if (observed !== matches) return;
  return { sourceText, header, entries, trailer, firstEntry: 2, unit: "lines" };
}

function eligibleShell(tool: Tool, sourceText: string): EligibleResult | undefined {
  if (tool.state.status !== "completed" || typeof tool.state.input.command !== "string") return;
  const { exit, signal, timeout, status, shellID, truncated } = tool.state.metadata ?? {};
  if (exit !== 0 || signal !== undefined || timeout === true || shellID !== undefined ||
      (status !== undefined && status !== "completed") || truncated !== false) return;
  const entries = sourceText.split("\n");
  // A compound command can exit successfully after a failed subcommand.
  if (entries.some(line => /\b(?:error|failed|failure|traceback|exception|fatal|warning|warn|stderr)\b/i.test(line))) return;
  return { sourceText, entries, trailer: [], firstEntry: 1, unit: "lines", observation: "The host recorded exit code 0." };
}

function eligibleProse(sourceText: string): EligibleResult | undefined {
  const entries = sourceText.split("\n");
  if (entries.length < 3 || /\b(?:must|required|constraint|decision|decided|unresolved|blocker|failed|error)\b/i.test(sourceText)) return;
  return { sourceText, entries, trailer: [], firstEntry: 1, unit: "lines",
    observation: "These are excerpts of a previous assistant response." };
}

export function eligibleResult(candidate: Candidate): EligibleResult | undefined {
  const sourceText = originalText(candidate);
  if (!sourceText || sourceText.includes(checkpoint) || isSpanCheckpoint(sourceText)) return;
  switch (candidate.tool.name) {
    case "read": return eligibleRead(candidate.tool, sourceText);
    case "glob": return eligibleGlob(candidate.tool, sourceText);
    case "grep": return eligibleGrep(candidate.tool, sourceText);
    case "shell": return eligibleShell(candidate.tool, sourceText);
    case "assistant_text": return eligibleProse(sourceText);
  }
}
