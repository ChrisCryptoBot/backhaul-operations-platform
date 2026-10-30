import React from "react";
import { CONTACT, telHref } from "@/lib/contact";

/**
 * How to reach a person. It says a person answers, and shows only the ways that are real: the email and the booking link always, a phone line only when
 * a real number is set in lib/contact.ts, and hours only when some are promised. It never claims round-the-clock cover on its own.
 */
export function ContactCard({ heading = "Talk to a person" }: { heading?: string }) {
  return (
    <aside className="pub-contact" aria-label={heading}>
      <h2>{heading}</h2>
      <p>A person answers, not a bot. Tell them about your fleet and they will set you up.</p>
      <ul>
        {CONTACT.phone ? (
          <li>
            <span>Call</span>
            <a href={telHref(CONTACT.phone)}>{CONTACT.phone}</a>
          </li>
        ) : null}
        <li>
          <span>Email</span>
          <a href={`mailto:${CONTACT.email}?subject=${encodeURIComponent("TrueLane Dispatch")}`}>{CONTACT.email}</a>
        </li>
        <li>
          <span>Book a time</span>
          <a href={CONTACT.bookingUrl} target="_blank" rel="noopener noreferrer">
            Pick a time that suits
          </a>
        </li>
      </ul>
      {CONTACT.hours ? <p className="pub-hours">{CONTACT.hours}</p> : null}
    </aside>
  );
}
