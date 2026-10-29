/**
 * The life of a load as eight steps, read from timestamps the rows already carry:
 * Drafted, Assigned, Sent, Answered, On the road, Delivered, Invoiced, Paid. Pure.
 * Exactly one step is "current" (the next thing waiting to happen); a declined answer is a "problem" and nothing after it is current.
 */
export type StepState = "done" | "current" | "pending" | "problem";
export type TimelineStep = { key: string; label: string; state: StepState; at: Date | null; note?: string };

export type TimelineLoad = {
  status: string;
  createdAt: Date;
  completedAt: Date | null;
  invoicedAt: Date | null;
  paidAt: Date | null;
  paymentStatus: string | null;
  /** The earliest `arrivedAt` among the load's stops, if the phone has reported one. */
  firstArrivedAt: Date | null;
  assignment: null | { status: string; createdAt: Date; dispatchedAt: Date | null; respondedAt: Date | null };
};

export function deriveTimeline(l: TimelineLoad): TimelineStep[] {
  const a = l.assignment;
  const answered = !!a && ["accepted", "in_progress", "completed"].includes(a.status);
  const declined = a?.status === "declined";
  const started = l.status === "in_progress" || l.status === "completed";
  const delivered = l.status === "completed";
  const invoiced = l.paymentStatus === "invoiced" || l.paymentStatus === "paid";
  const paid = l.paymentStatus === "paid";

  const base: Array<{ key: string; label: string; done: boolean; at: Date | null; note?: string }> = [
    { key: "drafted", label: "Drafted", done: true, at: l.createdAt },
    { key: "assigned", label: "Assigned", done: !!a, at: a?.createdAt ?? null },
    { key: "sent", label: "Sent to driver", done: !!a && a.status !== "draft", at: a?.dispatchedAt ?? null },
    { key: "answered", label: declined ? "Driver declined" : "Driver answered", done: answered, at: a?.respondedAt ?? null },
    { key: "road", label: "On the road", done: started, at: l.firstArrivedAt },
    { key: "delivered", label: "Delivered", done: delivered, at: l.completedAt },
    { key: "invoiced", label: "Invoiced", done: invoiced, at: l.invoicedAt },
    { key: "paid", label: "Paid", done: paid, at: l.paidAt }
  ];

  let currentTaken = declined;
  return base.map((s) => {
    if (s.key === "answered" && declined) return { ...s, state: "problem" as const, note: "Assign another driver" };
    if (s.done) return { ...s, state: "done" as const };
    if (!currentTaken) {
      currentTaken = true;
      return { ...s, state: "current" as const };
    }
    return { ...s, state: "pending" as const };
  });
}
