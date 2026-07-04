/**
 * Reviewer — YOLO 模式下审查模型输出并给出判决
 *
 * 在 agent loop 自然终止处调用，检查模型最后一轮回复是否符合用户需求。
 * 区分四种状态：completed / stalled / deflecting / asking_user。
 * 只有 asking_user 时等待用户输入，其余情况自动让模型继续。
 */

import type { ModelProvider } from './model-provider.js';
import type { Message, ReviewVerdict } from '../types/index.js';

/** 审查系统提示词 */
const REVIEW_SYSTEM_PROMPT = `You are a conversation quality reviewer. Your job is to classify the assistant's latest response based on the conversation context.

Analyze the user's recent inputs and the assistant's latest response, then classify into EXACTLY ONE category:

1. **completed** — The assistant has fully addressed the user's request, provided a complete answer, finished all necessary actions, or clearly explained the result. The response is coherent and complete.

2. **stalled** — The assistant's response appears incomplete, cut off mid-sentence, or stopped without finishing the task. The output feels like it was interrupted mid-way.

3. **deflecting** — The assistant refused to execute commands or take action that it has the ability to perform. Examples: "I can't execute commands", "you need to run this yourself", "please execute this in your terminal", "you can do this by running...". The assistant is pushing responsibility back to the user when it should have used its own tools (shell, file operations, etc.).

4. **asking_user** — The assistant is genuinely asking the user a question or requesting input that it needs to proceed. The question requires the user's knowledge, preference, or decision. Examples: "What name would you like to use?", "Which approach do you prefer?", "Can you clarify what you mean by...".

Key distinction between deflecting and asking_user:
- "I cannot run commands, you need to execute this in your terminal" → **deflecting**
- "I've prepared the script. Where would you like me to save it?" → **asking_user** (needs user decision)
- "Here's what to do: run ./script.sh" → **deflecting** (should have run it)
- "Do you want approach A or B?" → **asking_user**
- "Let me know if you want me to proceed" → **deflecting** (should just proceed in YOLO mode)

Respond with ONLY a valid JSON object, no markdown, no code fences, no explanation:
{"verdict": "completed", "reason": "Brief explanation of why"}`;

/** 审查最大上下文：最近用户输入条数 */
const MAX_USER_INPUTS = 5;

/**
 * 调用审查模型，对当前对话做出判决
 *
 * @param recentUserInputs  最近 N 条用户输入（含当前轮）
 * @param modelReply        模型本轮最终回复 content
 * @param provider          模型提供商
 * @param reviewModelName   审查用模型名（可选，默认用 provider 默认模型）
 * @returns                 判决结果
 */
export async function reviewConversation(
	recentUserInputs: string[],
	modelReply: string,
	provider: ModelProvider,
	reviewModelName?: string,
): Promise<{ verdict: ReviewVerdict; reason: string }> {
	// 拼接用户输入上下文
	const userContext = recentUserInputs
		.map((text, i) => `用户输入 ${i + 1}: ${text}`)
		.join('\n');

	const content = [
		'## Recent User Inputs',
		userContext,
		'',
		'## Latest Assistant Response',
		modelReply || '(empty response)',
	].join('\n');

	const messages: Message[] = [
		{ role: 'system', content: REVIEW_SYSTEM_PROMPT },
		{ role: 'user', content },
	];

	try {
		const response = await provider.chat(messages, {
			model: reviewModelName,
			temperature: 0.1,
			max_tokens: 200,
		});

		const reply = response.choices[0]?.message?.content ?? '';
		return parseVerdict(reply);
	} catch {
		// 审查失败时走安全路径：判 completed，不阻塞流程
		return { verdict: 'completed', reason: 'Review call failed, default to completed' };
	}
}

/** 从审查模型回复中解析 JSON 判决 */
function parseVerdict(text: string): { verdict: ReviewVerdict; reason: string } {
	// 尝试直接解析 JSON
	try {
		const parsed = JSON.parse(text);
		if (parsed.verdict && ['completed', 'stalled', 'deflecting', 'asking_user'].includes(parsed.verdict)) {
			return {
				verdict: parsed.verdict as ReviewVerdict,
				reason: parsed.reason ?? '',
			};
		}
	} catch {
		// JSON 解析失败，fallback 到文本匹配
	}

	// Fallback: 从文本中匹配关键词
	const lower = text.toLowerCase();
	if (lower.includes('"stalled"') || lower.includes("'stalled'") || (lower.includes('stalled') && !lower.includes('completed'))) {
		return { verdict: 'stalled', reason: 'Parsed from text fallback' };
	}
	if (lower.includes('"deflecting"') || lower.includes("'deflecting'") || (lower.includes('deflecting') && !lower.includes('completed'))) {
		return { verdict: 'deflecting', reason: 'Parsed from text fallback' };
	}
	if (lower.includes('"asking_user"') || lower.includes("'asking_user'") || (lower.includes('asking') && !lower.includes('completed'))) {
		return { verdict: 'asking_user', reason: 'Parsed from text fallback' };
	}
	return { verdict: 'completed', reason: 'Fallback: default to completed' };
}
