/** Said when a server call never came back. It may or may not have reached the desk, so this does not claim that nothing changed. */
export const UNREACHABLE = "That did not go through. Check the connection and try again.";

/** A browser's own words for a request that never got an answer: Chrome and Edge, Safari, Firefox. */
export const isLostConnection = (reason: unknown): boolean => reason instanceof TypeError && /failed to fetch|load failed|networkerror/i.test(reason.message);
