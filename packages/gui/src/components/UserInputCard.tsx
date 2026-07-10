import { useState } from "react";
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
  const question = request.questions[0];
  const [otherMode, setOtherMode] = useState(false);
  const [other, setOther] = useState("");

  if (!question) return null;
  const options = question.options ?? [];

  return (
    <div className="w-full max-w-[46rem] mx-auto">
      <div className="rounded-card bg-scout-panel/95 border border-scout-hairline shadow-card overflow-hidden">
        <div className="flex items-start gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            {question.header && question.header !== "Question" && (
              <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-scout-muted mb-1">
                {question.header}
              </div>
            )}
            <div className="text-[15px] leading-snug text-scout-text">
              {question.question}
            </div>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            className="p-1 rounded-lg text-scout-muted hover:text-scout-text hover:bg-scout-lift transition-colors"
            aria-label="Dismiss question"
          >
            <X size={15} />
          </button>
        </div>

        {options.length > 0 && (
          <div className="px-3 pb-2">
            {options.map((option, index) => (
              <button
                type="button"
                key={`${option.label}-${index}`}
                onClick={() => onAnswer(answerText(question, option.label))}
                className="group w-full flex items-center gap-3 px-2.5 py-2.5 rounded-xl text-left border-t border-scout-hairline-faint first:border-t-0 hover:bg-scout-lift transition-colors"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-scout-lift text-[13px] font-medium text-scout-muted group-hover:text-scout-text">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-scout-text">{option.label}</span>
                  {option.description && (
                    <span className="block text-xs text-scout-muted leading-snug mt-0.5">
                      {option.description}
                    </span>
                  )}
                </span>
                <CornerDownLeft size={14} className="text-scout-muted opacity-0 group-hover:opacity-100 transition-opacity" />
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
                  if (e.key === "Enter" && other.trim()) onAnswer(answerText(question, other.trim()));
                  if (e.key === "Escape" && options.length > 0) setOtherMode(false);
                }}
                placeholder="Reply directly..."
                className="flex-1 bg-scout-lift border border-scout-hairline-faint rounded-xl px-3 py-2 text-sm text-scout-text placeholder:text-scout-muted focus:outline-none focus:ring-2 focus:ring-scout-text/15"
              />
              <button
                type="button"
                disabled={!other.trim()}
                onClick={() => other.trim() && onAnswer(answerText(question, other.trim()))}
                className="px-3 py-2 rounded-xl text-sm font-semibold bg-scout-text text-scout-bg disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Send
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2 border-t border-scout-hairline-faint pt-2">
              <button
                type="button"
                onClick={() => setOtherMode(true)}
                className="flex flex-1 items-center gap-3 px-2.5 py-2 rounded-xl text-left hover:bg-scout-lift transition-colors"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-scout-lift text-scout-muted">
                  <Pencil size={14} />
                </span>
                <span className="text-sm text-scout-muted">Something else</span>
              </button>
              <button
                type="button"
                onClick={() => onAnswer(answerText(question, "Skip"))}
                className="px-3 py-1.5 rounded-lg text-sm font-semibold text-scout-text bg-scout-lift hover:bg-scout-lift/80 transition-colors"
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
