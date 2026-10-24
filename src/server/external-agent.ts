/**
 * THE EXTERNAL AGENT SEAM — an outside agent (Claude Code, or any MCP
 * client) drives a teaching session instead of the app's own model loop.
 *
 * Why: the app's loop needs a pay-per-token provider key. An MCP client
 * that the learner already runs (on whatever plan they use) can be the
 * teacher instead: it reads the same doctrine (the composed prober /
 * teacher prompts), calls the same tools (probe, quiz, plan_init,
 * probe_done, …), and the app stays the classroom — it renders the
 * transcript, the question dock, the plan map, and keeps the graph.
 *
 * The record stays the single source of truth. Every agent action lands
 * as the SAME native messages the app's own loop would have written
 * (an AssistantMessage with text and/or one tool call, then the tool's
 * result), through the same persist seam (persistTurn: placeholder
 * filtering, id stamping, plan-block emission). The UI therefore needs no
 * external-mode rendering at all.
 *
 * LIVENESS: while the agent is "speaking", the chat holds an EXTERNAL
 * TURN — a PiTurnHandle registered in the turn registry exactly like a
 * real turn, so the existing reattach stream, busy states, and turn
 * events work unchanged. The turn starts when the learner hands the
 * agent something (an answer, a message) or when the agent speaks
 * unprompted, and settles when the agent poses a question or goes back
 * to waiting. An idle guard settles it if the agent goes silent.
 *
 * Learner input reaches the agent through the record itself: question
 * tools and wait_for_learner poll the chat file for new learner messages
 * (answers, typed messages, dismissals) — no hook in any write path is
 * needed, so every input surface (dock, composer, dismissal route) works.
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { validateToolArguments, type AssistantMessage, type ToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import type { ChatRecord } from "../core/contracts.ts";
import { titleFromPrompt } from "../core/contracts.ts";
import {
	danglingQuestionOf,
	hasProbeDone,
	newHandoffMessage,
	newMessageId,
	newUserMessage,
	type LhMessage,
} from "../core/native-messages.ts";
import { QUESTION_TOOLS } from "../core/pending.ts";
import { emit } from "../core/events.ts";
import { ChatInputError, inputAppends, type TurnInput } from "../core/input-events.ts";
import { coverageOf, messageViewLines } from "../core/coverage.ts";
import { getGraph, mergeFindings } from "../core/graph.ts";
import { settleGraphLayout } from "../core/layout-settle.ts";
import type { AuditVerdicts, SessionFindings } from "../core/contracts.ts";
import {
	askUserQuestionTool,
	probeExplainTool,
	probeQuizTool,
	teachExplainToolFor,
	teachQuizToolFor,
} from "../agent/tools.ts";
import { planTools } from "../agent/tools/plan.ts";
import { probeDoneTool } from "../agent/tools/probe.ts";
import { withArgumentHeal } from "../agent/tools/heal.ts";
import { effectivePromptSegments } from "../agent/prompt-segments.ts";
import { EXTRACTION_CORE, SESSION_MESSAGE_ID_RULE, SESSION_PREAMBLE, sourceDigest } from "../agent/subagents/extraction.ts";
import { externalSessionStore } from "../store/external-sessions.ts";
import { effectiveSettings, stores } from "./stores.ts";
import { beginTurn, endTurn, isTurnRunning } from "./turn-liveness.ts";
import { registerTurn, runningTurn, settledTurnResponse, unregisterTurn } from "./turn-runs.ts";
import { persistTurn } from "./turn-service.ts";
import type { PiTurnHandle, PiTurnSubscriber, TurnWireEvent } from "./pi/ui-stream.ts";

// ─── configuration ───────────────────────────────────────────────────────────

/** How long one blocking call (a question's answer, wait_for_learner) holds
 *  before returning a "still waiting" result. Claude Code aborts an HTTP
 *  tool call that sends nothing for 5 minutes, so this stays well under. */
export function waitWindowMs(): number {
	const s = Number(process.env.LH_MCP_WAIT_SECONDS);
	return Number.isFinite(s) && s > 0 ? Math.round(s * 1000) : 240_000;
}

/** How long an external turn may sit with no agent activity before the
 *  busy state is released (the agent crashed or was closed). */
function turnIdleMs(): number {
	const s = Number(process.env.LH_EXTERNAL_TURN_IDLE_SECONDS);
	return Number.isFinite(s) && s > 0 ? Math.round(s * 1000) : 15 * 60_000;
}

/** Poll period for the record-watching waits. The record is a small local
 *  file; this is cheap and works across Next's per-route module instances. */
const POLL_MS = Number(process.env.LH_MCP_POLL_MS) > 0 ? Number(process.env.LH_MCP_POLL_MS) : 300;

/** Is every new teach session externally driven (no per-chat marking
 *  needed)? Set LH_EXTERNAL_AGENT=1 to start sessions from the app's own
 *  home screen and have the connected agent pick them up. */
export function externalModeDefault(): boolean {
	return process.env.LH_EXTERNAL_AGENT === "1" || process.env.LH_EXTERNAL_AGENT === "true";
}

