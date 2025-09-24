// clusters-worker.ts (pure Node/BullMQ environment)
import { createClient as createSb } from "@supabase/supabase-js";
import type { CreateClusterInput } from "../types";

type Phase = "create" | "connect" | "verify";
type Status = "pending" | "creating" | "ready" | "failed" | "deleted";

const supabase = createSb(
  process.env.NEXT_PUBLIC_SUPABASE_URL!, // or SUPABASE_URL
  process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY!, // service role for server-side writes
  { auth: { persistSession: false } }
);

export async function createClusterWorker(payload: CreateClusterInput) {
  const row = {
    cluster_id: payload.clusterId,
    cluster_name: payload.clusterName,

    control_plane: payload.controlPlane ?? null,
    workers: payload.workers ?? [],

    create_status: payload.createStatus ?? false,
    connect_status: payload.connectStatus ?? false,
    verify_status: payload.verifyStatus ?? false,

    kubeconfig: payload.kubeConfig ?? null,
    node_config: payload.nodeConfig ?? null,

    cni_plugin: payload.cniPlugin ?? null,
    k8s_version: payload.k8sVersion ?? null,

    status: payload.status ?? "pending",
    owner_id: payload.ownerId ?? null,
  };

  const { data, error } = await supabase
    .from("clusters")
    .insert(row)
    .select()
    .single();

  if (error) {
    console.error("[createClusterWorker] insert failed:", error.message);
    return { success: false, error: error.message };
  }
  return { success: true, cluster: data };
}

export async function updateClusterPhaseWorker(params: {
  clusterId: string;
  phase: Phase;
  value?: boolean;
  status?: Status;
  extras?: Partial<{
    control_plane: string | null;
    workers: string[];
    kubeconfig: string | null;
    node_config: Record<string, any> | null;
    cni_plugin: string | null;
    k8s_version: string | null;
  }>;
}) {
  const { clusterId, phase, value = true, status, extras = {} } = params;

  const fieldMap: Record<
    Phase,
    "create_status" | "connect_status" | "verify_status"
  > = {
    create: "create_status",
    connect: "connect_status",
    verify: "verify_status",
  };

  const patch: Record<string, any> = {
    [fieldMap[phase]]: value,
    ...extras,
  };
  if (status) patch.status = status;

  const { data, error } = await supabase
    .from("clusters")
    .update(patch)
    .eq("cluster_id", clusterId)
    .select()
    .single();

  if (error) {
    console.error("[updateClusterPhaseWorker] failed:", error.message);
    return { success: false, error: error.message };
  }
  return { success: true, cluster: data };
}
