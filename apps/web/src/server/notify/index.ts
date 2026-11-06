import { resend } from "./adapters/resend";
import { sandbox } from "./adapters/sandbox";
import { slack } from "./adapters/slack";
import { webhook } from "./adapters/webhook";
import type { Channel, ChannelName, Env } from "./types";

export type { Channel, ChannelName, Env, Fetch, SendResult } from "./types";

/** Every channel the desk knows, in the order they are tried. */
export const CHANNELS: readonly Channel[] = [sandbox, webhook, resend, slack];

/** The channels this server is set up for. None is the normal state of a desk nobody has connected yet: nothing leaves it. */
export const configuredChannels = (env: Env = process.env): Channel[] => CHANNELS.filter((c) => c.configured(env));

const WORDS: Record<ChannelName, string> = { sandbox: "the simulator (nothing leaves the desk)", webhook: "the webhook", resend: "email through Resend", slack: "Slack" };
export const channelWords = (names: readonly ChannelName[]): string[] => names.map((n) => WORDS[n]);
