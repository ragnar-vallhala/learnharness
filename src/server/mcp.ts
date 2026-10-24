/**
 * THE MCP ENDPOINT — LearnHarness as a Model Context Protocol server, so an
 * external agent (Claude Code, or any MCP client) can be the teacher.
 *
 * Transport: Streamable HTTP, stateless, JSON responses (a single POST per
 * JSON-RPC message or batch; no server-initiated stream). Framework-free
 * (Request → Response) so tests drive it directly; app/api/mcp is a thin
 * wrapper. The tools are thin: every action is implemented once, in
 * external-agent.ts, against the same record and tool code the app's own
 * agent uses.
 *
 * Tool schemas are the app's OWN TypeBox schemas (they are JSON Schema),
 * extended with `chatId` (and `lead` for questions) — the external agent
 * fills exactly the fields the in-app agent fills, validated by the same
 * code.
 */

import type { TSchema } from "typebox";
import {
	askUserQuestionTool,
	probeExplainTool,
	probeQuizTool,
	teachExplainToolFor,
	teachQuizToolFor,
} from "../agent/tools.ts";
import { planTools } from "../agent/tools/plan.ts";
import { probeDoneTool } from "../agent/tools/probe.ts";
import { stores } from "./stores.ts";
import {
	askQuestion,
	ExternalAgentError,
	extractionSource,
	graphSearch,
	graphSubmit,
	instructionsFor,
	listExternalSessions,
	noteAgentSeen,
	readSession,
	releaseExternal,
	runServerTool,
	say,
	startSession,
	waitForLearner,
	type GraphSubmitInput,
} from "./external-agent.ts";
import { hasProbeDone } from "../core/native-messages.ts";

const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_VERSION = "0.1.0";

const SERVER_INSTRUCTIONS = `LearnHarness is the learner's classroom app; you are its teacher. The learner only sees what you send through these tools.

Start: call start_session with what the learner wants to understand (or wait_for_learner with no chatId to pick up a session the learner started in the app). Results carry the teaching doctrine in "instructions" the first time you enter each phase — follow it closely.

Loop: say (teaching prose) and question tools (they block until answered) → when you end a reply without a question, call wait_for_learner with the chatId. A "waiting" status means: call wait_for_learner again. Never stop serving an open session on your own.

Phases: probing (probe / recall / ask_user_question, then probe_done) → teaching (plan_init, then quiz / explain / ask_user_question / say). At a natural end, extract the session into the knowledge graph: extraction_source → graph_search → graph_submit.`;

// ─── tool catalog ────────────────────────────────────────────────────────────

interface McpTool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

const chatIdProp = { type: "string", description: "The LearnHarness session id (from start_session, wait_for_learner, or list_sessions)." };
const leadProp = {
	type: "string",
	description: "Optional short lead-in text (Markdown) shown right above the question, in the same teacher message.",
};

/** A TypeBox schema as plain JSON Schema (symbol keys dropped). */
function plain(schema: TSchema): Record<string, unknown> {
	return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
}

/** The app tool's own schema + chatId (+ lead). */
function withChat(schema: TSchema, extra: Record<string, unknown> = {}): Record<string, unknown> {
	const s = plain(schema);
	if (s.type === "object") {
		return {
			...s,
			properties: { chatId: chatIdProp, ...extra, ...((s.properties as Record<string, unknown>) ?? {}) },
			required: ["chatId", ...(((s.required as string[]) ?? []).filter((r) => r !== "chatId"))],
			additionalProperties: false,
		};
	}
	// Non-object schemas never occur for these tools; wrap defensively.
	return { type: "object", properties: { chatId: chatIdProp, ...extra, args: s }, required: ["chatId", "args"] };
}