// ─── process-wide state (globalThis: Next compiles routes as separate
//     module instances; the MCP route and the chat route must share it) ──────

interface ExternalState {
	turns: Map<string, ExternalTurn>;
	/** Learner message ids already handed to the agent, per chat. */
	delivered: Map<string, Set<string>>;
	/** The phase whose instructions the agent last received, per chat. */
	instructed: Map<string, Phase>;
	/** Chats whose busy state the learner stopped — a bare "continue"
	 *  must not re-arm it until something new happens. */
	stopped: Set<string>;
	/** Last time any MCP request arrived (the connection indicator). */
	lastSeen: number;
}

interface ExternalGlobal {
	__lhExternalAgent?: ExternalState;
}

function state(): ExternalState {
	const g = globalThis as typeof globalThis & ExternalGlobal;
	return (g.__lhExternalAgent ??= {
		turns: new Map(),
		delivered: new Map(),
		instructed: new Map(),
		stopped: new Set(),
		lastSeen: 0,
	});
}

/** Record that an agent is connected (every MCP request calls this). */
export function noteAgentSeen(): void {
	state().lastSeen = Date.now();
}

/** The connection indicator for the UI: seen within the last wait window
 *  plus a margin (a waiting agent re-calls at least that often). */
export function externalAgentStatus(): { enabled: boolean; connected: boolean; lastSeen: string | null } {
	const seen = state().lastSeen;
	return {
		enabled: externalModeDefault(),
		connected: seen > 0 && Date.now() - seen < waitWindowMs() + 60_000,
		lastSeen: seen > 0 ? new Date(seen).toISOString() : null,
	};
}

// ─── which chats are external ────────────────────────────────────────────────

export function isExternalChat(record: Pick<ChatRecord, "id" | "kind">): boolean {
	if (record.kind === "practice") return false; // practice stays on the app's own loop (v1)
	return externalModeDefault() || externalSessionStore.has(record.id);
}

export function markExternal(chatId: string): void {
	externalSessionStore.add(chatId);
}

export function releaseExternal(chatId: string): void {
	externalSessionStore.remove(chatId);
	settleExternalTurn(chatId);
}

// ─── the external turn (a PiTurnHandle the existing wire understands) ────────

class ExternalTurn implements PiTurnHandle {
	private log: TurnWireEvent[] = [];
	private subscribers = new Set<PiTurnSubscriber>();
	private settled = false;
	private idleTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		readonly chatId: string,
		private readonly onSettle: () => void,
	) {
		this.push({ type: "agent_start" } as TurnWireEvent);
		this.touch();
	}

	/** Any agent activity re-arms the idle guard. */
	touch(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => this.settle(), turnIdleMs());
		// Never keep a process alive just for this guard.
		(this.idleTimer as { unref?: () => void }).unref?.();
	}

	push(event: TurnWireEvent): void {
		if (this.settled) return;
		this.log.push(event);
		for (const sub of this.subscribers) sub.push(event);
	}

	/** Stream one persisted message to every open view. */
	pushMessage(message: LhMessage): void {
		this.push({ type: "message_start", message } as unknown as TurnWireEvent);
		this.push({ type: "message_end", message } as unknown as TurnWireEvent);
	}

	settle(): void {
		if (this.settled) return;
		this.push({ type: "agent_end", messages: [] } as unknown as TurnWireEvent);
		this.settled = true;
		if (this.idleTimer) clearTimeout(this.idleTimer);
		for (const sub of this.subscribers) sub.done();
		this.subscribers.clear();
		this.onSettle();
	}

	get isSettled(): boolean {
		return this.settled;
	}

	subscribe(): ReadableStream<Uint8Array> {
		let sub: PiTurnSubscriber | undefined;
		return new ReadableStream<Uint8Array>({
			start: (controller) => {
				const encoder = new TextEncoder();
				let closed = false;
				sub = {
					push(event) {
						if (closed) return;
						try {
							controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
						} catch {
							closed = true;
						}
					},
					done() {
						if (closed) return;
						closed = true;
						try {
							controller.enqueue(encoder.encode("data: [DONE]\n\n"));
							controller.close();
						} catch {
							/* already cancelled */
						}
					},
				};
				this.subscribers.add(sub);
				for (const event of this.log) sub.push(event);
				if (this.settled) sub.done();
			},
			cancel: () => {
				if (sub) this.subscribers.delete(sub);
			},
		});
	}

	/** The stop button: the learner interrupts — release the busy state.
	 *  The agent finds out on its next call (nothing is lost: the record
	 *  holds everything it already wrote). */
	abort(): void {
		state().stopped.add(this.chatId);
		this.settle();
	}
}

/** The chat's live external turn, starting one if none runs. Returns null
 *  only when a NON-external turn owns the chat (cannot happen for chats
 *  routed here, but never clobber a real turn). */
