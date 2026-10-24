/**
 * EXTERNAL-AGENT PINS: an MCP client drives a whole teaching session —
 * probe → probe_done → plan_init → quiz → free text → graph extraction —
 * through POST /api/mcp, while the learner answers through the app's own
 * chat route. No model is configured anywhere: the external chat must never
 * hit the BYOK gate. Runs under an isolated LH_DATA_DIR with short waits.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-external-agent-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.LH_MCP_WAIT_SECONDS = "1.5";
process.env.LH_MCP_POLL_MS = "20";
delete process.env.LH_EXTERNAL_AGENT;

const { handleMcpRequest } = await import("../src/server/mcp.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { graphStore } = await import("../src/store/graph.ts");
const { isTurnRunning } = await import("../src/server/turn-liveness.ts");
const { getGraph } = await import("../src/core/graph.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
	// Idle guards are unref'd; nothing else keeps the process alive.
});

let rpcId = 0;
async function rpc(method: string, params?: Record<string, unknown>, headers: Record<string, string> = {}) {
	const res = await handleMcpRequest(
		new Request("http://localhost:3000/api/mcp", {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
			body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, ...(params ? { params } : {}) }),
		}),
	);
	return { status: res.status, body: res.status === 200 ? ((await res.json()) as any) : null };
}

/** Call a tool; returns the parsed structured block + raw content. */
async function call(name: string, args: Record<string, unknown>) {
	const { body } = await rpc("tools/call", { name, arguments: args });
	const result = body.result as { content: Array<{ text: string }>; isError?: boolean };
	let data: any = null;
	try {
		data = JSON.parse(result.content[0]!.text);
	} catch {
		data = result.content[0]!.text;
	}
	return { data, isError: result.isError === true, content: result.content };
}

async function learner(chatId: string, input: Record<string, unknown>) {
	return handleChatRequest(
		new Request("http://localhost:3000/api/chat", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ chatId, input }),
		}),
	);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until the record shows a dangling question, then answer it. */
async function answerWhenAsked(chatId: string, answer: (toolCallId: string) => Record<string, unknown>) {
	const { danglingQuestionOf } = await import("../src/core/native-messages.ts");
	for (let i = 0; i < 200; i++) {
		const record = chatStore.getChat(chatId)!;
		const open = danglingQuestionOf(record.messages);
		if (open) {
			const res = await learner(chatId, { type: "answer", toolCallId: open.toolCallId, answer: answer(open.toolCallId) });
			assert.equal(res.status, 200, await res.clone().text());
			return open;
		}
		await sleep(10);
	}
	throw new Error("no question was posed");
}

const quizAnswer = (tool: string) => ({
	kind: "quiz",
	tool,
	questionText: "q",
	dontKnow: false,
	answers: [{ index: 0, label: "$6\\cos(2x)$" }],
	correct: true,
	confidence: 80,
	thinking: "chain rule twice",
	answeredAt: new Date().toISOString(),
});

const probeArgs = {
	question: "What is $\\frac{d}{dx}\\sin(2x)$?",
	options: [
		{ label: "$2\\cos(2x)$", value: "a" },
		{ label: "$\\cos(2x)$", value: "b" },
	],
	explanation: "Chain rule: the inner derivative is 2.",
	correctAnswer: "a",
};

