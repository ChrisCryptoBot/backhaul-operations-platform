"use client";

import React from "react";
import { BrandMark } from "@/components/desk/kit/brand-mark";
import "@/components/desk/public.css";

/** Something failed outside the desk's own screens (for example the shell could not read the database). */
export default function RootError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="pub-center">
      <BrandMark size={44} />
      <h1>The desk could not load</h1>
      <p>It could not read its data. Check that the database is running, then try again.</p>
      <button type="button" className="pub-btn" onClick={() => reset()}>
        Try again
      </button>
    </main>
  );
}
