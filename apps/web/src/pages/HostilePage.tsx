import { IconArrowUp, IconFlame, IconLock, IconPinFilled, IconShieldCheck } from "@tabler/icons-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { BlastRadiusCard } from "@airlock/contracts";
import { BlastRadiusView } from "../components/BlastRadius";
import { ErrorBox, Notice } from "../components/common";
import { PageHeader } from "../components/layout/page-header";
import { ComposerFrame } from "../components/thread/composer-frame";
import { Bubble, BubbleContent } from "../components/ui/bubble";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../components/ui/empty";
import { Message, MessageContent, MessageFooter, MessageHeader } from "../components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerViewport,
  useStickToBottom,
} from "../components/ui/message-scroller";
import { canOperate, useSession } from "../hooks/session";
import { describeError, runHostile } from "../lib/api";
import { formatTime } from "../lib/format";
import { hrefFor } from "../lib/router";

const COMMAND_MAX = 4096;
const HISTORY_MAX = 20;

const QUICK: { label: string; command: string }[] = [
  { label: "rm -rf / --no-preserve-root", command: "rm -rf / --no-preserve-root; echo exit=$?; ls / | head" },
  { label: "fork bomb", command: ":(){ :|:& };:" },
  {
    label: "curl metadata",
    command:
      "curl -sS -m 3 http://169.254.169.254/v1.json || python3 -c \"import urllib.request; print(urllib.request.urlopen('http://169.254.169.254/v1.json', timeout=3).read()[:200])\"",
  },
  {
    label: "curl example.com",
    command:
      "curl -sS -m 3 https://example.com || python3 -c \"import urllib.request; print(urllib.request.urlopen('https://example.com', timeout=3).read()[:200])\"",
  },
];

type Exchange =
  | { id: number; command: string; at: string; state: "running" }
  | { id: number; command: string; at: string; state: "done"; card: BlastRadiusCard }
  | { id: number; command: string; at: string; state: "error"; error: string };

function Reply({ exchange }: { exchange: Exchange }) {
  return (
    <Message align="start">
      <MessageContent className="gap-2">
        <MessageHeader className="gap-1.5 px-0">
          <span className="flex size-5 items-center justify-center rounded-full bg-foreground text-background">
            <IconShieldCheck className="size-3" />
          </span>
          <span className="text-foreground/80">Supervisor</span>
          <span className="font-normal">blast radius</span>
        </MessageHeader>
        {exchange.state === "running" ? (
          <span className="tool-line-running text-sm text-muted-foreground">Creating a disposable sandbox, running, tearing down…</span>
        ) : exchange.state === "error" ? (
          <ErrorBox message={exchange.error} />
        ) : (
          <div className="rounded-xl border border-border bg-card p-3 dark:border-transparent">
            <BlastRadiusView card={exchange.card} />
          </div>
        )}
      </MessageContent>
    </Message>
  );
}

