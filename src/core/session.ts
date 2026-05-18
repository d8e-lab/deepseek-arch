/**
 * SessionManager — 会话门面（Facade）
 *
 * 协调 ApiClient + Storage，封装对话生命周期：
 *   1. 创建/恢复会话
 *   2. 发送消息 → API 调用 → 自动持久化 turn JSON
 *   3. 构建请求消息队列（含历史轮次的 reasoning_content 以命中 kv-cache）
 *   4. 更新标题
 */

import { Storage } from './storage.js';
import { ApiClient } from './api.js';
import type {
  Message,
  Session,
  SessionMeta,
  TurnRecord,
  TokenUsage,
  ChatCompletionResponse,
  StreamChunk,
} from './types.js';

/** 流式事件（SessionManager → ChatUI 回调） */
export interface StreamEvent {
  type: 'reasoning_delta' | 'content_delta' | 'done' | 'error';
  /** 增量文本（reasoning_delta / content_delta） */
  text?: string;
  /** token 用量（done 事件） */
  usage?: TokenUsage;
  /** 错误信息（error 事件） */
  error?: string;
}

export class SessionManager {
  private storage: Storage;
  private client: ApiClient;
  private session: Session | null = null;
  private systemPrompt: Message | null = null;

  constructor(storage: Storage, client: ApiClient) {
    this.storage = storage;
    this.client = client;
  }

  /** 设置 system prompt（每次请求前插入消息队列首位） */
  setSystemPrompt(prompt: Message | null): void {
    this.systemPrompt = prompt;
  }

  // ─── 会话生命周期 ──────────────────────────────

  /** 创建新会话并持久化 meta.json */
  async startNewSession(title = ''): Promise<SessionMeta> {
    const meta = await this.storage.createSession(title);
    this.session = {
      meta,
      turns: [],
      systemPrompt: this.systemPrompt?.content,
    };
    return meta;
  }

  /** 恢复已有会话（从文件加载所有 turn） */
  async resumeSession(id: string): Promise<Session> {
    const session = await this.storage.getSession(id);
    if (!session) throw new Error(`会话不存在: ${id}`);
    this.session = session;
    return session;
  }

  /** 获取当前会话 */
  getSession(): Session | null {
    return this.session;
  }

  /** 获取当前会话 ID */
  getSessionId(): string | null {
    return this.session?.meta.id ?? null;
  }

  /** 更新会话标题 */
  async setTitle(title: string): Promise<void> {
    if (!this.session) return;
    await this.storage.updateSessionTitle(this.session.meta.id, title);
    this.session.meta.title = title;
    this.session.meta.updated_at = new Date().toISOString();
  }

  // ─── 消息收发 ─────────────────────────────────

  /**
   * 发送用户消息并返回本轮完整记录
   *
   * 自动构建消息队列（system prompt → 历史 turns → 当前消息），
   * 调用 API 后持久化 turn JSON 到文件系统。
   */
  async sendMessage(
    userContent: string,
  ): Promise<{ turn: TurnRecord; response: ChatCompletionResponse }> {
    if (!this.session) {
      throw new Error('未创建会话——请先调用 startNewSession() 或 resumeSession()');
    }

    // 构建完整消息队列
    const messages = this.buildMessages(userContent);

    // 调用 API
    const response = await this.client.chat(messages);

    const choice = response.choices[0];
    const assistantMsg = choice?.message;
    if (!assistantMsg) {
      throw new Error('模型返回空响应');
    }

    // 提取 usage（API 不保证一定有）
    const usage: TokenUsage = response.usage ?? {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    };

    // 费用暂为 0（Phase 7 TokenCalculator 实现后补全）
    const costRmb = 0;

    // 持久化 turn JSON
    const turn = await this.storage.saveTurn(
      this.session.meta.id,
      { role: 'user', content: userContent },
      {
        id: response.id,
        role: 'assistant',
        content: assistantMsg.content,
        reasoning_content: assistantMsg.reasoning_content,
      },
      usage,
      costRmb,
    );

    // 更新内存中的会话
    this.session.turns.push(turn);
    this.session.meta.turnCount = this.session.turns.length;
    this.session.meta.updated_at = turn.created_at;

    return { turn, response };
  }

