// app/vms/actions.ts
"use server";

import { success } from "zod";
import { createClient } from "./server";

import { headers, cookies } from "next/headers";

type Plan = { cpu: number; ram: number;storage: number };

export async function updateVmByIps(ips: string[]) {

  console.log(ips,"...............ips");
  
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("vms")
    .update({ status: "used" })
    .in("ip_address", ips) // <- match multiple rows by IP
    .eq("status", "free") // optional guard: only free -> used
    .select("id, ip_address, username, location, status, created_at");
    console.log(error.message,"...............error.message");
  if (error) throw new Error(error.message);

  // if you used `next: { tags: ['vms'] }` on fetch, you can revalidate here:
  // revalidateTag('vms');

  return { success: true, message: "IP status updated successfully" };
}

// Call  GET /api/vms and PUT /api/vms/use with the user's session cookies.
export async function buildPayloadWithFreeIps(payloads: {
  name: string;
  location: string;
  version: string; // e.g. "1.31.1"
  planDetails: Plan; // { cpu, ram }
  nodes:number;
  // if you want dynamic nodes, pass an array of node keys, else we'll use cp-1, wp-1, wp-2
  // e.g. ["cp-1","wp-1","wp-2"]
}) {
  console.log(payloads, "...........in buildPayloadWithFreeIps........");
  const nodeKeys = makeNodeKeys(payloads.nodes);
  console.log(nodeKeys, "...........nodeKeys........");
  //const needed = nodeKeys.length;

 

  // 1) Get N free VMs for the location
  // console.log(host,scheme,cookieHeader,"...........host,scheme,cookieHeader........");
  // const res = await fetch(
  //   `http://localhost:3000/api/manageip/read?location=${encodeURIComponent(
  //     data.location
  //   )}&number=${needed}`,
  //   { headers: { cookie: cookieHeader }, cache: "no-store" }
  // );

  const supabase = await createClient();

  const { data, error } = await supabase
      .from('vms')
      .select('id, ip_address, username, location,ram,cpu,storage, status, created_at')
      .eq('location', payloads.location)
      .eq('status', 'free')
      .eq('ram', payloads.planDetails.ram)
      .eq('cpu', payloads.planDetails.cpu)
      .eq('storage', payloads.planDetails.storage)
      .order('created_at', { ascending: true })
      .limit(payloads.nodes+1);

  //console.log(res.status, "...........res.status........");

  if (error) {
    // const msg = await res.text().catch(() => "Failed to fetch free IPs");
    return { success: false, error: error.message };
  }

  // // const free = (await res.json()) as Array<{
  // //   id: string;
  // //   ipAddress: string;
  // //   username: string;
  // //   location: string;
  // //   status: "free" | "used";
  // // }>;
  // // console.log(free, "...........free........");

  // if (free.length < payloads.nodes) {
  //   return {
  //     success: false,
  //     error: `Only ${free.length}/${needed} free IPs available in ${data.location}.`,
  //   };
  // }

   const ips = data.slice(0, payloads.nodes+1).map((v) => v.ip_address);

  //3) Build node map with attached IPs
  const nodes: Record<
    string,
    {
      host: string;
      role: "control-plane" | "worker";
      hostname: string;
      cpu: number;
      memory_mb: number;
    }
  > = {};

  nodeKeys.forEach((key, i) => {
    nodes[key] = {
      host: ips[i],
      role: key.startsWith("cp-") ? "control-plane" : "worker",
      hostname: key,
      cpu: payloads.planDetails.cpu,
      memory_mb: payloads.planDetails.ram,
    };
  });

  // 4) Final payload (IPs included; no passwords in ips array)
  const payload = {
    provider: "existing",
    cluster: {
      name: payloads.name,
      location: payloads.location,
      pod_cidr: "10.244.0.0/16",
      k8s_minor: payloads.version,
    },
    auth: { method: "password", user: "root", password: "luV5DivOV98g" }, // <-- replace with your real secret handling
    nodes,
    ips, // only IPs, as requested
  };

  return { success: true, payload };
}



function makeNodeKeys(workers: number): string[] {
  const n = Math.max(0, Math.floor(workers)); // sanitize
  const keys = ["cp-1"];
  for (let i = 1; i <= n; i++) keys.push(`wp-${i}`);
  return keys;
}
