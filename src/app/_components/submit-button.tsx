"use client";

import { useFormStatus } from "react-dom";

/**
 * A submit button that knows its form is in flight. The label never changes, so
 * the accessible name stays stable; the card dims through CSS (`.job:has(...)`)
 * and repeat clicks are blocked until the server answers.
 */
export function SubmitButton({ children, className = "button" }: { children: React.ReactNode; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending} aria-busy={pending || undefined}>
      {children}
    </button>
  );
}
