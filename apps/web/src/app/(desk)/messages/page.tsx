import Link from "next/link";
import React from "react";
import type { Metadata } from "next";
import { Composer, MarkRead } from "@/components/desk/messages/composer";
import { LiveMessages } from "@/components/desk/messages/live";
import { Attachments, MessageText } from "@/components/desk/messages/parts";
import { LiveSearch } from "@/components/desk/kit/search-box";
import { telHref } from "@/lib/contact";
import { EmptyState } from "@/components/desk/kit/states";
import { PageHead } from "@/components/desk/ui";
import { deliveryNote, groupByDay, snippet, stamp, timeLabel } from "@/lib/messages";
import { DESK_DELIVERY_LABEL, deskDelivery } from "@/lib/driver-messages";
import { getConversation, listThreads, startableDrivers } from "@/server/tl/messages";
import { CanGate } from "@/components/desk/kit/can-gate";
import { currentTerminal } from "@/server/tl/terminal";

export const metadata: Metadata = { title: "Messages · TrueLane" };

export default async function MessagesPage({ searchParams }: { searchParams?: { driver?: string; find?: string } }) {
  // Conversations and who to start one with are the drivers of the terminals in view; a driver outside what the person may see is not found, whatever the address says.
  const terminal = await currentTerminal();
  const find = (searchParams?.find ?? "").trim().slice(0, 60);
  const [threads, starters] = await Promise.all([listThreads(undefined, terminal), startableDrivers(undefined, terminal, find)]);
  const wanted = searchParams?.driver ?? threads[0]?.driverId ?? null;
  const convo = wanted ? await getConversation(wanted) : null;
  const unread = threads.find((t) => t.driverId === wanted)?.unread ?? 0;
  const now = new Date();
  const needle = find.toLowerCase();
  const listed = needle ? threads.filter((t) => t.driverName.toLowerCase().includes(needle)) : threads;

  return (
    <>
      <PageHead title="Messages" sub="Your conversations with drivers. A driver who connected the TrueLane app gets them on the phone; the desk keeps the record." />
      <LiveMessages />
      <div className="ms">
        <aside className="ms-list" aria-label="Conversations">
          {/* One box: it narrows the conversations, and offers the drivers who have none yet. */}
          <div className="ms-find">
            <LiveSearch path="/messages" name="find" q={find} keep={searchParams?.driver ? { driver: searchParams.driver } : {}} placeholder="Find or message a driver" label="Find a driver to message" />
          </div>
          {listed.length === 0 ? (
            <p className="ms-none">{find ? "No conversation with that driver." : "No conversations yet."}</p>
          ) : (
            <ul>
              {listed.map((t) => (
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
          {starters.length > 0 ? (
            <details className="ms-new" open={find !== "" || listed.length === 0 || undefined}>
              <summary>
                {find ? "Start one with" : "Start a conversation"} <em>{starters.length}</em>
              </summary>
              <ul>
                {starters.map((d) => (
                  <li key={d.id}>
                    <Link href={`/messages?driver=${d.id}`} className="ms-row">
                      {d.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
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
                              {m.direction === "out" && m.sentBy ? <span className="ms-by">{m.sentBy}</span> : null}
                              <time dateTime={m.sentAt.toISOString()}>{timeLabel(m.sentAt)}</time>
                              {m.direction === "out" ? <DeliveryState state={deskDelivery(m, convo.bridged)} /> : null}
                            </span>
                          </div>
                        )
                      )}
                    </div>
                  ))
                )}
              </div>
              {convo.bridged ? (
                <p className="ms-note">{deliveryNote(convo.bridged)}</p>
              ) : (
                <p className="ms-note t-stale" role="note">
                  Desk log only{convo.driver.phone ? <>: call or text <a href={telHref(convo.driver.phone)}>{convo.driver.phone}</a></> : null} <span>{deliveryNote(convo.bridged)}</span>
                </p>
              )}
              <CanGate caps={["dispatch", "bill"]} banner who="A dispatcher or the accounting office" what="these messages">
                <Composer driverId={convo.driver.id} driverName={convo.driver.name} loads={convo.loads} />
              </CanGate>
            </>
          )}
        </section>
      </div>
    </>
  );
}

/** Where a sent message stands: Sending (on its way to the phone link), Delivered, Read, or Saved on the desk for a driver without the app. Read carries the positive tone. */
function DeliveryState({ state }: { state: ReturnType<typeof deskDelivery> }) {
  return (
    <>
      {" · "}
      <span className={`ms-state ${state}`} data-state={state}>
        {DESK_DELIVERY_LABEL[state]}
      </span>
    </>
  );
}
