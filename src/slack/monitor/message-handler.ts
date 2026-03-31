import { hasControlCommand } from "../../auto-reply/command-detection.js";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "../../auto-reply/inbound-debounce.js";
import { logVerbose } from "../../globals.js";
import type { ResolvedSlackAccount } from "../accounts.js";
import type { SlackMessageEvent } from "../types.js";
import { stripSlackMentionsForCommandDetection } from "./commands.js";
import type { SlackMonitorContext } from "./context.js";
import { dispatchPreparedSlackMessage } from "./message-handler/dispatch.js";
import { prepareSlackMessage } from "./message-handler/prepare.js";
import { createSlackThreadTsResolver } from "./thread-resolution.js";

export type SlackMessageHandler = (
  message: SlackMessageEvent,
  opts: { source: "message" | "app_mention"; wasMentioned?: boolean },
) => Promise<void>;

export function createSlackMessageHandler(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  /** Called on each inbound event to update liveness tracking. */
  trackEvent?: () => void;
}): SlackMessageHandler {
  const { ctx, account, trackEvent } = params;
  const debounceMs = resolveInboundDebounceMs({ cfg: ctx.cfg, channel: "slack" });
  const threadTsResolver = createSlackThreadTsResolver({ client: ctx.app.client });

  /** Tracks muted threads. Key: "channel:threadTs". When muted, the bot ignores
   *  messages in that thread unless explicitly @mentioned. */
  const mutedThreads = new Set<string>();

  const debouncer = createInboundDebouncer<{
    message: SlackMessageEvent;
    opts: { source: "message" | "app_mention"; wasMentioned?: boolean };
  }>({
    debounceMs,
    buildKey: (entry) => {
      const senderId = entry.message.user ?? entry.message.bot_id;
      if (!senderId) {
        return null;
      }
      const messageTs = entry.message.ts ?? entry.message.event_ts;
      // If Slack flags a thread reply but omits thread_ts, isolate it from root debouncing.
      const threadKey = entry.message.thread_ts
        ? `${entry.message.channel}:${entry.message.thread_ts}`
        : entry.message.parent_user_id && messageTs
          ? `${entry.message.channel}:maybe-thread:${messageTs}`
          : entry.message.channel;
      return `slack:${ctx.accountId}:${threadKey}:${senderId}`;
    },
    shouldDebounce: (entry) => {
      const text = entry.message.text ?? "";
      if (!text.trim()) {
        return false;
      }
      if (entry.message.files && entry.message.files.length > 0) {
        return false;
      }
      const textForCommandDetection = stripSlackMentionsForCommandDetection(text);
      return !hasControlCommand(textForCommandDetection, ctx.cfg);
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      const combinedText =
        entries.length === 1
          ? (last.message.text ?? "")
          : entries
              .map((entry) => entry.message.text ?? "")
              .filter(Boolean)
              .join("\n");
      const combinedMentioned = entries.some((entry) => Boolean(entry.opts.wasMentioned));
      const syntheticMessage: SlackMessageEvent = {
        ...last.message,
        text: combinedText,
      };
      const prepared = await prepareSlackMessage({
        ctx,
        account,
        message: syntheticMessage,
        opts: {
          ...last.opts,
          wasMentioned: combinedMentioned || last.opts.wasMentioned,
        },
      });
      if (!prepared) {
        return;
      }
      if (entries.length > 1) {
        const ids = entries.map((entry) => entry.message.ts).filter(Boolean) as string[];
        if (ids.length > 0) {
          prepared.ctxPayload.MessageSids = ids;
          prepared.ctxPayload.MessageSidFirst = ids[0];
          prepared.ctxPayload.MessageSidLast = ids[ids.length - 1];
        }
      }
      await dispatchPreparedSlackMessage(prepared);
    },
    onError: (err) => {
      ctx.runtime.error?.(`slack inbound debounce flush failed: ${String(err)}`);
    },
  });

  return async (message, opts) => {
    if (opts.source === "message" && message.type !== "message") {
      return;
    }
    if (
      opts.source === "message" &&
      message.subtype &&
      message.subtype !== "file_share" &&
      message.subtype !== "bot_message"
    ) {
      return;
    }
    if (ctx.markMessageSeen(message.channel, message.ts)) {
      return;
    }
    trackEvent?.();
    // Skip messages that start with "aside" (case-insensitive, after stripping mentions).
    const strippedText = stripSlackMentionsForCommandDetection(message.text ?? "");
    if (/^aside\b/i.test(strippedText)) {
      return;
    }

    // Mute / unmute: thread-scoped commands that silence the bot unless @mentioned.
    const threadTs = message.thread_ts ?? message.ts;
    const muteKey = threadTs ? `${message.channel}:${threadTs}` : undefined;

    if (muteKey && /^mute\b/i.test(strippedText)) {
      mutedThreads.add(muteKey);
      logVerbose(`slack: muted thread ${muteKey}`);
      ctx.app.client.chat
        .postMessage({
          channel: message.channel,
          thread_ts: threadTs,
          text: "\ud83d\udd07 Muted. Tag me to resume, or say *unmute*.",
        })
        .catch((err) => {
          logVerbose(`slack: failed posting mute ack: ${String(err)}`);
        });
      return;
    }

    if (muteKey && /^unmute\b/i.test(strippedText)) {
      mutedThreads.delete(muteKey);
      logVerbose(`slack: unmuted thread ${muteKey}`);
      ctx.app.client.chat
        .postMessage({
          channel: message.channel,
          thread_ts: threadTs,
          text: "\ud83d\udd0a Unmuted.",
        })
        .catch((err) => {
          logVerbose(`slack: failed posting unmute ack: ${String(err)}`);
        });
      return;
    }

    // If thread is muted, only process messages where the bot was explicitly @mentioned.
    if (muteKey && mutedThreads.has(muteKey) && opts.source !== "app_mention" && !opts.wasMentioned) {
      return;
    }

    const resolvedMessage = await threadTsResolver.resolve({ message, source: opts.source });
    await debouncer.enqueue({ message: resolvedMessage, opts });
  };
}
