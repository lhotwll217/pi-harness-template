"use client";

import { createContext, useContext, useEffect, useRef } from "react";
import type { GatewayEvent } from "@/lib/gateway-contracts";

/**
 * What the page's one `EventSource` hands its panes: a Gateway invalidation, or `resync` when
 * the page may have missed some (a reconnect, or the window regaining focus).
 */
export type PageEvent = GatewayEvent | { readonly kind: "resync" };

type Subscribe = (listener: (event: PageEvent) => void) => () => void;

export const GatewayEventsContext = createContext<Subscribe>(() => () => undefined);

/** Calls the newest `listener` for every page event, for as long as the caller is mounted. */
export function useGatewayEvents(listener: (event: PageEvent) => void): void {
  const subscribe = useContext(GatewayEventsContext);
  const latest = useRef(listener);
  useEffect(() => { latest.current = listener; }, [listener]);
  useEffect(() => subscribe((event) => latest.current(event)), [subscribe]);
}
