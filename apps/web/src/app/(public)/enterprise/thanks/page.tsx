import React from "react";
import type { Metadata } from "next";
import { ContactCard } from "@/components/desk/public/contact-card";

export const metadata: Metadata = { title: "We have your request · TrueLane" };

export default function EnterpriseThanks() {
  return (
    <div className="pub-split">
      <section className="pub-card" aria-labelledby="et-h">
        <h1 id="et-h">We have your request</h1>
        <p>A person will contact you to set up your fleet. You do not need to do anything else.</p>
        <p>If it cannot wait, reach them directly.</p>
      </section>
      <ContactCard heading="Reach a person" />
    </div>
  );
}
