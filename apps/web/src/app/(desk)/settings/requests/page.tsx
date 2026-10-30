import Link from "next/link";
import React from "react";
import type { Metadata } from "next";
import { EmptyState } from "@/components/desk/kit/states";
import { PageHead } from "@/components/desk/ui";
import { listSignupRequests } from "@/server/tl/signup";

export const metadata: Metadata = { title: "Sign-up requests · TrueLane" };
export const dynamic = "force-dynamic";

const when = (d: Date) => d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });

/**
 * Who has asked for an account, newest first, enterprise requests marked. Read only: a person follows up (an enterprise request is set up by hand with
 * scripts/provision-enterprise.ts), and the list is where they find who to call.
 */
export default async function SignupRequestsPage() {
  const rows = await listSignupRequests();
  const enterprise = rows.filter((r) => r.kind === "enterprise" && r.status === "open").length;
  return (
    <>
      <PageHead title="Sign-up requests" sub={`${rows.length} in all${enterprise > 0 ? `, ${enterprise} large ${enterprise === 1 ? "fleet" : "fleets"} waiting for a person` : ""}.`}>
        <Link href="/settings" className="tl-btn">
          Settings
        </Link>
      </PageHead>
      {rows.length === 0 ? (
        <EmptyState icon="inbox" title="No requests yet">
          Requests from the sign-up and enterprise pages land here.
        </EmptyState>
      ) : (
        <div className="kc-tab-wrap">
          <table className="kc-tab">
            <thead>
              <tr>
                <th scope="col">Asked</th>
                <th scope="col">Who</th>
                <th scope="col">Company</th>
                <th scope="col" className="num">
                  Trucks
                </th>
                <th scope="col">Door</th>
                <th scope="col">Reach them</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <th scope="row">{when(r.createdAt)}</th>
                  <td>
                    {r.name}
                    {r.role ? ` · ${r.role}` : ""}
                  </td>
                  <td>{r.company}</td>
                  <td className="num">{r.trucks}</td>
                  <td>{r.kind === "enterprise" ? "Large fleet" : "Self-serve"}</td>
                  <td>
                    <a href={`mailto:${r.email}`}>{r.email}</a>
                    {r.phone ? ` · ${r.phone}` : ""}
                    {r.bestTime ? ` · ${r.bestTime}` : ""}
                  </td>
                  <td>{r.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
