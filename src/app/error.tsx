"use client";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <>
      <h1>Something went wrong</h1>
      <p>The page could not load. The database may be waking up, so try again in a moment.</p>
      <button type="button" className="button" onClick={reset}>
        Try again
      </button>
    </>
  );
}
