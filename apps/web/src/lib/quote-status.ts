/**
 * A quote is a load that has been priced and saved but not booked: it has stops, an offer and a verdict, and nobody has agreed to it. It lives
 * in the loads table with this status so that booking it is a change of status, not a copy. Everything that lists, counts, searches or judges
 * loads leaves quotes out by spreading `notQuote` into its query, so a quote never shows on the board, in the dispatch queue, in an alert, on the
 * planner or in a KPI. The Quote page is the one place that lists them.
 */
export const QUOTE_STATUS = "quote";

/** The Prisma `where` fragment every general load query carries. */
export const notQuote = { status: { not: QUOTE_STATUS } } as const;

export const isQuote = (status: string | null | undefined) => status === QUOTE_STATUS;