function catalog(): McpTool[] {
	// Schemas never depend on the chat: a placeholder context builds them.
	const ctx = { chatId: "_", chatStore: stores.chatStore };
	const quiz = teachQuizToolFor(ctx);
	const explain = teachExplainToolFor(ctx);
	const plan = planTools(ctx).plan_init!;
	const probeDone = probeDoneTool({ ...ctx, deliver: () => {} }).probe_done!;
	const blocking =
		" BLOCKS until the learner answers (up to a few minutes) and returns the graded answer; if it returns status \"waiting\", call wait_for_learner with the chatId.";
	return [
		{
			name: "start_session",
			description:
				"Create a new LearnHarness teaching session for what the learner wants to understand, open in the app. Returns the chatId, a link, and the probing doctrine. Next: probe the learner's current understanding.",
			inputSchema: {
				type: "object",
				properties: { topic: { type: "string", description: "What the learner wants to understand, in their words." } },
				required: ["topic"],
				additionalProperties: false,
			},
		},
		{
			name: "wait_for_learner",
			description:
				"Wait for the learner. With chatId: releases the app's busy indicator and blocks until the learner writes or answers an open question. Without chatId: waits for any session the learner started or wrote in from the app. Returns the learner's input, or status \"waiting\"/\"idle\" when the window passes — then call it again.",
			inputSchema: { type: "object", properties: { chatId: chatIdProp }, additionalProperties: false },
		},
		{
			name: "say",
			description:
				"Send teaching prose to the learner as one teacher message (Markdown; LaTeX as $…$ and $$…$$; fenced code). Does not wait — follow with a question tool or wait_for_learner. Returns any learner input that arrived meanwhile.",
			inputSchema: {
				type: "object",
				properties: { chatId: chatIdProp, text: { type: "string", description: "The message, Markdown." } },
				required: ["chatId", "text"],
				additionalProperties: false,
			},
		},
		{ name: "probe", description: `[probing phase] ${probeQuizTool.description}${blocking}`, inputSchema: withChat(probeQuizTool.parameters, { lead: leadProp }) },
		{ name: "recall", description: `[probing phase] ${probeExplainTool.description}${blocking}`, inputSchema: withChat(probeExplainTool.parameters, { lead: leadProp }) },
		{ name: "quiz", description: `[teaching phase] ${quiz.description}${blocking}`, inputSchema: withChat(quiz.parameters, { lead: leadProp }) },
		{ name: "explain", description: `[teaching phase] ${explain.description}${blocking}`, inputSchema: withChat(explain.parameters, { lead: leadProp }) },
		{
			name: "ask_user_question",
			description: `[both phases] ${askUserQuestionTool.description}${blocking}`,
			inputSchema: withChat(askUserQuestionTool.parameters, { lead: leadProp }),
		},
		{ name: "probe_done", description: `[probing phase] ${probeDone.description} Returns the teaching doctrine.`, inputSchema: withChat(probeDone.parameters) },
		{ name: "plan_init", description: `[teaching phase] ${plan.description}`, inputSchema: withChat(plan.parameters) },
		{
			name: "read_session",
			description: "Read a session's recent transcript, phase and plan — for resuming a session after a restart.",
			inputSchema: {
				type: "object",
				properties: { chatId: chatIdProp, limit: { type: "number", description: "How many recent messages (default 60)." } },
				required: ["chatId"],
				additionalProperties: false,
			},
		},
		{
			name: "list_sessions",
			description: "List the learner's teaching sessions with phase and who the session is waiting on.",
			inputSchema: { type: "object", properties: {}, additionalProperties: false },
		},
		{
			name: "get_instructions",
			description: "Fetch the teaching doctrine for a session's current phase (or for a named phase).",
			inputSchema: {
				type: "object",
				properties: { chatId: chatIdProp, phase: { type: "string", enum: ["probe", "teach"] } },
				additionalProperties: false,
			},
		},
		{
			name: "release_session",
			description: "Hand a session back to the app's own built-in model loop (only useful if the app has a model configured).",
			inputSchema: { type: "object", properties: { chatId: chatIdProp }, required: ["chatId"], additionalProperties: false },
		},
		{
			name: "extraction_source",
			description:
				"Knowledge-graph extraction, step 1: the session's not-yet-extracted teacher prose (with message ids), what the graph already holds from this session, and the extraction rules. Then graph_search for overlaps, then graph_submit.",
			inputSchema: { type: "object", properties: { chatId: chatIdProp }, required: ["chatId"], additionalProperties: false },
		},
		{
			name: "graph_search",
			description: "Search the learner's knowledge graph (names, statements, aliases). Use before graph_submit to link instead of duplicating.",
			inputSchema: {
				type: "object",
				properties: {
					query: { type: "string", description: "Words to match; omit to list recent nodes." },
					limit: { type: "number", description: "Max results (default 40)." },
				},
				additionalProperties: false,
			},
		},
		{
			name: "graph_submit",
			description:
				"Knowledge-graph extraction, step 2: submit the core ideas (propositions) and reasoning chains for the stretch extraction_source gave you. Merged deterministically into the graph; marks that stretch as extracted.",
			inputSchema: {
				type: "object",
				properties: {
					chatId: chatIdProp,
					messageIds: { type: "array", items: { type: "string" }, description: "The messageIds extraction_source returned." },
					propositions: {
						type: "array",
						items: {
							type: "object",
							properties: {
								id: { type: "string", description: 'Local id: "p1", "p2", … — referenced by chains in this call.' },
								name: { type: "string", description: "A very short label — the discipline's own term, like a glossary headword." },
								statement: {
									type: "string",
									description:
										"One true, self-contained, world-facing idea at full precision. Never about the learner or the lesson. A misconception enters as its TRUE correction.",
								},
								aliases: { type: "array", items: { type: "string" }, description: "Verbatim phrasings the source used, if any." },
								messageId: { type: "string", description: "The message id of the passage that states or explains it." },
								linkTo: { type: "string", description: 'An existing node id ("n_…") this proposition IS (same claim, any wording).' },
							},
							required: ["id", "name", "statement"],
							additionalProperties: false,
						},
					},
					chains: {
						type: "array",
						items: {
							type: "object",
							properties: {
								premises: {
									type: "array",
									items: { type: "string" },
									description: "Ids (local or existing n_…) that JOINTLY entail the conclusion.",
								},
								conclusion: { type: "string", description: "The id the premises jointly imply." },
							},
							required: ["premises", "conclusion"],
							additionalProperties: false,
						},
					},
				},
				required: ["chatId", "messageIds", "propositions", "chains"],
				additionalProperties: false,
			},
		},
	];
}