  /**
   * 流式发送用户消息
   *
   * 通过 onEvent 回调推送增量内容，支持外部 AbortSignal 中断。
   * 流式完成后自动持久化 turn；中断时保存不完整轮次（interrupted=true）。
   *
   * @returns 完整的 TurnRecord（正常完成），或 null（中断/错误）
   */
  async sendMessageStream(
    userContent: string,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<TurnRecord | null> {
    if (!this.session) {
      throw new Error('未创建会话——请先调用 startNewSession() 或 resumeSession()');
    }

    const messages = this.buildMessages(userContent);

    let responseId = '';
    let modelName = '';
    let fullReasoning = '';
    let fullContent = '';
    let usage: TokenUsage | undefined;

    try {
      for await (const chunk of this.client.chatStream(messages, { signal })) {
        // 记录元信息（首个 chunk）
        if (!responseId) responseId = chunk.id;
        if (!modelName) modelName = chunk.model;

        const delta = chunk.choices[0]?.delta;
        if (delta?.reasoning_content) {
          fullReasoning += delta.reasoning_content;
          onEvent({ type: 'reasoning_delta', text: delta.reasoning_content });
        }
        if (delta?.content) {
          fullContent += delta.content;
          onEvent({ type: 'content_delta', text: delta.content });
        }

        // 最后一个 chunk 携带 usage
        if (chunk.usage) {
          usage = chunk.usage;
        }
      }

      // 流式完成
      const finalUsage = usage ?? {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      };

      onEvent({ type: 'done', usage: finalUsage });

      const costRmb = 0; // Phase 7

      const turn = await this.storage.saveTurn(
        this.session.meta.id,
        { role: 'user', content: userContent },
        {
          id: responseId || '',
          role: 'assistant',
          content: fullContent,
          reasoning_content: fullReasoning || undefined,
        },
        finalUsage,
        costRmb,
      );

      this.session.turns.push(turn);
      this.session.meta.turnCount = this.session.turns.length;
      this.session.meta.updated_at = turn.created_at;

      return turn;
    } catch (err: any) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      const msg = err?.message ?? String(err);

      if (isAbort && (fullReasoning || fullContent)) {
        // 中断：保存不完整轮次
        const partialUsage = usage ?? {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        };

        try {
          const turn = await this.storage.saveTurn(
            this.session.meta.id,
            { role: 'user', content: userContent },
            {
              id: responseId || '',
              role: 'assistant',
              content: fullContent || '[已中断]',
              reasoning_content: fullReasoning || undefined,
            },
            partialUsage,
            0,
            true, // interrupted
          );
          this.session.turns.push(turn);
          this.session.meta.turnCount = this.session.turns.length;
          this.session.meta.updated_at = turn.created_at;

          onEvent({ type: 'error', error: '已中断' });
          return turn;
        } catch {
          // 持久化失败，不阻塞
        }
      }

      onEvent({ type: 'error', error: msg });
      return null;
    }
  }

  /** 构建请求消息队列（含 reasoning_content 以命中 kv-cache，跳过 interrupted 轮次） */
  private buildMessages(currentContent: string): Message[] {
    const messages: Message[] = [];

    // 1. System prompt
    if (this.systemPrompt) {
      messages.push(this.systemPrompt);
    }

    // 2. 历史轮次（跳过中断的不完整轮次）
    for (const turn of this.session!.turns) {
      if (turn.interrupted) continue;
      messages.push(turn.user);
      messages.push({
        role: 'assistant',
        content: turn.assistant.content,
        reasoning_content: turn.assistant.reasoning_content,
      });
    }

    // 3. 当前用户消息
    messages.push({ role: 'user', content: currentContent });

    return messages;
  }
}
