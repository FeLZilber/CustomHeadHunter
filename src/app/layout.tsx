import type { Metadata } from "next";
import Link from "next/link";
import { NavLink } from "./_components/nav-link";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Job Hunter", template: "%s · Job Hunter" },
  robots: { index: false, follow: false },
};

// Every page here is private and per-request.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#content">
          Skip to content
        </a>
        <header className="site-header">
          <Link href="/" className="brand">
            Job Hunter
          </Link>
          <nav aria-label="Main">
            <NavLink href="/">Jobs</NavLink>
            <NavLink href="/near">Near misses</NavLink>
            <NavLink href="/saved">Saved</NavLink>
            <NavLink href="/applied">Applied</NavLink>
            <NavLink href="/dismissed">Dismissed</NavLink>
            <NavLink href="/filtered">Filtered out</NavLink>
            <NavLink href="/search">Search</NavLink>
            <NavLink href="/profile">Profile</NavLink>
            <NavLink href="/status">Status</NavLink>
          </nav>
          <Link href="/api/auth/signout" className="signout" prefetch={false}>
            Sign out
          </Link>
        </header>
        <main id="content">{children}</main>
      </body>
    </html>
  );
}
