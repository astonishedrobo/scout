import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Message } from "scout-core";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";

/**
 * Anchored turn scrolling: the message you just sent rises to the top of the
 * thread and stays there while the reply streams in beneath it.
 *
 * The default for a chat transcript is to stick to the bottom, and that is right
 * when messages are short and arrive from other people. It is wrong for a long
 * streamed reply: the line you are reading slides upward continuously while you
 * read it. Anchoring pins the start of the answer instead, so nothing under your
 * eyes moves.
 *
 * Two mechanisms, and the second is the one naive implementations miss:
 *
 *  1. On send, scroll the new user message so its top sits just under the top
 *     edge of the viewport.
 *  2. Reserve space below it. Step 1 is only *possible* if a viewport's worth of
 *     scrollable space exists beneath the anchor — otherwise you reach the bottom
 *     of the container before the anchor reaches the top. So a spacer is sized to
 *     exactly that shortfall, and as the reply grows the spacer shrinks by the
 *     same amount. That is what holds the anchor still: not repeated scrolling,
 *     but a total height that does not change. Once the reply outgrows the
 *     viewport the spacer is 0 and ordinary stick-to-bottom resumes.
 *
 * The reserved space is *transient*. It is released on the first upward scroll
 * after the turn ends, which is why a finished short exchange ends up sitting
 * snugly above the composer rather than keeping a permanent void.
 *
 * Rejected alternative, recorded because it looks identical at first: giving each
 * turn `min-height: 100dvh`. Same anchor effect with no measuring at all, but the
 * space becomes permanent layout, so every short exchange is padded forever.
 */

/**
 * How far below the viewport's top edge the anchored message sits.
 *
 * Relative rather than fixed: on a short window a constant 32px is a large
 * fraction of the screen, and on a tall one it is invisible. Clamped at both ends
 * so it never collapses to nothing or grows absurd.
 */
function topGapFor(viewport: number): number {
  return Math.max(12, Math.min(32, Math.round(viewport * 0.06)));
}

/**
 * Where the anchored message sits, and how much content follows it.
 *
 * Deliberately layout offsets rather than `getBoundingClientRect`. Every message
 * wrapper carries `.animate-enter`, whose `fade-in-up` keyframes run
 * `translateY(5px) → none`, so a rect read during the entrance is 5px out. A
 * transform does not change layout size, so no `ResizeObserver` would fire to
 * correct it and the error would be *permanent* rather than transient. `offsetTop`
 * ignores transforms.
 *
 * `anchor.offsetTop - content.offsetTop` is valid because the anchor is a direct
 * child of the content element and neither is positioned, so both resolve against
 * the same `offsetParent` and the difference is exactly the anchor's layout offset
 * within the thread.
 *
 * `contentTop` does use rects, because `content.offsetTop` resolves against an
 * ancestor *outside* the scroll container and so is not in scroll coordinates. The
 * content element is never animated, so its rect is trustworthy.
 */
function geometry(scroll: HTMLElement, content: HTMLElement, anchor: HTMLElement) {
  const anchorWithinContent = anchor.offsetTop - content.offsetTop;
  const contentTop =
    content.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
  return {
    /** The anchor's position in the scroll container's own coordinates. */
    anchorTop: contentTop + anchorWithinContent,
    /**
     * Everything from the anchor's top to the end of the thread. `offsetHeight`
     * includes `.thread-pad`'s bottom padding, which is real space below the last
     * message and must count.
     */
    tail: content.offsetHeight - anchorWithinContent,
  };
}

export interface ThreadAnchor {
  /** Index in `messages` of the anchored message, or null when not anchored. */
  anchorIndex: number | null;
  /** Attach to the message wrapper whose index is `anchorIndex`. */
  anchorRef: (element: HTMLElement | null) => void;
  /** Attach to the thread's flow container (the element that holds the messages). */
  contentRef: (element: HTMLElement | null) => void;
  /** Attach to the spacer element. Its height is written directly, not rendered. */
  spacerRef: (element: HTMLElement | null) => void;
  /**
   * Reserved height in px right now, for scroll arithmetic. A getter rather than
   * state because the value changes on every streamed frame and no render depends
   * on it — see the note on imperative sizing in the hook body.
   */
  reservedHeight: () => number;
}

