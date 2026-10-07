// Run from a source checkout after `npm ci` (which also builds the server).
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { decisionImageMetadata } from "../dist/openai.js";

async function main() {
  const [file, flag] = process.argv.slice(2);
  if (!file || (flag && flag !== "--dry-run") || process.argv.length > 4) {
    throw new Error("Usage: node examples/openai-decide.mjs INPUT.json [--dry-run]");
  }
  const args = JSON.parse(await readFile(file, "utf8"));
  const imageEvidence = decisionImageMetadata(args.images ?? []);
  if (flag === "--dry-run") {
    // Show the decision and image metadata, keeping large base64 out of logs.
    const { images, ...textArgs } = args;
    console.log(JSON.stringify({ mode: "prepared_only", tool: "jev_decide", arguments: textArgs, image_evidence: imageEvidence }, null, 2));
    return;
  }
  if (!process.env.OPENAI_API_KEY) throw new Error("Set OPENAI_API_KEY, or use --dry-run to inspect inputs.");
  const client = new Client({ name: "openai-decide-example", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
    env: {
      JEV_PROVIDER: "openai", OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      ...Object.fromEntries(["JEV_MCP_MODEL", "JEV_OPENAI_BASE_URL", "JEV_MCP_REQUEST_TIMEOUT_MS", "JEV_MCP_MAX_ATTEMPTS"]
        .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]])),
    },
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "jev_decide", arguments: args });
    const block = result.content?.find((part) => part.type === "text");
    if (result.isError || !block) throw new Error("jev_decide failed; check the input and OpenAI provider configuration.");
    console.log(block.text);
  } finally {
    await client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("openai-decide: invalid input or failed judgment; see examples/openai-decisions.md.\n");
    process.exitCode = 1;
  });
}
