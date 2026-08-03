// Linear presentation helpers, kept pure so the decisions a card makes can be
// unit-tested without a DOM. The vocabulary mirrors the backend's
// `linear::LinkMetadata` (src/linear.rs) and Linear's own UI.
//
// See components/linear-link-card.tsx for what draws from these.
//
// The rule these encode: read the *category*, never the label. A workspace renames
// its workflow states freely — "Pending Review", "En revue", "Ready to ship" are
// all `state_type: "started"` — so anything that colours or shapes a state must key
// off `state_type`, and show `state` only as text.

/** The one host whose links Linear enriches, mirroring `linear::WEB_HOST`
 *  (src/linear.rs). Linear is SaaS-only, so unlike the GitLab host this is fixed
 *  and needs no setting. The message list uses it to spot the links worth asking
 *  the backend about. */
export const LINEAR_WEB_HOST = "linear.app";

/** How a Linear state is drawn: which icon shape stands for it, and the fallback
 *  tint for a workspace that gave us no colour. */
export type StateShape = "backlog" | "unstarted" | "started" | "completed" | "canceled";

/** Linear's own state categories, mapped to the shape the card draws.
 *  `triage` has no shape of its own in Linear either — it borrows the backlog
 *  circle — and a project adds `planned` and `paused`. */
const STATE_SHAPES: Record<string, StateShape> = {
  backlog: "backlog",
  triage: "backlog",
  planned: "unstarted",
  unstarted: "unstarted",
  started: "started",
  paused: "started",
  completed: "completed",
  canceled: "canceled",
};

/** The shape to draw for a `state_type`, or null when Linear sent a category we do
 *  not know (a newer one, or none at all) — the card then shows the state as plain
 *  text rather than inventing a symbol for it. */
export function stateShape(stateType: string | null | undefined): StateShape | null {
  if (!stateType) return null;
  return STATE_SHAPES[stateType] ?? null;
}

/** A CSS colour from Linear's `state_color`, guarded.
 *
 *  The value goes into an inline `style`, and it arrives from a remote API, so it
 *  is only used when it is exactly a hex colour. Anything else — an unexpected
 *  format, or a string built to break out of the declaration — is dropped and the
 *  card falls back to its own palette. */
export function stateColor(color: string | null | undefined): string | undefined {
  if (!color) return undefined;
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(color.trim()) ? color.trim() : undefined;
}

/** The Linear priorities a card spends space on: Urgent (1) and High (2).
 *
 *  Not the whole scale (0 none, 3 medium, 4 low): Medium and Low are its middle and
 *  would put a badge on nearly every card, which is the same as putting one on
 *  none. Urgent is the one a reader must not miss. */
export type BadgedPriority = 1 | 2;

/** The badge level for a Linear priority, or null when it does not earn one. */
export function badgedPriority(priority: number | null | undefined): BadgedPriority | null {
  return priority === 1 || priority === 2 ? priority : null;
}

/** A project's completion as a whole percentage, or null when Linear sent no
 *  progress. Clamped to 0–100, so a float that rounds past either end (or a value
 *  outside the documented 0–1) cannot draw a bar past its track. */
export function progressPercent(progress: number | null | undefined): number | null {
  if (progress == null || !Number.isFinite(progress)) return null;
  return Math.min(100, Math.max(0, Math.round(progress * 100)));
}

/** Format Linear's plain "YYYY-MM-DD" date as a short day-and-month label in the
 *  reader's locale ("11 Sep", "Sep 11"), adding the year when it is not the current one — the
 *  same shape the calendar views use for a date chip.
 *
 *  Parsed into parts rather than handed to `new Date(string)`: a bare "YYYY-MM-DD"
 *  is read as UTC midnight, which renders as the PREVIOUS day for every reader west
 *  of Greenwich — a due date silently off by one. */
export function formatDueDate(date: string | null | undefined, today = new Date()): string | null {
  if (!date) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!match) return null;
  const [, year, month, day] = match;
  const local = new Date(Number(year), Number(month) - 1, Number(day));
  if (Number.isNaN(local.getTime())) return null;
  const label = local.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return Number(year) === today.getFullYear() ? label : `${label} ${year}`;
}
