import Link from "next/link";
import React from "react";
import type { Metadata } from "next";
import { Composer, MarkRead } from "@/components/desk/messages/composer";
import { Attachments, MessageText } from "@/components/desk/messages/parts";
import { EmptyState } from "@/components/desk/kit/states";
import { PageHead } from "@/components/desk/ui";
import { SAVED_ONLY, SAVED_ONLY_NOTE, groupByDay, snippet, stamp, timeLabel } from "@/lib/messages";
import { getConversation, listThreads, startableDrivers } from "@/server/tl/messages";

export const metadata: Metadata = { title: "Messages · TrueLane" };

export default async function MessagesPage({ searchParams }: { searchParams?: { driver?: string } }) {
  const [threads, starters] = await Promise.all([listThreads(), startableDrivers()]);
  const wanted = searchParams?.driver ?? threads[0]?.driverId ?? null;
  const convo = wanted ? await getConversation(wanted) : null;
  const unread = threads.find((t) => t.driverId === wanted)?.unread ?? 0;
  const now = new Date();

  return (
    <>
      <PageHead title="Messages" sub="Your conversations with drivers. They are saved on the desk; nothing carries them to a driver's phone yet." />
      <div className="ms">
        <aside className="ms-list" aria-label="Conversations">
          {starters.length > 0 ? (
            <form action="/messages" className="ms-start">
              <label>
                <span>Start a conversation</span>
                <select name="driver" defaultValue="" required>
                  <option value="" disabled>
                    Choose a driver
                  </option>
                  {starters.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" className="tl-btn sm">
                Open
              </button>
            </form>
          ) : null}
          {threads.length === 0 ? (
            <p className="ms-none">No conversations yet.</p>
          ) : (
            <ul>
              {threads.map((t) => (
                <li key={t.driverId}>
                  <Link href={`/messages?driver=${t.driverId}`} aria-current={t.driverId === wanted ? "true" : undefined} className="ms-row">
                    <span className="ms-row-top">
                      <b>{t.driverName}</b>
                      <time dateTime={t.lastAt.toISOString()}>{stamp(t.lastAt, now)}</time>
                    </span>
                    <span className="ms-row-bottom">
                      <span className="ms-snip">
                        {t.lastDirection === "out" ? "You: " : ""}
                        {snippet(t.lastBody)}
                      </span>
                      {t.unread > 0 ? (
                        <span className="ms-unread" aria-label={`${t.unread} unread`}>
                          {t.unread}
                        </span>
                      ) : null}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section className="ms-pane" aria-label={convo ? `Conversation with ${convo.driver.name}` : "Conversation"}>
          {!convo ? (
            <EmptyState icon="message" title={threads.length === 0 ? "No conversations yet" : "That driver is not on this desk"}>
              {starters.length > 0 ? "Choose a driver on the left to start one." : "Add a driver first, then start a conversation here."}
            </EmptyState>
          ) : (
            <>
              <MarkRead driverId={convo.driver.id} unread={unread} />
              <header className="ms-head">
                <div>
                  <h2>{convo.driver.name}</h2>
                  <p>
                    {[convo.driver.truck, convo.driver.terminal, convo.driver.phone].filter(Boolean).join(" · ") || "No truck, terminal or phone on file"}
                  </p>
                </div>
                <Link href={`/drivers/${convo.driver.id}`} className="tl-btn sm">
                  Driver page
                </Link>
              </header>
              <div className="ms-log" role="log" aria-live="polite" tabIndex={0} aria-label="Messages">
                {convo.messages.length === 0 ? (
                  <p className="ms-none">No messages with {convo.driver.name} yet.</p>
                ) : (
                  groupByDay(convo.messages, now).map((g) => (
                    <div key={g.day} className="ms-day">
                      <div className="ms-daylabel">{g.day}</div>
                      {g.items.map((m) =>
                        m.direction === "system" ? (
                          <p key={m.id} className="ms-sys">
                            {m.body} <time dateTime={m.sentAt.toISOString()}>{timeLabel(m.sentAt)}</time>
                          </p>
                        ) : (
                          <div key={m.id} className={`ms-msg ${m.direction}`}>
                            <div className="ms-bubble">
                              {m.load ? (
                                <Link href={`/loads/${m.load.id}`} className="ms-load">
                                  {m.load.loadNumber ?? "Load"}
                                </Link>
                              ) : null}
                              <MessageText body={m.body} />
                              <Attachments items={m.attachments} />
                            </div>
                            <span className="ms-meta">
                              <time dateTime={m.sentAt.toISOString()}>{timeLabel(m.sentAt)}</time>
                              {m.direction === "out" ? <> · {m.deliveredAt ? "Delivered" : SAVED_ONLY}</> : null}
                            </span>
                          </div>
                        )
                      )}
                    </div>
                  ))
                )}
              </div>
              <p className="ms-note">{SAVED_ONLY_NOTE}</p>
              <Composer driverId={convo.driver.id} driverName={convo.driver.name} loads={convo.loads} />
            </>
          )}
        </section>
      </div>
    </>
  );
}
