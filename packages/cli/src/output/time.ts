/**
 * Format a past timestamp as a short relative string: "just now",
 * "5 min ago", "2 h ago", "3 d ago". Future timestamps fall back to the
 * raw ISO form so they stand out.
 */
export function relativeTime(isoOrDate: string | Date, now: Date = new Date()): string {
  const then = typeof isoOrDate === "string" ? new Date(isoOrDate) : isoOrDate;
  if (Number.isNaN(then.getTime())) return String(isoOrDate);
  const delta = Math.round((now.getTime() - then.getTime()) / 1000);
  if (delta < 0) return then.toISOString();
  if (delta < 30) return "just now";
  if (delta < 60) return `${delta} s ago`;
  const minutes = Math.round(delta / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  const months = Math.round(days / 30);
  if (months < 24) return `${months} mo ago`;
  const years = Math.round(months / 12);
  return `${years} y ago`;
}