function ensureExternalTurn(chatId: string): ExternalTurn | null {
	state().stopped.delete(chatId);
	const existing = state().turns.get(chatId);
	if (existing && !existing.isSettled) {
		existing.touch();
		return existing;
	}
	if (isTurnRunning(chatId) || runningTurn(chatId)) return null;
	if (!beginTurn(chatId)) return null;
	const turn = new ExternalTurn(chatId, () => {
		// The same settle order as the app's own turns: the record is
		// already durable; liveness ends, then the handle unregisters.
		endTurn(chatId);
		unregisterTurn(chatId);
		if (state().turns.get(chatId) === turn) state().turns.delete(chatId);
	});
	state().turns.set(chatId, turn);
	registerTurn(chatId, turn);
	return turn;
}

/** Release the chat's busy state (the agent is now waiting on the learner). */
export function settleExternalTurn(chatId: string): void {
	state().turns.get(chatId)?.settle();
}

// ─── learner input → the record (the /api/chat bypass) ───────────────────────

/**
 * The chat route's branch for externally driven chats: the learner's
 * input is appended exactly as the app's own turn would append it, and
 * instead of running a model, the chat enters an external turn — busy
 * until the connected agent answers. No model gate, no key gate.
 */
export function handleExternalInput(record: ChatRecord, input: TurnInput): Response {
	const chatId = record.id;
	if (input.type === "steers") {
		// Wake-pipeline deliveries have no model to wake here; keep them in
		// the record so the agent sees them on its next read.
		const merged = [...record.messages, ...input.steers];
		stores.chatStore.saveMessages(chatId, merged);
		emit("record-changed", { chatId });
		return settledTurnResponse();
	}
	// A bare continuation (the client's "the agent owes a reply" nudge)
	// only marks the chat busy when an agent is actually listening and the
	// learner hasn't just pressed stop — otherwise it would re-arm forever.
	if (input.type === "continue" && (state().stopped.has(chatId) || !externalAgentStatus().connected)) {
		return settledTurnResponse();
	}
	let appends: LhMessage[];
	try {
		appends = inputAppends(record, input);
	} catch (err) {
		if (err instanceof ChatInputError) return Response.json({ error: err.message }, { status: 400 });
		throw err;
	}
	const merged = [...record.messages, ...appends];
	if (appends.length > 0) {
		stores.chatStore.saveMessages(chatId, merged);
		emit("record-changed", { chatId });
	}
	// An answer that leaves a sibling question open: nothing is owed yet.
	if (input.type === "answer" && danglingQuestionOf(merged) !== null) return settledTurnResponse();
	// Something is now owed by the agent: the chat is busy until it replies.
	ensureExternalTurn(chatId);
	return Response.json({ ok: true });
}

// ─── reading the learner's side of the record ────────────────────────────────

type Phase = "probe" | "teach";

function phaseOf(record: ChatRecord): Phase {
	return hasProbeDone(record.messages) ? "teach" : "probe";
}

/** One learner-originated event, shaped for the agent. */
export type LearnerEvent =
	| { type: "message"; id: string; text: string }
	| { type: "answer"; id: string; toolCallId: string; tool: string; answer: unknown }
	| { type: "context"; id: string; text: string };

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c): c is { type: "text"; text: string } => (c as { type?: string }).type === "text")
			.map((c) => c.text)
			.join("\n");
	}
	return "";
}

function asLearnerEvent(m: LhMessage): LearnerEvent | null {
	const role = (m as { role?: string }).role;
	if (role === "user") return { type: "message", id: m.id, text: textOf((m as { content: unknown }).content) };
	if (role === "toolResult") {
		const r = m as ToolResultMessage & { id: string };
		if (!(QUESTION_TOOLS as readonly string[]).includes(r.toolName)) return null;
		let answer: unknown = textOf(r.content);
		try {
			answer = JSON.parse(answer as string);
		} catch {
			/* keep the text */
		}
		return { type: "answer", id: m.id, toolCallId: r.toolCallId, tool: r.toolName, answer };
	}
	if (role === "custom") {
		const c = m as { customType?: string; content?: string };
		// The learner's map picks / injected context are model-facing text.
		if (c.customType === "graph-context" && c.content) return { type: "context", id: m.id, text: c.content };
	}
	return null;
}

/** Learner events not yet handed to the agent (record order). */
function undelivered(record: ChatRecord): LearnerEvent[] {
	const seen = state().delivered.get(record.id) ?? new Set<string>();
	// Only input AFTER the agent's last message is ever owed — older input
	// was answered (this also keeps a restarted server from re-delivering
	// the whole history).
	let start = 0;
	for (let i = record.messages.length - 1; i >= 0; i--) {
		if ((record.messages[i] as { role?: string }).role === "assistant") {
			start = i + 1;
			break;
		}
	}
	const out: LearnerEvent[] = [];
	for (const m of record.messages.slice(start)) {
		if (seen.has(m.id)) continue;
		const ev = asLearnerEvent(m);
		if (ev) out.push(ev);
	}
	return out;
}

