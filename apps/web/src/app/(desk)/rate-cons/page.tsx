import React from "react";
import { RateConIntake } from "@/components/desk/rate-con-intake";
import { PageHead } from "@/components/desk/ui";

export default function RateConsPage() {
  return (
    <>
      <PageHead title="Rate confirmations" sub="A document in, a load out. You check what was read before anything is saved, and a rate confirmation never shows a verdict: it is for a load you already accepted." />
      <RateConIntake />
    </>
  );
}
