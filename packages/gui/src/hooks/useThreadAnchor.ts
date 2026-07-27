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
 * Two mechanisms:
 *
 *  1. On send, scroll the new user message so its top sits just under the top
 *     edge of the viewport.
 *  2. Reserve empty space below it, **once**. Step 1 is only possible if enough
 *     scrollable space exists beneath the anchor — otherwise you reach the bottom
 *     of the container before the anchor reaches the top. The reply then grows
 *     into that space, and because the reservation never changes, the anchor holds
 *     position through pure layout. No scrolling and no measuring per frame.
 *
 * The space is handed back the instant the reply has filled the viewport below the
 * anchor, which is provably seamless — see `reconcile`. Otherwise it is released on
 * the first upward scroll after the turn ends, which is why a finished short
 * exchange ends up sitting snugly above the composer instead of keeping a void.
 *
 * ## Why the reservation is written once and never resized down
 *
 * The first version of this recomputed the reservation on every streamed frame,
 * shrinking it by exactly the amount the content grew so the total height stayed
 * constant. That is a tempting invariant and it flickered badly.
 *
 * The reason is that sizing the reservation to *exactly* the shortfall puts the
 * anchored position at `scrollHeight - clientHeight` — the anchor sits precisely at
 * the maximum scroll offset, the most fragile place in the range. Growth then
 * arrived from two independent schedulers: React repainting taller content on its
 * own animation frame, and a `ResizeObserver` shrinking the spacer on another. The
 * order alternated frame to frame, and on every frame where the spacer shrank
 * first, maximum scroll briefly fell below `scrollTop`, the browser clamped it, and
 * the content lurched — recovering the next frame, then lurching again.
 *
 * Writing the reservation once removes the race outright. Content growth only ever
 * *raises* the maximum scroll offset, so it can never clamp, so there is nothing to
 * flicker. `reconcile` below is therefore monotone: it may grow the reservation
 * when the viewport changes under it, and it may drop it entirely, but it never
 * trims it to track the content.
 *
 * Rejected alternative, recorded because it looks identical at first: giving each
 * turn `min-height: 100dvh`. Same anchor effect with no measuring at all, but the
 * space becomes permanent layout, so every short exchange is padded forever.
 */

/**
 * How much of the conversation stays visible above the anchored message.
 *
 * Deliberately generous rather than a cosmetic gap. Leaving the tail of the
 * previous reply on screen is what makes the jump read as the thread moving up,
 * instead of the view being yanked somewhere unfamiliar — you can still see what
 * you were replying to. Clamping the message flush against the top edge is what
 * made the motion feel abrupt.
 *
 * Relative to the viewport, so a tall window shows more context and a short one is
 * not swallowed by it, clamped at both ends so it neither disappears nor eats the
 * screen.
 */
function headroomFor(viewport: number): number {
  return Math.max(56, Math.min(160, Math.round(viewport * 0.15)));
}

/**
 * How close to the end of the content counts as "at the end", in px.
 *
 * Shared with the thread's own scroll handler so the two cannot disagree about
 * whether the jump affordance should be showing.
 */
export const FOLLOW_THRESHOLD = 72;

/**
 * Where the anchored message starts and where the thread ends, both in the scroll
 * container's own coordinates.
 *
 * The anchor's offset uses layout offsets rather than `getBoundingClientRect`.
 * Every message wrapper carries `.animate-enter`, whose `fade-in-up` keyframes run
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
 * content element itself is never animated, so its rect is trustworthy.
 */
function geometry(scroll: HTMLElement, content: HTMLElement, anchor: HTMLElement) {
  const contentTop =
    content.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
  return {
    anchorTop: contentTop + (anchor.offsetTop - content.offsetTop),
    // `offsetHeight` includes `.thread-pad`'s bottom padding, which is real space
    // below the last message and must count as content.
    contentEnd: contentTop + content.offsetHeight,
  };
}

