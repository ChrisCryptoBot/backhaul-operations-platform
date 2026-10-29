import { redirect } from "next/navigation";

/** The desk's front door is the loads board. */
export default function Home() {
  redirect("/loads");
}
