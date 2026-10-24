/**
 * The MCP endpoint (src/server/mcp.ts): an external agent such as Claude
 * Code connects here and drives teaching sessions —
 *   claude mcp add --transport http learnharness http://localhost:3000/api/mcp
 * Thin transport wrapper over the server barrel (the import law).
 */
import { handleMcpRequest, mcpMethodNotAllowed } from "@/src/server";

// Question tools block until the learner answers (up to a few minutes).
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
	return handleMcpRequest(req);
}

export function GET(): Response {
	return mcpMethodNotAllowed();
}

export function DELETE(): Response {
	return mcpMethodNotAllowed();
}
