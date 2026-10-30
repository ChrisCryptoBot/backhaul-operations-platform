/**
 * How a person reaches TrueLane. A real person answers: today that is the founder. `phone` stays null until a real number is supplied, and nothing on
 * the screens claims round-the-clock cover: when someone is on call, change `hours` and the pages say so.
 */
export const CONTACT = {
  email: "superior.one.logistics@gmail.com",
  /** A real number goes here when there is one. Never a placeholder: the screens show a phone line only when this is set. */
  phone: null as string | null,
  bookingUrl: "https://calendly.com/cm145571/new-meeting",
  /** When a person is reachable, in words; null means "no hours promised". */
  hours: null as string | null
} as const;

export const telHref = (phone: string) => `tel:${phone.replace(/[^\d+]/g, "")}`;
