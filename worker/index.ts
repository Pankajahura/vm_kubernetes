// worker/index.ts
// worker/index.ts
import "dotenv/config";
import { Worker, Job } from "bullmq";
import IORedis from "ioredis";
import path from "node:path";
import fs from "node:fs/promises";

import { waitForSSH } from "./ssh";
import {
  bootstrapNode,
  kubeadmInit,
  getJoinCommand,
  joinWorker,
  installCalico,
  fetchKubeconfig,
  enableControlPlaneScheduling
} from "./bootstrap";

const connection = new IORedis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: null,
});

const KUBECONFIG_DIR = process.env.KUBECONFIG_DIR || "/srv/kubeconfigs";
const SSH_USER = process.env.SSH_USER || "ubuntu";
const SSH_KEY_PATH =
  process.env.SSH_KEY_PATH ||
  (process.env.HOME ? `${process.env.HOME}/.ssh/id_ed25519` : "/root/.ssh/id_ed25519");
const POD_CIDR = process.env.POD_CIDR || "192.168.0.0/16";
const K8S_MINOR = process.env.K8S_MINOR || 1.31;

type NodeSpec = { ip: string; role: "control-plane" | "worker" };

function withTimeout<T>(p: Promise<T>, ms: number, label: string) {
  return Promise.race<T>([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

const processor = async (job: Job) => {
  const { name, cpu, ramMb, workerCount, nodes } = job.data as {
    name: string;
    cpu: number;
    ramMb: number;
    workerCount: number;
    nodes: NodeSpec[];
  };

  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error("No node IPs provided. (Upstream step should pass nodes[])");
  }
  const cp = nodes.find((n) => n.role === "control-plane");
  if (!cp) throw new Error("No control-plane node in nodes[]");

  console.log("[env]", {
    hasRedis: !!process.env.REDIS_URL,
    SSH_USER,
    SSH_KEY_PATH,
    KUBECONFIG_DIR,
    POD_CIDR,
    K8S_MINOR,
    typeOf(K8S_MINOR),".......checking kbs minor type.."
  });




  // 3) kubeadm init on control plane
  console.log(`[init] kubeadm init on ${cp.ip}`);
  await withTimeout(
    kubeadmInit(cp.ip, SSH_USER, SSH_KEY_PATH, POD_CIDR),
    10 * 60_000,
    "kubeadm init"
  );
  console.log("[init] done");

  // 4) Install CNI
  console.log("[cni] install calico");
  await withTimeout(installCalico(cp.ip, SSH_USER, SSH_KEY_PATH), 3 * 60_000, "calico");
  console.log("[cni] done");
  console.log("[job] received", { id: job.id, name, cpu, ramMb, workerCount, nodes });
// 5) Get join command
  console.log("[join] getting join command");
  const joinCmd = await withTimeout(
    getJoinCommand(cp.ip, SSH_USER, SSH_KEY_PATH),
    60_000,
    "get join command"
  );
  console.log("[join] command:", joinCmd);


  // 6) Join workers
  const workers = nodes.filter((n) => n.role === "worker");
  if (workers.length === 0) {
  await enableControlPlaneScheduling(cp.ip, SSH_USER, SSH_KEY_PATH);
}
  // 7) Fetch kubeconfig
  const kubePath = path.join(KUBECONFIG_DIR, `${job.id}.yaml`);
  await fs.mkdir(KUBECONFIG_DIR, { recursive: true });
  console.log("[kubeconfig] fetching to", kubePath);
  await withTimeout(
    fetchKubeconfig(cp.ip, SSH_USER, SSH_KEY_PATH, kubePath),
    60_000,
    "fetch kubeconfig"
  );
  console.log("[kubeconfig] done");

  return { ok: true, kubeconfigPath: kubePath, controlPlane: cp.ip };
};

const worker = new Worker("cluster", processor, { connection, concurrency: 1 });

worker.on("active", (job) => console.log(`[worker] active ${job.id}`));
worker.on("completed", (job, res) => console.log(`[worker] completed ${job.id}`, res));
worker.on("failed", (job, err) =>
  console.error(`[worker] failed ${job?.id}`, err?.stack || err)
);
worker.on("error", (err) => console.error("[worker] runtime error", err));
