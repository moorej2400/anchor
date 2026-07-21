/**
 * Typed event subscriptions — the ONLY place `listen` may appear.
 * Contract: docs/SPEC.md §6.3.
 */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  EVENT,
  type AttentionCountPayload,
  type PtyOutputPayload,
  type Session,
  type SessionStatusPayload,
} from "./types";
import { mockListen } from "./mock";

const useMock = import.meta.env.VITE_IPC === "mock";

function sub<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  if (useMock) return mockListen<T>(event, handler);
  return listen<T>(event, (e) => handler(e.payload));
}

export const onPtyOutput = (h: (p: PtyOutputPayload) => void) =>
  sub<PtyOutputPayload>(EVENT.ptyOutput, h);

export const onSessionStatus = (h: (p: SessionStatusPayload) => void) =>
  sub<SessionStatusPayload>(EVENT.sessionStatus, h);

export const onSessionUpdated = (h: (p: Session) => void) =>
  sub<Session>(EVENT.sessionUpdated, h);

export const onAttentionCount = (h: (p: AttentionCountPayload) => void) =>
  sub<AttentionCountPayload>(EVENT.attentionCount, h);