// ─── dispatch ────────────────────────────────────────────────────────────────

type CallResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function ok(value: unknown): CallResult {
	// Instructions are long Markdown: they ride as their own text block so
	// the structured part stays readable.
	if (value && typeof value === "object" && "instructions" in value && typeof (value as { instructions?: unknown }).instructions === "string") {
		const { instructions, ...rest } = value as { instructions: string };
		return {
			content: [
				{ type: "text", text: JSON.stringify(rest, null, 2) },
				{ type: "text", text: instructions },
			],
		};
	}
	if (value && typeof value === "object" && "instructions" in value) {
		const { instructions: _drop, ...rest } = value as { instructions?: unknown };
		return { content: [{ type: "text", text: JSON.stringify(rest, null, 2) }] };
	}
	return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function err(message: string): CallResult {
	return { content: [{ type: "text", text: message }], isError: true };
}

const QUESTION_TOOL_NAMES = new Set(["probe", "recall", "quiz", "explain", "ask_user_question"]);

async function callTool(name: string, args: Record<string, unknown>, origin: string | undefined): Promise<CallResult> {
	const chatId = typeof args.chatId === "string" ? args.chatId : undefined;
	try {
		if (QUESTION_TOOL_NAMES.has(name)) {
			const { chatId: _c, lead, ...rest } = args;
			return ok(await askQuestion(chatId ?? "", name, rest, typeof lead === "string" ? lead : undefined));
		}
		switch (name) {
			case "start_session":
				return ok(await startSession(String(args.topic ?? ""), origin));
			case "wait_for_learner":
				return ok(await waitForLearner(chatId));
			case "say":
				return ok(await say(chatId ?? "", String(args.text ?? "")));
			case "probe_done":
			case "plan_init": {
				const { chatId: _c, ...rest } = args;
				return ok(await runServerTool(chatId ?? "", name, rest));
			}
			case "read_session":
				return ok(readSession(chatId ?? "", typeof args.limit === "number" ? args.limit : undefined));
			case "list_sessions":
				return ok({ sessions: listExternalSessions() });
			case "get_instructions": {
				let phase: "probe" | "teach" | undefined = args.phase === "probe" || args.phase === "teach" ? args.phase : undefined;
				if (!phase && chatId) {
					const record = stores.chatStore.getChat(chatId);
					if (!record) return err(`Unknown chat: ${chatId}`);
					phase = hasProbeDone(record.messages) ? "teach" : "probe";
				}
				return ok({ phase: phase ?? "probe", instructions: instructionsFor(phase ?? "probe") });
			}
			case "release_session":
				if (!chatId) return err("chatId is required");
				releaseExternal(chatId);
				return ok({ ok: true, note: "The session is back on the app's own model loop." });
			case "extraction_source":
				return ok(extractionSource(chatId ?? ""));
			case "graph_search":
				return ok(graphSearch(typeof args.query === "string" ? args.query : undefined, typeof args.limit === "number" ? args.limit : undefined));
			case "graph_submit":
				return ok(graphSubmit(args as unknown as GraphSubmitInput));
			default:
				return err(`Unknown tool: ${name}`);
		}
	} catch (e) {
		if (e instanceof ExternalAgentError) return err(e.message);
		console.error(`[mcp] ${name} failed:`, e);
		return err(`${name} failed: ${(e as Error).message}`);
	}
}

// ─── JSON-RPC over HTTP ──────────────────────────────────────────────────────

interface RpcRequest {
	jsonrpc: "2.0";
	id?: string | number | null;
	method: string;
	params?: Record<string, unknown>;
}

type RpcResponse =
	| { jsonrpc: "2.0"; id: string | number | null; result: unknown }
	| { jsonrpc: "2.0"; id: string | number | null; error: { code: number; message: string } };

async function handleOne(msg: RpcRequest, origin: string | undefined): Promise<RpcResponse | null> {
	const isNotification = msg.id === undefined;
	const id = msg.id ?? null;
	const reply = (result: unknown): RpcResponse => ({ jsonrpc: "2.0", id, result });
	const fail = (code: number, message: string): RpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });
	if (msg?.jsonrpc !== "2.0" || typeof msg.method !== "string") return isNotification ? null : fail(-32600, "Invalid Request");
	switch (msg.method) {
		case "initialize": {
			const requested = typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : "";
			return reply({
				protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: "learnharness", title: "LearnHarness", version: SERVER_VERSION },
				instructions: SERVER_INSTRUCTIONS,
			});
		}
		case "ping":
			return reply({});
		case "tools/list":
			return reply({ tools: catalog() });
		case "tools/call": {
			const name = typeof msg.params?.name === "string" ? msg.params.name : "";
			const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
			return reply(await callTool(name, args, origin));
		}
		case "resources/list":
			return reply({ resources: [] });
		case "prompts/list":
			return reply({ prompts: [] });
		default:
			if (msg.method.startsWith("notifications/")) return null;
			return isNotification ? null : fail(-32601, `Method not found: ${msg.method}`);
	}
}

