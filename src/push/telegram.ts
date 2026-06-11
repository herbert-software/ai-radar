/**
 * grammY 真实发送器（telegram-push 9.3，design D6）。
 *
 * 把 grammY 的 `bot.api.sendMessage` 包装成 dispatcher 的 MessageSender 接口——
 * dispatcher 只依赖抽象，本模块是其唯一真实实现（单测/集成测注入 mock 不走这里，
 * 真实发送冒烟留给 11.1）。
 *
 * bot 实例可注入（便于复用单例 / 测试），缺省按 env.TELEGRAM_BOT_TOKEN 新建。
 * 目标 chat 取 env.TELEGRAM_CHAT_ID。
 */
import { Bot } from 'grammy';
import { env } from '../config/env.js';
import type { MessageSender } from './dispatcher.js';

/** grammY 发送依赖的最小能力面（便于注入/收窄）。 */
export interface BotApiLike {
  sendMessage(
    chatId: string | number,
    text: string,
    other?: { parse_mode?: 'MarkdownV2' },
  ): Promise<unknown>;
}

export interface TelegramSenderOptions {
  /** 注入已建好的 grammY bot 的 api（默认按 env.TELEGRAM_BOT_TOKEN 新建）。 */
  api?: BotApiLike;
  /** 目标 chat id（默认 env.TELEGRAM_CHAT_ID）。 */
  chatId?: string;
}

/**
 * 构造一个走 grammY 的 MessageSender。
 * 发送失败时让 grammY 的错误向上抛——dispatcher 据此把整批置 failed。
 */
export function createTelegramSender(
  options: TelegramSenderOptions = {},
): MessageSender {
  const api: BotApiLike =
    options.api ?? (new Bot(env.TELEGRAM_BOT_TOKEN).api as unknown as BotApiLike);
  const chatId = options.chatId ?? env.TELEGRAM_CHAT_ID;

  return {
    async send(text: string, parseMode: 'MarkdownV2'): Promise<void> {
      await api.sendMessage(chatId, text, { parse_mode: parseMode });
    },
  };
}