function markDelivered(chatId: string, events: LearnerEvent[]): void {
	if (events.length === 0) return;
	const s = state();
	const set = s.delivered.get(chatId) ?? new Set<string>();
	for (const e of events) set.add(e.id);
	s.delivered.set(chatId, set);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ─── the doctrine the agent teaches by ───────────────────────────────────────

/** Prompt fragments that describe app-only machinery the external agent
 *  does not have (background job dispatch, interactive demos). */
const EXCLUDED_SEGMENTS = new Set(["teacher/40-jobs.md", "teacher/50-demos.md"]);

const ADAPTER_PREAMBLE = `# You are driving a LearnHarness session over MCP

LearnHarness is the learner's classroom app. You are its teacher. The learner reads ONLY what you send through the LearnHarness tools — your normal replies in your own interface are invisible to them. So:

- Teaching prose goes through \`say\` (Markdown, LaTeX with $…$ / $$…$$, code fences). One \`say\` per reply is typical; it renders as one teacher message.
- Questions go through the question tools (\`probe\`/\`recall\` while probing; \`quiz\`/\`explain\` while teaching; \`ask_user_question\` in both). Each one BLOCKS until the learner answers and returns the answer — that IS the end of your turn and the start of your next one. Use the optional \`lead\` field for the short lead-in text that should appear right above the question.
- \`probe_done\` concludes probing (the learner assessment is its input); \`plan_init\` writes the plan map. Same semantics as in the doctrine below.
- When you finish a reply WITHOUT a question, call \`wait_for_learner\` with the chatId: it releases the app's busy state and blocks until the learner writes. Never just stop.
- If a call returns \`status: "waiting"\`, the learner has not answered yet — call \`wait_for_learner\` again with the same chatId. Keep the session alive until the learner clearly ends it.
- Every LearnHarness tool takes \`chatId\`. Tool names below map 1:1 to these MCP tools.

Differences from the in-app agent the doctrine was written for:
- There is no \`research\`, \`pdf\`, \`demo\`, or \`visual\` dispatch tool. When the doctrine calls for verification, use your own web search (if you have one) and cite sources in \`say\`. For learner files and PDFs, use your own file tools (read/glob/grep) — the doctrine's \`read\`/\`ls\`/\`find\`/\`grep\` map to those.
- Turn mechanics ("end your turn") mean: pose the question (it blocks) or call \`wait_for_learner\`.
- Knowledge-graph extraction is yours too: at natural breakpoints (end of a session, or when the learner asks), call \`extraction_source\` and then \`graph_submit\`.`;

export function instructionsFor(phase: Phase): string {
	const kind = phase === "probe" ? "prober" : "teacher";
	const switches = effectiveSettings().agent.prompts ?? {};
	const doctrine = effectivePromptSegments(kind, switches)
		.filter((s) => !EXCLUDED_SEGMENTS.has(s.path))
		.map((s) => (s.enabled ? s.overrideText! : s.sourceText).trim())
		.filter(Boolean)
		.join("\n\n---\n\n");
	return `${ADAPTER_PREAMBLE}\n\n# Phase: ${phase === "probe" ? "PROBING (find the learner's edge, then probe_done)" : "TEACHING (plan_init, then teach by the plan)"}\n\n${doctrine}`;
}

/** Instructions are attached the first time the agent touches a chat in a
 *  phase; later results stay small. get_instructions re-fetches any time. */
function instructionsIfNew(record: ChatRecord): string | undefined {
	const phase = phaseOf(record);
	if (state().instructed.get(record.id) === phase) return undefined;
	state().instructed.set(record.id, phase);
	return instructionsFor(phase);
}

// ─── the agent's actions → native record messages ────────────────────────────

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** The stamp on every externally authored assistant message. */
export const EXTERNAL_PROVIDER = "external";
function agentModelName(): string {
	return process.env.LH_EXTERNAL_AGENT_NAME || "claude-code";
}

function assistantMessage(content: AssistantMessage["content"]): LhMessage & AssistantMessage {
	const hasCall = content.some((c) => c.type === "toolCall");
	return {
		id: newMessageId(),
		role: "assistant",
		content,
		api: "external",
		provider: EXTERNAL_PROVIDER,
		model: agentModelName(),
		usage: ZERO_USAGE,
		stopReason: hasCall ? "toolUse" : "stop",
		timestamp: Date.now(),
	};
}

function newToolCallId(): string {
	return `toolu_lh${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

/** Append messages through the canonical persist seam and stream every
 *  resulting record message (plan blocks included) to open views. */
function appendAndStream(chatId: string, messages: LhMessage[]): LhMessage[] {
	const before = stores.chatStore.getChat(chatId);
	if (!before) throw new ExternalAgentError(`Unknown chat: ${chatId}`);
	persistTurn(stores.chatStore, chatId, before.messages.length, [...before.messages, ...messages] as never, false);
	const after = stores.chatStore.getChat(chatId);
	const added = after ? after.messages.slice(before.messages.length) : [];
	const turn = ensureExternalTurn(chatId);
	for (const m of added) turn?.pushMessage(m);
	emit("record-changed", { chatId });
	return added;
}

export class ExternalAgentError extends Error {}

function requireChat(chatId: unknown): ChatRecord {
	if (typeof chatId !== "string" || chatId.length === 0) throw new ExternalAgentError("chatId is required");
	const record = stores.chatStore.getChat(chatId);
	if (!record) throw new ExternalAgentError(`Unknown chat: ${chatId}`);
	if (record.kind === "practice") {
		throw new ExternalAgentError("Practice sessions are not supported over MCP yet — use a teach session.");
	}
	// Touching a chat over MCP adopts it as externally driven.
	if (!isExternalChat(record)) markExternal(record.id);
	return record;
}

/** The phase-correct tool registry for one chat (mirrors the app's
 *  prober/teacher registries, minus job dispatch and file tools — the
 *  external agent brings its own). */
function toolsFor(chatId: string, phase: Phase): Record<string, AgentTool<any>> {
	const ctx = { chatId, chatStore: stores.chatStore };
	const tools: Record<string, AgentTool<any>> =
		phase === "probe"
			? {
					probe: probeQuizTool,
					recall: probeExplainTool,
					ask_user_question: askUserQuestionTool,
					...probeDoneTool({ ...ctx, deliver: () => {} }),
				}
			: {
					quiz: teachQuizToolFor(ctx),
					explain: teachExplainToolFor(ctx),
					ask_user_question: askUserQuestionTool,
					...planTools(ctx),
				};
	return Object.fromEntries(Object.entries(tools).map(([k, t]) => [k, withArgumentHeal(t)]));
}

/** Which phase a tool belongs to (for honest wrong-phase errors). */
const PHASE_OF_TOOL: Record<string, Phase | "both"> = {
	probe: "probe",
	recall: "probe",
	probe_done: "probe",
	quiz: "teach",
	explain: "teach",
	plan_init: "teach",
	ask_user_question: "both",
};

function resultText(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

function failed(result: AgentToolResult<unknown>): boolean {
	if ((result as { isError?: boolean }).isError) return true;
	const d = result.details as { ok?: unknown } | null | undefined;
	return typeof d === "object" && d !== null && d.ok === false;
}

/** Everything a tool call hands back to the agent. */
export interface ActionResult {
	chatId: string;
	phase: Phase;
	status?: "answered" | "waiting" | "ok" | "interrupted";
	result?: unknown;
	learnerInput?: LearnerEvent[];
	instructions?: string;
	note?: string;
}

/**
 * Run one of the app's own tools on behalf of the external agent: the
 * exact validation the in-app loop applies (prepareArguments → schema →
 * the tool's own refinements), then the native record appends. Invalid
 * calls are NOT persisted — the agent gets the problem list and retries.
 */
async function runAppTool(
	record: ChatRecord,
	name: string,
	rawArgs: Record<string, unknown>,
	lead: string | undefined,
): Promise<{ toolCallId: string; result: AgentToolResult<unknown> }> {
	const phase = phaseOf(record);
	const owner = PHASE_OF_TOOL[name];
	if (owner && owner !== "both" && owner !== phase) {
		throw new ExternalAgentError(
			owner === "probe"
				? `${name} belongs to the probing phase, which has concluded. Use quiz/explain/ask_user_question now.`
				: `${name} belongs to the teaching phase. Finish probing with probe_done first (use probe/recall/ask_user_question until then).`,
		);
	}
	const tool = toolsFor(record.id, phase)[name];
	if (!tool) throw new ExternalAgentError(`Unknown tool: ${name}`);
	if ((QUESTION_TOOLS as readonly string[]).includes(name) && danglingQuestionOf(record.messages)) {
		throw new ExternalAgentError(
			"A question is already waiting for the learner's answer. Call wait_for_learner to receive it first.",
		);
	}
	const prepared = tool.prepareArguments ? tool.prepareArguments(rawArgs) : rawArgs;
	const toolCall: ToolCall = { type: "toolCall", id: newToolCallId(), name, arguments: prepared as ToolCall["arguments"] };
	let validated: unknown;
	try {
		validated = validateToolArguments(tool as never, toolCall);
	} catch (err) {
		throw new ExternalAgentError((err as Error).message);
	}
	const result = (await tool.execute(toolCall.id, validated as never, undefined)) as AgentToolResult<unknown>;
	if (failed(result)) throw new ExternalAgentError(resultText(result) || `${name} failed`);

	const content: AssistantMessage["content"] = [];
	if (lead && lead.trim()) content.push({ type: "text", text: lead });
	content.push({ ...toolCall, arguments: validated as ToolCall["arguments"] });
	const messages: LhMessage[] = [assistantMessage(content)];
	// Question placeholders are filtered by persistTurn; server tools keep
	// their real result (plan_init's tree, probe_done's ack).
	messages.push({
		id: newMessageId(),
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: name,
		content: result.content as ToolResultMessage["content"],
		details: (result.details ?? null) as ToolResultMessage["details"],
		isError: false,
		timestamp: Date.now(),
	} as LhMessage);
	if (name === "probe_done") messages.push(newHandoffMessage(record.id) as LhMessage);
	appendAndStream(record.id, messages);
	return { toolCallId: toolCall.id, result };
}

/** Block until the chat has undelivered learner input (or the window ends). */
async function awaitLearner(chatId: string, until: number, predicate?: (ev: LearnerEvent[]) => boolean): Promise<{
	record: ChatRecord;
	events: LearnerEvent[];
	interrupted: boolean;
}> {
	for (;;) {
		noteAgentSeen();
		const record = stores.chatStore.getChat(chatId);
		if (!record) throw new ExternalAgentError(`The chat was deleted: ${chatId}`);
		const events = undelivered(record);
		if (events.length > 0 && (!predicate || predicate(events))) {
			markDelivered(chatId, events);
			return { record, events, interrupted: false };
		}
		if (Date.now() >= until) return { record, events: [], interrupted: false };
		await sleep(POLL_MS);
	}
}

// ─── the public actions (the MCP tools call exactly these) ──────────────────

export async function startSession(topic: string, origin?: string): Promise<ActionResult & { url?: string; title: string }> {
	const text = topic.trim();
	if (!text) throw new ExternalAgentError("topic is required — what the learner wants to understand");
	const chat = stores.chatStore.createChat(titleFromPrompt(text));
	markExternal(chat.id);
	const first = newUserMessage(text);
	stores.chatStore.saveMessages(chat.id, [first]);
	markDelivered(chat.id, [{ type: "message", id: first.id, text }]);
	ensureExternalTurn(chat.id); // the agent speaks first: busy until its first question
	const record = stores.chatStore.getChat(chat.id)!;
	return {
		chatId: chat.id,
		title: chat.title,
		phase: "probe",
		url: origin ? `${origin}/chat/${chat.id}` : undefined,
		learnerInput: [{ type: "message", id: first.id, text }],
		instructions: instructionsIfNew(record),
		note: "Session created and open in LearnHarness. Begin probing now: say a short greeting if you like, then pose your first probe question.",
	};
}

export async function say(chatId: string, text: string): Promise<ActionResult> {
	const record = requireChat(chatId);
	if (!text || !text.trim()) throw new ExternalAgentError("text is required");
	// Learner input that arrived while the agent was working rides along —
	// the agent must never talk past a message it hasn't seen.
	const pending = undelivered(record);
	markDelivered(chatId, pending);
	appendAndStream(chatId, [assistantMessage([{ type: "text", text }])]);
	return {
		chatId,
		phase: phaseOf(record),
		status: "ok",
		...(pending.length > 0 ? { learnerInput: pending } : {}),
		instructions: instructionsIfNew(record),
	};
}

/** Pose a question tool and wait (one window) for its answer. */
export async function askQuestion(
	chatId: string,
	tool: string,
	args: Record<string, unknown>,
	lead?: string,
): Promise<ActionResult & { toolCallId: string }> {
	const record = requireChat(chatId);
	const earlier = undelivered(record);
	const { toolCallId } = await runAppTool(record, tool, args, lead);
	// The question is on screen: release the busy state so the dock opens.
	settleExternalTurn(chatId);
	const answered = await awaitLearner(chatId, Date.now() + waitWindowMs(), (events) =>
		events.some((e) => e.type === "answer" && e.toolCallId === toolCallId),
	);
	if (earlier.length > 0) markDelivered(chatId, earlier);
	const answer = answered.events.find((e) => e.type === "answer" && e.toolCallId === toolCallId);
	// The answer itself rides in `result`; learnerInput carries anything else.
	const events = [...earlier, ...answered.events.filter((e) => e !== answer)];
	return {
		chatId,
		toolCallId,
		phase: phaseOf(answered.record),
		status: answer ? "answered" : "waiting",
		...(answer ? { result: (answer as { answer: unknown }).answer } : {}),
		...(events.length > 0 ? { learnerInput: events } : {}),
		...(answer
			? {}
			: { note: "No answer yet. Call wait_for_learner with this chatId to keep waiting — the question stays open." }),
	};
}

/** Run a server-side app tool (plan_init, probe_done) — no waiting. */
export async function runServerTool(chatId: string, tool: "plan_init" | "probe_done", args: Record<string, unknown>): Promise<ActionResult> {
	const record = requireChat(chatId);
	const pending = undelivered(record);
	markDelivered(chatId, pending);
	const { result } = await runAppTool(record, tool, args, undefined);
	const after = stores.chatStore.getChat(chatId)!;
	return {
		chatId,
		phase: phaseOf(after),
		status: "ok",
		result: resultText(result),
		...(pending.length > 0 ? { learnerInput: pending } : {}),
		// probe_done flips the phase: the teaching doctrine rides along.
		instructions: instructionsIfNew(after),
		...(tool === "probe_done"
			? { note: "Probing concluded. You are now the TEACHER: say a closing line if you haven't, then call plan_init with the plan map." }
			: {}),
	};
}

/**
 * Wait for the learner. With a chatId: release that chat's busy state and
 * block until the learner writes (or answers an open question). Without
 * one: wait for ANY externally driven chat that has input for the agent —
 * a session started from the app's home screen arrives this way.
 */
export async function waitForLearner(chatId?: string): Promise<ActionResult | { status: "idle"; note: string }> {
	const until = Date.now() + waitWindowMs();
	if (chatId) {
		requireChat(chatId);
		settleExternalTurn(chatId);
		const { record, events } = await awaitLearner(chatId, until);
		if (events.length === 0) {
			const open = danglingQuestionOf(record.messages);
			return {
				chatId,
				phase: phaseOf(record),
				status: "waiting",
				note: open
					? "The learner is still on the open question. Call wait_for_learner again."
					: "The learner hasn't written yet. Call wait_for_learner again.",
			};
		}
		// The agent now owes a reply: busy until it speaks or asks.
		ensureExternalTurn(chatId);
		return {
			chatId,
			phase: phaseOf(record),
			status: "answered",
			learnerInput: events,
			instructions: instructionsIfNew(record),
		};
	}
	// No chat given: the agent isn't speaking anywhere — release every
	// external turn that has nothing owed, then watch all external chats.
	for (const [id, turn] of state().turns) {
		const rec = stores.chatStore.getChat(id);
		if (!rec || undelivered(rec).length === 0) turn.settle();
	}
	for (;;) {
		noteAgentSeen();
		for (const summary of stores.chatStore.listChats()) {
			const record = stores.chatStore.getChat(summary.id);
			if (!record || !isExternalChat(record)) continue;
			const events = undelivered(record);
			if (events.length === 0) continue;
			markDelivered(record.id, events);
			ensureExternalTurn(record.id);
			return {
				chatId: record.id,
				phase: phaseOf(record),
				status: "answered",
				learnerInput: events,
				instructions: instructionsIfNew(record),
				note: `Session "${record.title}".`,
			};
		}
		if (Date.now() >= until) {
			return { status: "idle", note: "No learner activity yet. Call wait_for_learner again to keep listening." };
		}
		await sleep(POLL_MS);
	}
}

// ─── reading sessions ────────────────────────────────────────────────────────

export function listExternalSessions(): Array<{ chatId: string; title: string; phase: Phase; external: boolean; updatedAt: string; waitingOn: "agent" | "learner" | "none" }> {
	return stores.chatStore
		.listChats()
		.filter((c) => c.kind !== "practice")
		.map((c) => {
			const record = stores.chatStore.getChat(c.id);
			const external = record ? isExternalChat(record) : false;
			const owed = record ? undelivered(record).length > 0 || state().turns.has(c.id) : false;
			const open = record ? danglingQuestionOf(record.messages) !== null : false;
			return {
				chatId: c.id,
				title: c.title,
				phase: record ? phaseOf(record) : ("probe" as Phase),
				external,
				updatedAt: c.updatedAt,
				waitingOn: owed ? ("agent" as const) : open ? ("learner" as const) : ("none" as const),
			};
		});
}

/** A compact, model-readable transcript (for resuming a session). */
export function readSession(chatId: string, limit = 60): ActionResult & { title: string; plan?: unknown; transcript: string } {
	const record = requireChat(chatId);
	const lines: string[] = [];
	for (const m of record.messages.slice(-limit)) {
		const role = (m as { role?: string }).role;
		if (role === "user") lines.push(`LEARNER: ${textOf((m as { content: unknown }).content)}`);
		else if (role === "assistant") {
			for (const block of (m as AssistantMessage).content) {
				if (block.type === "text" && block.text.trim()) lines.push(`TEACHER: ${block.text}`);
				if (block.type === "toolCall") lines.push(`TEACHER called ${block.name} [${block.id}]: ${JSON.stringify(block.arguments)}`);
			}
		} else if (role === "toolResult") {
			const r = m as ToolResultMessage;
			lines.push(`${(QUESTION_TOOLS as readonly string[]).includes(r.toolName) ? "ANSWER" : "RESULT"} [${r.toolCallId}]: ${textOf(r.content)}`);
		} else if (role === "custom") {
			const c = m as { customType?: string; content?: string };
			if (c.content) lines.push(`[${c.customType}] ${c.content}`);
		}
	}
	const open = danglingQuestionOf(record.messages);
	return {
		chatId,
		title: record.title,
		phase: phaseOf(record),
		plan: record.tree ? { nodes: record.tree.nodes.map((n) => ({ id: n.id, title: n.title })), edges: record.tree.edges } : undefined,
		transcript: lines.join("\n\n"),
		...(open ? { note: `A question is open (${open.tool} [${open.toolCallId}]) — call wait_for_learner to receive its answer.` } : {}),
	};
}

// ─── the knowledge graph (the agent is extractor + auditor) ──────────────────

const AUDIT_GUIDANCE = `IDENTITY (you are also the auditor): before submitting, search the existing graph (graph_search) for each idea. When one of your propositions IS an existing node — paraphrases, rewordings and compressions of the same claim count as the same — set its linkTo to that node's id ("n_…") instead of creating a duplicate. Only genuinely distinct propositions stay new.`;

export function extractionSource(chatId: string): {
	chatId: string;
	messageIds: string[];
	source: string;
	graphSoFar: string;
	instructions: string;
	note?: string;
} {
	const record = requireChat(chatId);
	const covered = coverageOf(record.messages, stores.graphStore.readCoverage(), chatId);
	const slots = covered.uncovered.map((i) => covered.slots[i]!);
	const lines = slots.flatMap((s) => messageViewLines(s.message, s.message.id));
	const graph = getGraph(stores.graphStore);
	return {
		chatId,
		messageIds: slots.map((s) => s.message.id),
		source: lines.length > 0 ? `# ${record.title}\n\n${lines.join("\n\n")}` : "",
		graphSoFar: sourceDigest(graph, chatId),
		instructions: `${SESSION_PREAMBLE}\n\n${EXTRACTION_CORE.replace("SUBMIT with one submit_findings call", "SUBMIT with one graph_submit call")}\n\n${SESSION_MESSAGE_ID_RULE}\n\n${AUDIT_GUIDANCE}\n\nPass the messageIds you were given back to graph_submit — they mark exactly this stretch as extracted.`,
		...(lines.length === 0 ? { note: "Nothing new to extract — every teacher passage of this session is already in the graph." } : {}),
	};
}

export function graphSearch(query?: string, limit = 40): { total: number; nodes: Array<{ id: string; name: string; statement: string }> } {
	const graph = getGraph(stores.graphStore);
	const q = (query ?? "").trim().toLowerCase();
	const words = q.split(/\s+/).filter(Boolean);
	const scored = graph.nodes
		.map((n) => {
			if (words.length === 0) return { n, score: 1 };
			const hay = [n.name, n.statement, ...n.aliases].join(" ").toLowerCase();
			const score = words.reduce((acc, w) => acc + (hay.includes(w) ? 1 : 0), 0);
			return { n, score };
		})
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score || b.n.createdAt.localeCompare(a.n.createdAt));
	return {
		total: graph.nodes.length,
		nodes: scored.slice(0, Math.max(1, Math.min(limit, 200))).map(({ n }) => ({ id: n.id, name: n.name, statement: n.statement })),
	};
}

export interface GraphSubmitInput {
	chatId: string;
	messageIds: string[];
	propositions: Array<{ id: string; name: string; statement: string; aliases?: string[]; messageId?: string; linkTo?: string }>;
	chains: Array<{ premises: string[]; conclusion: string }>;
}

export function graphSubmit(input: GraphSubmitInput): { ok: true; nodes: number; chains: number; linked: number; droppedChains?: number } {
	const record = requireChat(input.chatId);
	const existing = new Set(getGraph(stores.graphStore).nodes.map((n) => n.id));
	const problems: string[] = [];
	const localIds = new Set<string>();
	for (const p of input.propositions ?? []) {
		if (!p.id || !p.name || !p.statement) problems.push(`proposition ${JSON.stringify(p.id)} needs id, name and statement`);
		if (localIds.has(p.id)) problems.push(`duplicate proposition id "${p.id}"`);
		localIds.add(p.id);
		if (p.linkTo !== undefined && !existing.has(p.linkTo)) problems.push(`linkTo "${p.linkTo}" is not an existing node id`);
	}
	for (const [i, c] of (input.chains ?? []).entries()) {
		if (!Array.isArray(c.premises) || c.premises.length === 0) problems.push(`chain ${i + 1} has no premises`);
		for (const end of [...(c.premises ?? []), c.conclusion]) {
			if (!localIds.has(end) && !existing.has(end)) problems.push(`chain ${i + 1}: "${end}" is neither a proposition id in this submission nor an existing node id`);
		}
		if ((c.premises ?? []).includes(c.conclusion)) problems.push(`chain ${i + 1}: the conclusion cannot be its own premise`);
	}
	const covered = coverageOf(record.messages, stores.graphStore.readCoverage(), input.chatId);
	const requested = new Set(input.messageIds ?? []);
	const batch = covered.uncovered.map((i) => covered.slots[i]!).filter((s) => requested.has(s.message.id));
	const batchIds = new Set(batch.map((s) => s.message.id));
	for (const p of input.propositions ?? []) {
		if (p.messageId && !batchIds.has(p.messageId)) problems.push(`proposition "${p.id}": messageId "${p.messageId}" is not one of the messageIds being extracted`);
	}
	if (problems.length > 0) throw new ExternalAgentError(`graph_submit refused:\n${problems.map((p) => `- ${p}`).join("\n")}`);

	const findings: SessionFindings = {
		propositions: (input.propositions ?? []).map((p) => ({
			id: p.id,
			name: p.name,
			statement: p.statement,
			aliases: p.aliases ?? [],
			...(p.messageId ? { messageId: p.messageId } : {}),
		})),
		chains: (input.chains ?? []).map((c) => ({ premises: c.premises, conclusion: c.conclusion })),
	};
	const verdicts: AuditVerdicts = {
		links: (input.propositions ?? []).filter((p) => p.linkTo).map((p) => ({ id: p.id, linkTo: p.linkTo! })),
	};
	const foldedAt = new Date().toISOString();
	const stats = mergeFindings(input.chatId, findings, verdicts, { chatStore: stores.chatStore, graphStore: stores.graphStore }, {
		foldedAt,
		coverage: batch
			.filter((s) => messageViewLines(s.message, s.message.id).length > 0)
			.map((s) => ({ chatId: input.chatId, fp: s.fp, tokens: s.tokens, foldedAt })),
	});
	settleGraphLayout(stores.graphStore);
	emit("activity-changed", {});
	return {
		ok: true,
		nodes: stats.nodes,
		chains: stats.chains ?? 0,
		linked: verdicts.links.length,
		...(stats.droppedChains ? { droppedChains: stats.droppedChains } : {}),
	};
}