export function useThreadAnchor({
  scrollRef,
  messages,
  isLoading,
  sessionId,
  followsLatestRef,
  setFollowsLatest,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  messages: Message[];
  isLoading: boolean;
  sessionId: string | null;
  /**
   * The thread's existing stick-to-bottom flag. Anchoring has to suspend it —
   * otherwise the per-token `scrollTop = scrollHeight` immediately undoes the
   * anchor — and hand it back once the reply outgrows the reserved space.
   */
  followsLatestRef: React.MutableRefObject<boolean>;
  setFollowsLatest: (follows: boolean) => void;
}): ThreadAnchor {
  const reduceMotion = usePrefersReducedMotion();

  const contentElement = useRef<HTMLElement | null>(null);
  const anchorElement = useRef<HTMLElement | null>(null);
  const spacerElement = useRef<HTMLElement | null>(null);

  const [anchorIndex, setAnchorIndex] = useState<number | null>(null);

  // Mirrored onto refs so `measure` can stay a stable callback and read current
  // values without being re-created (and re-subscribed) on every render.
  const anchorIndexRef = useRef<number | null>(null);
  const reserved = useRef(0);
  const loadingRef = useRef(isLoading);
  loadingRef.current = isLoading;

  const frame = useRef<number | null>(null);
  const previousCount = useRef(messages.length);
  const previousSession = useRef(sessionId);

  /**
   * Write the reserved height straight to the DOM rather than through state.
   *
   * Two reasons, both load-bearing. It must take effect *within* the layout pass
   * that then scrolls to the anchor — a `setState` would not reach the DOM until
   * after, leaving the scroll target still out of range and silently clamped. And
   * it changes on every streamed frame, which through state would re-render the
   * whole thread for a number nothing renders.
   */
  const setReserved = useCallback((next: number) => {
    reserved.current = next;
    const element = spacerElement.current;
    if (element) element.style.height = `${next}px`;
  }, []);

  const clearAnchor = useCallback(() => {
    anchorIndexRef.current = null;
    anchorElement.current = null;
    setReserved(0);
    setAnchorIndex(null);
  }, [setReserved]);

  /**
   * End anchoring and give following back to the normal stick-to-bottom.
   *
   * A one-way exit, taken once the reply is taller than the reserved space. It has
   * to end the anchor outright, not merely re-enable following: streamed content
   * also *shrinks* sometimes (a `response_reset` folds transient prose into a
   * thinking step), and a still-live anchor would re-open a void mid-reply and
   * then fight stick-to-bottom over it.
   */
  const handBackToBottom = useCallback(() => {
    clearAnchor();
    followsLatestRef.current = true;
    setFollowsLatest(true);
  }, [clearAnchor, followsLatestRef, setFollowsLatest]);

  /**
   * Size the spacer to the shortfall between what the anchor needs in order to
   * reach the top and what the content below it already provides.
   */
  const measure = useCallback(() => {
    const scroll = scrollRef.current;
    const content = contentElement.current;
    const anchor = anchorElement.current;
    if (!scroll || !content || !anchor || anchorIndexRef.current === null) return;

    const viewport = scroll.clientHeight;
    if (viewport <= 0) return;

    const { tail } = geometry(scroll, content, anchor);

    // Never reserve more than one screen: that is what keeps this honest on a
    // short viewport instead of opening a void taller than the window.
    const next = Math.max(0, Math.min(viewport - topGapFor(viewport) - tail, viewport));

    // Checked before the unchanged-value shortcut below, or a turn that needs no
    // reservation at all — a sent message already taller than the viewport — would
    // sit anchored at zero with stick-to-bottom suspended, and the reply would
    // stream by without ever following.
    if (next === 0) {
      handBackToBottom();
      return;
    }

    if (next === reserved.current) return;
    setReserved(next);
  }, [scrollRef, setReserved, handBackToBottom]);

  const scheduleMeasure = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      measure();
    });
  }, [measure]);

  /**
   * Detect a send and set the anchor.
   *
   * A send is exactly: the list grew, and the last message is the user's. Retry
   * sets `isLoading` without appending a user message, so this distinguishes the
   * two and keeps retry out of scope by construction rather than by a flag.
   *
   * `useLayoutEffect` because the spacer must exist before we scroll — the target
   * position is not reachable until the space below it does.
   */
  useLayoutEffect(() => {
    const grew = messages.length > previousCount.current;
    const shrank = messages.length < previousCount.current;
    const switched = sessionId !== previousSession.current;
    previousCount.current = messages.length;
    previousSession.current = sessionId;

    // A different conversation must never inherit the previous one's reservation,
    // and its history arriving is not a send. Handled here rather than in a passive
    // effect because layout effects run first: a conversation whose last message
    // happens to be the user's would otherwise anchor and scroll for a frame
    // before any later reset could undo it.
    if (switched) {
      clearAnchor();
      return;
    }

    // A transcript with no conversation identity is read-only; see `sessionId`.
    if (sessionId === null) return;

    // Fork, clear or a session's history loading in: any index we held is stale.
    if (shrank) {
      clearAnchor();
      return;
    }
    if (!grew) return;
    if (messages[messages.length - 1]?.role !== "user") return;

    const index = messages.length - 1;
    anchorIndexRef.current = index;
    setAnchorIndex(index);
    // Suspend stick-to-bottom for the duration of the anchor.
    followsLatestRef.current = false;
    setFollowsLatest(false);
  }, [messages, sessionId, clearAnchor, followsLatestRef, setFollowsLatest]);

  /**
   * Once the anchor element exists, reserve the space and scroll to it — in that
   * order, within one layout pass.
   */
  useLayoutEffect(() => {
    if (anchorIndex === null) return;
    const scroll = scrollRef.current;
    const content = contentElement.current;
    const anchor = anchorElement.current;
    if (!scroll || !content || !anchor) return;

    // Reserve first. `setReserved` writes the height straight to the DOM, so the
    // target below is genuinely reachable by the time we scroll to it.
    measure();

    const { anchorTop } = geometry(scroll, content, anchor);
    scroll.scrollTo({
      top: Math.max(0, anchorTop - topGapFor(scroll.clientHeight)),
      // Smooth is the point — it reads as the thread making room. But a motion
      // preference means a hard cut, not a slow one.
      behavior: reduceMotion ? "auto" : "smooth",
    });
  }, [anchorIndex, scrollRef, measure, reduceMotion]);

  /**
   * Re-measure on every height change, from one observer.
   *
   * This covers streaming growth, ToolCard expand/collapse, image and Markdown
   * reflow, window resize, live density changes (which alter heights, so they need
   * no special handling despite the `data-density` stamp bypassing React), and —
   * via the scroll container's own box — the composer growing to multiple lines
   * and shrinking the space the thread has.
   *
   * No feedback loop: the spacer is a *sibling* of the observed content, so
   * changing it alters the container's `scrollHeight` but not either observed
   * content box.
   */
  useEffect(() => {
    const scroll = scrollRef.current;
    const content = contentElement.current;
    if (!scroll || !content) return;

    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(scroll);
    observer.observe(content);
    return () => observer.disconnect();
  }, [scrollRef, scheduleMeasure, anchorIndex]);

  /**
   * Release the reserved space on the first upward scroll after the turn ends.
   *
   * Driven by input intent rather than the `scroll` event, which cannot tell our
   * own programmatic scroll from a real one. Releasing only on an *upward* move
   * is also what makes it jump-free: by then the space being removed is off-screen
   * below, so nothing visible shifts.
   */
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;

    /**
     * Give the space back, but only once doing so cannot move anything.
     *
     * Removing trailing space shortens the scrollable range, and if the current
     * `scrollTop` no longer fits, the browser clamps it and the content lurches.
     * That is not hypothetical: a 900px thread in a 600px viewport anchored at 700
     * sits at `scrollTop` 668, a position only the reservation makes reachable —
     * dropping it clamps to 300 and jumps the content nearly 370px.
     *
     * So release is conditional on the scroll position already fitting without the
     * reservation. Scrolling up reaches that point quickly, and until it does the
     * space simply stays, which is the behaviour we want anyway.
     */
    const release = () => {
      if (anchorIndexRef.current === null) return;
      if (loadingRef.current) return;
      const withoutReservation = scroll.scrollHeight - reserved.current - scroll.clientHeight;
      if (scroll.scrollTop > Math.max(0, withoutReservation)) return;
      clearAnchor();
    };

    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) release();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home") release();
    };

    let touchY: number | null = null;
    const onTouchStart = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY;
      if (touchY === null || y === undefined) return;
      // Dragging the finger down scrolls the content up.
      if (y - touchY > 8) release();
      touchY = y;
    };

    scroll.addEventListener("wheel", onWheel, { passive: true });
    scroll.addEventListener("keydown", onKeyDown);
    scroll.addEventListener("touchstart", onTouchStart, { passive: true });
    scroll.addEventListener("touchmove", onTouchMove, { passive: true });
    return () => {
      scroll.removeEventListener("wheel", onWheel);
      scroll.removeEventListener("keydown", onKeyDown);
      scroll.removeEventListener("touchstart", onTouchStart);
      scroll.removeEventListener("touchmove", onTouchMove);
    };
  }, [scrollRef, clearAnchor]);

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  const anchorRef = useCallback(
    (element: HTMLElement | null) => {
      anchorElement.current = element;
      if (element) scheduleMeasure();
    },
    [scheduleMeasure],
  );

  const contentRef = useCallback(
    (element: HTMLElement | null) => {
      contentElement.current = element;
      if (element) scheduleMeasure();
    },
    [scheduleMeasure],
  );

  const spacerRef = useCallback(
    (element: HTMLElement | null) => {
      spacerElement.current = element;
      // React never renders the height, so re-mounting the element would lose it.
      if (element) element.style.height = `${reserved.current}px`;
    },
    [],
  );

  const reservedHeight = useCallback(() => reserved.current, []);

  return { anchorIndex, anchorRef, contentRef, spacerRef, reservedHeight };
}
