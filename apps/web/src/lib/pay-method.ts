/** How a payment came in. Kept on the load so the invoice and the books say it. Pure. */
export const PAID_METHODS: Array<{ key: string; label: string }> = [
  { key: "ach", label: "ACH" },
  { key: "check", label: "Check" },
  { key: "wire", label: "Wire" },
  { key: "card", label: "Card" },
  { key: "factoring", label: "Paid by the factor" },
  { key: "other", label: "Other" }
];

export const isPaidMethod = (key: string) => PAID_METHODS.some((m) => m.key === key);
export const paidMethodLabel = (key: string | null | undefined) => PAID_METHODS.find((m) => m.key === key)?.label ?? "";