/** Reservation needed for `target` to be a valid scroll offset. */
function reservationFor(target: number, viewport: number, contentEnd: number): number {
  return target + viewport - contentEnd;
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
   * Whether auto-follow is suppressed for the current turn.
   *
   * A ref because the pin effect must read it synchronously without re-rendering
   * per streamed token — the same reason `followsLatestRef` is one.
   */
  anchoredRef: React.MutableRefObject<boolean>;
  /** Stop anchoring and resume following. For "caught up" and jump-to-latest. */
  endAnchor: () => void;
  /** Whether a given distance-to-content-end means the reader has caught up. */
  caughtUp: (distance: number) => boolean;
  /**
   * Reserved height in px right now, for scroll arithmetic. A getter rather than
   * state because nothing renders it — see the note on imperative sizing below.
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
  /**
   * Identifies the conversation. `null` disables anchoring entirely, for a
   * transcript that is read but never sent into.
   */
  sessionId: string | null;
  /**
   * The thread's existing stick-to-bottom flag. Anchoring has to suspend it —
   * otherwise the per-token `scrollTop = scrollHeight` immediately undoes the
   * anchor — and hand it back once the reply has filled the viewport.
   */
  followsLatestRef: React.MutableRefObject<boolean>;
  setFollowsLatest: (follows: boolean) => void;
}): ThreadAnchor {
  const reduceMotion = usePrefersReducedMotion();

  const contentElement = useRef<HTMLElement | null>(null);
  const anchorElement = useRef<HTMLElement | null>(null);
  const spacerElement = useRef<HTMLElement | null>(null);

  const [anchorIndex, setAnchorIndex] = useState<number | null>(null);

  // Mirrored onto refs so the callbacks below stay stable and still read current
  // values, rather than being re-created (and re-subscribed) every render.
  const anchorIndexRef = useRef<number | null>(null);
  const reserved = useRef(0);
  const loadingRef = useRef(isLoading);
  loadingRef.current = isLoading;

  /**
   * Auto-follow is suppressed for this turn.
   *
   * A separate lifetime from the reservation, and conflating the two was a real
   * bug. The reservation only needs to live until the reply is tall enough to
   * provide the scroll range on its own; this outlives it, until the reader catches
   * up to the bottom themselves. Ending it when the reservation ran out is what
   * made long replies start chasing the stream — the exact behaviour anchoring
   * exists to prevent.
   */
  const anchoredRef = useRef(false);

  /**
   * Set by real input, so a programmatic scroll cannot masquerade as the reader
   * acting. Load-bearing: the opening scroll to the anchor is smooth and therefore
   * emits scroll events, and at the anchored position the distance to the content
   * end is *negative* (the reservation lies below the content), so a bare
   * "near the bottom" test is trivially true and would end the anchor on the very
   * animation that establishes it.
   */
  const userDriven = useRef(false);

  /**
   * The scroll offset the anchor is held at.
   *
   * Deliberately used in place of the live `scrollTop` when reconciling. The
   * initial scroll is smooth, so during that animation `scrollTop` is somewhere
   * mid-flight; reconciling against it would size the reservation for a position
   * we are only passing through and could hand the space back before the anchor
   * ever arrived.
   */
  const targetTop = useRef(0);

  const frame = useRef<number | null>(null);
  const previousCount = useRef(messages.length);
  const previousSession = useRef(sessionId);

  /**
   * Write the reserved height straight to the DOM rather than through state.
   *
   * It must take effect *within* the layout pass that then scrolls to the anchor —
   * a `setState` would not reach the DOM until after, leaving the scroll target
   * still out of range and silently clamped.
   */
  const setReserved = useCallback((next: number) => {
    reserved.current = next;
    const element = spacerElement.current;
    if (element) element.style.height = `${next}px`;
  }, []);

  const clearAnchor = useCallback(() => {
    anchorIndexRef.current = null;
    anchorElement.current = null;
    anchoredRef.current = false;
    setReserved(0);
    setAnchorIndex(null);
  }, [setReserved]);

  /**
   * Stop anchoring and let the thread follow the stream again.
   *
   * Only ever the reader's decision — they scrolled to the end, or pressed jump to
   * latest. Never triggered by the reply simply getting long, which is the mistake
   * this replaced.
   */
  const endAnchor = useCallback(() => {
    clearAnchor();
    followsLatestRef.current = true;
    setFollowsLatest(true);
  }, [clearAnchor, followsLatestRef, setFollowsLatest]);

  /**
   * Keep the reservation valid, and keep the jump affordance honest.
   *
   * Monotone by design — see the flicker note at the top of this file for why it
   * must never trim to track content growth.
   *
   * When the reservation is no longer needed it is dropped and *nothing else
   * happens*: the view stays exactly where it is and the reply keeps growing below
   * the fold. Dropping it cannot move anything, because it only becomes unnecessary
   * once the content itself reaches the bottom of the viewport.
   */
  const reconcile = useCallback(() => {
    const scroll = scrollRef.current;
    const content = contentElement.current;
    const anchor = anchorElement.current;
    if (!scroll || !content || !anchor || anchorIndexRef.current === null) return;

    const viewport = scroll.clientHeight;
    if (viewport <= 0) return;

    const { contentEnd } = geometry(scroll, content, anchor);
    const required = reservationFor(targetTop.current, viewport, contentEnd);

    if (required <= 0) {
      // Surplus now, so drop it — this is what stops a long reply leaving an empty
      // band at the bottom. Anchoring continues.
      if (reserved.current !== 0) setReserved(0);
    } else if (required > reserved.current) {
      // Grow only. The viewport shrinking under us — the composer growing to
      // several lines — is the case that needs this.
      setReserved(Math.min(required, viewport));
    }

    // While anchored the content grows without any scroll event firing, so
    // `onScroll` alone would never notice the reply running off the bottom and the
    // jump affordance would stay hidden exactly when it is needed.
    setFollowsLatest(contentEnd - (scroll.scrollTop + viewport) < FOLLOW_THRESHOLD);
  }, [scrollRef, setReserved, setFollowsLatest]);

  const scheduleReconcile = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      reconcile();
    });
  }, [reconcile]);

  /**
   * Detect a send and set the anchor.
   *
   * A send is exactly: the list grew, and the last message is the user's. Retry
   * sets `isLoading` without appending a user message, so this distinguishes the
   * two and keeps retry out of scope by construction rather than by a flag.
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
    // Suppress auto-follow for the turn. Note this does *not* touch
    // `followsLatest`, which is now purely a description of where the viewport sits
    // and drives only the jump affordance — forcing it false here is what used to
    // show that button over a short reply that was entirely visible.
    anchoredRef.current = true;
    userDriven.current = false;
  }, [messages, sessionId, clearAnchor]);

  /**
   * Once the anchor element exists, reserve the space and scroll to it — in that
   * order, within one layout pass, so the target is reachable when we ask for it.
   *
   * This is the only place the reservation is sized from scratch.
   */
  useLayoutEffect(() => {
    if (anchorIndex === null) return;
    const scroll = scrollRef.current;
    const content = contentElement.current;
    const anchor = anchorElement.current;
    if (!scroll || !content || !anchor) return;

    const viewport = scroll.clientHeight;
    const { anchorTop, contentEnd } = geometry(scroll, content, anchor);
    // `Math.max(0, …)` matters for the first message in a conversation: there is
    // nothing above it to keep visible, so it simply sits at the natural top.
    const target = Math.max(0, anchorTop - headroomFor(viewport));
    targetTop.current = target;

    const required = reservationFor(target, viewport, contentEnd);
    setReserved(required > 0 ? Math.min(required, viewport) : 0);

    scroll.scrollTo({
      top: target,
      // Smooth is the point — it reads as the thread making room. A motion
      // preference means a hard cut, not a slow one.
      behavior: reduceMotion ? "auto" : "smooth",
    });

    // A message already taller than the viewport needs no reservation, but it is
    // still anchored: the reply grows below the fold and the view holds.
  }, [anchorIndex, scrollRef, setReserved, reduceMotion]);

  /**
   * Watch for height changes.
   *
   * During streaming this is almost always a no-op: content growth lowers the
   * required reservation and `reconcile` never trims, so nothing is written. It
   * earns its place on the cases that do matter — the composer growing to several
   * lines, the window resizing, a live density change, a `ToolCard` expanding —
   * and on spotting the moment the content has filled the viewport so the space can
   * be handed back.
   *
   * No feedback loop: the spacer is a *sibling* of the observed content, so
   * changing it alters the container's `scrollHeight` but neither observed box.
   */
  useEffect(() => {
    const scroll = scrollRef.current;
    const content = contentElement.current;
    if (!scroll || !content) return;

    const observer = new ResizeObserver(scheduleReconcile);
    observer.observe(scroll);
    observer.observe(content);
    return () => observer.disconnect();
  }, [scrollRef, scheduleReconcile, anchorIndex]);

  /**
   * Release the reservation on the first upward scroll after the turn ends.
   *
   * Driven by input intent rather than the `scroll` event, which cannot tell our
   * own programmatic scroll from a real one.
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
     * So release waits until the scroll position already fits without the
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
      userDriven.current = true;
      if (event.deltaY < 0) release();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      userDriven.current = true;
      if (event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home") release();
    };

    let touchY: number | null = null;
    const onTouchStart = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (event: TouchEvent) => {
      userDriven.current = true;
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
    },
    [],
  );

  const contentRef = useCallback((element: HTMLElement | null) => {
    contentElement.current = element;
  }, []);

  const spacerRef = useCallback((element: HTMLElement | null) => {
    spacerElement.current = element;
    // React never renders the height, so a re-mount would otherwise lose it.
    if (element) element.style.height = `${reserved.current}px`;
  }, []);

  const reservedHeight = useCallback(() => reserved.current, []);

  /**
   * Whether the reader has just caught up to the end of the content by their own
   * scrolling, which is the one condition that ends anchoring mid-turn.
   *
   * Gated on `userDriven` and on the reservation already being spent. Without the
   * latter, sitting near the content end while a reservation is still open — the
   * normal state during a short reply — would read as having caught up.
   */
  const caughtUp = useCallback(
    (distance: number) =>
      anchoredRef.current && userDriven.current && reserved.current === 0
      && distance < FOLLOW_THRESHOLD,
    [],
  );

  return {
    anchorIndex,
    anchorRef,
    contentRef,
    spacerRef,
    reservedHeight,
    anchoredRef,
    endAnchor,
    caughtUp,
  };
}
