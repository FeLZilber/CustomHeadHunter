"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Marks the page the visitor is on, for sighted and screen reader users alike. */
export function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const current = href === "/" ? pathname === "/" || pathname.startsWith("/jobs/") : pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link href={href} aria-current={current ? "page" : undefined}>
      {children}
    </Link>
  );
}