export function HostilePage() {
  const session = useSession();
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<Exchange[]>([]);
  const nextId = useRef(1);
  const editor = useRef<HTMLTextAreaElement>(null);
  const scroller = useStickToBottom(history.map((h) => `${h.id}:${h.state}`).join(","));

  const allowed = canOperate(session.role);
  const trimmed = command.trim();

  useEffect(() => {
    const el = editor.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [command]);

  const run = async () => {
    if (trimmed.length === 0) {
      setError("Enter a command.");
      return;
    }
    if (command.length > COMMAND_MAX) {
      setError(`Commands are limited to ${COMMAND_MAX} characters.`);
      return;
    }
    const id = nextId.current++;
    const sent = command;
    const at = new Date().toISOString();
    setBusy(true);
    setError(null);
    setCommand("");
    setHistory((prev) => [...prev, { id, command: sent, at, state: "running" as const }].slice(-HISTORY_MAX));
    try {
      const card = await runHostile(sent);
      setHistory((prev) => prev.map((h) => (h.id === id ? { id, command: sent, at, state: "done" as const, card } : h)));
    } catch (err) {
      setHistory((prev) => prev.map((h) => (h.id === id ? { id, command: sent, at, state: "error" as const, error: describeError(err) } : h)));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (allowed && !busy && trimmed.length > 0) void run();
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader>
        <span className="flex size-[22px] items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <IconFlame className="size-3.5" />
        </span>
        <span className="truncate text-sm tracking-tight">Hostile input</span>
        <IconPinFilled className="size-3 shrink-0 text-muted-foreground/70" aria-label="Pinned" />
      </PageHeader>

      <div className="flex min-h-0 flex-1">
        <MessageScroller>
          <MessageScrollerViewport ref={scroller.viewportRef}>
            <MessageScrollerContent ref={scroller.contentRef} className="mx-auto w-full max-w-2xl px-4 py-6">
              {history.length === 0 ? (
                <Empty className="flex-none py-10">
                  <EmptyHeader>
                    <EmptyMedia variant="icon" className="size-10 rounded-xl bg-destructive/10 text-destructive">
                      <IconFlame className="size-5" />
                    </EmptyMedia>
                    <EmptyTitle className="text-base">Try to break out</EmptyTitle>
                    <EmptyDescription className="text-pretty">
                      Each command runs once in a disposable author-profile sandbox with the author caps, then the sandbox is destroyed.
                      The command is passed to the sandbox shell as data; nothing runs on the control host. The reply says what died and
                      what survived.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : null}
              {history.map((h) => (
                <MessageScrollerItem key={h.id} className="flex flex-col gap-6 animate-in fade-in-0 duration-300 motion-reduce:animate-none">
                  <Message align="end">
                    <MessageContent>
                      <Bubble align="end" variant="muted" className="max-w-[85%]">
                        <BubbleContent>
                          <span className="font-mono text-xs whitespace-pre-wrap break-all">{h.command}</span>
                        </BubbleContent>
                      </Bubble>
                      <MessageFooter>{formatTime(h.at)}</MessageFooter>
                    </MessageContent>
                  </Message>
                  <Reply exchange={h} />
                </MessageScrollerItem>
              ))}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton active={!scroller.atEnd} onClick={() => scroller.scrollToEnd("smooth")} />
        </MessageScroller>
      </div>

      <ComposerFrame
        above={
          <div className="mb-2 flex flex-col gap-2">
            {!allowed && !session.loading ? (
              <Notice className="flex items-center gap-2 text-xs">
                <IconLock className="size-4 shrink-0" />
                <span>
                  This panel is for judges and operators.{" "}
                  <a className="font-medium text-foreground underline underline-offset-4" href={hrefFor({ name: "login" })}>
                    Sign in
                  </a>{" "}
                  to use it.
                </span>
              </Notice>
            ) : null}
            {error ? <ErrorBox message={error} /> : null}
            <div className="flex flex-wrap gap-1.5">
              {QUICK.map((q) => (
                <Button
                  key={q.label}
                  type="button"
                  size="sm"
                  variant="outline"
                  className="rounded-full font-mono text-xs"
                  title={q.command}
                  onClick={() => {
                    setCommand(q.command);
                    editor.current?.focus();
                  }}
                  disabled={busy || !allowed}
                >
                  {q.label}
                </Button>
              ))}
            </div>
          </div>
        }
        footnote="Enter runs the command, Shift + Enter adds a line. Commands are untrusted input and run only inside the sandbox."
      >
        <div className="flex items-end gap-3">
          <textarea
            ref={editor}
            aria-label="Hostile command"
            className="max-h-[200px] min-h-6 min-w-0 flex-1 resize-none bg-transparent px-1 py-1 font-mono text-sm outline-none placeholder:font-sans placeholder:text-muted-foreground disabled:cursor-not-allowed"
            value={command}
            rows={1}
            maxLength={COMMAND_MAX}
            spellCheck={false}
            placeholder="A bash command to run inside the sandbox"
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={busy || !allowed}
          />
          <Button
            type="button"
            aria-label="Run in the sandbox"
            title="Run in the sandbox"
            className="size-8 shrink-0 rounded-full p-0"
            size="icon"
            onClick={() => void run()}
            disabled={busy || !allowed || trimmed.length === 0}
          >
            {busy ? <span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" /> : <IconArrowUp className="size-4" />}
          </Button>
        </div>
      </ComposerFrame>
    </div>
  );
}
