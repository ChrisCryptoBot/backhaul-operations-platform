import { NextResponse } from "next/server";
import { z } from "zod";
import { processQueueEnvelope } from "@/server/queue-consumer";

const requestSchema = z.object({
  envelope: z.unknown()
});

export async function POST(request: Request) {
  try {
    const sharedSecret = process.env.WORKER_SHARED_SECRET;
    if (!sharedSecret) {
      // Never accept unauthenticated worker calls in production.
      if (process.env.NODE_ENV === "production") {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    } else {
      const provided = request.headers.get("x-worker-secret");
      if (provided !== sharedSecret) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }

    const parsed = requestSchema.parse(await request.json());
    await processQueueEnvelope(parsed.envelope);
    return NextResponse.json({ ok: true }, { status: 202 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid request payload", details: error.issues }, { status: 400 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

