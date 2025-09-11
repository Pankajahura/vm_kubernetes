// app/api/clusters/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { provisionQueue } from "@/lib/queue";

// --- Schemas ---
const ExistingSpec = z.object({
  provider: z.literal("existing"),
  ssh: z.object({
    user: z.string(),
    private_key_path: z.string()
  }),
  nodes: z.record(z.string(),z.object({
    role: z.enum(["control-plane", "worker"]),
    host: z.string(), // IP or DNS of the existing machine
  })),
});

const LibvirtSpec = z.object({
  provider: z.literal("libvirt"),
  libvirt: z.object({
    uri: z.string(),               // e.g. "qemu:///system"
    pool: z.string(),              // e.g. "default"
    network: z.string(),           // e.g. "default"
    bridge: z.string(),            // e.g. "virbr0"
    cloud_image: z.string(),       // path to ubuntu cloud image
    ssh_public_key_path: z.string(),
    cloud_init_user: z.string().default("ubuntu"),
  }),
  nodes: z.record(z.string(),z.object({
    role: z.enum(["control-plane","worker"]),
    cpu: z.number().int().min(1),
    memory_mb: z.number().int().min(1024),
    disk_gb: z.number().int().min(20),
    hostname: z.string(),
  })),
});

const ProxmoxSpec = z.object({
  provider: z.literal("proxmox"),
  proxmox: z.object({
    api_url: z.string(),         // "https://<PVE>:8006/api2/json"
    user: z.string(),            // "terraform@pve"
    password: z.string(),
    template_name: z.string(),   // "ubuntu-24.04-cloudinit"
    target_node: z.string(),
    storage: z.string(),
    bridge: z.string(),
    vlan_id: z.number(),
    gateway: z.string(),
    dns: z.string(),
    ssh_public_key_path: z.string().default("/home/provisioner/.ssh/id_ed25519.pub"),
  }),
  nodes: z.record(z.string(),z.object({
    role: z.enum(["control-plane","worker"]),
    ip_cidr: z.string(),          // "192.168.10.101/24"
    cpu: z.number().int().min(1),
    memory_mb: z.number().int().min(1024),
    disk_gb: z.number().int().min(20),
    hostname: z.string(),
  })),
});

// Discriminated union on "provider"
const Spec = z.discriminatedUnion("provider", [ExistingSpec, LibvirtSpec, ProxmoxSpec]);

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

//  const parsed = Spec.safeParse(body);
  // if (!parsed.success) {
  //   return NextResponse.json(
  //     { error: "Validation failed", details: parsed.error.flatten() },
  //     { status: 400 }
  //   );
  // }

  //const spec = parsed.data;
  const clusterId = crypto.randomUUID();

const response=  await provisionQueue.add(
    "provision",
    { clusterId, ...body,   nodes: [
    { ip: "159.65.154.159", role: "control-plane" },
    { ip: "10.47.0.7", role: "worker" }
  ]},
    { removeOnComplete: true, attempts: 1 }
  );
  if(response.data.success===false){
    return NextResponse.json({message:response.data.message})
  }

  console.log(response,".......................93");

  return NextResponse.json({ clusterId, status: "QUEUED" });
}

