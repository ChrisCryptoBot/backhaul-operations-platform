"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { chasedAction } from "@/app/(desk)/actions";
import { tried } from "./kit/tried";

/**
 * Chase a customer about a late invoice: an email already written (with the balance, the due date and what the accounts team will ask for), or a call. The desk sends nothing: the link opens
 * the person's own mail or phone, and the click is remembered on the invoice ("last chased") so the next person does not chase the same customer the same morning.
 */
export function ChaseActions({
  loadId,
  email,
  phone,
  subject,
  body,
  lastChased,
  canChase = true
}: {
  loadId: string;
  email: string | null;
  phone: string | null;
  subject: string;
  body: string;
  lastChased: string | null;
  canChase?: boolean;
}) {
  const router = useRouter();
  const note = (how: "email" | "phone") => {
    if (!canChase) return;
    void tried(() => chasedAction(loadId, how)).then((got) => {
      if (got.ok && got.value.ok) router.refresh();
    });
  };
  if (!email && !phone) return lastChased ? <span className="sub">Last chased {lastChased}</span> : null;
  return (
    <span className="sub" style={{ display: "inline-flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      {email ? (
        <a className="t-btn sm" href={`mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`} onClick={() => note("email")}>
          Email
        </a>
      ) : null}
      {phone ? (
        <a className="t-btn sm" href={`tel:${phone.replace(/[^\d+]/g, "")}`} onClick={() => note("phone")}>
          Call
        </a>
      ) : null}
      {lastChased ? <span>· last chased {lastChased}</span> : null}
    </span>
  );
}
