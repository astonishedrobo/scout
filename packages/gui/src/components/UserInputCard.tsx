import { useCallback, useEffect, useState } from "react";
import { CornerDownLeft, Pencil, X } from "lucide-react";
import type { UserInputRequest, UserInputQuestion } from "scout-core";

interface UserInputCardProps {
  request: UserInputRequest;
  onAnswer: (text: string) => void;
  onDismiss: () => void;
}

function answerText(question: UserInputQuestion, answer: string) {
  return `Q: ${question.question}\nA: ${answer}`;
}

export function UserInputCard({ request, onAnswer, onDismiss }: UserInputCardProps) {
  // Every question is asked, one at a time. This used to render
  // `questions[0]` only and silently drop the rest of the request.
  const questions = request.questions ?? [];
  const [index, setIndex] = useState(0);
  const [answered, setAnswered] = useState<string[]>([]);
  const [otherMode, setOtherMode] = useState(false);
  const [other, setOther] = useState("");
  // Answering is a one-way action; without this, double-clicking an option
  // submitted twice.
  const [submitting, setSubmitting] = useState(false);

  const question = questions[index];
  const options = question?.options ?? [];
  const total = questions.length;

  const submit = useCallback(
    (answer: string) => {
      if (!question || submitting) return;
      const collected = [...answered, answerText(question, answer)];
      if (index + 1 < total) {
        setAnswered(collected);
        setIndex(index + 1);
        setOtherMode(false);
        setOther("");
        return;
      }
      setSubmitting(true);
      onAnswer(collected.join("\n\n"));
    },
    [question, submitting, answered, index, total, onAnswer],
  );

  // The options are numbered 1..n, which promises a number-key shortcut. It was
  // never wired up.
  useEffect(() => {
    if (otherMode || options.length === 0 || submitting) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > options.length) return;
      e.preventDefault();
      submit(options[n - 1]!.label);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [otherMode, options, submitting, submit]);

  if (!question) return null;

  return (
    <div className="mx-auto w-full max-w-[46rem]">
      <div className="overflow-hidden rounded-card border border-scout-hairline bg-scout-panel/95 shadow-pop">
        <div className="flex items-start gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center gap-2">
              {question.header && question.header !== "Question" && (
                <span className="text-micro font-semibold uppercase tracking-[0.16em] text-scout-muted">
                  {question.header}
                </span>
              )}
              {total > 1 && (
                <span className="text-micro font-medium tabular-nums text-scout-muted/80">
                  {index + 1} of {total}
                </span>
              )}
            </div>
            <div className="text-prose leading-snug text-scout-text">{question.question}</div>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-btn p-2 text-scout-muted transition-colors hover:bg-scout-lift hover:text-scout-text"
            aria-label="Dismiss question"
          >
            <X size={15} />
          </button>
        </div>

        {options.length > 0 && (
          <div className="px-3 pb-2">
            {options.map((option, optionIndex) => (
              <button
                type="button"
                key={`${option.label}-${optionIndex}`}
                disabled={submitting}
                onClick={() => submit(option.label)}
                className="group flex w-full items-center gap-3 rounded-card border-t border-scout-hairline-faint px-2.5 py-2.5 text-left transition-colors first:border-t-0 hover:bg-scout-lift disabled:opacity-50"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-btn bg-scout-lift text-label font-medium text-scout-muted group-hover:text-scout-text">
                  {optionIndex + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-label text-scout-text">{option.label}</span>
                  {option.description && (
                    <span className="mt-0.5 block text-caption leading-snug text-scout-muted">
                      {option.description}
                    </span>
                  )}
                </span>
                <CornerDownLeft size={14} className="hover-reveal text-scout-muted" />
              </button>
            ))}
          </div>
        )}

        <div className="px-3 pb-3">
          {otherMode || options.length === 0 ? (
            <div className="flex gap-2 border-t border-scout-hairline-faint pt-3">
              <input
                autoFocus
                value={other}
                onChange={(e) => setOther(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && other.trim()) submit(other.trim());
                  if (e.key === "Escape" && options.length > 0) setOtherMode(false);
                }}
                placeholder="Reply directly..."
                aria-label="Your answer"
                className="flex-1 rounded-btn border border-scout-hairline-faint bg-scout-lift px-3 py-2 text-label text-scout-text placeholder:text-scout-muted focus:outline-none focus:ring-2 focus:ring-scout-text/15"
              />
              <button
                type="button"
                disabled={!other.trim() || submitting}
                onClick={() => other.trim() && submit(other.trim())}
                className="rounded-btn bg-scout-text px-3 py-2 text-label font-semibold text-scout-bg disabled:cursor-not-allowed disabled:opacity-40"
              >
                {index + 1 < total ? "Next" : "Send"}
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2 border-t border-scout-hairline-faint pt-2">
              <button
                type="button"
                onClick={() => setOtherMode(true)}
                className="flex flex-1 items-center gap-3 rounded-card px-2.5 py-2 text-left transition-colors hover:bg-scout-lift"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-btn bg-scout-lift text-scout-muted">
                  <Pencil size={14} />
                </span>
                <span className="text-label text-scout-muted">Something else</span>
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={() => submit("Skip")}
                className="rounded-btn bg-scout-lift px-3 py-2 text-label font-semibold text-scout-text transition-colors hover:bg-scout-lift/80 disabled:opacity-50"
              >
                Skip
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
