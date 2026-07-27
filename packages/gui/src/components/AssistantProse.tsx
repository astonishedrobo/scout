import { MarkdownRenderer } from "./MarkdownRenderer";

/**
 * The assistant's rendered prose scope.
 *
 * `prose-scout text-prose overflow-x-auto` was triplicated across
 * MessageBubble and ToolCard and nested a fourth time by ChatView, which meant
 * the code-block treatment and any copy affordance had no single home.
 */
export function AssistantProse({
  content,
  baseUrl,
  token,
  className = "",
}: {
  content: string;
  baseUrl?: string;
  token?: string | null;
  className?: string;
}) {
  return (
    <div className={`prose-scout overflow-x-auto text-prose ${className}`}>
      <MarkdownRenderer content={content} baseUrl={baseUrl} token={token} />
    </div>
  );
}
