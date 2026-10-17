"use client";

import { CheckIcon, ChevronDownIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import { toolName } from "@/lib/chat-tools";
import type { ToolCall } from "@/lib/tool-groups";

function StatusIcon({ status }: { readonly status: ToolCall["status"] }) {
  if (status === "running") return <Spinner className="size-3.5 shrink-0" />;
  if (status === "completed") return <CheckIcon className="size-3.5 shrink-0" />;
  return <XIcon className="size-3.5 shrink-0 text-destructive" />;
}

function Command({ text }: { readonly text: string }) {
  return <span className="min-w-0 truncate font-mono text-muted-foreground/70" title={text}>{text}</span>;
}

function GroupLabel({ calls }: { readonly calls: readonly ToolCall[] }) {
  const running = calls.findLast((call) => call.status === "running");
  if (running) {
    return (
      <>
        <Spinner className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">{`Running ${toolName(running.tool)}${running.summary ? ` · ${running.summary}` : ""}`}</span>
        {calls.length > 1 && <span className="shrink-0 tabular-nums text-muted-foreground/70">{calls.length}</span>}
      </>
    );
  }
  const failed = calls.filter((call) => call.status === "failed").length;
  return (
    <>
      {failed ? <XIcon className="size-3.5 shrink-0 text-destructive" /> : <CheckIcon className="size-3.5 shrink-0" />}
      <span className="min-w-0 truncate">
        Used {calls.length} {calls.length === 1 ? "tool" : "tools"}
        {failed > 0 && <span className="text-destructive"> · {failed} failed</span>}
      </span>
    </>
  );
}

export function ToolGroup({ calls }: { readonly calls: readonly ToolCall[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible className="group/tools my-2 text-xs text-muted-foreground" onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger className="-mx-1.5 flex max-w-full cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 font-medium hover:bg-muted/70">
        <GroupLabel calls={calls} />
        <ChevronDownIcon className="size-3.5 shrink-0 transition-transform group-data-[state=open]/tools:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="ml-1.5 mt-1 flex flex-col gap-1 border-l pl-3">
          {calls.map((call) => (
            <li className="min-w-0" data-tool-status={call.status} key={call.callId}>
              <div className="flex min-w-0 items-center gap-2">
                <StatusIcon status={call.status} />
                <span className="shrink-0 text-foreground/80">{toolName(call.tool)}</span>
                {call.summary && <Command text={call.summary} />}
                <span className="sr-only">{call.status}</span>
              </div>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}
