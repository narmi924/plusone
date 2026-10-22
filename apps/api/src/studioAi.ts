// The seller's report (AG Studio) talks to Claude through this route.
// POST /api/studio-ai/turn: one Studio agent turn = one streamed Anthropic
// Messages call. Studio owns the agent loop and runs every tool in the browser
// (querying the report data, adding widgets, our payment reminder); this route
// only translates between Studio's conversation format and the Messages API.
import Anthropic from "@anthropic-ai/sdk";
import type {
  AgAiConversationItem,
  AgAiEvent,
  AgAiOutputItem,
  AgAiReasoningItem,
  AgLlmRequest,
  AgLlmResponse,
} from "ag-studio"; // type-only: no runtime dependency on the server
import type { FastifyInstance } from "fastify";

import B = Anthropic.Beta.Messages; // type namespace for Beta* params
type RawThinking = B.BetaThinkingBlockParam | B.BetaRedactedThinkingBlockParam;
/** Our private extension: the raw thinking block rides along on Studio's reasoning item. */
type ReasoningItem = AgAiReasoningItem & { anthropic?: RawThinking };

const MODEL = "claude-opus-5-5";

// ---------- AG Studio request -> Anthropic params ----------
function toAnthropic(req: AgLlmRequest) {
  const messages: B.BetaMessageParam[] = [];
  let assistant: B.BetaContentBlockParam[] | null = null;
  let turnKey: string | undefined; // groups items of one assistant turn (ids we minted)
  const openCalls = new Set<string>();
  let results: B.BetaToolResultBlockParam[] = [];
  let systemExtra = "";

  const flush = () => {
    if (assistant) messages.push({ role: "assistant", content: assistant });
    // Every tool_use needs a tool_result in the next user turn (a cancelled run can leave one open).
    for (const id of openCalls)
      results.push({
        type: "tool_result",
        tool_use_id: id,
        is_error: true,
        content: "Not run (cancelled).",
      });
    if (results.length) messages.push({ role: "user", content: results });
    assistant = null;
    turnKey = undefined;
    openCalls.clear();
    results = [];
  };
  const key = (id?: string) => (id?.startsWith("t:") ? id.split("#")[0] : undefined);

  for (const item of req.input as AgAiConversationItem[]) {
    if (item.type === "function_call_output") {
      openCalls.delete(item.callId);
      results.push({ type: "tool_result", tool_use_id: item.callId, content: item.output });
      continue;
    }
    if (item.kind === "input") {
      // user or system text
      const text = item.content.map((c) => (c.type === "text" ? c.text : "")).join("");
      if (item.role === "system") {
        systemExtra += `\n\n${text}`;
        continue;
      }
      flush();
      const last = messages.at(-1);
      if (last?.role === "user" && Array.isArray(last.content))
        last.content.push({ type: "text", text });
      else messages.push({ role: "user", content: [{ type: "text", text }] });
      continue;
    }
    // output item: reasoning | message | function_call
    const k = key(item.id);
    const sameTurn = assistant && (k ? k === turnKey : !(results.length && openCalls.size === 0));
    if (!sameTurn) {
      flush();
      assistant = [];
      turnKey = k;
    }
    const turn: B.BetaContentBlockParam[] = assistant ?? [];
    assistant = turn;
    if (item.type === "reasoning") {
      const raw = (item as ReasoningItem).anthropic;
      if (raw) turn.push(raw); // replay verbatim (signature included)
    } else if (item.type === "message") {
      const text = item.content.map((c) => (c.type === "text" ? c.text : c.refusal)).join("");
      if (text) turn.push({ type: "text", text });
    } else {
      let input: unknown = {};
      try {
        input = item.arguments ? JSON.parse(item.arguments) : {};
      } catch {
        /* keep {} */
      }
      turn.push({ type: "tool_use", id: item.callId, name: item.name, input });
      openCalls.add(item.callId);
    }
  }
  flush();

  const tools: B.BetaTool[] = (req.tools ?? [])
    .filter((t) => (t.kind ?? "client") !== "provided") // pass provider-hosted tools natively if you add any
    .map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as B.BetaTool.InputSchema,
    }));

  // Claude Opus 5.5 rejects forced tool_choice ({type:'tool'|'any'}) AND assistant prefill.
  // Studio forces `complete_task` at the end of a delegated sub-run, after appending the model's
  // plain-text turn - so the history ends on `assistant`. Answer with a user nudge + tool_choice auto.
  const tool_choice: B.BetaToolChoice | undefined =
    req.toolChoice === "none" ? { type: "none" } : undefined;
  const nudge =
    typeof req.toolChoice === "object"
      ? `Now call the \`${req.toolChoice.name}\` tool.`
      : req.toolChoice === "required"
        ? "Now call one of the tools."
        : "";
  const last = messages.at(-1);
  if (last?.role === "assistant")
    messages.push({ role: "user", content: [{ type: "text", text: nudge || "Continue." }] });
  else if (nudge && last && Array.isArray(last.content))
    last.content.push({ type: "text", text: nudge }); // after tool_results

  return { system: (req.instructions ?? "") + systemExtra, messages, tools, tool_choice };
}

