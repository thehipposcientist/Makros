/**
 * Strip markdown artifacts from AI-generated plain-text fields so they
 * render cleanly inside a single React Native <Text> component.
 *
 * The backend prompts ask for plain prose, but models occasionally leak:
 *   - **bold** / __italic__ / `code`
 *   - leading "- " / "* " / "• " / "1. " bullets
 *   - #/## headings
 *   - literal "\n" escape sequences
 *   - multiple consecutive blank lines
 *
 * This util is intentionally conservative: it only strips syntax, never
 * content. Safe to call on any string; empty/undefined input returns "".
 */
export function cleanAiText(raw: string | null | undefined): string {
  if (!raw) return '';
  let s = String(raw);

  // Literal escape artifacts from over-escaped JSON
  s = s.replace(/\\n/g, '\n').replace(/\\t/g, ' ');

  // Strip heading markers at line start (# / ## / ### ...)
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');

  // Strip leading bullet markers: "- ", "* ", "• ", "– "
  s = s.replace(/^\s*[-*•–]\s+/gm, '');

  // Strip leading numbered-list markers: "1.  ", "2) "
  s = s.replace(/^\s*\d+[.)]\s+/gm, '');

  // Remove **bold** and __bold__ wrappers (keep inner text)
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/__([^_]+)__/g, '$1');

  // Remove single *italic* and _italic_ wrappers
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2');
  s = s.replace(/(^|[^_])_([^_\n]+)_/g, '$1$2');

  // Strip `inline code` backticks
  s = s.replace(/`([^`]+)`/g, '$1');

  // Collapse 3+ newlines to a single blank line
  s = s.replace(/\n{3,}/g, '\n\n');

  // Trim whitespace
  return s.trim();
}
