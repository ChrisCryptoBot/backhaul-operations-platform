"use server";

import { redirect } from "next/navigation";
import { kindFor, parseTrucks, readRequest, type RequestErrors, type RequestValues } from "@/lib/signup";
import { saveSignupRequest } from "@/server/tl/signup";

export type RequestState = { values: RequestValues; errors: RequestErrors; error?: string };

/** Step one of signing up: how many trucks. Under the line goes on to make an account; at or over it goes to a person. */
export async function trucksStepAction(formData: FormData): Promise<void> {
  const raw = formData.get("trucks");
  const trucks = parseTrucks(typeof raw === "string" ? raw : "");
  if (trucks == null) redirect("/sign-up?error=trucks");
  redirect(kindFor(trucks) === "enterprise" ? `/enterprise?trucks=${trucks}` : `/sign-up?trucks=${trucks}`);
}

/** Save a request for an account (self-serve) or for a person to set one up (enterprise), and go to the page that says what happens next. */
export async function submitRequestAction(_prev: RequestState, formData: FormData): Promise<RequestState> {
  const values = readRequest(formData);
  let out;
  try {
    out = await saveSignupRequest(values);
  } catch {
    return { values, errors: {}, error: "We could not save that just now. Try again in a moment." };
  }
  if (!out.ok) return { values, errors: out.errors };
  redirect(out.kind === "enterprise" ? `/enterprise/thanks?ref=${out.id}` : `/sign-up/thanks?ref=${out.id}`);
}