// ---------- route ----------
export function studioAiRoute(deps: {
  apiKey: string;
  isSeller: (token: string | undefined) => boolean;
  /** Per-visitor and demo-wide limits on assistant turns. */
  allow: (ip: string) => boolean;
}) {
  const client = new Anthropic({ apiKey: deps.apiKey, timeout: 120_000, maxRetries: 2 });
  return async (app: FastifyInstance) => {
    app.post<{ Body: AgLlmRequest }>(
      "/api/studio-ai/turn",
      { bodyLimit: 2 * 1024 * 1024 },
      async (request, reply) => {
        const token = request.headers["x-seller-token"];
        if (!deps.isSeller(typeof token === "string" ? token : undefined)) {
          return reply.code(401).send({ error: "Seller sign-in required" });
        }
        if (!deps.allow(request.ip))
          return reply
            .code(429)
            .send({ error: "The assistant needs a short break. Try again soon." });
        const req = request.body;
        const { system, messages, tools, tool_choice } = toAnthropic(req);

        reply.hijack();
        const out = reply.raw;
        out.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const send = (event: "ag" | "complete" | "error", data: unknown) =>
          out.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        const ag = (e: AgAiEvent) => send("ag", e);

        const abort = new AbortController();
        // Browser cancelled the run (Studio aborts its fetch). Listen on the RESPONSE: request.raw emits
        // 'close' as soon as the body has been read, which would abort every call immediately.
        out.on("close", () => {
          if (!out.writableFinished) abort.abort();
        });

        try {
          const stream = client.beta.messages.stream(
            {
              model: MODEL,
              max_tokens: 8000,
              cache_control: { type: "ephemeral" }, // Studio resends the whole history every turn
              system,
              messages,
              tools,
              ...(tool_choice && { tool_choice }),
              thinking: {
                type: "adaptive",
                display: "summarized",
                block_binding: { prefix_mismatch_behavior: "drop_block" },
              },
              output_config: {
                effort: (req.model?.effort as "low" | "medium" | "high" | undefined) ?? "medium",
              },
              fallbacks: "default",
              betas: ["thinking-binding-controls-2026-08-01", "server-side-fallback-2026-07-01"],
            },
            { signal: abort.signal },
          );

          let msgId = "";
          const blockIds = new Map<number, string>(); // content index -> AG message/tool id
          for await (const ev of stream) {
            if (ev.type === "message_start") msgId = ev.message.id;
            else if (ev.type === "content_block_start") {
              const b = ev.content_block;
              const id = `t:${msgId}#${ev.index}`;
              if (b.type === "text") {
                blockIds.set(ev.index, id);
                ag({ type: "TEXT_MESSAGE_START", messageId: id, role: "assistant" });
              } else if (b.type === "thinking") {
                blockIds.set(ev.index, id);
                ag({ type: "REASONING_MESSAGE_START", messageId: id, role: "reasoning" });
              } else if (b.type === "tool_use") {
                blockIds.set(ev.index, b.id);
                ag({ type: "TOOL_CALL_START", toolCallId: b.id, toolCallName: b.name });
              }
            } else if (ev.type === "content_block_delta") {
              const id = blockIds.get(ev.index);
              if (!id) continue;
              const d = ev.delta;
              if (d.type === "text_delta")
                ag({ type: "TEXT_MESSAGE_CONTENT", messageId: id, delta: d.text });
              else if (d.type === "thinking_delta")
                ag({ type: "REASONING_MESSAGE_CONTENT", messageId: id, delta: d.thinking });
              else if (d.type === "input_json_delta")
                ag({ type: "TOOL_CALL_ARGS", toolCallId: id, delta: d.partial_json });
            } else if (ev.type === "content_block_stop") {
              const id = blockIds.get(ev.index);
              if (!id) continue;
              const kind = stream.currentMessage?.content[ev.index]?.type;
              ag(
                kind === "tool_use"
                  ? { type: "TOOL_CALL_END", toolCallId: id }
                  : kind === "thinking"
                    ? { type: "REASONING_MESSAGE_END", messageId: id }
                    : { type: "TEXT_MESSAGE_END", messageId: id },
              );
            }
          }

          const msg = await stream.finalMessage();
          const output: AgAiOutputItem[] = [];
          msg.content.forEach((b, i) => {
            const id = `t:${msg.id}#${i}`;
            if (b.type === "text")
              output.push({
                id,
                kind: "output",
                type: "message",
                role: "assistant",
                status: "completed",
                content: [{ type: "text", text: b.text, annotations: [] }],
              });
            else if (b.type === "thinking")
              output.push({
                id,
                kind: "output",
                type: "reasoning",
                summary: [{ type: "summary", text: b.thinking }],
                anthropic: { type: "thinking", thinking: b.thinking, signature: b.signature },
              } as ReasoningItem);
            else if (b.type === "redacted_thinking")
              output.push({
                id,
                kind: "output",
                type: "reasoning",
                summary: [],
                anthropic: { type: "redacted_thinking", data: b.data },
              } as ReasoningItem);
            else if (b.type === "tool_use")
              output.push({
                id,
                kind: "output",
                type: "function_call",
                callId: b.id,
                name: b.name,
                arguments: JSON.stringify(b.input ?? {}),
                status: "completed",
              });
          });
          if (msg.stop_reason === "refusal") {
            output.push({
              id: `t:${msg.id}#refusal`,
              kind: "output",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "refusal", refusal: "The model declined this request." }],
            });
          }
          const truncated = msg.stop_reason === "max_tokens";
          const u = msg.usage;
          const response: AgLlmResponse = {
            id: msg.id,
            createdAt: Date.now(),
            model: msg.model,
            status: truncated ? "incomplete" : "completed",
            ...(truncated && { incompleteDetails: { reason: "max_output_tokens" as const } }),
            output: truncated ? output.filter((o) => o.type !== "function_call") : output, // never run a truncated tool call
            usage: {
              inputTokens:
                u.input_tokens +
                (u.cache_read_input_tokens ?? 0) +
                (u.cache_creation_input_tokens ?? 0),
              outputTokens: u.output_tokens,
              ...(u.cache_read_input_tokens != null && {
                cachedInputTokens: u.cache_read_input_tokens,
              }),
              ...(u.cache_creation_input_tokens != null && {
                cacheWriteTokens: u.cache_creation_input_tokens,
              }),
            },
          };
          send("complete", response);
        } catch (err) {
          if (!abort.signal.aborted)
            send("error", {
              message:
                err instanceof Anthropic.APIError ? `${err.status} ${err.message}` : String(err),
            });
        } finally {
          out.end();
        }
      },
    );
  };
}
