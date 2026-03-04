/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import {
	type AssistantMessage,
	type Context,
	EventStream,
	logRetryError,
	streamSimple,
	type TextContent,
	type ToolResultMessage,
	type UserMessage,
	validateToolArguments,
} from "@mariozechner/pi-ai";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolResult,
	StreamFn,
} from "./types.js";

// Repetition loop detection: if the model produces identical responses
// (or receives identical requests) 5 times in a row, inject a steering
// message to force a different approach.
const REPETITION_THRESHOLD = 5;

const REPETITION_STEERING_TEXT =
	"You appear to be repeating the same response or approach multiple times. " +
	"This strategy is not working. Please try a completely different approach. " +
	"Consider alternative tools, different arguments, or a different strategy entirely.";

function fingerprintAssistantMessage(message: AssistantMessage): string {
	const parts: string[] = [];
	for (const block of message.content) {
		if (block.type === "text") {
			parts.push(`text:${block.text}`);
		} else if (block.type === "toolCall") {
			parts.push(`tool:${block.name}:${JSON.stringify(block.arguments)}`);
		}
		// Skip thinking blocks — they vary even in repeated responses
	}
	return parts.join("\n");
}

function fingerprintRequestContext(messages: AgentMessage[]): string {
	const parts: string[] = [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === "assistant") break;
		if (m.role === "user") {
			const content =
				typeof m.content === "string"
					? m.content
					: m.content
							.filter((c): c is TextContent => c.type === "text")
							.map((c) => c.text)
							.join("");
			parts.unshift(`user:${content}`);
		} else if (m.role === "toolResult") {
			const textContent = m.content
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => c.text)
				.join("");
			parts.unshift(`toolResult:${m.toolName}:${textContent}:${m.isError}`);
		}
	}
	return parts.join("\n");
}

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	(async () => {
		const newMessages: AgentMessage[] = [...prompts];
		const currentContext: AgentContext = {
			...context,
			messages: [...context.messages, ...prompts],
		};

		stream.push({ type: "agent_start" });
		stream.push({ type: "turn_start" });
		for (const prompt of prompts) {
			stream.push({ type: "message_start", message: prompt });
			stream.push({ type: "message_end", message: prompt });
		}

		await runLoop(currentContext, newMessages, config, signal, stream, streamFn);
	})();

	return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	(async () => {
		const newMessages: AgentMessage[] = [];
		const currentContext: AgentContext = { ...context };

		stream.push({ type: "agent_start" });
		stream.push({ type: "turn_start" });

		await runLoop(currentContext, newMessages, config, signal, stream, streamFn);
	})();

	return stream;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

// Agent-loop level retry configuration (longer delays for model reload scenarios)
const AGENT_LOOP_MAX_RETRIES = 2;

function isAgentRetryableError(errorMessage?: string): boolean {
	if (!errorMessage) return false;
	if (/model not found/i.test(errorMessage)) return false;
	return /ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|ENETUNREACH|socket hang up|network|fetch failed|connection.*(reset|refused|closed|terminated|aborted)|other side closed|server error|internal error|model has crashed|exit code|model.?unloaded|no model|not loaded|502|503|504/i.test(
		errorMessage,
	);
}

function agentSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("aborted"));
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new Error("aborted"));
			},
			{ once: true },
		);
	});
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
	currentContext: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	streamFn?: StreamFn,
): Promise<void> {
	let firstTurn = true;
	// Check for steering messages at start (user may have typed while waiting)
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

	// Repetition loop detection state
	const responseFingerprints: string[] = [];
	const requestFingerprints: string[] = [];
	let repetitionSteeringMessage: UserMessage | null = null;

	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	while (true) {
		let hasMoreToolCalls = true;
		let steeringAfterTools: AgentMessage[] | null = null;

		// Inner loop: process tool calls and steering messages
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			if (!firstTurn) {
				stream.push({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			// Process pending messages (inject before next assistant response)
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					stream.push({ type: "message_start", message });
					stream.push({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			// Repetition detection: fingerprint the request context before LLM call
			const requestFp = fingerprintRequestContext(currentContext.messages);
			requestFingerprints.push(requestFp);
			if (requestFingerprints.length >= REPETITION_THRESHOLD) {
				const lastN = requestFingerprints.slice(-REPETITION_THRESHOLD);
				if (lastN.every((fp) => fp === lastN[0]) && lastN[0] !== "") {
					console.warn(
						`[agent-loop] Repetition detected: identical request pattern ${REPETITION_THRESHOLD} times in a row. Injecting steering message.`,
					);
					requestFingerprints.length = 0;
					responseFingerprints.length = 0;
					const steeringMsg: UserMessage = {
						role: "user",
						content: REPETITION_STEERING_TEXT,
						timestamp: Date.now(),
					};
					stream.push({ type: "message_start", message: steeringMsg });
					stream.push({ type: "message_end", message: steeringMsg });
					currentContext.messages.push(steeringMsg);
					newMessages.push(steeringMsg);
				}
			}

			// Stream assistant response with agent-level retry for recoverable errors
			let message = await streamAssistantResponse(currentContext, config, signal, stream, streamFn);
			newMessages.push(message);

			if (message.stopReason === "error" && !signal?.aborted) {
				const errorMsg = message.errorMessage;
				if (isAgentRetryableError(errorMsg)) {
					let recovered = false;
					for (let retry = 0; retry < AGENT_LOOP_MAX_RETRIES; retry++) {
						const delayMs = Math.round(5000 + Math.random() * 5000);
						logRetryError(
							"agent-loop",
							`Retryable LLM error (retry ${retry + 1}/${AGENT_LOOP_MAX_RETRIES}), waiting ${delayMs}ms: ${errorMsg}`,
						);
						try {
							await agentSleep(delayMs, signal);
						} catch {
							break; // Aborted during sleep
						}
						if (signal?.aborted) break;

						// Remove the failed assistant message from context and newMessages
						currentContext.messages.pop();
						newMessages.pop();

						// Retry the LLM call
						message = await streamAssistantResponse(currentContext, config, signal, stream, streamFn);
						newMessages.push(message);

						if (message.stopReason !== "error") {
							recovered = true;
							break;
						}
					}

					if (recovered) {
						// Fall through to normal processing below
					} else {
						// All retries exhausted or aborted
						stream.push({ type: "turn_end", message, toolResults: [] });
						stream.push({ type: "agent_end", messages: newMessages });
						stream.end(newMessages);
						return;
					}
				} else {
					// Non-retryable error
					stream.push({ type: "turn_end", message, toolResults: [] });
					stream.push({ type: "agent_end", messages: newMessages });
					stream.end(newMessages);
					return;
				}
			} else if (message.stopReason === "aborted") {
				stream.push({ type: "turn_end", message, toolResults: [] });
				stream.push({ type: "agent_end", messages: newMessages });
				stream.end(newMessages);
				return;
			}

			// Repetition detection: fingerprint the assistant response
			const responseFp = fingerprintAssistantMessage(message);
			responseFingerprints.push(responseFp);
			if (responseFingerprints.length >= REPETITION_THRESHOLD) {
				const lastN = responseFingerprints.slice(-REPETITION_THRESHOLD);
				if (lastN.every((fp) => fp === lastN[0]) && lastN[0] !== "") {
					console.warn(
						`[agent-loop] Repetition detected: identical assistant response ${REPETITION_THRESHOLD} times in a row. Injecting steering message.`,
					);
					responseFingerprints.length = 0;
					requestFingerprints.length = 0;
					repetitionSteeringMessage = {
						role: "user",
						content: REPETITION_STEERING_TEXT,
						timestamp: Date.now(),
					};
				}
			}

			// Check for tool calls
			const toolCalls = message.content.filter((c) => c.type === "toolCall");
			hasMoreToolCalls = toolCalls.length > 0;

			const toolResults: ToolResultMessage[] = [];
			if (hasMoreToolCalls) {
				const toolExecution = await executeToolCalls(
					currentContext.tools,
					message,
					signal,
					stream,
					config.getSteeringMessages,
				);
				toolResults.push(...toolExecution.toolResults);
				steeringAfterTools = toolExecution.steeringMessages ?? null;

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			}

			stream.push({ type: "turn_end", message, toolResults });

			// Get steering messages after turn completes
			if (steeringAfterTools && steeringAfterTools.length > 0) {
				pendingMessages = steeringAfterTools;
				steeringAfterTools = null;
			} else {
				pendingMessages = (await config.getSteeringMessages?.()) || [];
			}

			// Append repetition steering after normal steering (so it isn't overwritten)
			if (repetitionSteeringMessage) {
				pendingMessages.push(repetitionSteeringMessage);
				repetitionSteeringMessage = null;
			}
		}

		// Agent would stop here. Check for follow-up messages.
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			// Set as pending so inner loop processes them
			pendingMessages = followUpMessages;
			continue;
		}

		// No more messages, exit
		break;
	}

	stream.push({ type: "agent_end", messages: newMessages });
	stream.end(newMessages);
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	streamFn?: StreamFn,
): Promise<AssistantMessage> {
	// Apply context transform if configured (AgentMessage[] → AgentMessage[])
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	// Convert to LLM-compatible messages (AgentMessage[] → Message[])
	const llmMessages = await config.convertToLlm(messages);

	// Build LLM context
	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: context.tools,
	};

	const streamFunction = streamFn || streamSimple;

	// Resolve API key (important for expiring tokens)
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

	const response = await streamFunction(config.model, llmContext, {
		...config,
		apiKey: resolvedApiKey,
		signal,
	});

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	for await (const event of response) {
		switch (event.type) {
			case "start":
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				stream.push({ type: "message_start", message: { ...partialMessage } });
				break;

			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				if (partialMessage) {
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					stream.push({
						type: "message_update",
						assistantMessageEvent: event,
						message: { ...partialMessage },
					});
				}
				break;

			case "done":
			case "error": {
				const finalMessage = await response.result();
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				if (!addedPartial) {
					stream.push({ type: "message_start", message: { ...finalMessage } });
				}
				stream.push({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
		}
	}

	return await response.result();
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
	tools: AgentTool<any>[] | undefined,
	assistantMessage: AssistantMessage,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	getSteeringMessages?: AgentLoopConfig["getSteeringMessages"],
): Promise<{ toolResults: ToolResultMessage[]; steeringMessages?: AgentMessage[] }> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	const results: ToolResultMessage[] = [];
	let steeringMessages: AgentMessage[] | undefined;

	for (let index = 0; index < toolCalls.length; index++) {
		const toolCall = toolCalls[index];
		const tool = tools?.find((t) => t.name === toolCall.name);

		stream.push({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		let result: AgentToolResult<any>;
		let isError = false;

		try {
			if (!tool) throw new Error(`Tool ${toolCall.name} not found`);

			const validatedArgs = validateToolArguments(tool, toolCall);

			result = await tool.execute(toolCall.id, validatedArgs, signal, (partialResult) => {
				stream.push({
					type: "tool_execution_update",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					args: toolCall.arguments,
					partialResult,
				});
			});
		} catch (e) {
			result = {
				content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
				details: {},
			};
			isError = true;
		}

		stream.push({
			type: "tool_execution_end",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			result,
			isError,
		});

		const toolResultMessage: ToolResultMessage = {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: result.content,
			details: result.details,
			isError,
			timestamp: Date.now(),
		};

		results.push(toolResultMessage);
		stream.push({ type: "message_start", message: toolResultMessage });
		stream.push({ type: "message_end", message: toolResultMessage });

		// Check for steering messages - skip remaining tools if user interrupted
		if (getSteeringMessages) {
			const steering = await getSteeringMessages();
			if (steering.length > 0) {
				steeringMessages = steering;
				const remainingCalls = toolCalls.slice(index + 1);
				for (const skipped of remainingCalls) {
					results.push(skipToolCall(skipped, stream));
				}
				break;
			}
		}
	}

	return { toolResults: results, steeringMessages };
}

function skipToolCall(
	toolCall: Extract<AssistantMessage["content"][number], { type: "toolCall" }>,
	stream: EventStream<AgentEvent, AgentMessage[]>,
): ToolResultMessage {
	const result: AgentToolResult<any> = {
		content: [{ type: "text", text: "Skipped due to queued user message." }],
		details: {},
	};

	stream.push({
		type: "tool_execution_start",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		args: toolCall.arguments,
	});
	stream.push({
		type: "tool_execution_end",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		result,
		isError: true,
	});

	const toolResultMessage: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: result.content,
		details: {},
		isError: true,
		timestamp: Date.now(),
	};

	stream.push({ type: "message_start", message: toolResultMessage });
	stream.push({ type: "message_end", message: toolResultMessage });

	return toolResultMessage;
}
