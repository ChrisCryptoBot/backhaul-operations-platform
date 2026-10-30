import { Splash } from "@/components/desk/splash";

/** The desk's front door: the launch intro, then the loads board. (Sign-in slots in here when it exists: the intro hands on to wherever the visitor belongs.) */
export default function Home() {
  return <Splash next="/loads" />;
}
