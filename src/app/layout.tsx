import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Job Hunter",
  robots: { index: false, follow: false },
};

// Every page here is private and per-request.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <Link href="/" className="brand">
            Job Hunter
          </Link>
          <nav aria-label="Main">
            <Link href="/">Jobs</Link>
            <Link href="/saved">Saved</Link>
            <Link href="/applied">Applied</Link>
            <Link href="/dismissed">Dismissed</Link>
            <Link href="/search">Search</Link>
            <Link href="/profile">Profile</Link>
            <Link href="/status">Status</Link>
            <Link href="/api/auth/signout">Sign out</Link>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
