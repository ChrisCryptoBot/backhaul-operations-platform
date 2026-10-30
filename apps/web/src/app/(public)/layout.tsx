import Link from "next/link";
import React from "react";
import { BrandMark } from "@/components/desk/kit/brand-mark";
import "@/components/desk/public.css";

/** The screens before you are in the desk: sign in, sign up, ask for a person. No sidebar, no data; the brand and one column. */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="pub">
      <header className="pub-top">
        <Link href="/" className="pub-brand" aria-label="TrueLane Dispatch">
          <span className="tl-tile" aria-hidden="true">
            <BrandMark size={20} />
          </span>
          <span>
            <b>TrueLane</b>
            <small>Dispatch</small>
          </span>
        </Link>
        <nav aria-label="Account">
          <Link href="/sign-in">Sign in</Link>
          <Link href="/sign-up" className="pub-btn sm">
            Create an account
          </Link>
        </nav>
      </header>
      <main className="pub-main">{children}</main>
    </div>
  );
}
