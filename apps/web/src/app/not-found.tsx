import Link from "next/link";
import React from "react";
import { BrandMark } from "@/components/desk/kit/brand-mark";
import "@/components/desk/public.css";

/** A URL that matches no screen at all (the desk's own not-found handles a missing record inside the shell). */
export default function NotFound() {
  return (
    <main className="pub-center">
      <BrandMark size={44} />
      <h1>That page does not exist</h1>
      <p>The link may be old or mistyped.</p>
      <Link href="/loads" className="pub-btn">
        Back to the desk
      </Link>
    </main>
  );
}
