import "dotenv/config";
import { Worker, Job } from "bullmq";
import IORedis from "ioredis";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

// ---------- ENV ----------
const REDIS_URL = process.env.REDIS_URL!;
const QUEUE_NAME = process.env.QUEUE_NAME || "provision-queue";
const POD_CIDR_DEFAULT = process.env.POD_CIDR || "10.244.0.0/16";
const KUBECONFIG_DIR = process.env.KUBECONFIG_DIR || "/srv/kubeconfigs";
const CALICO_URL =
  process.env.CALICO_URL ||
  "https://raw.githubusercontent.com/projectcalico/calico/v3.28.0/manifests/calico.yaml";

// version handling: accept env K8S_SERIES="v1.31" or K8S_MINOR="1.31"
function toSeries(x?: string | number): string {
  const s = (x ?? "v1.31").toString();
  const withV = s.startsWith("v") ? s : `v${s}`;
  const m = withV.match(/^v\d+\.\d+/);
  return m ? m[0] : "v1.31";
}
// kubeadm version: allow pin via K8S_VERSION (e.g. v1.31.1 or stable-1.31),
// otherwise default to latest patch of the series
function toKubeadmVersion(series: string, pin?: string): string {
  if (pin) return pin; // "v1.31.1" or "stable-1.31"
  return `stable-${series.slice(1)}`;
}

const K8S_SERIES = toSeries(process.env.K8S_SERIES ?? process.env.K8S_MINOR);
const KUBEADM_VERSION = toKubeadmVersion(K8S_SERIES, process.env.K8S_VERSION);

// ---------- Types ----------
type Role = "control-plane" | "worker";
type Auth =
  | { method: "password"; user: string; password: string }
  | { method: "key"; user: string; private_key_path: string };

type NodeSpec = {
  host: string;
  role: Role;
  hostname?: string;
  cpu?: number;
  memory_mb?: number;
};
type JobData = {
  clusterId: string;
  provider: "existing";
  cluster: { name: string; location: string; pod_cidr?: string; k8s_minor?: number | string };
  auth: Auth;
  nodes: Record<string, NodeSpec>;
};

// ---------- Redis ----------
const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });

function dest(auth: Auth, host: string) {
  if (host.includes("@")) throw new Error(`host must not contain '@': ${host}`);
  return `${auth.user}@${host}`;
}

// ---------- SSH helpers ----------
function sshBaseArgs(auth: Auth, host: string) {
  const d = dest(auth, host);
  const common = [
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "ConnectTimeout=20",
    "-o", "NumberOfPasswordPrompts=1",
    "-o", "PreferredAuthentications=keyboard-interactive,password",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=4",
  ];
  if (auth.method === "password") {
    return { bin: "sshpass", args: ["-p", auth.password, "ssh", ...common, "-o", "PubkeyAuthentication=no", d] };
  }
  return { bin: "ssh", args: ["-i", auth.private_key_path, ...common, d] };
}

async function sshExec(auth: Auth, host: string, oneStringCmd: string, tag?: string) {
  const { bin, args } = sshBaseArgs(auth, host);
  const script = typeof oneStringCmd === "string" ? oneStringCmd : String(oneStringCmd);
   const quoted = JSON.stringify(script);  
  const { stdout, stderr } = await execFileAsync(
    bin,
    [...args, "bash", "-lc", quoted], // ONE string after -lc
    { encoding: "utf8" }
  );
  if (stderr?.trim()) console.warn(`[ssh:${tag ?? host}] ${stderr.trim()}`);
  return stdout.trim();
}

async function scpFrom(auth: Auth, host: string, remote: string, local: string) {
  await fs.mkdir(path.dirname(local), { recursive: true });
  if (auth.method === "password") {
    const args = [
      "-p", auth.password, "scp",
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "ServerAliveInterval=30",
      "-o", "ServerAliveCountMax=4", // <-- removed stray leading space
      `${auth.user}@${host}:${remote}`, local,
    ];
    await execFileAsync("sshpass", args);
  } else {
    const args = [
      "-i", auth.private_key_path,
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      `${auth.user}@${host}:${remote}`, local,
    ];
    await execFileAsync("scp", args);
  }
}

async function getHostInfo(auth: Auth, host: string) {
  const cmd = `set -e; printf '%s %s %s\\n' \
"$(hostnamectl --static 2>/dev/null || hostname)" \
"$(nproc)" \
"$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"`;
  const out = await sshExec(auth, host, cmd, "host-info");
  const [hn, cpuStr, memStr] = out.trim().split(/\s+/);
  return { hostname: hn, cpu: Number(cpuStr), memory_mb: Number(memStr) };
}

