import Link from "next/link";

// Public on purpose, and holds no data: this is where anyone but the owner lands.
export default function DeniedPage() {
  return (
    <>
      <h1>Access denied</h1>
      <p>This dashboard is private to its owner.</p>
      <p>
        <Link href="/api/auth/signout">Sign out</Link>
      </p>
    </>
  );
}
