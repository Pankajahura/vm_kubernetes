import { NextResponse } from "next/server";
import { z } from "zod";
import { provisionQueue } from "@/lib/queue";

const Auth = z.discriminatedUnion("method", [
  z.object({
    method: z.literal("password"),
    user: z.string().default("ubuntu"),
    password: z.string().min(1),
  }),
  z.object({
    method: z.literal("key"),
    user: z.string().default("ubuntu"),
    private_key_path: z.string().min(1),
  }),
]);

const NodeSpec = z.object({
  host: z.string(),                               // external IP or DNS
  role: z.enum(["control-plane", "worker"]),
  hostname: z.string().optional(),
  cpu: z.number().int().min(1).optional(),        // validated only
  memory_mb: z.number().int().min(512).optional() // validated only
});

const Payload = z.object({
  provider: z.literal("existing"),
  cluster: z.object({
    name: z.string(),                              // e.g. "ahura-01"
    location: z.string(),                          // e.g. "mumbai"
    pod_cidr: z.string().default("10.244.0.0/16"),
    k8s_minor: z.string().default("1.31.0")
  }),
  auth: Auth,
  nodes: z.record(z.string(), NodeSpec)            // {"cp-1":{...}, "w-1":{...}}
});

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = Payload.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid payload", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const clusterId = crypto.randomUUID();
  const job = await provisionQueue.add("provision", { clusterId, ...parsed.data });

  return NextResponse.json({ clusterId, jobId: job.id, status: "QUEUED" });
}