describe("external agent over MCP", () => {
	it("speaks MCP: initialize, tools/list, notifications, unknown methods", async () => {
		const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
		assert.equal(init.body.result.protocolVersion, "2025-06-18");
		assert.equal(init.body.result.serverInfo.name, "learnharness");
		assert.match(init.body.result.instructions, /wait_for_learner/);

		const unknownVersion = await rpc("initialize", { protocolVersion: "1999-01-01" });
		assert.equal(unknownVersion.body.result.protocolVersion, "2025-06-18");

		const note = await handleMcpRequest(
			new Request("http://localhost:3000/api/mcp", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
			}),
		);
		assert.equal(note.status, 202);

		const list = await rpc("tools/list");
		const names = list.body.result.tools.map((t: { name: string }) => t.name);
		for (const n of ["start_session", "wait_for_learner", "say", "probe", "recall", "quiz", "explain", "ask_user_question", "probe_done", "plan_init", "extraction_source", "graph_search", "graph_submit"]) {
			assert.ok(names.includes(n), `missing tool ${n}`);
		}
		const quiz = list.body.result.tools.find((t: { name: string }) => t.name === "quiz");
		assert.deepEqual(quiz.inputSchema.required.slice(0, 1), ["chatId"]);
		assert.ok(quiz.inputSchema.properties.nodeId, "the app's own quiz schema rides through");
		assert.ok(quiz.inputSchema.properties.lead);

		const missing = await rpc("no/such/method");
		assert.equal(missing.body.error.code, -32601);
	});

	it("refuses non-local browser origins", async () => {
		const res = await rpc("tools/list", undefined, { origin: "https://evil.example" });
		assert.equal(res.status, 403);
	});

	it("drives probe → plan → teach → extraction end to end, with no model configured", async () => {
		// 1. Start: the topic is the learner's first message; busy until the agent asks.
		const started = await call("start_session", { topic: "Why does the chain rule work?" });
		assert.equal(started.isError, false);
		const chatId: string = started.data.chatId;
		assert.match(started.data.url, /\/chat\/chat_/);
		assert.equal(started.data.phase, "probe");
		assert.match(started.content[1]!.text, /PROBING/, "probing doctrine rides along once");
		assert.equal(isTurnRunning(chatId), true);

		// 2. say: a native assistant text message, stamped external.
		const said = await call("say", { chatId, text: "Let's find where you are." });
		assert.equal(said.isError, false);
		let record = chatStore.getChat(chatId)!;
		const last = record.messages.at(-1) as any;
		assert.equal(last.role, "assistant");
		assert.equal(last.provider, "external");
		assert.equal(last.content[0].text, "Let's find where you are.");

		// 3. Wrong-phase and invalid calls are refused and never persisted.
		const count = chatStore.getChat(chatId)!.messages.length;
		const wrongPhase = await call("quiz", { chatId, type: "check", nodeId: "x", ...probeArgs });
		assert.equal(wrongPhase.isError, true);
		assert.match(wrongPhase.data, /teaching phase/);
		const invalid = await call("probe", { chatId, question: "?", options: [{ label: "a", value: "a" }], explanation: "e", correctAnswer: "zzz" });
		assert.equal(invalid.isError, true);
		assert.equal(chatStore.getChat(chatId)!.messages.length, count);

		// 4. A probe blocks until the learner answers through the app's chat route.
		const answering = answerWhenAsked(chatId, () => quizAnswer("probe"));
		const probed = await call("probe", { chatId, lead: "First, a warm-up:", ...probeArgs });
		await answering;
		assert.equal(probed.isError, false, JSON.stringify(probed.data));
		assert.equal(probed.data.status, "answered");
		assert.equal(probed.data.result.correct, true);
		assert.equal(probed.data.result.thinking, "chain rule twice");
		record = chatStore.getChat(chatId)!;
		const call0 = record.messages.find((m: any) => m.role === "assistant" && m.content.some((b: any) => b.type === "toolCall")) as any;
		assert.equal(call0.content[0].text, "First, a warm-up:", "the lead rides in the same message");
		assert.equal(call0.content[1].name, "probe");
		assert.equal(isTurnRunning(chatId), true, "the answer makes the chat busy until the agent replies");

		// 5. probe_done: phase flips, teaching doctrine arrives, handoff marker lands.
		const done = await call("probe_done", {
			chatId,
			assessment: { strands: [{ strand: "derivatives of compositions", assessment: "Applies the chain rule mechanically; no picture of why." }] },
		});
		assert.equal(done.isError, false, JSON.stringify(done.data));
		assert.equal(done.data.phase, "teach");
		assert.match(done.content[1]!.text, /TEACHING/);
		record = chatStore.getChat(chatId)!;
		assert.ok(record.messages.some((m: any) => m.role === "custom" && m.customType === "probe-handoff"));

		// 6. plan_init: tree saved, plan block emitted by the shared persist seam.
		const plan = await call("plan_init", {
			chatId,
			mermaid: "graph TD\n  rates[Rates multiply] --> chain[The chain rule]",
		});
		assert.equal(plan.isError, false, JSON.stringify(plan.data));
		record = chatStore.getChat(chatId)!;
		assert.deepEqual(record.tree?.nodes.map((n) => n.id), ["rates", "chain"]);
		assert.ok(record.messages.some((m: any) => m.role === "custom" && m.customType === "plan-block"));

		// 7. Teach: prose, then a quiz whose nodeId is validated against the live plan.
		await call("say", { chatId, text: "If $y$ changes twice as fast as $u$, and $u$ three times as fast as $x$…" });
		const badNode = await call("quiz", { chatId, type: "check", nodeId: "nope", ...probeArgs });
		assert.equal(badNode.isError, true);
		assert.match(badNode.data, /matches no node/);

		// 8. A quiz nobody answers in the window returns "waiting"; the answer
		//    arrives later through wait_for_learner.
		const unanswered = await call("quiz", { chatId, type: "check", nodeId: "chain", ...probeArgs });
		assert.equal(unanswered.data.status, "waiting");
		assert.equal(isTurnRunning(chatId), false, "the open question releases the busy state");
		const lateAnswer = answerWhenAsked(chatId, () => quizAnswer("quiz"));
		const waited = await call("wait_for_learner", { chatId });
		await lateAnswer;
		assert.equal(waited.data.status, "answered");
		assert.equal(waited.data.learnerInput[0].type, "answer");
		assert.equal(waited.data.learnerInput[0].toolCallId, unanswered.data.toolCallId);

		// 9. Free text: wait_for_learner releases busy, then returns the message.
		await call("say", { chatId, text: "Questions so far?" });
		const typing = (async () => {
			await sleep(100);
			const res = await learner(chatId, { type: "text", text: "Why multiply and not add?" });
			assert.equal(res.status, 200, "no 503 — external chats skip the model gate");
		})();
		const msg = await call("wait_for_learner", { chatId });
		await typing;
		assert.equal(msg.data.learnerInput[0].type, "message");
		assert.equal(msg.data.learnerInput[0].text, "Why multiply and not add?");
		const resumed = await call("read_session", { chatId });
		assert.match(resumed.data.transcript, /LEARNER: Why multiply and not add\?/);

		// 10. Extraction: the agent extracts + links; coverage closes the stretch.
		const src = await call("extraction_source", { chatId });
		assert.ok(src.data.messageIds.length >= 2);
		assert.match(src.data.source, /TEACHER/);
		const submitted = await call("graph_submit", {
			chatId,
			messageIds: src.data.messageIds,
			propositions: [
				{ id: "p1", name: "Rates of change multiply through a composition", statement: "If y changes at rate a per unit of u and u at rate b per unit of x, y changes at rate ab per unit of x.", messageId: src.data.messageIds.at(-1) },
				{ id: "p2", name: "Chain rule", statement: "The derivative of f(g(x)) is f'(g(x))·g'(x)." },
			],
			chains: [{ premises: ["p1"], conclusion: "p2" }],
		});
		assert.equal(submitted.isError, false, JSON.stringify(submitted.data));
		assert.equal(submitted.data.nodes, 2);
		assert.equal(submitted.data.chains, 1);
		assert.equal(getGraph(graphStore).nodes.length, 2);
		const again = await call("extraction_source", { chatId });
		assert.deepEqual(again.data.messageIds, []);

		// Linking instead of duplicating.
		const found = await call("graph_search", { query: "chain rule" });
		const chainNode = found.data.nodes.find((n: { name: string }) => n.name === "Chain rule");
		assert.ok(chainNode);
		const badLink = await call("graph_submit", {
			chatId,
			messageIds: [],
			propositions: [{ id: "q1", name: "x", statement: "y", linkTo: "n_doesnotexist" }],
			chains: [],
		});
		assert.equal(badLink.isError, true);
	});

	it("picks up a session the learner starts in the app (LH_EXTERNAL_AGENT=1)", async () => {
		process.env.LH_EXTERNAL_AGENT = "1";
		try {
			const chat = chatStore.createChat("Entropy");
			const typing = (async () => {
				await sleep(100);
				const res = await learner(chat.id, { type: "text", text: "I want to understand entropy" });
				assert.equal(res.status, 200);
			})();
			const picked = await call("wait_for_learner", {});
			await typing;
			assert.equal(picked.data.chatId, chat.id);
			assert.equal(picked.data.learnerInput[0].text, "I want to understand entropy");
			assert.match(picked.content[1]!.text, /PROBING/);
			assert.equal(isTurnRunning(chat.id), true);
			// Idle when nothing is owed.
			const idle = await call("wait_for_learner", {});
			assert.equal(idle.data.status, "idle");
			assert.equal(isTurnRunning(chat.id), false, "waiting with nothing owed releases the busy state");
		} finally {
			delete process.env.LH_EXTERNAL_AGENT;
		}
	});

	it("leaves app-driven chats on the model gate", async () => {
		const chat = chatStore.createChat("not external");
		const res = await learner(chat.id, { type: "text", text: "hello" });
		assert.equal(res.status, 503, "a normal chat with no model configured still refuses honestly");
	});
});
