/**
 * External-agent session registry — the fs adapter for which chats are
 * driven by an EXTERNAL agent (an MCP client such as Claude Code) instead
 * of the app's own model loop.
 *
 * A tiny JSON set (data/external-sessions.json) rather than a ChatRecord
 * field: the chat record is read-modify-written by several writers (the
 * model picker replaces settings whole, the turn pipeline replaces
 * messages), and this marker must survive all of them. A deleted chat
 * leaves a harmless stale id behind.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";

function registryFile(): string {
	return path.join(PATHS.data, "external-sessions.json");
}

function readIds(): Set<string> {
	try {
		const raw = JSON.parse(fs.readFileSync(registryFile(), "utf-8")) as { ids?: unknown };
		return new Set(Array.isArray(raw.ids) ? raw.ids.filter((v): v is string => typeof v === "string") : []);
	} catch {
		return new Set();
	}
}

function writeIds(ids: Set<string>): void {
	fs.mkdirSync(PATHS.data, { recursive: true });
	fs.writeFileSync(registryFile(), JSON.stringify({ ids: [...ids] }, null, "\t"), "utf-8");
}

export const externalSessionStore = {
	/** Is this chat marked as externally driven? */
	has(chatId: string): boolean {
		return readIds().has(chatId);
	},
	/** Mark a chat as externally driven (idempotent). */
	add(chatId: string): void {
		const ids = readIds();
		if (ids.has(chatId)) return;
		ids.add(chatId);
		writeIds(ids);
	},
	/** Hand a chat back to the app's own model loop (idempotent). */
	remove(chatId: string): void {
		const ids = readIds();
		if (!ids.delete(chatId)) return;
		writeIds(ids);
	},
};

export type ExternalSessionStore = typeof externalSessionStore;