/** Only local origins may drive the endpoint (DNS-rebinding guard): a
 *  browser page elsewhere must never be able to post into a session. */
function originAllowed(req: Request): boolean {
	const origin = req.headers.get("origin");
	if (!origin) return true; // non-browser clients (Claude Code) send none
	try {
		const host = new URL(origin).hostname;
		return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
	} catch {
		return false;
	}
}

/** POST /api/mcp — one JSON-RPC message or a batch. */
export async function handleMcpRequest(req: Request): Promise<Response> {
	if (!originAllowed(req)) return Response.json({ error: "Forbidden origin" }, { status: 403 });
	noteAgentSeen();
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
	}
	const url = new URL(req.url);
	const host = req.headers.get("host") ?? url.host;
	const origin = `${url.protocol}//${host}`;
	if (Array.isArray(body)) {
		const out = (await Promise.all(body.map((m) => handleOne(m as RpcRequest, origin)))).filter((r): r is RpcResponse => r !== null);
		return out.length > 0 ? Response.json(out) : new Response(null, { status: 202 });
	}
	const res = await handleOne(body as RpcRequest, origin);
	return res ? Response.json(res) : new Response(null, { status: 202 });
}

/** GET/DELETE — no server-initiated stream, no sessions (stateless server). */
export function mcpMethodNotAllowed(): Response {
	return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
