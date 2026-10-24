/**
 * External-agent status (src/server/external-agent.ts): whether new
 * sessions are driven by a connected MCP agent (LH_EXTERNAL_AGENT=1) and
 * whether one has been seen recently. The home screen reads it to skip the
 * model/key setup guards that only the built-in loop needs.
 */
import { externalAgentStatus } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET(): Response {
	return Response.json(externalAgentStatus());
}