// sudo wrapper returns JUST a string; outer layer already does sh -lc
function sudoWrap(auth: Auth, raw: string) {
  const body = `export DEBIAN_FRONTEND=noninteractive; ${raw}`;
  if (auth.user === "root") return body;
  if (auth.method === "password") {
    const pw = auth.password.replace(/'/g, `'\\''`);
    return `set -e; echo '${pw}' | sudo -S -p '' bash -lc ${JSON.stringify(body)}`;
  }
  return `sudo bash -lc ${JSON.stringify(body)}`;
}

// ---------- Provision steps ----------
async function bootstrapNode(auth: Auth, host: string, k8sSeries: string) {
  await sshExec(
    auth,
    host,
    sudoWrap(
      auth,
      `set -eux
swapoff -a || true
sed -i.bak '/\\sswap\\s/d' /etc/fstab || true

# containerd
if ! command -v containerd >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg lsb-release apt-transport-https
  install -m 0755 -d /etc/apt/keyrings || true
  rm -f /etc/apt/keyrings/docker.gpg || true
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$(. /etc/os-release; echo "$ID") $(. /etc/os-release; echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list|| true
  apt-get update -y || true
  apt-get install -y containerd.io|| true
  mkdir -p /etc/containerd || true
  containerd config default | tee /etc/containerd/config.toml >/dev/null || true
  systemctl enable --now containerd || true
fi

# Kubernetes apt repo (SERIES like v1.31 in ${k8sSeries})
install -m 0755 -d /etc/apt/keyrings || true
rm -f /etc/apt/keyrings/kubernetes-apt-keyring.gpg || true
curl -fsSL "https://pkgs.k8s.io/core:/stable:/${k8sSeries}/deb/Release.key" \ || true
  | gpg --dearmor --batch --yes -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg || true
chmod 0644 /etc/apt/keyrings/kubernetes-apt-keyring.gpg || true
echo "deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/${k8sSeries}/deb/ /" | tee /etc/apt/sources.list.d/kubernetes.list >/dev/null || true
apt-get update -y || true
apt-get install -y kubelet kubeadm kubectl || true
apt-mark hold kubelet kubeadm kubectl || true


# sysctl
cat >/etc/sysctl.d/99-kubernetes-cri.conf <<'SYS'
net.bridge.bridge-nf-call-iptables  = 1
net.ipv4.ip_forward                 = 1
net.bridge.bridge-nf-call-ip6tables = 1
SYS
sysctl --system >/dev/null`
    ),
    "bootstrap"
  );
}

async function kubeadmInit(auth: Auth, host: string, podCidr: string, kubeadmVersion: string) {
  // You can omit --kubernetes-version to use the installed one; here we pass a valid label/version.
 
 try{
   await sshExec(
    auth,
    host,
    sudoWrap(
      auth,
      `set -eux
kubeadm init --pod-network-cidr=${podCidr} --kubernetes-version=${kubeadmVersion}
mkdir -p /root/.kube
cp -f /etc/kubernetes/admin.conf /root/.kube/config
chown root:root /root/.kube/config
if [ "$SUDO_USER" != "" ]; then
  UHOME=$(getent passwd "$SUDO_USER" | cut -d: -f6)
  mkdir -p "$UHOME/.kube"
  cp -f /etc/kubernetes/admin.conf "$UHOME/.kube/config"
  chown $(id -u "$SUDO_USER"):$(id -g "$SUDO_USER") "$UHOME/.kube/config"
fi`
    ),
    "kubeadm-init"
  );

 }catch(err){
   console.log(err||"error in 217")
 }
}

async function installCalico(auth: Auth, host: string, calicoUrl: string) {
  await sshExec(auth, host, sudoWrap(auth, `kubectl apply -f ${calicoUrl}`), "calico");
}

async function getJoinCommand(auth: Auth, host: string) {
  const cmd = await sshExec(auth, host, sudoWrap(auth, `kubeadm token create --print-join-command`), "join-token");
  return `sudo ${cmd.trim()}`;
}

async function joinWorker(auth: Auth, host: string, joinCmd: string) {
  await sshExec(auth, host, sudoWrap(auth, `set -eux; ${joinCmd}`), `join-${host}`);
}

async function fetchKubeconfig(auth: Auth, host: string, destPath: string) {
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await scpFrom(auth, host, "/etc/kubernetes/admin.conf", destPath);
}

async function labelNode(auth: Auth, apiHost: string, nodeName: string, labels: Record<string, string>) {
  const args = Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  await sshExec(auth, apiHost, sudoWrap(auth, `kubectl label node ${nodeName} ${args} --overwrite`), `label-${nodeName}`);
}

// ---------- Processor ----------
const processor = async (job: Job) => {
  const data = job.data as JobData;
  const clusterId = data.clusterId;
  const podCidr = data.cluster.pod_cidr || POD_CIDR_DEFAULT;

  // Allow job to override the series if it provides k8s_minor
  const jobSeries = toSeries(data.cluster.k8s_minor ?? K8S_SERIES);
  const kubeadmVersion = toKubeadmVersion(jobSeries, undefined /* or allow pin via payload */);

  console.log("[job] starting", {
    id: job.id,
    clusterId,
    nodes: Object.keys(data.nodes).length,
    series: jobSeries,
    kubeadmVersion,
  });

  const nodes = Object.values(data.nodes);
  const cp = nodes.find((n) => n.role === "control-plane");
  if (!cp) throw new Error("No control-plane node provided.");
  const workers = nodes.filter((n) => n.role === "worker");

  // Optionally set hostnames
  for (const n of nodes) {
    if (n.hostname) {
      await sshExec(
        data.auth,
        n.host,
        sudoWrap(data.auth, `hostnamectl set-hostname -- ${JSON.stringify(n.hostname)}`),
        "set-hostname"
      );
    }
  }

  // Warn if sizing below requested
  for (const n of nodes) {
    const info = await getHostInfo(data.auth, n.host);
    if (n.cpu && info.cpu < n.cpu) console.warn(`[warn] ${n.host} CPU present=${info.cpu} < target=${n.cpu}`);
    if (n.memory_mb && info.memory_mb < n.memory_mb) console.warn(`[warn] ${n.host} RAM present=${info.memory_mb}MB < target=${n.memory_mb}MB`);
  }

  // Bootstrap all nodes
  await Promise.all(nodes.map((n) => bootstrapNode(data.auth, n.host, jobSeries)));

  // Init control-plane
  await kubeadmInit(data.auth, cp.host, podCidr, kubeadmVersion);

  // CNI
  await installCalico(data.auth, cp.host, CALICO_URL);

  // Join workers or enable master scheduling
  if (workers.length) {
    const joinCmd = await getJoinCommand(data.auth, cp.host);
    for (const w of workers) await joinWorker(data.auth, w.host, joinCmd);
  } else {
    // Single-node: allow workloads on control-plane
    await sshExec(
      data.auth,
      cp.host,
      sudoWrap(data.auth, `kubectl taint nodes --all node-role.kubernetes.io/control-plane- || true`),
      "cp-sched"
    );
  }

  // Fetch kubeconfig
  const kubePath = path.join(KUBECONFIG_DIR, `${clusterId}.yaml`);
  await fetchKubeconfig(data.auth, cp.host, kubePath);

  // Optional labels
  const cpInfo = await getHostInfo(data.auth, cp.host);
  await labelNode(data.auth, cp.host, cpInfo.hostname, {
    "ahura.cloud/cluster": data.cluster.name,
    "topology.kubernetes.io/region": data.cluster.location,
  });
  for (const w of workers) {
    const wInfo = await getHostInfo(data.auth, w.host);
    await labelNode(data.auth, cp.host, wInfo.hostname, {
      "ahura.cloud/cluster": data.cluster.name,
      "topology.kubernetes.io/region": data.cluster.location,
    });
  }

  return { ok: true, kubeconfigPath: kubePath, controlPlane: cp.host, nodes: data.nodes };
};

// ---------- Start worker ----------
const worker = new Worker(QUEUE_NAME, processor, { connection, concurrency: 1 });
worker.on("ready", () => console.log(`[worker] ready on ${QUEUE_NAME}`));
worker.on("active", (job) => console.log(`[worker] active ${job.id}`));
worker.on("completed", (job, res) => console.log(`[worker] completed ${job.id}`, res));
worker.on("failed", (job, err) => console.error(`[worker] failed ${job?.id}`, err?.stack || err));
worker.on("error", (err) => console.error("[worker] runtime error", err));
