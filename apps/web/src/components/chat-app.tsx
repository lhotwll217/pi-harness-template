"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { MessageSquareIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { useGatewayEvents, type PageEvent } from "@/components/gateway-events";
import { ToolGroup } from "@/components/tool-group";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Spinner } from "@/components/ui/spinner";
import { cancelChat, chatMessagesRoute, fetchChat } from "@/lib/chat-client";
import type { ChatBootstrap, HarnessUIMessage } from "@/lib/chat-types";
import type { ChatId } from "@/lib/gateway-contracts";
import { groupMessageParts } from "@/lib/tool-groups";
import { cn } from "@/lib/utils";

export const RUNNING_ELSEWHERE = "A reply is running in this chat.";

const TERMINAL_NOTE = {
  cancelled: "Reply stopped.",
  interrupted: "Reply interrupted by a restart.",
  failed: "Reply did not finish.",
} as const;

const sendNewestMessageOnly = ({ messages }: { messages: HarnessUIMessage[] }) => ({ body: { messages: messages.slice(-1) } });

export interface ChatAppProps {
  readonly chatId: ChatId;
  readonly title: string;
}

export function ChatApp({ chatId, title }: ChatAppProps) {
  const [booting, setBooting] = useState(true);
  const [inlineError, setInlineError] = useState<string>();
  const [foreignTurn, setForeignTurn] = useState<{ readonly turnId?: string }>();
  const turnRef = useRef<string | undefined>(undefined);

  const transport = useMemo(() => new DefaultChatTransport<HarnessUIMessage>({
    api: chatMessagesRoute(chatId),
    prepareSendMessagesRequest: sendNewestMessageOnly,
  }), [chatId]);

  const { messages, setMessages, sendMessage, status, stop, error: chatError, clearError } = useChat<HarnessUIMessage>({
    id: chatId,
    transport,
    onData(part) {
      if (part.type === "data-turn") turnRef.current = part.data.turnId;
    },
    onFinish() { turnRef.current = undefined; },
  });
  const transportBusy = status === "streaming" || status === "submitted";
  const streamingOwnReplyRef = useRef(false);
  useEffect(() => { streamingOwnReplyRef.current = transportBusy; }, [transportBusy]);

  const adopt = useCallback((bootstrap: ChatBootstrap) => {
    setMessages(bootstrap.messages);
    setForeignTurn(bootstrap.running ? { ...(bootstrap.turnId ? { turnId: bootstrap.turnId } : {}) } : undefined);
  }, [setMessages]);

  const load = useCallback(async (quiet = false): Promise<void> => {
    if (!quiet) {
      setBooting(true);
      setInlineError(undefined);
    }
    try {
      adopt(await fetchChat(chatId));
    } catch (error: unknown) {
      if (!quiet) setInlineError(error instanceof Error ? error.message : "Could not load chat.");
    } finally {
      if (!quiet) setBooting(false);
    }
  }, [adopt, chatId]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useGatewayEvents(useCallback((event: PageEvent) => {
    if (streamingOwnReplyRef.current) return;
    if (event.kind === "resync" || (event.kind === "chat.changed" && event.chatId === chatId)) void load(true);
  }, [chatId, load]));

  const submit = useCallback(({ text }: PromptInputMessage) => {
    if (!text.trim() || transportBusy || foreignTurn) return;
    setInlineError(undefined);
    clearError();
    // Not awaited: sendMessage settles when the reply ends, and PromptInput clears the draft
    // only after this returns.
    void sendMessage({ id: `message-${crypto.randomUUID()}`, role: "user", metadata: {}, parts: [{ type: "text", text }] });
  }, [clearError, foreignTurn, sendMessage, transportBusy]);

  const stopReply = useCallback(async () => {
    const turnId = transportBusy ? turnRef.current : foreignTurn?.turnId;
    setInlineError(undefined);
    try {
      await cancelChat(chatId, turnId);
    } catch (error: unknown) {
      if (transportBusy) await stop().catch(() => undefined);
      setInlineError(error instanceof Error ? error.message : "Could not stop the reply.");
      await load(true);
    }
  }, [chatId, foreignTurn, load, stop, transportBusy]);

  const busy = transportBusy || Boolean(foreignTurn);
  // While a reply runs the submit button is Stop, so PromptInput's Enter handler would submit the
  // form anyway; submit refuses the turn and PromptInput then clears the draft the owner typed.
  const holdEnterWhileBusy = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (busy && event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) event.preventDefault();
  }, [busy]);
  const shownError = inlineError ?? chatError?.message;
  const lastMessage = messages.at(-1);
  const toolRunning = lastMessage?.role === "assistant"
    && lastMessage.parts.some((part) => part.type === "data-tool" && part.data.status === "running");

  return (
    <main className="chat-shell flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b bg-background/85 backdrop-blur-xl">
        <div className="mx-auto flex h-12 w-full max-w-5xl items-center gap-3 px-4 sm:px-6">
          <MessageSquareIcon aria-hidden className="size-4 text-muted-foreground" />
          <h1 className="min-w-0 truncate font-heading text-sm font-semibold tracking-tight">{title}</h1>
        </div>
      </header>

      <section className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">
        {booting ? (
          <div aria-label="Loading conversation" className="flex-1 space-y-4 px-4 py-12 sm:px-6"><div className="h-4 w-32 animate-pulse rounded bg-muted" /><div className="h-20 animate-pulse rounded-2xl bg-muted/70" /></div>
        ) : messages.length === 0 ? (
          <Empty className="min-h-0 flex-1 rounded-none px-6">
            <EmptyHeader className="max-w-lg gap-3">
              <EmptyMedia><MessageSquareIcon className="size-7" /></EmptyMedia>
              <EmptyTitle className="text-3xl font-semibold sm:text-4xl">Start a conversation.</EmptyTitle>
              <EmptyDescription className="text-pretty leading-6">The agent works in your files folder. Anything it writes there appears in the sidebar.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="relative flex min-h-0 flex-1 flex-col" data-slot="chat-messages">
            <MessageScrollerProvider>
              <MessageScroller className="flex-1">
                <MessageScrollerViewport>
                  <MessageScrollerContent aria-busy={busy} className="mx-auto w-full max-w-3xl gap-7 px-4 py-8 sm:px-6">
                    {messages.map((message, index) => (
                      <MessageScrollerItem key={message.id} messageId={message.id} scrollAnchor={message.role === "user"}>
                        <Message from={message.role}>
                          <MessageContent className={cn(message.role === "assistant" && "w-full max-w-none text-[15px] leading-7")}>
                            {groupMessageParts(message.parts).map((group) => {
                              if (group.kind === "tools") return <ToolGroup calls={group.calls} key={group.id} />;
                              const { part, index: partIndex } = group;
                              const key = `${message.id}-${part.type}-${partIndex}`;
                              if (part.type === "text") {
                                return message.role === "assistant"
                                  ? <MessageResponse isAnimating={busy && index === messages.length - 1} key={key}>{part.text}</MessageResponse>
                                  : <p className="whitespace-pre-wrap" key={key}>{part.text}</p>;
                              }
                              if (part.type === "data-terminal" && part.data.status !== "completed") {
                                return <p className="mt-2 text-xs text-muted-foreground" key={key}>{TERMINAL_NOTE[part.data.status]}</p>;
                              }
                              return null;
                            })}
                          </MessageContent>
                        </Message>
                      </MessageScrollerItem>
                    ))}
                    {busy && !toolRunning && (
                      <MessageScrollerItem messageId="thinking">
                        <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground" role="status">
                          <Spinner className="size-3.5" />
                          <span>{foreignTurn ? RUNNING_ELSEWHERE : "Thinking…"}</span>
                        </div>
                      </MessageScrollerItem>
                    )}
                  </MessageScrollerContent>
                </MessageScrollerViewport>
                <MessageScrollerButton />
              </MessageScroller>
            </MessageScrollerProvider>
          </div>
        )}

        <div className="sticky bottom-0 z-10 bg-gradient-to-t from-background via-background to-transparent px-4 pb-4 pt-8 sm:px-6 sm:pb-6" data-slot="composer">
          {shownError && (
            <div className="mb-2 flex items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
              <span>{shownError}</span>
              <Button aria-label="Retry loading" onClick={() => void load()} size="icon-xs" variant="ghost"><RefreshCwIcon /></Button>
            </div>
          )}
          <PromptInput className="[&_[data-slot=input-group]]:rounded-3xl [&_[data-slot=input-group]]:bg-card [&_[data-slot=input-group]]:shadow-lg [&_[data-slot=input-group]]:shadow-black/5" onSubmit={submit}>
            <PromptInputBody>
              <PromptInputTextarea
                aria-label="Message the agent"
                disabled={booting || Boolean(foreignTurn)}
                onKeyDown={holdEnterWhileBusy}
                placeholder={foreignTurn ? RUNNING_ELSEWHERE : "Ask the agent…"}
              />
            </PromptInputBody>
            <PromptInputFooter>
              <PromptInputTools />
              <PromptInputSubmit disabled={booting} onStop={() => void stopReply()} status={foreignTurn ? "streaming" : status} />
            </PromptInputFooter>
          </PromptInput>
        </div>
      </section>
    </main>
  );
}
